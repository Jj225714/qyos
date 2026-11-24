import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

export const CHAT_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,127}$/;
const ID = /^[a-z0-9-]{1,80}$/;
const endpoint = new Set(['/status', '/probe', '/allow', '/commit', '/revert']);
const hour = 60 * 60_000;
const grace = 7 * 24 * hour;
const maxState = 8192;
const token = value => typeof value === 'string' && ID.test(value);
const modelId = value => typeof value === 'string' && CHAT_MODEL.test(value);
const instant = value => Number.isSafeInteger(value) && value > 0;
const shape = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k));
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const unavailable = () => fail(503, 'MODEL_CONTROL_UNAVAILABLE');

function validate(state) {
    if (!shape(state, ['version', 'model', 'revision', 'previous', 'pending', 'last']) ||
        state.version !== 1 || !modelId(state.model) || !token(state.revision)) throw unavailable();
    if (state.previous !== null && (!shape(state.previous, ['model', 'until']) || !modelId(state.previous.model) ||
        state.previous.model === state.model || !instant(state.previous.until))) throw unavailable();
    if (state.pending !== null && (!shape(state.pending, ['model', 'probeId', 'transitionId']) ||
        !modelId(state.pending.model) || !token(state.pending.probeId) || !token(state.pending.transitionId))) throw unavailable();
    if (state.last !== null && (!shape(state.last, ['decision', 'transitionId']) ||
        !['commit', 'revert'].includes(state.last.decision) || !token(state.last.transitionId) ||
        state.last.transitionId === state.pending?.transitionId)) throw unavailable();
    return state;
}

async function readState(path, fallback) {
    let fd;
    try {
        // lstat distinguishes a missing file from dangling links, including on Windows.
        const entry = await lstat(path);
        if (!entry.isFile()) throw unavailable();
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return { version: 1, model: fallback, revision: `initial-${randomUUID()}`, previous: null, pending: null, last: null };
    }
    try {
        fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        const info = await fd.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > maxState ||
            (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid()))) throw unavailable();
        const buffer = Buffer.alloc(maxState + 1);
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
        if (bytesRead > maxState) throw unavailable();
        return validate(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
    } finally { await fd?.close(); }
}

async function persist(path, state, onIndeterminate) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let renamed = false, created = false;
    try {
        const fd = await open(temporary, 'wx', 0o600);
        created = true;
        try { await fd.writeFile(`${JSON.stringify(validate(state))}\n`); await fd.sync(); }
        finally { await fd.close(); }
        await rename(temporary, path);
        renamed = true;
        if (process.platform !== 'win32') {
            const directory = await open(dirname(path), 'r');
            try { await directory.sync(); } finally { await directory.close(); }
        }
    } catch {
        // A rename followed by a failed directory sync has an uncertain durable outcome.
        // Stop serving the pilot rather than publish conflicting state. Restart to reconcile.
        if (renamed) onIndeterminate();
        throw unavailable();
    } finally {
        if (created && !renamed) await unlink(temporary).catch(() => {});
    }
}

