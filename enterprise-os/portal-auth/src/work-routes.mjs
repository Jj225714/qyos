/**
 * Authenticated /portal/work/* adapter. Maps a FIXED set of employee resource paths onto one call,
 * POST /employee, on the work-calendar service's private Unix socket. It is not a URL proxy: no browser
 * headers, cookies, credentials or URLs are forwarded, and the subject comes only from the checked portal
 * session. Socket peer-UID / permission enforcement belongs to the Python service (not verifiable here).
 */
import { request } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const WORK_PREFIX = '/portal/work';
export const WORK_SOCKET = '/run/qyos-work-calendar/employee.sock'; // code-owned; never configurable
export const WORK_CONTEXT_HEADER = 'x-qyos-work-context';
// Byte budgets shared with work_core.py (EMPLOYEE_BODY_MAX_BYTES / ENVELOPE_MAX_BYTES / RESPONSE_MAX_BYTES).
export const MAX_WORK_BODY = 64 * 1024; // report: 10000 code points x 4 UTF-8 bytes + JSON keys fits with margin
export const MAX_WORK_ENVELOPE = 128 * 1024; // re-serialized portal->service envelope (body + subject/path)
export const MAX_WORK_RESULT = 8 * 1024 * 1024; // worst legal overview (500+500 items, 4-byte text) < 5 MB
export const WORK_DEADLINE_MS = 5000;
const TASK_DRAFT_DEADLINE_MS = 18000;
export const FRESH_CHECK_MS = 4000;

const MAX_QUERY = 256;
const MAX_SUBJECT = 256;
const CONTEXT_SHAPE = /^[A-Za-z0-9_-]{32}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_ONLY = new RegExp(`^${UUID}$`);
const DATE = '\\d{4}-\\d{2}-\\d{2}';
const route = (pattern, methods) => ({ re: new RegExp(`^${pattern}$`), methods });
/** Exact employee resource families (no trailing slash, no admin realm). The Python service stays authoritative. */
const ROUTES = [
    route('/bootstrap', ['GET']),
    route('/todo-summary', ['GET']),
    route('/task-draft', ['POST']),
    route('/lists', ['GET', 'POST']),
    route(`/lists/${UUID}`, ['GET', 'PATCH', 'DELETE']),
    route('/tasks', ['GET', 'POST']),
    route(`/tasks/${UUID}`, ['GET', 'PATCH', 'DELETE']),
    route(`/tasks/${UUID}/(?:complete|undo)`, ['POST']),
    route(`/tasks/${UUID}/subtasks/${UUID}`, ['POST']),
    route('/assignments', ['GET']),
    route(`/assignments/${UUID}`, ['GET']),
    route(`/assignments/${UUID}/(?:complete|undo)`, ['POST']),
    route(`/assignments/${UUID}/subtasks/${UUID}`, ['POST']),
    route(`/reports/(${DATE})`, ['GET', 'PATCH']),
    route(`/reports/(${DATE})/(?:prefill|submit)`, ['POST']),
];
const QUERY_ORDER = ['from', 'to', 'listId', 'unscheduled'];
const QUERY_KEYS = { from: v => validDate(v), to: v => validDate(v), listId: v => UUID_ONLY.test(v), unscheduled: v => v === 'true' || v === 'false' };
const PASS_STATUSES = new Set([200, 201, 204, 400, 403, 404, 409, 422]);
const DEFAULT_ERROR = { 400: 'invalid', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 422: 'invalid' };
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Identity/authority fields the browser may never supply, compared case/punctuation-insensitively, at any depth. */
const FORBIDDEN_KEYS = new Set(['subject', 'sub', 'organization', 'organisation', 'organizationid', 'org', 'orgid', 'role', 'roles',
    'actor', 'actorid', 'user', 'userid', 'uid', 'owner', 'ownerid', 'casdoorid', 'employeeid', 'assignee', 'assigneeid',
    'createdby', 'updatedby', 'tenant', 'tenantid', 'realm', 'admin', 'isadmin']);
const SINGLE_HEADERS = ['origin', 'sec-fetch-site', 'content-type', 'content-length', 'transfer-encoding', WORK_CONTEXT_HEADER];

class Refusal extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

const normKey = key => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const mediaType = value => String(value ?? '').split(';')[0].trim().toLowerCase();
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeCode = error => (typeof error?.code === 'string' ? error.code.slice(0, 40) : 'error');
const headerCount = (req, name) => { let n = 0; for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) n++; return n; };

