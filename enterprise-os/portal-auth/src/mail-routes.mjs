/**
 * Authenticated, read-only GET /auth/mail/status adapter for the enterprise-mail card.
 * Exactly ONE resource. It maps onto one call, POST /employee {subject}, on the enterprise-mail service's private
 * Unix socket. It is not a proxy: no browser headers, cookies, credentials, query or body are forwarded; the subject
 * comes only from the checked portal session; only explicitly validated, projected reply fields are returned.
 * Department / visibility policy is decided independently by the Python service and is not re-implemented here;
 * socket peer-UID / permission enforcement also belongs to that service. The browser never reaches a mail provider.
 */
import { request } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const MAIL_PREFIX = '/auth/mail';
export const MAIL_SUMMARY_PATH = '/auth/mail/status';
export const MAIL_SOCKET = '/run/qyos-work-calendar/mail.sock'; // code-owned; never configurable
export const MAIL_CONTEXT_HEADER = 'x-qyos-mail-context';
export const MAX_MAIL_RESULT = 16 * 1024;
export const MAIL_DEADLINE_MS = 5000;
export const MAIL_FRESH_CHECK_MS = 4000;
export const MAIL_MAILBOX = 'sales@example.invalid';
export const MAIL_PROVIDERS = Object.freeze(['tencent', 'google', 'custom']);
export const MAIL_STATUSES = Object.freeze(['ok', 'error', 'pending', 'link_only', 'unconfigured']);

const MAX_SUBJECT = 256;
const MAX_WEBMAIL_URL = 2048;
const CONTEXT_SHAPE = /^[A-Za-z0-9_-]{32}$/;
const SINGLE_HEADERS = ['host', 'origin', 'sec-fetch-site', 'content-type', 'content-length', 'transfer-encoding', MAIL_CONTEXT_HEADER];

class Refusal extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

const mediaType = value => String(value ?? '').split(';')[0].trim().toLowerCase();
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const safeCode = error => (typeof error?.code === 'string' ? error.code.slice(0, 40) : 'error');
const headerCount = (req, name) => { let n = 0; for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) n++; return n; };
const hasBody = req => req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] ?? '0') !== '0';

/** Per-session, NON-authenticating anti-stale token (never the session cookie, never the work context; no identity). */
export function ensureMailContext(record) {
    if (typeof record.mailContext !== 'string' || !CONTEXT_SHAPE.test(record.mailContext)) record.mailContext = randomBytes(24).toString('base64url');
    return record.mailContext;
}
const sameContext = (given, expected) => typeof given === 'string' && CONTEXT_SHAPE.test(given) && timingSafeEqual(Buffer.from(given), Buffer.from(expected));

/** HTTPS only, no userinfo, default port, no whitespace/control/backslash; returns the normalized href or null. */
function webmailHref(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_WEBMAIL_URL || /[\x00-\x20\x7f-\x9f\\]/.test(value)) return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hostname === '' || url.href.length > MAX_WEBMAIL_URL) return null;
    return url.href;
}

/**
 * Validates the raw service reply and returns ONLY projected fields:
 *   {visible:false} | {visible:true, revision, provider, mailbox, webmailUrl, unread, status}
 * Anything else (status, media type, size, encoding, shape, value) throws bad_reply; bodies are never echoed.
 */