export async function createChatModelControl({ stateFile, initialModel, probeGateway, clock = Date.now }) {
    if (!isAbsolute(stateFile) || !modelId(initialModel) || typeof probeGateway !== 'function') throw unavailable();
    let state = await readState(stateFile, initialModel).catch(() => null);
    let tail = Promise.resolve();
    let probing = false;
    let tries = [];
    const tickets = new Map();
    function requireState() { if (!state) throw unavailable(); return state; }
    function status() {
        const { model, revision, pending } = requireState();
        return pending ? { model, revision, pending: { model: pending.model, transitionId: pending.transitionId } } : { model, revision };
    }
    function checkRevision(revision) {
        if (requireState().revision !== revision) throw fail(409, 'MODEL_REVISION_CONFLICT');
    }
    function checkPending() {
        if (requireState().pending) throw fail(409, 'MODEL_TRANSITION_PENDING');
    }
    async function save(next) {
        await persist(stateFile, next, () => { state = null; });
        state = next;
    }
    function write(work) {
        const result = tail.then(work);
        tail = result.catch(() => {});
        return result;
    }
    function prune(now) {
        for (const [id, ticket] of tickets) if (ticket.until <= now) tickets.delete(id);
    }
    async function probe({ model, revision }) {
        checkRevision(revision);
        checkPending();
        const now = clock();
        tries = tries.filter(started => now - started < hour);
        if (probing || tries.length >= 5) throw fail(429, 'MODEL_PROBE_RATE_LIMITED');
        tries.push(now);
        probing = true;
        try {
            const signal = AbortSignal.timeout(30_000);
            try { await probeGateway(model, signal); signal.throwIfAborted(); }
            catch { throw fail(signal.aborted ? 504 : 502, 'MODEL_PROBE_FAILED'); }
            checkRevision(revision);
            checkPending();
            const probeId = randomUUID();
            prune(clock());
            tickets.set(probeId, { model, revision, until: clock() + 10 * 60_000 });
            return { model, revision, probeId };
        } finally { probing = false; }
    }
    function allow({ model, revision, probeId }) {
        return write(async () => {
            checkRevision(revision);
            const pending = state.pending;
            if (pending?.probeId === probeId && pending.model === model) return { ...status(), transitionId: pending.transitionId };
            checkPending();
            prune(clock());
            const ticket = tickets.get(probeId);
            if (ticket?.model !== model || ticket.revision !== revision) throw fail(409, 'MODEL_PROBE_REQUIRED');
            const transitionId = randomUUID();
            await save({ ...state, pending: { model, probeId, transitionId } });
            tickets.delete(probeId);
            return { ...status(), transitionId };
        });
    }
    function resolve(decision, { transitionId }) {
        return write(async () => {
            const current = requireState();
            if (!current.pending && current.last?.transitionId === transitionId && current.last.decision === decision) return status();
            if (current.pending?.transitionId !== transitionId) throw fail(409, 'MODEL_TRANSITION_CONFLICT');
            const model = decision === 'commit' ? current.pending.model : current.model;
            await save({ ...current, model, revision: randomUUID(), pending: null,
                previous: model === current.model ? current.previous : { model: current.model, until: clock() + grace },
                last: { transitionId, decision } });
            tickets.clear();
            return status();
        });
    }
    function allowsModel(model) {
        const current = requireState();
        return modelId(model) && (model === current.model || model === current.pending?.model ||
            (model === current.previous?.model && current.previous.until > clock()));
    }
    async function handler(req, res) {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        try {
            if (!endpoint.has(req.url)) throw fail(404, 'MODEL_NOT_FOUND');
            if (req.method !== 'POST') {
                res.setHeader('allow', 'POST');
                throw fail(405, 'MODEL_METHOD_NOT_ALLOWED');
            }
            const bad = () => fail(400, 'MODEL_BAD_INPUT');
            if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw bad();
            let bytes = 0;
            const parts = [];
            // Keep an oversized request from consuming memory. The socket is local and timeout-limited.
            for await (const part of req.iterator({ destroyOnReturn: false })) {
                bytes += part.length;
                if (bytes > 4096) { res.setHeader('connection', 'close'); throw bad(); }
                parts.push(part);
            }
            let input;
            try { input = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw bad(); }
            const route = req.url.slice(1);
            const fields = route === 'status' ? [] : route === 'probe' ? ['model', 'revision'] :
                route === 'allow' ? ['model', 'revision', 'probeId'] : ['transitionId'];
            if (!shape(input, fields) || fields.some(field => !(field === 'model' ? modelId(input[field]) : token(input[field])))) throw bad();
            const result = route === 'status' ? status() : route === 'probe' ? await probe(input) :
                route === 'allow' ? await allow(input) : await resolve(route, input);
            res.end(JSON.stringify(result));
        } catch (error) {
            const known = Number.isInteger(error?.status) && /^MODEL_[A-Z_]+$/.test(error.code);
            res.statusCode = known ? error.status : 503;
            res.end(JSON.stringify({ code: known ? error.code : 'MODEL_CONTROL_UNAVAILABLE' }));
        }
    }
    return { handler, allowsModel };
}

// An explicitly named systemd-inherited Unix descriptor is the only supported listener.
export function chatModelSocketFd(env = process.env, pid = process.pid) {
    if (env.LISTEN_PID !== String(pid) || !/^\d{1,3}$/.test(env.LISTEN_FDS || '')) return null;
    const names = (env.LISTEN_FDNAMES || '').split(':');
    if (names.length !== Number(env.LISTEN_FDS)) return null;
    const index = names.indexOf('qyos-chat-model-control');
    return index >= 0 && index === names.lastIndexOf('qyos-chat-model-control') ? 3 + index : null;
}