function validDate(text) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    const [y, m, d] = text.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return y >= 2000 && y <= 2100 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Per-session, NON-authenticating anti-stale token (never the session cookie; carries no identity). */
export function ensureWorkContext(record) {
    if (typeof record.workContext !== 'string' || !CONTEXT_SHAPE.test(record.workContext)) record.workContext = randomBytes(24).toString('base64url');
    return record.workContext;
}
const sameContext = (given, expected) => typeof given === 'string' && CONTEXT_SHAPE.test(given) && timingSafeEqual(Buffer.from(given), Buffer.from(expected));

/** Raw request target (not URL-normalized): exact prefix, no fragment; returns the resource path and raw query. */
function parseTarget(rawUrl) {
    const raw = String(rawUrl);
    if (raw.includes('#') || !raw.startsWith(`${WORK_PREFIX}/`)) return null;
    const q = raw.indexOf('?');
    return { resource: (q < 0 ? raw : raw.slice(0, q)).slice(WORK_PREFIX.length), query: q < 0 ? null : raw.slice(q + 1) };
}

function matchRoute(resource) {
    for (const entry of ROUTES) {
        const m = entry.re.exec(resource);
        if (m) return m[1] === undefined || validDate(m[1]) ? entry : null;
    }
    return null;
}

/** Strict read query: known keys once each, raw (un-encoded) values of a fixed shape; canonical order. */
function canonicalQuery(raw) {
    if (raw.length === 0 || raw.length > MAX_QUERY) return null;
    const seen = new Map();
    for (const part of raw.split('&')) {
        const eq = part.indexOf('=');
        if (eq <= 0) return null;
        const key = part.slice(0, eq);
        const value = part.slice(eq + 1);
        if (!Object.hasOwn(QUERY_KEYS, key) || seen.has(key) || !QUERY_KEYS[key](value)) return null;
        seen.set(key, key === 'listId' ? value.toLowerCase() : value);
    }
    return QUERY_ORDER.filter(key => seen.has(key)).map(key => `${key}=${seen.get(key)}`).join('&');
}

/** Plain JSON data only, bounded depth/size; optional key screen. Throws `refusal` (or forbidden_field). */
function inspectData(value, { maxDepth, maxNodes, screenKeys = false }, refusal) {
    let nodes = 0;
    const walk = (item, depth) => {
        if (++nodes > maxNodes || depth > maxDepth) throw refusal;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
        if (typeof item === 'number') { if (!Number.isFinite(item)) throw refusal; return; }
        if (Array.isArray(item)) { for (const entry of item) walk(entry, depth + 1); return; }
        if (!isPlainObject(item)) throw refusal;
        for (const [key, entry] of Object.entries(item)) {
            if (UNSAFE_KEYS.has(key) || (screenKeys && FORBIDDEN_KEYS.has(normKey(key)))) throw screenKeys ? new Refusal(400, 'forbidden_field') : refusal;
            walk(entry, depth + 1);
        }
    };
    walk(value, 0);
}

/** Validates the service reply {status, body}; error bodies are reduced to a whitelisted code (no internals). */
export function parseReply(raw, { taskDraft = false } = {}) {
    const bad = Object.assign(new Error('bad_reply'), { code: 'bad_reply' });
    if (!raw || raw.status !== 200 || mediaType(raw.contentType) !== 'application/json' || !Buffer.isBuffer(raw.bytes) || raw.bytes.length > MAX_WORK_RESULT) throw bad;
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes)); } catch { throw bad; }
    if (!isPlainObject(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'status') || !Object.hasOwn(value, 'body')) throw bad;
    const { status, body } = value;
    if (!PASS_STATUSES.has(status)) {
        if (!taskDraft || !((status === 503 && body?.error === 'work_ai_unavailable')
                || (status === 429 && body?.error === 'work_ai_busy'))) throw bad;
        return { status, body: { error: body.error } };
    }
    inspectData(body, { maxDepth: 32, maxNodes: 200000 }, bad);
    if (status === 204) { if (body !== null) throw bad; return { status, body: null }; }
    if (status >= 400) return { status, body: { error: typeof body?.error === 'string' && ERROR_CODE.test(body.error) ? body.error : DEFAULT_ERROR[status] } };
    if (body === null || typeof body !== 'object') throw bad;
    return { status, body };
}

