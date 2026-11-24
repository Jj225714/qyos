import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const validImageModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$/.test(value);
const isRevision = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const hasFields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const error = (status, code, retryAfterSeconds) => Object.assign(new Error(code), { status, code, retryAfterSeconds });
const unavailable = () => error(503, 'MODEL_CONTROL_UNAVAILABLE');
const badInput = () => error(400, 'MODEL_BAD_INPUT');
const TTL = 10 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** fsync the new bytes, perform the final atomic commit, and sync the owning directory. */
export async function writeImageModelOverride(path, encrypted, reportDirectorySyncFailure = () => {}) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const directory = process.platform === 'win32' ? null : await open(dirname(path), 'r');
    try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(encrypted); await file.sync(); } finally { await file.close(); }
        await rename(temporary, path);
        // Rename already committed and other processes can see it. Never report a rollback after this point.
        await directory?.sync().catch(() => reportDirectorySyncFailure());
    } finally {
        await directory?.close().catch(() => {});
        await unlink(temporary).catch(() => {});
    }
}

export async function createImageModelControl({ defaultModel, routeEpoch, getRouteEpoch, load, save, probe, now = Date.now }) {
    if (!validImageModel(defaultModel) || typeof routeEpoch !== 'string' || !routeEpoch || [load, save, probe].some(fn => typeof fn !== 'function')) throw new Error('Invalid Image model control dependency');
    let state = null, ready = true, writing = false, probing = false, attempts = [];
    const tickets = new Map();
    try {
        const stored = await load();
        if (stored !== null && (!(hasFields(stored, ['schema', 'id', 'model', 'previousModel']) || (hasFields(stored, ['schema', 'id', 'model', 'previousModel', 'verifiedEpoch']) && isRevision(stored.verifiedEpoch))) || stored.schema !== 1 || typeof stored.id !== 'string' || !uuid.test(stored.id) || !validImageModel(stored.model) || !(stored.previousModel === null || (validImageModel(stored.previousModel) && stored.previousModel !== stored.model)))) throw unavailable();
        state = stored;
    } catch { ready = false; }
    const currentModel = () => {
        if (!ready) throw unavailable();
        return state?.model ?? defaultModel;
    };
    const status = (epoch = routeEpoch) => ({
        model: currentModel(),
        revision: createHash('sha256').update(`${epoch}:${state?.id ?? 'bootstrap'}`).digest('hex'),
        canRollback: !getRouteEpoch && Boolean(state?.previousModel),
        ...(getRouteEpoch ? { routeVerified: state?.verifiedEpoch === epoch } : {}),
    });
    const assertRevision = (revision, epoch) => {
        if (status(epoch).revision !== revision) throw error(409, 'MODEL_REVISION_CONFLICT');
    };
    async function runProbe({ model, revision }, epoch) {
        assertRevision(revision, epoch);
        const start = now();
        attempts = attempts.filter(at => start - at < HOUR);
        for (const [id, ticket] of tickets) if (ticket.expiresAt <= start) tickets.delete(id);
        if (probing) throw error(409, 'MODEL_PROBE_IN_PROGRESS');
        if (attempts.length >= 5) throw error(429, 'MODEL_PROBE_RATE_LIMITED', Math.ceil((attempts[0] + HOUR - start) / 1000));
        probing = true;
        attempts.push(start);
        try {
            try { await probe(model, epoch); }
            catch (err) {
                if (err?.status === 429) throw error(429, 'MODEL_UPSTREAM_RATE_LIMITED', err.retryAfterSeconds);
                if (err?.status === 409) throw error(409, 'MODEL_REVISION_CONFLICT');
                throw err?.status === 503 ? unavailable() : error(err?.status === 504 ? 504 : 502, 'MODEL_PROBE_FAILED');
            }
            assertRevision(revision, getRouteEpoch ? await getRouteEpoch() : epoch);
            const probeId = randomUUID();
            tickets.set(probeId, { model, revision, expiresAt: now() + TTL });
            return { model, revision, probeId };
        } finally { probing = false; }
    }
    async function mutate(input, rollback, epoch) {
        assertRevision(input.revision, epoch);
        if (writing) throw error(409, 'MODEL_REVISION_CONFLICT');
        if (!rollback) {
            const ticket = tickets.get(input.probeId);
            if (!ticket || ticket.expiresAt <= now() || ticket.model !== input.model || ticket.revision !== input.revision) throw error(409, 'MODEL_PROBE_REQUIRED');
            tickets.delete(input.probeId);
            if (input.model === currentModel() && (!getRouteEpoch || status(epoch).routeVerified)) return status(epoch);
        } else if (getRouteEpoch || !state?.previousModel) throw error(409, 'MODEL_NO_ROLLBACK');
        writing = true;
        try {
            const before = currentModel();
            const next = { schema: 1, id: randomUUID(), model: rollback ? state.previousModel : input.model, previousModel: rollback ? null : input.model === before ? state?.previousModel ?? null : before, ...(getRouteEpoch ? { verifiedEpoch: epoch } : {}) };
            try { await save(next); } catch { throw unavailable(); }
            state = next;
            tickets.clear();
            return status(epoch);
        } finally { writing = false; }
    }
    const dispatchAt = (path, input, epoch) => {
        if (path === '/status' && hasFields(input, [])) return status(epoch);
        if (path === '/probe' && hasFields(input, ['model', 'revision']) && validImageModel(input.model) && isRevision(input.revision)) return runProbe(input, epoch);
        if (path === '/commit' && hasFields(input, ['model', 'revision', 'probeId']) && validImageModel(input.model) && isRevision(input.revision) && typeof input.probeId === 'string' && uuid.test(input.probeId)) return mutate(input, false, epoch);
        if (path === '/rollback' && hasFields(input, ['revision']) && isRevision(input.revision)) return mutate(input, true, epoch);
        if (['/status', '/probe', '/commit', '/rollback'].includes(path)) throw badInput();
        throw error(404, 'MODEL_NOT_FOUND');
    };
    const dispatch = (path, input) => getRouteEpoch ? getRouteEpoch().then(epoch => dispatchAt(path, input, epoch)) : dispatchAt(path, input, routeEpoch);
    return { currentModel, dispatch, verified: epoch => !getRouteEpoch || status(epoch).routeVerified === true };
}

