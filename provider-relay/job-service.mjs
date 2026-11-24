import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { taskView, TaskLimits } from './task-contract.mjs';
import { listTasks } from './task-list.mjs';
import { QueueCipher } from './queue-crypto.mjs';
import { credentialOwner, providerCredential, ownershipVersion, authenticateJob } from './job-auth.mjs';

export const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "canceled", "uncertain"]);

function publicJob(job) {
  return {
    job_id: job.id,
    status: job.status,
    provider_job_id: job.providerJobId || null,
    error: job.error || null,
    result: job.result || null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    ...taskView(job),
  };
}

function ownerHash(credential) {
  return credentialOwner(credential);
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDER_JOB_ID = /^[A-Za-z0-9_-]{1,100}$/;
const JOURNAL_LINE_MAX = 4096;
const JOURNAL_BYTES_MAX = 1024 * 1024;
const journalContext = (jobId) => JSON.stringify(['fal-accepted-v1', jobId]);

/**
 * Small atomic JSON store. Caller credentials and input payloads are ciphertext only.
 *
 * Next to the snapshot, `<path>.accepted.jsonl` records provider job ids that were accepted while the snapshot
 * could not be written. Appends, snapshots and journal compaction run on one serialized chain; an entry is
 * removed only after a successful snapshot that contains that job with that provider id.
 */
export class JsonJobStore {
  constructor(path, { now = () => Date.now(), retentionMs = 7 * 86400000 } = {}) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new Error('Invalid retention period');
    this.retentionMs = retentionMs;
    this.path = path;
    this.journalPath = `${path}.accepted.jsonl`;
    /** Optional QueueCipher; when set, journal entries must be sealed by it. */
    this.journalCipher = null;
    this.journal = [];
    this.journalRejected = [];
    this.now = now;
    this.jobs = new Map();
    this.loaded = false;
    this.write = Promise.resolve();
  }

  async load() {
    this.loading ||= this.loadOnce().catch((error) => { this.loading = null; throw error; });
    return this.loading;
  }

  /** Runs one file operation after every earlier one, whatever their outcome (a failure never blocks later writes). */
  enqueue(operation) {
    const run = this.write.catch(() => undefined).then(operation);
    this.write = run;
    return run;
  }

  async settled() { await this.write.catch(() => undefined); }

  /** Validated journal entry or null. */
  parseJournalLine(line) {
    if (!line || line.length > JOURNAL_LINE_MAX) return null;
    let record;
    try { record = JSON.parse(line); } catch { return null; }
    if (!record || typeof record !== 'object' || record.v !== 1 || typeof record.jobId !== 'string' || !JOB_ID.test(record.jobId)) return null;
    let providerJobId = record.providerJobId;
    if (this.journalCipher) {
      try {
        const opened = this.journalCipher.open(record.sealed, journalContext(record.jobId));
        if (opened?.jobId !== record.jobId) return null;
        providerJobId = opened.providerJobId;
      } catch { return null; }
    } else if (record.sealed !== undefined) return null;
    if (typeof providerJobId !== 'string' || !PROVIDER_JOB_ID.test(providerJobId)) return null;
    return { jobId: record.jobId, providerJobId, line };
  }

  async readJournal() {
    let raw;
    try { raw = await readFile(this.journalPath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    // Bounded read; a journal beyond the bound is never compacted, so entries past it are not erased.
    if (raw.length > JOURNAL_BYTES_MAX) { raw = raw.slice(0, JOURNAL_BYTES_MAX); this.journalTruncated = true; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const entry = this.parseJournalLine(line);
      if (entry) this.journal.push(entry); else this.journalRejected.push(line.slice(0, JOURNAL_LINE_MAX));
    }
  }

  /**
   * Applies journal ids to jobs that exist and are unresolved. Conflicts fail closed:
   * - journal names a different id than the snapshot: the snapshot id stays (it was durably written first), flagged;
   * - two journal entries name different ids for a job without one: NO id is applied and the job is held as
   *   "uncertain" (code journal_conflict) - neither id is queried nor anything resubmitted; entries stay for inspection.
   */
  applyJournal() {
    const byJob = new Map();
    for (const entry of this.journal) {
      if (!byJob.has(entry.jobId)) byJob.set(entry.jobId, new Set());
      byJob.get(entry.jobId).add(entry.providerJobId);
    }
    for (const [jobId, ids] of byJob) {
      const job = this.jobs.get(jobId);
      if (!job || ['succeeded', 'failed', 'canceled'].includes(job.status)) continue;
      if (job.providerJobId) {
        if (ids.size > 1 || !ids.has(job.providerJobId)) job.journalConflict = true;
        continue;
      }
      if (ids.size > 1) {
        job.journalConflict = true;
        job.status = 'uncertain'; job.stage = 'uncertain'; job.finishedAt = this.now(); delete job.sealed;
        job.error = { code: 'journal_conflict', message: 'Conflicting provider job ids were recorded; nothing is queried or resubmitted. An operator must inspect the job journal.' };
        continue;
      }
      job.providerJobId = [...ids][0];
      // Accepted by the provider: never a waiting/dispatchable job again. The restart rules turn it into "recoverable".
      if (job.durableQueue) job.queueState = 'submitting';
      if (['queued', 'uncertain'].includes(job.status)) job.status = 'running';
      delete job.finishedAt;
      job.error = { code: 'recovered_from_journal', message: 'Provider job id restored after a failed save; querying the existing job only.' };
    }
  }

  /** Durably appends one accepted provider id (fsync before resolving). */
  recordAccepted(jobId, providerJobId) {
    if (!JOB_ID.test(jobId) || !PROVIDER_JOB_ID.test(providerJobId)) return Promise.reject(new Error('Invalid journal entry'));
    const record = this.journalCipher
      ? { v: 1, jobId, sealed: this.journalCipher.seal({ jobId, providerJobId }, journalContext(jobId)) }
      : { v: 1, jobId, providerJobId };
    const line = JSON.stringify(record);
    return this.enqueue(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const handle = await open(this.journalPath, 'a', 0o600);
      try { await handle.appendFile(`${line}\n`); await handle.sync(); } finally { await handle.close(); }
      this.journal.push({ jobId, providerJobId, line });
    });
  }

  /** After a successful snapshot: drop the journal entries it covers (best effort; a failure keeps them). */
  async compactJournal(covered) {
    if (this.journalTruncated) return;
    const remaining = this.journal.filter((entry) => covered.get(entry.jobId) !== entry.providerJobId);
    if (remaining.length === this.journal.length) return;
    try {
      const lines = [...this.journalRejected, ...remaining.map((entry) => entry.line)];
      if (!lines.length) await unlink(this.journalPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      else {
        const temp = `${this.journalPath}.${process.pid}.${randomUUID()}.tmp`;
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(lines.map((line) => `${line}\n`).join('')); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, this.journalPath);
      }
      this.journal = remaining;
    } catch { /* entries stay until a later snapshot compacts them */ }
  }

  async loadOnce() {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      for (const job of Array.isArray(parsed) ? parsed : []) {
        if (job && typeof job.id === "string") this.jobs.set(job.id, job);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Accepted provider ids that never reached the snapshot are restored before the restart rules below,
    // so such a job becomes query-only "recoverable" rather than "uncertain".
    await this.readJournal();
    this.applyJournal();
    // A process restart cannot safely replay a paid submit. Jobs with a provider id
    // can be resumed by the caller; jobs without one are explicitly uncertain.
    for (const job of this.jobs.values()) {
      // Old terminal records receive a full retention window at migration.
      if (['succeeded', 'failed', 'canceled'].includes(job.status) && !Number.isFinite(job.finishedAt)) job.finishedAt = this.now();
      if (job.durableQueue && job.queueState === 'waiting' && job.status === 'queued' && job.sealed) continue;
      if (["queued", "running", "retrying", "recoverable"].includes(job.status)) {
        job.status = job.providerJobId ? "recoverable" : "uncertain";
        job.updatedAt = this.now();
        job.stage = job.status;
        if (job.status === 'uncertain') { job.finishedAt = job.updatedAt; delete job.sealed; }
      }
    }
    await this.flush();
    this.loaded = true;
  }

  async cleanup() {
    if (this.cleaning) return this.cleaning;
    this.cleaning = this.cleanupOnce();
    try { return await this.cleaning; } finally { this.cleaning = null; }
  }

  async cleanupOnce() {
    // Durable queue identities are never recycled automatically. Results may expire.
    const archived = [...this.jobs.values()].filter(j => j.durableQueue && j.result && ['succeeded', 'failed', 'canceled'].includes(j.status) && j.finishedAt + this.retentionMs <= this.now());
    const expired = [...this.jobs.values()].filter(j => !j.durableQueue && ['succeeded', 'failed', 'canceled'].includes(j.status) && Number.isFinite(j.finishedAt) && j.finishedAt + this.retentionMs <= this.now());
    if (archived.length) { for (const job of archived) { job.result = null; job.resultExpired = true; } await this.flush(); }
    if (!expired.length) return 0;
    for (const job of expired) this.jobs.delete(job.id);
    try { await this.flush(); } catch (error) {
      for (const job of expired) if (!this.jobs.has(job.id)) this.jobs.set(job.id, job);
      throw error; // A failed write must not authorize a replacement paid submission.
    }
    return expired.length;
  }

  async flush() {
    const data = JSON.stringify([...this.jobs.values()]);
    const covered = new Map([...this.jobs.values()].filter((job) => job.providerJobId).map((job) => [job.id, job.providerJobId]));
    return this.enqueue(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      let lastError;
      for (let attempt = 0; attempt < 6; attempt++) {
        try { await rename(temp, this.path); lastError = undefined; break; }
        catch (error) {
          lastError = error;
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
        }
      }
      if (lastError) throw lastError;
      if (process.platform !== 'win32') { const dir = await open(dirname(this.path), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
      if (this.journal.length) await this.compactJournal(covered);
    });
  }
}

function retryable(error) {
  return Boolean(error?.retryable || [408, 425, 429, 500, 502, 503, 504].includes(error?.status));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fal queue job coordinator. submit is intentionally never retried: after a network
 * break the provider may have accepted the paid request, so the job becomes uncertain.
 */
export class FalJobService {
  constructor({ store, provider, now = () => Date.now(), sleepFn = sleep, maxPollRetries = 3, pollDelayMs = 1200, maxActive = 2, modelLimits = {}, pollTimeoutMs = 540000, queueKey = null, maxQueueBytes = 128 * 1024 * 1024, requireAccountOwnership = false, legacyGuard, persistRetryMs = 1000, persistRetryMaxMs = 60000 } = {}) {
    if (!store || !provider) throw new TypeError("store and provider are required");
    this.store = store;
    this.provider = provider;
    this.now = now;
    this.sleep = sleepFn;
    this.maxPollRetries = maxPollRetries;
    this.pollDelayMs = pollDelayMs;
    this.limits = new TaskLimits(maxActive, modelLimits);
    this.workers = new Map();
    this.pollTimeoutMs = pollTimeoutMs;
    this.cipher = queueKey === null ? null : new QueueCipher(queueKey);
    if (!Number.isSafeInteger(maxQueueBytes) || maxQueueBytes < 1) throw new Error('Invalid queue byte limit');
    this.maxQueueBytes = maxQueueBytes;
    this.recovery = new Set();
    this.stopped = false; this.requireAccountOwnership = requireAccountOwnership; this.legacyGuard = legacyGuard;
    // Storage health: while the last snapshot write failed, no new paid work is admitted or dispatched.
    this.storageError = null;
    this.persistRetryMs = persistRetryMs; this.persistRetryMaxMs = persistRetryMaxMs; this.persistRetryTimer = null; this.persistRetryDelay = persistRetryMs;
    if ('journalCipher' in store) store.journalCipher = this.cipher;
  }

  get storageHealthy() { return this.storageError === null; }

  /**
   * Writes the snapshot. `required` writes (markers that must be durable BEFORE a paid submit or a cancel) throw on
   * failure; best-effort writes keep the in-memory state, mark storage unhealthy and schedule a retry.
   */
  async persist({ required = false } = {}) {
    try {
      await this.store.flush();
    } catch (error) {
      this.storageError = error;
      this.armPersistRetry();
      if (required) throw Object.assign(new Error('job_store_unavailable'), { status: 503, cause: error });
      return false;
    }
    const wasUnhealthy = this.storageError !== null;
    this.storageError = null;
    this.persistRetryDelay = this.persistRetryMs;
    if (this.persistRetryTimer) { clearTimeout(this.persistRetryTimer); this.persistRetryTimer = null; }
    if (wasUnhealthy) {
      for (const job of this.store.jobs.values()) if (job.error?.code === 'persist_failed_after_accept' && !TERMINAL_JOB_STATUSES.has(job.status)) job.error = null;
      this.schedule();
    }
    return true;
  }

  armPersistRetry() {
    if (this.persistRetryTimer || this.stopped) return;
    const delay = this.persistRetryDelay;
    this.persistRetryDelay = Math.min(this.persistRetryDelay * 2, this.persistRetryMaxMs);
    this.persistRetryTimer = setTimeout(() => { this.persistRetryTimer = null; void this.retryPersistence(); }, delay);
    this.persistRetryTimer.unref?.();
  }

  /** Re-attempts the snapshot (also called by the retry timer). Resolves true once storage is healthy again. */
  async retryPersistence() { return this.storageHealthy || this.persist(); }

  /** New paid work requires healthy storage; one fresh attempt is made before refusing. */
  async requireHealthyStorage() {
    await this.store.settled();
    if (this.storageHealthy) return;
    if (!(await this.persist())) throw Object.assign(new Error('job_store_unavailable'), { status: 503 });
  }

  async init() {
    this.initializing ||= this.store.load().then(() => {
      if (this.requireAccountOwnership && [...this.store.jobs.values()].some(j => j.ownershipVersion !== 'account-v1')) throw new Error('Legacy tasks require quarantine');
      for (const j of this.store.jobs.values()) if (j.durableQueue && j.status === 'recoverable' && j.providerJobId && j.sealed) this.recovery.add(j.id);
      this.schedule();
    }).catch((error) => { this.initializing = null; throw error; });
    await this.initializing;
    // cleanup restores records on a failed write; reads and query-only recovery must keep working.
    await this.store.cleanup().catch((error) => { this.storageError = error; this.armPersistRetry(); });
  }

  context(j) { return JSON.stringify(['fal', 'https://queue.fal.run', j.id, j.owner, j.key, j.model]); }

  schedule() {
    if (!this.cipher || this.stopped || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.stopped) return;
      for (const j of this.store.jobs.values()) {
        const recovery = this.recovery.has(j.id) && j.status === 'recoverable' && j.providerJobId;
        // Query-only recovery may run on unhealthy storage; a new paid submission may not.
        const waiting = this.storageHealthy && j.durableQueue && j.status === 'queued' && j.queueState === 'waiting' && !j.providerJobId;
        if ((!recovery && !waiting) || !j.sealed || this.workers.has(j.id)) continue;
        try { if (!this.limits.acquire(j.id, j.model)) continue; }
        catch (error) { if (error.status === 429) continue; this.stopped = true; return; }
        this.recovery.delete(j.id);
        j.status = 'running'; j.stage = recovery ? 'querying_provider' : 'submitting';
        if (!recovery) { j.queueState = 'submitting'; j.startedAt = this.now(); }
        j.updatedAt = this.now();
        this.track(j, () => this.dispatch(j, recovery));
      }
    });
  }

  /** A dispatch whose marker never became durable goes back to the waiting queue; nothing was submitted. */
  returnToWaiting(j, sealed) {
    j.sealed = sealed; j.status = 'queued'; j.stage = 'waiting'; j.queueState = 'waiting'; delete j.startedAt; j.updatedAt = this.now();
  }

  async dispatch(j, recovery) {
    const original = j.sealed;
    if (recovery) await this.persist();
    else {
      try { await this.persist({ required: true }); }
      catch { this.returnToWaiting(j, original); return; }
    }
    let data;
    try {
      data = this.cipher.open(j.sealed, this.context(j));
      if (ownerHash(data.credential) !== j.owner || (!recovery && fingerprint(data.payload) !== j.bodyHash)) throw new Error('Invalid queue binding');
    } catch {
      delete j.sealed;
      j.error = { code: 'queue_decryption_failed', message: 'Queue data cannot be safely decrypted; no upstream request was made.' };
      await this.update(j, recovery ? 'recoverable' : 'failed'); return;
    }
    if (recovery) { await this.poll(j, data.credential); return; }
    // Drop image/input data before network, retain only encrypted query credentials.
    j.sealed = this.cipher.seal({ credential: data.credential }, this.context(j));
    try { await this.persist({ required: true }); }
    catch { this.returnToWaiting(j, original); return; }
    await this.run(j.id, data.credential, data.payload);
  }

  async list(credential, search = '', model) {
    await this.init();
    return listTasks(this.store, ownerHash(credential), search, model);
  }

  async create({ model, idempotencyKey, credential, payload }) {
    await this.init();
    if (this.requireAccountOwnership && ownershipVersion(credential) !== 'account-v1') throw Object.assign(new Error('account_authentication_required'), { status: 401 });
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(model) || !/^[A-Za-z0-9._~-]{1,200}$/.test(idempotencyKey)) {
      const error = new Error("invalid job identity"); error.status = 400; throw error;
    }
    const owner = ownerHash(credential);
    const key = `${owner}:${model}:${idempotencyKey}`;
    const bodyHash = fingerprint(payload);
    const findExisting = () => {
      const found = [...this.store.jobs.values()].find((job) => job.key === key);
      if (found && found.bodyHash !== bodyHash) { const error = new Error("idempotency key was reused with different input"); error.status = 409; throw error; }
      return found;
    };
    // A joined job must still be stored after the pending write: its admission may have failed and been dropped.
    const joined = async (job) => {
      await this.store.settled();
      if (this.store.jobs.get(job.id) !== job) throw Object.assign(new Error('job_store_unavailable'), { status: 503 });
      return publicJob(job);
    };
    const existing = findExisting();
    if (existing) return joined(existing);
    this.legacyGuard?.(credential, idempotencyKey, model);
    await this.requireHealthyStorage();
    // Idempotency is re-checked after the last await: everything from here to the insertion below is synchronous,
    // so concurrent identical requests that waited for storage join the job the first one admitted.
    const admitted = findExisting();
    if (admitted) return joined(admitted);
    const now = this.now();
    const job = { id: randomUUID(), ownershipVersion: ownershipVersion(credential), key, owner, model, bodyHash, status: "queued", createdAt: now, updatedAt: now };
    if (this.store.jobs.size >= 1000) throw Object.assign(new Error('job_capacity'), { status: 429 });
    if (this.stopped) throw Object.assign(new Error('job_service_stopped'), { status: 503 });
    if (this.cipher) {
      Object.assign(job, { durableQueue: true, queueState: 'waiting', stage: 'waiting' });
      job.sealed = this.cipher.seal({ payload, credential }, this.context(job));
      const bytes = [...this.store.jobs.values()].reduce((n, j) => n + (j.sealed?.data.length || 0), job.sealed.data.length);
      if (bytes > this.maxQueueBytes) throw Object.assign(new Error('queue_bytes_capacity'), { status: 429 });
      this.store.jobs.set(job.id, job);
      // Not durable means not admitted: forget it (nothing was submitted) and refuse.
      try { await this.persist({ required: true }); } catch (error) { this.store.jobs.delete(job.id); throw error; }
      this.schedule(); return publicJob(job);
    }
    this.limits.acquire(job.id, model);
    this.store.jobs.set(job.id, job);
    try { await this.persist({ required: true }); } catch (error) { this.store.jobs.delete(job.id); this.limits.release(job.id); throw error; }
    // Keep payload and credential process-local only; neither is persisted.
    this.track(job, () => this.run(job.id, credential, payload));
    return publicJob(job);
  }

  async get(jobId, credential, { resume = true } = {}) {
    await this.init();
    const job = this.store.jobs.get(jobId);
    if (!job || job.owner !== ownerHash(credential)) { const error = new Error("job not found"); error.status = 404; throw error; }
    if (resume && job.status === "recoverable" && job.providerJobId) {
      // GET must remain readable even when recovery slots are full.
      this.resume(job.id, credential).catch(() => {});
    }
    return publicJob(job);
  }

  async cancel(jobId, credential) {
    await this.init();
    const job = this.store.jobs.get(jobId);
    if (!job || job.owner !== ownerHash(credential)) { const error = new Error("job not found"); error.status = 404; throw error; }
    if (job.durableQueue && job.queueState === 'waiting' && job.status === 'queued' && !job.providerJobId) {
      // A cancel that is not durable could be replayed as a paid submit after restart: it must be saved or refused.
      job.queueState = 'canceled';
      try { await this.update(job, 'canceled', 'canceled', { required: true }); }
      catch (error) { job.queueState = 'waiting'; throw error; }
      return publicJob(job);
    }
    if (TERMINAL_JOB_STATUSES.has(job.status) || !job.providerJobId) throw Object.assign(new Error('not_cancelable'), { status: 409 });
    if (job.cancelRequested) return publicJob(job);
    job.cancelRequested = true;
    try { await this.provider.cancel(job.model, job.providerJobId, providerCredential(credential)); }
    catch {
      job.cancelRequested = false;
      if (!TERMINAL_JOB_STATUSES.has(job.status)) job.error = { code: 'cancel_unconfirmed', message: 'Cancellation was not confirmed; query the existing job.' };
      await this.persist(); return publicJob(job);
    }
    if (!TERMINAL_JOB_STATUSES.has(job.status)) { job.stage = 'cancel_requested'; job.updatedAt = this.now(); await this.persist(); }
    // A successful cancel HTTP response is a request acknowledgement, not a final state.
    return publicJob(job);
  }

  async resume(jobId, credential, { background = false } = {}) {
    await this.init();
    const job = this.store.jobs.get(jobId);
    if (!job || job.owner !== ownerHash(credential)) throw Object.assign(new Error('job not found'), { status: 404 });
    if (this.workers.has(job.id)) return background ? publicJob(job) : this.workers.get(job.id);
    if (!job.providerJobId || job.status !== 'recoverable') throw Object.assign(new Error('paid_resubmit_disabled'), { status: 409 });
    this.limits.acquire(job.id, job.model);
    this.recovery.delete(job.id);
    job.status = "running";
    job.stage = 'querying_provider'; job.error = null;
    job.updatedAt = this.now();
    // Query-only: unhealthy storage does not block it, it only stays unsaved until storage recovers.
    const work = this.track(job, async () => { await this.persist(); await this.poll(job, credential); });
    return background ? publicJob(job) : work;
  }

  track(job, operation) {
    const work = Promise.resolve().then(operation).catch(() => {
      this.stopped = true;
      if (!TERMINAL_JOB_STATUSES.has(job.status)) {
        // A known provider id always stays query-recoverable; only an unknown outcome is uncertain.
        if (job.providerJobId) { job.status = 'recoverable'; job.stage = 'recoverable'; }
        else { job.status = 'uncertain'; job.stage = 'uncertain'; job.finishedAt = this.now(); }
        job.error = { code: 'worker_failed', message: job.providerJobId ? 'Worker stopped; query the existing provider job.' : 'Task outcome cannot be confirmed.' };
      }
    }).finally(() => { this.workers.delete(job.id); this.limits.release(job.id); this.schedule(); });
    this.workers.set(job.id, work); return work;
  }

  async waitForIdle() {
    do { await new Promise(resolve => setImmediate(resolve)); await Promise.all([...this.workers.values()]); }
    while (this.workers.size || this.scheduled);
    await this.store.settled();
  }

  async update(job, status, stage = status, { required = false } = {}) {
    if (TERMINAL_JOB_STATUSES.has(job.status)) return;
    const previous = { status: job.status, stage: job.stage, updatedAt: job.updatedAt, finishedAt: job.finishedAt, sealed: job.sealed };
    job.status = status; job.stage = stage; job.updatedAt = this.now();
    if (TERMINAL_JOB_STATUSES.has(status)) { job.finishedAt = job.updatedAt; delete job.sealed; }
    try { await this.persist({ required }); }
    catch (error) {
      // A required transition that is not durable did not happen.
      Object.assign(job, previous);
      if (previous.finishedAt === undefined) delete job.finishedAt;
      if (previous.sealed === undefined) delete job.sealed;
      throw error;
    }
  }

  async run(jobId, credential, payload) {
    const job = this.store.jobs.get(jobId);
    if (!job || job.providerJobId || !(job.status === 'queued' || (job.durableQueue && job.queueState === 'submitting' && job.status === 'running'))) return;
    job.startedAt = this.now();
    // Durable jobs already saved their submission marker in dispatch(). A direct job is never replayed after a
    // restart, but it is still not submitted while storage is failing.
    try { await this.update(job, 'running', 'submitting', { required: !job.durableQueue }); }
    catch {
      job.error = { code: 'storage_unavailable', message: 'Local job storage is unavailable; nothing was submitted.' };
      job.status = 'failed'; job.stage = 'failed'; job.finishedAt = job.updatedAt = this.now();
      return publicJob(job);
    }
    let submitted;
    try {
      submitted = await this.provider.submit(job.model, payload, providerCredential(credential));
    } catch {
      // A submit transport error is ambiguous: do not issue a second paid submit.
      return this.fail(job, "submit_uncertain", "provider acceptance is uncertain");
    }
    if (!submitted || typeof submitted.request_id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(submitted.request_id)) {
      return this.fail(job, "submit_uncertain", "provider returned an invalid job id");
    }
    // From here on the provider job id is known: every path is query-only.
    job.providerJobId = submitted.request_id;
    job.status = "running"; job.stage = 'submitted';
    job.updatedAt = this.now();
    if (!(await this.persist())) {
      const journaled = await this.store.recordAccepted?.(job.id, job.providerJobId).then(() => true, () => false);
      job.error = journaled
        ? { code: 'persist_failed_after_accept', message: 'Provider accepted the task; the job list could not be saved, the provider id is journaled. Query the existing job; it will not be resubmitted.' }
        : { code: 'persist_failed_after_accept', durability: 'memory_only', message: 'Provider accepted the task, but nothing could be saved: the provider id exists only in this process and is lost if the relay restarts before storage recovers. Query the existing job now; it will not be resubmitted.' };
    }
    try { await this.poll(job, credential); }
    catch { await this.fail(job, 'poll_failed', 'provider polling failed'); }
  }

  async poll(job, credential) {
    let retries = 0;
    const deadline = this.now() + this.pollTimeoutMs;
    try {
      for (;;) {
        if (TERMINAL_JOB_STATUSES.has(job.status)) return;
        if (this.now() >= deadline) return this.fail(job, 'status_unavailable', 'Polling deadline reached; resume querying the same provider job.');
        let status;
        try {
          status = await this.provider.status(job.model, job.providerJobId, providerCredential(credential));
          retries = 0;
        } catch (error) {
          if (!retryable(error) || retries >= this.maxPollRetries) return this.fail(job, "status_unavailable", "provider status could not be confirmed");
          await this.sleep(this.pollDelayMs * 2 ** retries++);
          continue;
        }
        if (status?.status === "COMPLETED") {
          await this.update(job, 'running', 'collecting_result');
          let result;
          try { result = await this.provider.result(job.model, job.providerJobId, providerCredential(credential)); }
          catch (error) { return this.fail(job, retryable(error) ? "result_unavailable" : "result_failed", "provider result could not be retrieved"); }
          if (TERMINAL_JOB_STATUSES.has(job.status)) return;
          job.result = result; job.error = null; await this.update(job, 'succeeded'); return;
        }
        if (['CANCELED', 'CANCELLED'].includes(status?.status)) { job.error = null; await this.update(job, 'canceled'); return; }
        if (!["IN_QUEUE", "IN_PROGRESS"].includes(status?.status)) return this.fail(job, "provider_failed", "provider reported task failure");
        await this.update(job, status.status === 'IN_QUEUE' ? 'queued' : 'running', job.cancelRequested ? 'cancel_requested' : status.status === 'IN_QUEUE' ? 'provider_queue' : 'generating');
        await this.sleep(this.pollDelayMs);
      }
    } catch (error) {
      await this.fail(job, "poll_failed", "provider polling failed");
    }
  }

  async fail(job, code, message) {
    if (TERMINAL_JOB_STATUSES.has(job.status)) return publicJob(job);
    // A known provider id is never downgraded to "uncertain": it stays query-recoverable unless the provider
    // itself reported failure.
    const recover = !!job.providerJobId && code !== 'provider_failed';
    job.error = { code, message };
    await this.update(job, recover ? 'recoverable' : code === 'submit_uncertain' ? 'uncertain' : 'failed');
    return publicJob(job);
  }
}

/** Optional HTTP adapter. Existing /submit and /requests routes remain unchanged. */
export function createFalJobHandler({ service, origin, authenticate, allowLegacyBearer = false }) {
  const allowed = /^\/api\/providers\/fal\/jobs\/(flux-fill|esrgan|qwen-layered)(?:\/([A-Za-z0-9_-]{1,100}))?$/;
  return async (req, res) => {
    const [pathname, search = ''] = (req.url || '').split('?');
    const match = allowed.exec(pathname);
    if (!match) return false;
    const fail = (status, message) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message } })); };
    if (origin && (req.headers.host !== new URL(origin).host || (req.headers.origin !== undefined && req.headers.origin !== origin) || (req.method === 'POST' && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])))) { fail(403, "请求来源不允许"); return true; }
    const auth = req.headers.authorization || "";
    if (!/^Bearer [A-Za-z0-9._~+/:=-]{1,512}$/.test(auth)) { fail(401, "请在渠道中填写有效 API Key"); return true; }
    let credential;
    try {
      credential = await authenticateJob(req, auth.slice(7), { authenticate, allowLegacyBearer });
      if (!match[2] && req.method === 'GET') {
        const result = await service.list(credential, search, match[1]);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result)); return true;
      }
      if (search) throw Object.assign(new Error('invalid_query'), { status: 400 });
      if (!match[2] && req.method === "POST") {
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string") { fail(400, "缺少 Idempotency-Key"); return true; }
        const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 48 * 1024 * 1024) throw Object.assign(new Error('payload_too_large'), { status: 413 }); chunks.push(chunk); }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = await service.create({ model: match[1], idempotencyKey: key, credential, payload });
        res.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(result)); return true;
      }
      if (match[2] && req.method === "GET") {
        const result = await service.get(match[2], credential); res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(result)); return true;
      }
      if (match[2] && req.method === "POST" && (req.headers["x-job-action"] || "") === "cancel") {
        const result = await service.cancel(match[2], credential); res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(result)); return true;
      }
      if (match[2] && req.method === 'POST' && req.headers['x-job-action'] === 'retry') {
        await service.resume(match[2], credential, { background: true });
        const result = await service.get(match[2], credential, { resume: false });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result)); return true;
      }
      fail(405, "不支持的方法");
    } catch (error) { fail(error.status || 502, error.message || "任务服务不可用"); }
    return true;
  };
}