/** Production transport: fixed UDS path, one POST /employee, no agent reuse, no retries, bounded reply. */
export function udsTransport(envelope, { signal } = {}) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(envelope), 'utf8');
        let settled = false;
        const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
        const req = request({ socketPath: WORK_SOCKET, path: '/employee', method: 'POST', agent: false, signal: signal ?? AbortSignal.timeout(WORK_DEADLINE_MS),
            headers: { 'content-type': 'application/json', 'content-length': payload.length } }, res => {
            const declared = res.headers['content-length'];
            if (declared !== undefined && !(Number(declared) <= MAX_WORK_RESULT)) { req.destroy(); return done(reject, new Error('reply too large')); }
            const chunks = [];
            let size = 0;
            res.on('data', chunk => { size += chunk.length; if (size > MAX_WORK_RESULT) { req.destroy(); done(reject, new Error('reply too large')); } else chunks.push(chunk); });
            res.on('end', () => done(resolve, { status: res.statusCode, contentType: res.headers['content-type'], bytes: Buffer.concat(chunks) }));
            res.on('aborted', () => done(reject, new Error('reply aborted')));
            res.on('error', error => done(reject, error));
        });
        req.on('error', error => done(reject, error));
        req.end(payload);
    });
}

function withDeadline(fn, ms) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { const error = Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' }); controller.abort(error); reject(error); }, ms);
    });
    return Promise.race([Promise.resolve().then(() => fn(controller.signal)), deadline]).finally(() => clearTimeout(timer));
}

/**
 * @param currentSession  server.mjs closure: (req) => {id, record} | null
 * @param isCurrentSession (id, record, subject) => boolean; REQUIRED, synchronous, no network: true only while `id`
 *                        still maps to this exact unexpired record with the same subject. Checked after every await,
 *                        immediately before dispatch and again before delivering the result.
 * @param freshCheck      (record) => {result:'ok'|'revoked'|...}; called before EVERY forwarded request
 * @param endSession      (id) => void; called when the fresh check reports revocation
 * @param transport       (envelope, {signal}) => {status, contentType, bytes}; injected in tests
 * Boundary: a session ended while the service call is in flight gets 404 and the result is discarded; an
 * already-dispatched write may still commit (no rollback; the window is bounded by WORK_DEADLINE_MS).
 */
