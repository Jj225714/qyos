import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_IDS, readSecret, validateConfig } from './config.mjs';
import { createPortalOidc, LoginError, sameText, STATE_SHAPE } from './oidc.mjs';
import { createSessions } from './sessions.mjs';
import { createWorkRoutes, ensureWorkContext, WORK_PREFIX } from './work-routes.mjs';
import { createMailRoutes, ensureMailContext, MAIL_PREFIX } from './mail-routes.mjs';

export const SESSION_COOKIE = '__Host-qyos_portal';
export const TXN_COOKIE = '__Host-qyos_portal_txn';
export const LOGOUT_COOKIE = '__Host-qyos_portal_logout';
const MAX_URL = 4096;

export function requestUsage(subject, days) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ subject, days });
        const req = request({ socketPath: '/run/qyos-api-usage/query.sock', path: '/query', method: 'POST',
            agent: false, signal: AbortSignal.timeout(4500), headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, async res => {
            try {
                if (res.statusCode !== 200) { res.resume(); throw Error('usage unavailable'); }
                let result = '';
                for await (const chunk of res) { result += chunk; if (result.length > 4096) throw Error('invalid usage'); }
                const value = JSON.parse(result);
                if (!['ok', 'unconfigured', 'unlinked'].includes(value?.status)) throw Error('invalid usage');
                resolve(value);
            } catch (error) { reject(error); }
        });
        req.on('error', reject);
        req.end(payload);
    });
}