export function parseMailReply(raw) {
    const bad = Object.assign(new Error('bad_reply'), { code: 'bad_reply' });
    // A trusted service denial revokes visibility; never turn it into a recoverable sync outage.
    if (raw?.status === 403) return { visible: false };
    if (!raw || raw.status !== 200 || mediaType(raw.contentType) !== 'application/json' || !Buffer.isBuffer(raw.bytes) || raw.bytes.length > MAX_MAIL_RESULT) throw bad;
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes)); } catch { throw bad; }
    if (!isPlainObject(value)) throw bad;
    const visible = own(value, 'visible');
    if (visible === false) return { visible: false };
    if (visible !== true) throw bad;
    const revision = own(value, 'revision');
    const provider = own(value, 'provider');
    const mailbox = own(value, 'mailbox');
    const webmailUrl = webmailHref(own(value, 'webmailUrl'));
    const unread = own(value, 'unread');
    const status = own(value, 'status');
    if (!Number.isSafeInteger(revision) || revision < 0) throw bad;
    if (typeof provider !== 'string' || !MAIL_PROVIDERS.includes(provider)) throw bad;
    if (mailbox !== MAIL_MAILBOX) throw bad;
    if (webmailUrl === null) throw bad;
    if (!(unread === null || (Number.isSafeInteger(unread) && unread >= 0))) throw bad;
    if (typeof status !== 'string' || !MAIL_STATUSES.includes(status)) throw bad;
    return { visible: true, revision, provider, mailbox, webmailUrl, unread, status };
}

/** Production transport: fixed UDS path, one POST /employee {subject}, fixed headers, no agent reuse, no retries, bounded. */
export function udsTransport(payload, { signal } = {}) {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify({ subject: payload?.subject }), 'utf8'); // rebuilt: nothing else can ride along
        let settled = false;
        const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
        const req = request({ socketPath: MAIL_SOCKET, path: '/employee', method: 'POST', agent: false, signal: signal ?? AbortSignal.timeout(MAIL_DEADLINE_MS),
            headers: { 'content-type': 'application/json', 'content-length': body.length } }, res => {
            const declared = res.headers['content-length'];
            if (declared !== undefined && !(Number(declared) <= MAX_MAIL_RESULT)) { req.destroy(); return done(reject, new Error('reply too large')); }
            const chunks = [];
            let size = 0;
            res.on('data', chunk => { size += chunk.length; if (size > MAX_MAIL_RESULT) { req.destroy(); done(reject, new Error('reply too large')); } else chunks.push(chunk); });
            res.on('end', () => done(resolve, { status: res.statusCode, contentType: res.headers['content-type'], bytes: Buffer.concat(chunks) }));
            res.on('aborted', () => done(reject, new Error('reply aborted')));
            res.on('error', error => done(reject, error));
            res.on('close', () => done(reject, new Error('reply closed')));
        });
        req.on('error', error => done(reject, error));
        req.end(body);
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
 * @param currentSession   server.mjs closure: (req) => {id, record} | null
 * @param isCurrentSession (id, record, subject) => boolean; REQUIRED, synchronous, no network. Checked after every
 *                         await, immediately before dispatch and again before delivering the result.
 * @param freshCheck       (record) => {result:'ok'|'revoked'|...}; called before EVERY service call (bounded 4 s)
 * @param endSession       (id) => void; called when the fresh check reports revocation
 * @param transport        (payload {subject}, {signal}) => {status, contentType, bytes}; injected in tests
 */
