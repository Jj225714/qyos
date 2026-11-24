import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FalJobService, JsonJobStore } from './job-service.mjs';

const credential = 'fake-fal-secret-only';
const key = Buffer.alloc(32, 23);
const input = (id) => ({ model: 'flux-fill', credential, idempotencyKey: id, payload: { prompt: 'private-test-prompt' } });
const until = async (fn) => { for (let i = 0; i < 500; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('condition timed out'); };
const exists = (path) => readFile(path, 'utf8').then(() => true, () => false);

async function dir(t) {
  const d = await mkdtemp(join(tmpdir(), 'fal-persist-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

/** Provider with a shared submit counter; status can be held open per instance. */
function provider(counter, { hold = false } = {}) {
  const gates = [];
  return {
    gates, statusIds: [],
    async submit() { counter.submits++; return { request_id: `p${counter.submits}` }; },
    async status(_model, id) { this.statusIds.push(id); if (hold) await new Promise(r => gates.push(r)); return { status: 'COMPLETED' }; },
    async result() { return { images: ['ok'] }; },
    async cancel() { return {}; },
  };
}

/** Breaks snapshot writes (only) while `broken.on` is set. */
function breakSnapshots(store, broken) {
  const flush = store.flush.bind(store);
  store.flush = async () => { if (broken.on) throw new Error('disk full (test)'); return flush(); };
}

test('JsonJobStore: a failed write does not poison later writes (real filesystem)', async (t) => {
  const d = await dir(t);
  await writeFile(join(d, 'sub'), 'not a directory');
  const store = new JsonJobStore(join(d, 'sub', 'jobs.json'));
  store.jobs.set('a', { id: 'a', status: 'queued' });
  await assert.rejects(store.flush());
  await rm(join(d, 'sub')); await mkdir(join(d, 'sub'));
  store.jobs.set('b', { id: 'b', status: 'queued' });
  await store.flush();
  const saved = JSON.parse(await readFile(join(d, 'sub', 'jobs.json'), 'utf8'));
  assert.deepEqual(saved.map(j => j.id), ['a', 'b']);
});

test('accepted then save fails: query-only recoverable, journaled, admission closed, recovery and restart without resubmit', async (t) => {
  const d = await dir(t); const path = join(d, 'jobs.json');
  const counter = { submits: 0 };
  const p = provider(counter, { hold: true });
  const store = new JsonJobStore(path); const broken = { on: false };
  breakSnapshots(store, broken);
  const s = new FalJobService({ store, provider: p, pollDelayMs: 1, persistRetryMs: 60_000 });
  const origSubmit = p.submit;
  p.submit = async (...args) => { const r = await origSubmit.apply(p, args); broken.on = true; return r; };
  const job = await s.create(input('accept'));
  await until(() => p.gates.length === 1);
  const view = await s.get(job.job_id, credential, { resume: false });
  assert.equal(view.provider_job_id, 'p1');
  assert.equal(view.error.code, 'persist_failed_after_accept');
  assert.equal(view.error.durability, undefined, 'journal write succeeded');
  assert.ok(!['uncertain', 'failed'].includes(view.status));
  assert.equal(s.storageHealthy, false);
  assert.deepEqual(p.statusIds, ['p1'], 'polling continues with the known id');
  const journal = await readFile(`${path}.accepted.jsonl`, 'utf8');
  assert.match(journal, /"providerJobId":"p1"/);
  assert.ok(!journal.includes(credential) && !journal.includes('private-test-prompt'));
  const onDisk = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(onDisk[0].providerJobId, undefined, 'snapshot never got the id');
  await assert.rejects(s.create(input('another')), { status: 503, message: 'job_store_unavailable' });
  assert.equal(counter.submits, 1);

  // Restart while snapshots still fail: the journal restores the id as query-only recovery.
  const p2 = provider(counter);
  const restarted = new FalJobService({ store: new JsonJobStore(path), provider: p2, pollDelayMs: 1 });
  const recovered = await restarted.get(job.job_id, credential, { resume: false });
  assert.equal(recovered.status, 'recoverable');
  assert.equal(recovered.provider_job_id, 'p1');
  await restarted.resume(job.job_id, credential);
  assert.deepEqual(p2.statusIds, ['p1']);
  assert.equal((await restarted.get(job.job_id, credential, { resume: false })).status, 'succeeded');
  assert.equal(counter.submits, 1);
  assert.equal(await exists(`${path}.accepted.jsonl`), false, 'journal compacted after a snapshot covering it');

  // Original process: storage recovers, the id is saved, the held poll completes.
  broken.on = false;
  assert.equal(await s.retryPersistence(), true);
  assert.equal(s.storageHealthy, true);
  p.gates.splice(0).forEach(r => r());
  await s.waitForIdle();
  assert.equal((await s.get(job.job_id, credential, { resume: false })).status, 'succeeded');
  assert.equal(counter.submits, 1);
});

test('restart after storage recovered: the saved id is queried, never resubmitted', async (t) => {
  const d = await dir(t); const path = join(d, 'jobs.json');
  const counter = { submits: 0 };
  const p = provider(counter, { hold: true });
  const store = new JsonJobStore(path); const broken = { on: false };
  breakSnapshots(store, broken);
  const s = new FalJobService({ store, provider: p, pollDelayMs: 1, persistRetryMs: 60_000 });
  const submit = p.submit; p.submit = async (...a) => { const r = await submit.apply(p, a); broken.on = true; return r; };
  const job = await s.create(input('recover'));
  await until(() => p.gates.length === 1);
  broken.on = false;
  assert.equal(await s.retryPersistence(), true);
  assert.equal(JSON.parse(await readFile(path, 'utf8'))[0].providerJobId, 'p1');
  assert.equal(await exists(`${path}.accepted.jsonl`), false);
  const p2 = provider(counter);
  const restarted = new FalJobService({ store: new JsonJobStore(path), provider: p2, pollDelayMs: 1 });
  assert.equal((await restarted.get(job.job_id, credential, { resume: false })).status, 'recoverable');
  await restarted.resume(job.job_id, credential);
  assert.equal((await restarted.get(job.job_id, credential, { resume: false })).status, 'succeeded');
  assert.deepEqual(p2.statusIds, ['p1']);
  assert.equal(counter.submits, 1);
  p.gates.splice(0).forEach(r => r());
});

test('snapshot and journal both fail: id kept in memory, new work refused, polling continues, restart limit reported', async (t) => {
  const d = await dir(t); const path = join(d, 'jobs.json');
  const counter = { submits: 0 };
  const p = provider(counter, { hold: true });
  const store = new JsonJobStore(path); const broken = { on: false };
  breakSnapshots(store, broken);
  store.recordAccepted = async () => { throw new Error('journal disk full (test)'); };
  const s = new FalJobService({ store, provider: p, pollDelayMs: 1, persistRetryMs: 60_000 });
  const submit = p.submit; p.submit = async (...a) => { const r = await submit.apply(p, a); broken.on = true; return r; };
  const job = await s.create(input('memory'));
  await until(() => p.gates.length === 1);
  const view = await s.get(job.job_id, credential, { resume: false });
  assert.equal(view.provider_job_id, 'p1');
  assert.equal(view.error.durability, 'memory_only');
  assert.match(view.error.message, /lost if the relay restarts/);
  await assert.rejects(s.create(input('more')), { status: 503 });
  p.gates.splice(0).forEach(r => r());
  await s.waitForIdle();
  assert.equal((await s.get(job.job_id, credential, { resume: false })).status, 'succeeded', 'query-only work finished in memory');
  // The documented limitation: a restart before storage recovers cannot know the id. It is uncertain, never resubmitted.
  const restarted = new FalJobService({ store: new JsonJobStore(path), provider: provider(counter), pollDelayMs: 1 });
  assert.equal((await restarted.get(job.job_id, credential, { resume: false })).status, 'uncertain');
  await assert.rejects(restarted.resume(job.job_id, credential), { status: 409 });
  assert.equal(counter.submits, 1);
});

test('durable queue: a submission marker that cannot be saved returns the job to waiting; recovery submits once', async (t) => {
  const d = await dir(t); const path = join(d, 'jobs.json');
  const counter = { submits: 0 };
  const store = new JsonJobStore(path); const broken = { on: false };
  breakSnapshots(store, broken);
  const s = new FalJobService({ store, provider: provider(counter), queueKey: key, pollDelayMs: 1, persistRetryMs: 60_000 });
  s.schedule = () => {};
  const job = await s.create(input('marker'));
  broken.on = true;
  delete s.schedule; s.schedule(); await s.waitForIdle();
  assert.equal(counter.submits, 0);
  const view = await s.get(job.job_id, credential, { resume: false });
  assert.equal(view.status, 'queued');
  assert.equal(s.store.jobs.get(job.job_id).queueState, 'waiting');
  assert.ok(s.store.jobs.get(job.job_id).sealed, 'payload still sealed for the later attempt');
  broken.on = false;
  assert.equal(await s.retryPersistence(), true);
  await s.waitForIdle();
  assert.equal((await s.get(job.job_id, credential, { resume: false })).status, 'succeeded');
  assert.equal(counter.submits, 1);
});

test('durable queue: accepted then save fails, restart from the journal recovers by querying only', async (t) => {
  const d = await dir(t); const path = join(d, 'jobs.json');
  const counter = { submits: 0 };
  const p = provider(counter, { hold: true });
  const store = new JsonJobStore(path); const broken = { on: false };
  breakSnapshots(store, broken);
  const s = new FalJobService({ store, provider: p, queueKey: key, pollDelayMs: 1, persistRetryMs: 60_000 });
  const submit = p.submit; p.submit = async (...a) => { const r = await submit.apply(p, a); broken.on = true; return r; };
  const job = await s.create(input('durable'));
  await until(() => p.gates.length === 1);
  const journal = await readFile(`${path}.accepted.jsonl`, 'utf8');
  assert.ok(!journal.includes('"providerJobId"'), 'with a queue key the journal entry is sealed');
  const p2 = provider(counter);
  const restarted = new FalJobService({ store: new JsonJobStore(path), provider: p2, queueKey: key, pollDelayMs: 1 });
  await restarted.init(); await restarted.waitForIdle();
  assert.deepEqual(p2.statusIds, ['p1']);
  assert.equal((await restarted.get(job.job_id, credential, { resume: false })).status, 'succeeded');
  assert.equal(counter.submits, 1);
  p.gates.splice(0).forEach(r => r());
});

test('journal append racing a snapshot: only entries covered by a completed snapshot are removed', async (t) => {
  const d = await dir(t); const path = join(d, 'jobs.json');
  const store = new JsonJobStore(path); await store.load();
  const id = '11111111-2222-4333-8444-555555555555';
  store.jobs.set(id, { id, status: 'running' });
  const before = store.flush();                 // snapshot taken without the id
  store.jobs.get(id).providerJobId = 'p9';
  const append = store.recordAccepted(id, 'p9'); // queued behind that snapshot
  await Promise.all([before, append]);
  assert.match(await readFile(`${path}.accepted.jsonl`, 'utf8'), /p9/, 'not covered by the earlier snapshot, kept');
  await store.flush();                           // snapshot containing the id
  assert.equal(await exists(`${path}.accepted.jsonl`), false);
  // Reverse order: append first, then a snapshot that still lacks the id must keep the entry.
  const other = '66666666-7777-4888-9999-000000000000';
  store.jobs.set(other, { id: other, status: 'running' });
  await store.recordAccepted(other, 'p10');
  await store.flush();
  assert.match(await readFile(`${path}.accepted.jsonl`, 'utf8'), /p10/);
});

test('journal: tampered, unsealed, oversized, unknown-job and conflicting entries are never applied', async (t) => {
  const d = await dir(t); const path = join(d, 'jobs.json');
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', c = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const owner = 'x';
  await writeFile(path, JSON.stringify([
    { id: a, status: 'running', owner, key: 'k-a', model: 'flux-fill' },
    { id: b, status: 'running', owner, key: 'k-b', model: 'flux-fill', providerJobId: 'p-original' },
    { id: c, status: 'running', owner, key: 'k-c', model: 'flux-fill' },
  ]));
  // A genuine sealed entry for c, written through the real store.
  const writer = new JsonJobStore(path); new FalJobService({ store: writer, provider: {}, queueKey: key });
  await writer.recordAccepted(c, 'p-genuine');
  const genuine = (await readFile(`${path}.accepted.jsonl`, 'utf8')).trim();
  const sealed = JSON.parse(genuine);
  const tampered = { ...sealed, jobId: a };       // replayed onto another job: context mismatch
  const lines = [
    JSON.stringify({ v: 1, jobId: a, providerJobId: 'p-forged' }),          // unsealed while a key is configured
    JSON.stringify(tampered),
    JSON.stringify({ v: 1, jobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sealed: sealed.sealed }),
    JSON.stringify({ v: 1, jobId: a, sealed: { ...sealed.sealed, data: Buffer.from('x').toString('base64') } }),
    'x'.repeat(5000),
    'not json',
  ];
  await appendFile(`${path}.accepted.jsonl`, lines.join('\n') + '\n');
  // Conflict: a sealed entry for b that names another provider id.
  await writer.recordAccepted(b, 'p-conflict');
  const s = new FalJobService({ store: new JsonJobStore(path), provider: {}, queueKey: key });
  await s.init();
  const jobs = s.store.jobs;
  assert.equal(jobs.get(a).providerJobId, undefined);
  assert.equal(jobs.get(a).status, 'uncertain');
  assert.equal(jobs.get(b).providerJobId, 'p-original');
  assert.equal(jobs.get(b).journalConflict, true);
  assert.equal(jobs.get(c).providerJobId, 'p-genuine');
  assert.equal(jobs.get(c).status, 'recoverable');
  // Rejected lines are kept for inspection; the covered genuine entry is gone after the startup snapshot.
  const remaining = await readFile(`${path}.accepted.jsonl`, 'utf8');
  assert.ok(remaining.includes('p-forged'));
  assert.ok(!remaining.includes(genuine));
});

for (const queueKey of [null, key]) {
  test(`concurrent identical creates admit exactly one paid job (${queueKey ? 'durable' : 'direct'})`, async (t) => {
    const d = await dir(t); const path = join(d, 'jobs.json');
    const counter = { submits: 0 };
    const s = new FalJobService({ store: new JsonJobStore(path), provider: provider(counter), queueKey, maxActive: 10, pollDelayMs: 1 });
    await s.init();
    const results = await Promise.all(Array.from({ length: 5 }, () => s.create({ model: 'flux-fill', idempotencyKey: 'same', credential: 'mock-test-key', payload: { image_url: 'fake' } })));
    await s.waitForIdle();
    assert.equal(new Set(results.map(r => r.job_id)).size, 1);
    assert.equal(counter.submits, 1);
    assert.equal(s.store.jobs.size, 1);
    // Default limits: the joiners must not fail with job_capacity either.
    const counter2 = { submits: 0 };
    const s2 = new FalJobService({ store: new JsonJobStore(join(d, 'jobs2.json')), provider: provider(counter2), queueKey, pollDelayMs: 1 });
    await s2.init();
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => s2.create({ model: 'flux-fill', idempotencyKey: 'same', credential: 'mock-test-key', payload: { image_url: 'fake' } })));
    assert.ok(settled.every(r => r.status === 'fulfilled'), JSON.stringify(settled.filter(r => r.status === 'rejected').map(r => r.reason.message)));
    await s2.waitForIdle();
    assert.equal(counter2.submits, 1);
  });
}

test('concurrent creates with the same key but different input: one admitted, the others 409, one submit', async (t) => {
  const d = await dir(t);
  const counter = { submits: 0 };
  const s = new FalJobService({ store: new JsonJobStore(join(d, 'jobs.json')), provider: provider(counter), maxActive: 10, pollDelayMs: 1 });
  await s.init();
  const settled = await Promise.allSettled([1, 2, 3].map(n => s.create({ model: 'flux-fill', idempotencyKey: 'same', credential: 'mock-test-key', payload: { n } })));
  await s.waitForIdle();
  assert.equal(settled.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(settled.filter(r => r.status === 'rejected').every(r => r.reason.status === 409));
  assert.equal(counter.submits, 1);
  assert.equal(s.store.jobs.size, 1);
});

test('two authenticated journal entries with different ids quarantine the job: nothing queried or submitted', async (t) => {
  const d = await dir(t); const path = join(d, 'jobs.json');
  const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  await writeFile(path, JSON.stringify([{ id, status: 'running', owner: 'x', key: 'k', model: 'flux-fill' }]));
  const writer = new JsonJobStore(path); new FalJobService({ store: writer, provider: {}, queueKey: key });
  await writer.recordAccepted(id, 'p-one');
  await writer.recordAccepted(id, 'p-two');
  const counter = { submits: 0 }; const p = provider(counter);
  const s = new FalJobService({ store: new JsonJobStore(path), provider: p, queueKey: key, pollDelayMs: 1 });
  await s.init(); await s.waitForIdle();
  const job = s.store.jobs.get(id);
  assert.equal(job.providerJobId, undefined);
  assert.equal(job.status, 'uncertain');
  assert.equal(job.error.code, 'journal_conflict');
  await assert.rejects(s.resume(id, 'whatever'), { status: 404 });
  assert.deepEqual(p.statusIds, []); assert.equal(counter.submits, 0);
  const journal = await readFile(`${path}.accepted.jsonl`, 'utf8');
  assert.equal(journal.trim().split('\n').length, 2, 'both entries kept for inspection');
});

test('a durable waiting job with a journaled id is never dispatched again; it recovers by query only', async (t) => {
  const d = await dir(t); const path = join(d, 'jobs.json');
  const counter = { submits: 0 };
  const first = new FalJobService({ store: new JsonJobStore(path), provider: provider(counter), queueKey: key, pollDelayMs: 1 });
  first.schedule = () => {};
  const job = await first.create(input('waiting-journal'));
  await first.store.recordAccepted(job.job_id, 'p-journal');
  const p2 = provider(counter);
  const restarted = new FalJobService({ store: new JsonJobStore(path), provider: p2, queueKey: key, pollDelayMs: 1 });
  await restarted.init(); await restarted.waitForIdle();
  assert.equal(counter.submits, 0);
  assert.deepEqual(p2.statusIds, ['p-journal']);
  assert.equal((await restarted.get(job.job_id, credential, { resume: false })).status, 'succeeded');
});

test('an oversized journal is read only up to its bound and never compacted', async (t) => {
  const d = await dir(t); const path = join(d, 'jobs.json');
  const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  await writeFile(path, JSON.stringify([{ id, status: 'running', owner: 'x', key: 'k', model: 'flux-fill' }]));
  const filler = `${'#'.repeat(1000)}\n`.repeat(1100);
  await writeFile(`${path}.accepted.jsonl`, filler + JSON.stringify({ v: 1, jobId: id, providerJobId: 'p-late' }) + '\n');
  const store = new JsonJobStore(path); await store.load();
  assert.equal(store.journalTruncated, true);
  assert.equal(store.jobs.get(id).providerJobId, undefined);
  assert.equal(store.jobs.get(id).status, 'uncertain');
  assert.match(await readFile(`${path}.accepted.jsonl`, 'utf8'), /p-late/, 'entry beyond the bound is not erased');
});