export function createWorkRoutes({ origin, currentSession, isCurrentSession, freshCheck, endSession = () => {}, transport = udsTransport, now = () => Date.now(), log = () => {},
    freshCheckMs = FRESH_CHECK_MS, deadlineMs = WORK_DEADLINE_MS, taskDraftDeadlineMs = TASK_DRAFT_DEADLINE_MS,
    maxInflight = 64, maxPerSession = 4 }) {
    if (typeof origin !== 'string' || typeof currentSession !== 'function' || typeof isCurrentSession !== 'function' || typeof freshCheck !== 'function' || typeof transport !== 'function') {
        throw new TypeError('createWorkRoutes: origin, currentSession, isCurrentSession, freshCheck and transport are required');
    }
    const checkMs = Math.min(Math.max(1, freshCheckMs), FRESH_CHECK_MS);
    const ipcMs = Math.min(Math.max(1, deadlineMs), WORK_DEADLINE_MS);
    const draftMs = Math.min(Math.max(1, taskDraftDeadlineMs), TASK_DRAFT_DEADLINE_MS);
    let inflight = 0;

    function send(res, status, value) {
        res.statusCode = status;
        res.setHeader('Cache-Control', 'no-store');
        if (status === 204) return res.end();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(value));
    }

    function checkWriteHeaders(req) {
        const site = req.headers['sec-fetch-site'];
        if (req.headers.origin !== origin || (site !== undefined && site !== 'same-origin')) throw new Refusal(403, 'forbidden');
        if (mediaType(req.headers['content-type']) !== 'application/json') throw new Refusal(415, 'unsupported_media_type');
        const length = req.headers['content-length'];
        if (req.headers['transfer-encoding'] !== undefined || length === undefined || !/^\d{1,9}$/.test(length)) throw new Refusal(411, 'length_required');
        if (Number(length) > MAX_WORK_BODY) throw new Refusal(413, 'too_large');
        return Number(length);
    }

    async function readBody(req, declared) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size <= MAX_WORK_BODY) chunks.push(chunk); }
        if (size !== declared || size > MAX_WORK_BODY) throw new Refusal(400, 'invalid_body');
        if (size === 0) return null;
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new Refusal(400, 'invalid_body'); }
        if (!isPlainObject(value)) throw new Refusal(400, 'invalid_body');
        inspectData(value, { maxDepth: 8, maxNodes: 2000, screenKeys: true }, new Refusal(400, 'invalid_body'));
        return value;
    }

    async function serve(req, res) {
        const target = parseTarget(req.url);
        const entry = target && matchRoute(target.resource);
        if (!entry) throw new Refusal(404, 'not_found');
        if (!entry.methods.includes(req.method)) { res.setHeader('Allow', entry.methods.join(', ')); throw new Refusal(405, 'method_not_allowed'); }
        if (SINGLE_HEADERS.some(name => headerCount(req, name) > 1)) throw new Refusal(400, 'ambiguous_headers');
        const write = req.method !== 'GET';
        let query = '';
        if (target.query !== null && (write || target.resource === '/todo-summary' || (query = canonicalQuery(target.query)) === null)) throw new Refusal(400, 'invalid_query');
        let body = null;
        if (write) body = await readBody(req, checkWriteHeaders(req));
        else if (req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] ?? '0') !== '0') throw new Refusal(400, 'unexpected_body');

        const current = await currentSession(req);
        const subject = current?.record?.casdoorId;
        if (!current || typeof subject !== 'string' || subject.length === 0 || subject.length > MAX_SUBJECT) throw new Refusal(404, 'not_found');
        const { id, record } = current;
        // Local, synchronous liveness (no network). Re-evaluated after every await and right before dispatch/delivery,
        // so logout, revocation, replacement or expiry during an await never dispatches or delivers a private result.
        const live = () => isCurrentSession(id, record, subject) === true;
        if (!live()) throw new Refusal(404, 'not_found');
        const context = ensureWorkContext(record);
        const given = req.headers[WORK_CONTEXT_HEADER];
        if ((write || given !== undefined) && !sameContext(given, context)) throw new Refusal(409, 'stale_context');
        const resource = target.resource.toLowerCase(); // matched shape: only literals, digits, '-' and hex
        const taskDraft = resource === '/task-draft';
        const envelope = { subject, method: req.method, path: query ? `${resource}?${query}` : resource, body };
        if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_WORK_ENVELOPE) throw new Refusal(413, 'too_large');

        if (inflight >= maxInflight) throw new Refusal(503, 'busy');
        if ((record.workInflight ?? 0) >= maxPerSession) {
            res.setHeader('X-QYOS-Work-Context', context);
            throw new Refusal(429, 'try_again');
        }
        inflight++;
        record.workInflight = (record.workInflight ?? 0) + 1;
        try {
            let verdict = null;
            try { verdict = await withDeadline(() => freshCheck(record), checkMs); } catch { verdict = null; }
            // Ended (logout / revoke / replace / expiry) while the check was pending: no dispatch, no record mutation.
            if (!live()) { log({ event: 'work_session_ended', stage: 'check' }); throw new Refusal(404, 'not_found'); }
            if (verdict?.result === 'revoked') { endSession(id); log({ event: 'work_recheck_revoked' }); throw new Refusal(404, 'not_found'); }
            if (verdict?.result !== 'ok') { log({ event: 'work_recheck_unavailable' }); throw new Refusal(503, 'unavailable'); }
            record.checkedAt = now();
            record.lastOkAt = record.checkedAt;
            let reply;
            try {
                reply = parseReply(await withDeadline(signal => {
                    if (!live()) throw new Refusal(404, 'not_found'); // final pre-dispatch check, same tick as transport()
                    return transport(envelope, { signal });
                }, taskDraft ? draftMs : ipcMs), { taskDraft }); // single attempt, never retried
            } catch (error) {
                if (!(error instanceof Refusal) && live()) { log({ event: 'work_unavailable', code: safeCode(error) }); throw new Refusal(503, 'unavailable'); }
                log({ event: 'work_session_ended', stage: 'dispatch', write });
                throw new Refusal(404, 'not_found');
            }
            // Ended while the service call was in flight: the result is never delivered. A dispatched write may already
            // have committed (no rollback); the client re-reads after signing in again.
            if (!live()) { log({ event: 'work_session_ended', stage: 'reply', write }); throw new Refusal(404, 'not_found'); }
            res.setHeader('X-QYOS-Work-Context', context);
            return send(res, reply.status, reply.body);
        } finally {
            inflight--;
            record.workInflight--;
        }
    }

    async function handle(req, res) {
        try { return await serve(req, res); }
        catch (error) {
            if (res.headersSent) return res.destroy();
            if (req.method !== 'GET') res.setHeader('Connection', 'close'); // a refused body may be unread
            if (error instanceof Refusal) return send(res, error.status, { error: error.code });
            log({ event: 'work_error', code: safeCode(error) });
            return send(res, 500, { error: 'failed' });
        }
    }

    return { handle };
}