export function createMailRoutes({ origin, currentSession, isCurrentSession, freshCheck, endSession = () => {}, transport = udsTransport, now = () => Date.now(), log = () => {},
    freshCheckMs = MAIL_FRESH_CHECK_MS, deadlineMs = MAIL_DEADLINE_MS, maxInflight = 32, maxPerSession = 2 }) {
    if (typeof origin !== 'string' || typeof currentSession !== 'function' || typeof isCurrentSession !== 'function' || typeof freshCheck !== 'function' || typeof transport !== 'function') {
        throw new TypeError('createMailRoutes: origin, currentSession, isCurrentSession, freshCheck and transport are required');
    }
    const checkMs = Math.min(Math.max(1, freshCheckMs), MAIL_FRESH_CHECK_MS);
    const ipcMs = Math.min(Math.max(1, deadlineMs), MAIL_DEADLINE_MS);
    const globalLimit = Math.max(1, Math.trunc(maxInflight) || 1);
    const sessionLimit = Math.max(1, Math.trunc(maxPerSession) || 1);
    let inflight = 0;

    function send(res, status, value) {
        res.statusCode = status;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(value));
    }

    async function serve(req, res) {
        // Raw request target (not URL-normalized): exactly /auth/mail/status; every other /auth/mail* target is 404.
        const raw = String(req.url);
        const q = raw.indexOf('?');
        const path = q < 0 ? raw : raw.slice(0, q);
        if (raw.includes('#') || path !== MAIL_SUMMARY_PATH) throw new Refusal(404, 'not_found');
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw new Refusal(405, 'method_not_allowed'); }
        if (SINGLE_HEADERS.some(name => headerCount(req, name) > 1)) throw new Refusal(400, 'ambiguous_headers');
        if (q >= 0) throw new Refusal(400, 'invalid_query'); // subject/email/department are never accepted from the browser
        if (hasBody(req)) throw new Refusal(400, 'unexpected_body');
        const site = req.headers['sec-fetch-site'];
        const requestOrigin = req.headers.origin;
        if ((site !== undefined && site !== 'same-origin') || (requestOrigin !== undefined && requestOrigin !== origin)) throw new Refusal(403, 'forbidden');

        const current = await currentSession(req);
        const subject = current?.record?.casdoorId;
        if (!current || typeof subject !== 'string' || subject.length === 0 || subject.length > MAX_SUBJECT) throw new Refusal(404, 'not_found');
        const { id, record } = current;
        const live = () => isCurrentSession(id, record, subject) === true;
        if (!live()) throw new Refusal(404, 'not_found');
        if (!sameContext(req.headers[MAIL_CONTEXT_HEADER], ensureMailContext(record))) throw new Refusal(409, 'stale_context'); // mandatory, exact

        if (inflight >= globalLimit) throw new Refusal(503, 'busy');
        if ((record.mailInflight ?? 0) >= sessionLimit) throw new Refusal(429, 'try_again');
        inflight++;
        record.mailInflight = (record.mailInflight ?? 0) + 1;
        try {
            let verdict = null;
            try { verdict = await withDeadline(() => freshCheck(record), checkMs); } catch { verdict = null; }
            if (!live()) { log({ event: 'mail_session_ended', stage: 'check' }); throw new Refusal(404, 'not_found'); }
            if (verdict?.result === 'revoked') { endSession(id); log({ event: 'mail_recheck_revoked' }); throw new Refusal(404, 'not_found'); }
            if (verdict?.result !== 'ok') { log({ event: 'mail_recheck_unavailable' }); throw new Refusal(503, 'unavailable'); }
            record.checkedAt = now();
            record.lastOkAt = record.checkedAt;
            let summary;
            try {
                summary = parseMailReply(await withDeadline(signal => {
                    if (!live()) throw new Refusal(404, 'not_found'); // final pre-dispatch check, same tick as transport()
                    return transport({ subject }, { signal });
                }, ipcMs)); // single attempt, never retried
            } catch (error) {
                if (!(error instanceof Refusal) && live()) { log({ event: 'mail_unavailable', code: safeCode(error) }); throw new Refusal(503, 'unavailable'); }
                log({ event: 'mail_session_ended', stage: 'dispatch' });
                throw new Refusal(404, 'not_found');
            }
            if (!live()) { log({ event: 'mail_session_ended', stage: 'reply' }); throw new Refusal(404, 'not_found'); }
            return send(res, 200, summary);
        } finally {
            inflight--;
            record.mailInflight--;
        }
    }

    async function handle(req, res) {
        try { return await serve(req, res); }
        catch (error) {
            if (res.headersSent) return res.destroy();
            if (req.method !== 'GET' || hasBody(req)) res.setHeader('Connection', 'close'); // a refused body is never read
            if (error instanceof Refusal) return send(res, error.status, { error: error.code });
            log({ event: 'mail_error', code: safeCode(error) });
            return send(res, 500, { error: 'failed' });
        }
    }

    return { handle };
}