const cookieHeader = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** All values of a cookie name (duplicates are reported so callers can refuse ambiguity). */
function cookieValues(req, name) {
    return String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`)).map(part => part.slice(name.length + 1));
}
const singleCookie = (req, name) => { const values = cookieValues(req, name); return values.length === 1 ? values[0] : null; };

/**
 * The portal's /auth/* endpoints (behind Nginx on the portal origin):
 *   GET  /auth/login[?app=chat|image|api]  → Casdoor authorize
 *   GET  /auth/callback                    → validates, asks os-bridge, creates the homepage session
 *   GET  /auth/me                          → {signedIn, user, apps, expiresAt} (rechecks the account)
 *   POST /auth/logout                      → ends the portal session, 303 to Casdoor end-session
 *   GET  /auth/logged-out                  → Casdoor's post-logout return; checks the logout state
 *   GET  /auth/healthz
 */
export function createPortalHandler({ settings, clientSecret, bridgeToken, fetchImpl = fetch, now = () => Date.now(), log = () => {}, maxSessions = 20000, maxTransactions = 10000, readUsage = requestUsage, workTransport, workFreshCheck, mailTransport, mailFreshCheck }) {
    const oidc = createPortalOidc({ origin: settings.origin, issuer: settings.issuer, clientId: settings.clientId, clientSecret, jwksUrl: settings.jwksUrl, scope: settings.scope, bridge: { baseUrl: settings.bridge.baseUrl, token: bridgeToken, japiInstance: settings.bridge.japiInstance }, fetchImpl, now, maxTransactions, log });
    const sessions = createSessions({ maxSessions, now });
    const host = new URL(settings.origin).host;
    const appIds = APP_IDS.filter(id => Object.hasOwn(settings.apps, id));

    function headers(res) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    const json = (res, status, value, cookies = []) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); if (cookies.length) res.setHeader('Set-Cookie', cookies); res.end(JSON.stringify(value)); };
    const redirect = (res, status, location, cookies = []) => { res.statusCode = status; res.setHeader('Location', location); if (cookies.length) res.setHeader('Set-Cookie', cookies); res.end(); };
    const clearTxn = cookieHeader(TXN_COOKIE, '', 0);
    const clearSession = cookieHeader(SESSION_COOKIE, '', 0);

    async function readSmallBody(req, limit = 1024) {
        let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > limit) return false; }
        return true;
    }

    /**
     * Local liveness, no network: `id` still maps to this exact unexpired record (not logged out, revoked, replaced
     * or expired) and the subject captured before an await is unchanged. A changed subject ends the session.
     */
    function isCurrentSession(id, record, subject) {
        if (sessions.get(id) !== record) return false; // sessions.get also drops expired records
        if (record.casdoorId !== subject) { sessions.delete(id); log({ event: 'session_subject_changed' }); return false; }
        return true;
    }

    /** Session for this request after the bounded recheck; null when absent, expired or revoked. */
    async function currentSession(req) {
        const id = singleCookie(req, SESSION_COOKIE);
        const record = sessions.get(id);
        if (!record) return null;
        const subject = record.casdoorId;
        // Due every recheckMs; and, while the last attempt failed, as soon as the grace (from the last success) runs out.
        const failing = record.lastOkAt < record.checkedAt;
        if (now() - record.checkedAt >= settings.recheckMs || (failing && now() - record.lastOkAt > settings.recheckGraceMs)) {
            record.pending ??= oidc.recheck(record).finally(() => { record.pending = null; });
            const verdict = await record.pending;
            if (!isCurrentSession(id, record, subject)) return null; // ended during the recheck: never refresh or return it
            record.checkedAt = now();
            if (verdict.result === 'ok') record.lastOkAt = now();
            else if (verdict.result === 'revoked') { sessions.delete(id); log({ event: 'recheck_revoked', reason: verdict.reason }); return null; }
            else if (now() - record.lastOkAt > settings.recheckGraceMs) { sessions.delete(id); log({ event: 'recheck_revoked', reason: 'bridge_unreachable' }); return null; }
            else log({ event: 'recheck_deferred' });
        }
        return { id, record };
    }

    // /portal/work/* exists only with settings.workCalendar.enabled === true; otherwise the prefix is a plain 404.
    const work = settings.workCalendar?.enabled === true ? createWorkRoutes({ origin: settings.origin, currentSession, isCurrentSession, freshCheck: workFreshCheck ?? (record => oidc.recheck(record)), endSession: id => sessions.delete(id), transport: workTransport, now, log }) : null;
    // /auth/mail/* is always routed and fails closed; the private service decides visibility (department) per employee.
    const mail = createMailRoutes({ origin: settings.origin, currentSession, isCurrentSession, freshCheck: mailFreshCheck ?? (record => oidc.recheck(record)), endSession: id => sessions.delete(id), transport: mailTransport, now, log });

    async function handleLogin(req, res, url) {
        const methods = url.searchParams.getAll('method');
        const providers = url.searchParams.getAll('provider');
        if (methods.length > 1 || (methods.length === 1 && !['email', 'enterprise'].includes(methods[0]))) return redirect(res, 303, '/?login_error=method');
        if (providers.length > 1 || (providers.length === 1 && !['lark', 'wecom', 'dingtalk'].includes(providers[0]))) return redirect(res, 303, '/?login_error=provider');
        if (methods[0] === 'email' && providers.length) return redirect(res, 303, '/?login_error=method');
        const requested = url.searchParams.get('app');
        const app = requested && appIds.includes(requested) ? requested : null;
        try {
            const { location, state } = await oidc.start({ app, method: methods[0] ?? null, provider: providers[0] ?? null });
            return redirect(res, 302, location, [cookieHeader(TXN_COOKIE, state, 600)]);
        } catch (error) {
            return redirect(res, 303, `/?login_error=${error instanceof LoginError ? error.code : 'unavailable'}`);
        }
    }

    async function handleCallback(req, res, url) {
        const cookieState = singleCookie(req, TXN_COOKIE);
        let replaced = false;
        // A validated login attempt ends the identity this browser held BEFORE the outcome is known, so a refused
        // replacement (no department, admin account, binding/identity refusal, failure) never leaves the
        // previous employee signed in. Invalid or forged callbacks (bad state) do not reach this point.
        const endPrevious = () => {
            for (const old of cookieValues(req, SESSION_COOKIE)) { if (sessions.get(old)) replaced = true; sessions.delete(old); }
            if (cookieValues(req, SESSION_COOKIE).length) replaced = true;
        };
        try {
            const { identity, app } = await oidc.finish({ query: url.searchParams, cookieState, onAccepted: endPrevious });
            const id = sessions.create(identity, settings.sessionMs);
            log({ event: 'login_ok', department: identity.department });
            const target = app ? settings.apps[app].launchUrl : '/';
            return redirect(res, 303, target, [clearTxn, cookieHeader(SESSION_COOKIE, id, Math.floor(settings.sessionMs / 1000))]);
        } catch (error) {
            const code = error instanceof LoginError ? error.code : 'unavailable';
            log({ event: 'login_refused', code });
            return redirect(res, 303, `/?login_error=${code}`, replaced ? [clearTxn, clearSession] : [clearTxn]);
        }
    }

    async function handleMe(req, res) {
        const current = await currentSession(req);
        if (!current) return json(res, 401, { signedIn: false });
        const { record } = current;
        const body = { signedIn: true, user: { name: record.name, email: record.email, department: record.department }, apps: appIds, expiresAt: new Date(record.expiresAt).toISOString() };
        if (work) body.workCalendar = { enabled: true, context: ensureWorkContext(record) };
        body.enterpriseMail = { context: ensureMailContext(record) };
        return json(res, 200, body);
    }

    async function handleUsage(req, res, url) {
        const current = await currentSession(req);
        if (!current) return json(res, 401, { error: 'unauthorized' });
        if (!appIds.includes('api')) return json(res, 403, { error: 'forbidden' });
        const days = url.searchParams.get('days') || '7';
        if ([...url.searchParams.keys()].some(key => key !== 'days') || url.searchParams.getAll('days').length > 1 || !['7', '30'].includes(days)) {
            return json(res, 400, { error: 'invalid_period' });
        }
        const record = current.record;
        if (record.lastUsageAt != null && now() - record.lastUsageAt < 1000) return json(res, 429, { error: 'try_again' });
        record.lastUsageAt = now();
        try {
            if ((await oidc.recheck(record)).result !== 'ok') return json(res, 503, { error: 'unavailable' });
            return json(res, 200, await readUsage(record.casdoorId, Number(days)));
        } catch { return json(res, 503, { error: 'unavailable' }); }
    }

    async function handleLogout(req, res) {
        // Same-origin HTML form only: exact Origin, no cross-site fetch metadata, form encoding.
        const site = req.headers['sec-fetch-site'];
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (req.headers.origin !== settings.origin || (site !== undefined && site !== 'same-origin') || type !== 'application/x-www-form-urlencoded') return json(res, 403, { error: 'forbidden' });
        if (!(await readSmallBody(req))) return json(res, 413, { error: 'too_large' });
        for (const id of cookieValues(req, SESSION_COOKIE)) sessions.delete(id);
        log({ event: 'logout' });
        const state = randomBytes(24).toString('base64url');
        let location;
        try { location = await oidc.logoutUrl(state); }
        catch { return redirect(res, 303, '/?signed_out=partial', [clearSession, clearTxn]); }
        return redirect(res, 303, location, [clearSession, clearTxn, cookieHeader(LOGOUT_COOKIE, state, 600)]);
    }

    function handleLoggedOut(req, res, url) {
        // Success only for exactly one query state and exactly one logout cookie, both of the generated shape,
        // and equal. Missing, empty, duplicated or malformed values never show the signed-out banner.
        const states = url.searchParams.getAll('state');
        const expected = singleCookie(req, LOGOUT_COOKIE);
        const given = states.length === 1 ? states[0] : null;
        const matched = typeof given === 'string' && typeof expected === 'string' && STATE_SHAPE.test(given) && STATE_SHAPE.test(expected) && sameText(given, expected);
        return redirect(res, 303, matched ? '/?signed_out=1' : '/', [cookieHeader(LOGOUT_COOKIE, '', 0)]);
    }

    return async (req, res) => {
        headers(res);
        try {
            if (req.headers.host !== host) return json(res, 421, { error: 'misdirected' });
            if (String(req.url).length > MAX_URL) return json(res, 414, { error: 'uri_too_long' });
            const url = new URL(req.url, settings.origin);
            if (url.pathname === MAIL_PREFIX || url.pathname.startsWith(`${MAIL_PREFIX}/`) || String(req.url).startsWith(MAIL_PREFIX)) {
                return await mail.handle(req, res);
            }
            if (url.pathname === WORK_PREFIX || url.pathname.startsWith(`${WORK_PREFIX}/`) || String(req.url).startsWith(`${WORK_PREFIX}/`)) {
                return work ? await work.handle(req, res) : json(res, 404, { error: 'not_found' });
            }
            const route = `${req.method} ${url.pathname}`;
            switch (route) {
                case 'GET /auth/healthz': return json(res, 200, { ok: true });
                case 'GET /auth/login': return await handleLogin(req, res, url);
                case 'GET /auth/callback': return await handleCallback(req, res, url);
                case 'GET /auth/me': return await handleMe(req, res);
                case 'GET /auth/api-usage': return await handleUsage(req, res, url);
                case 'GET /auth/options': return json(res, 200, await oidc.options());
                case 'POST /auth/logout': return await handleLogout(req, res);
                case 'GET /auth/logged-out': return handleLoggedOut(req, res, url);
                default:
                    if (['/auth/login', '/auth/callback', '/auth/me', '/auth/options', '/auth/logout', '/auth/logged-out', '/auth/healthz'].includes(url.pathname)) return json(res, 405, { error: 'method_not_allowed' });
                    return json(res, 404, { error: 'not_found' });
            }
        } catch (error) {
            log({ event: 'error', message: error?.message?.slice(0, 200) });
            if (!res.headersSent) json(res, 500, { error: 'failed' });
            else res.destroy();
        }
    };
}

export function configPathFromArgs(argv) {
    const index = argv.indexOf('--config');
    const value = index >= 0 ? argv[index + 1] : undefined;
    return value && !value.startsWith('--') ? value : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const configPath = configPathFromArgs(process.argv);
    if (!configPath) { console.error('usage: node src/server.mjs --config /etc/portal-auth/config.json'); process.exit(2); }
    const settings = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
    const clientSecret = await readSecret(settings.clientSecretFile, 'clientSecretFile');
    const bridgeToken = await readSecret(settings.bridge.tokenFile, 'bridge.tokenFile');
    const log = line => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`);
    const server = createServer(createPortalHandler({ settings, clientSecret, bridgeToken, log }));
    server.listen(settings.listen.port, settings.listen.host, () => log({ event: 'listening', host: settings.listen.host, port: settings.listen.port }));
    const shutdown = () => { server.close(); setTimeout(() => process.exit(0), 3000).unref(); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