/** Private HTTP handler. Bind only the inherited Unix socket, never the public Vault listener. */
export function imageModelHttpHandler(control) {
    return async (req, res) => {
        const send = (status, value) => {
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
            res.end(JSON.stringify(value));
        };
        try {
            if (req.method !== 'POST') throw error(405, 'MODEL_METHOD_NOT_ALLOWED');
            // A length-bounded request (no streaming) from a trusted local HTTP client only.
            const length = Number(req.headers['content-length']);
            if (req.headers.origin || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') || !Number.isInteger(length) || length < 2 || length > 2048 || req.headers['transfer-encoding']) throw badInput();
            const chunks = [];
            let bytes = 0;
            for await (const chunk of req) {
                bytes += chunk.length;
                if (bytes > length) throw badInput();
                chunks.push(chunk);
            }
            if (bytes !== length) throw badInput();
            let input;
            try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw badInput(); }
            if (!control) throw unavailable();
            send(200, await control.dispatch(req.url, input));
        } catch (err) {
            const known = Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599 && typeof err.code === 'string' && /^MODEL_[A-Z_]+$/.test(err.code);
            const body = { code: known ? err.code : 'MODEL_CONTROL_UNAVAILABLE' };
            if (known && err.status === 429 && Number.isInteger(err.retryAfterSeconds) && err.retryAfterSeconds >= 1 && err.retryAfterSeconds <= 3600) body.retryAfterSeconds = err.retryAfterSeconds;
            if (!res.destroyed && !res.writableEnded) send(known ? err.status : 503, body);
        }
    };
}

/** systemd supplies one named descriptor, starting at fd 3. No socket is opened when disabled. */
export function imageModelSocketFd(env = process.env, pid = process.pid, platform = process.platform) {
    if (platform !== 'linux' || env.LISTEN_PID !== String(pid)) return null;
    if (env.LISTEN_FDS !== '1' || env.LISTEN_FDNAMES !== 'qyos-image-model-control') throw new Error('Invalid Image model socket activation');
    return 3;
}
