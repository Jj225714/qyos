import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createIdTokenVerifier } from './jwt.mjs';

export const TXN_MS = 10 * 60000;
const DISCOVERY_MS = 3600000;
const HINT_MS = 5 * 60000;
const HINT_FAILURE_MS = 60000;

/** Error with a fixed portal error code (shown as /?login_error=<code>); never carries upstream text. */
export class LoginError extends Error {
    constructor(code) { super(code); this.code = code; }
}

/** os-bridge refusal codes the portal may show to the employee (anything else becomes "unavailable"/"failed"). */
export const BRIDGE_CODES = new Set(['NO_DEPARTMENT', 'ADMIN_ACCOUNT', 'IDENTITY_MISMATCH', 'BINDING_REQUIRED', 'USER_DISABLED', 'KEY_DISABLED', 'FORBIDDEN', 'EMAIL_UNVERIFIED', 'NO_EMAIL']);

/**
 * Constant-time equality of two non-empty strings. Compares UTF-8 bytes (equal JS lengths can differ in bytes:
 * timingSafeEqual would throw on malformed Unicode), so any input fails safely instead of raising.
 */
export const sameText = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const x = Buffer.from(a, 'utf8'); const y = Buffer.from(b, 'utf8');
    return x.length === y.length && timingSafeEqual(x, y);
};
/** Shape of the random values the portal generates (base64url); anything else is refused before comparison. */
export const STATE_SHAPE = /^[A-Za-z0-9_-]{32,64}$/;
const sameOrigin = (url, origin) => { try { return new URL(url).origin === origin; } catch { return false; } };

/**
 * The portal's confidential OIDC client (Casdoor application "portal"): code + PKCE + nonce, single-use
 * transactions bound to the browser's state cookie, full ID-token validation, identity and authorization
 * from os-bridge. No token survives `finish()`. No server-side request follows an HTTP redirect.
 */
export function createPortalOidc({ origin, issuer, clientId, clientSecret, jwksUrl, scope = 'openid profile email', bridge, fetchImpl = fetch, now = () => Date.now(), maxTransactions = 10000, log = () => {} }) {
    const redirectUri = `${origin}/auth/callback`;
    const issuerOrigin = new URL(issuer).origin;
    const bridgeRoot = bridge.baseUrl.replace(/\/+$/, '');
    const transactions = new Map();
    const verifyIdToken = createIdTokenVerifier({ issuer, clientId, jwksUrl, fetchImpl, now });
    let discovery = null;
    let hint = null;
    let statusCache = null;
    let statusRequest = 0;
    const providerTypes = ['lark', 'wecom', 'dingtalk'];

    async function loginStatus(force = false) {
        if (!force && statusCache && statusCache.expiresAt > now() && now() >= statusCache.checkedAt
            && (statusCache.value.state === 'unknown' || statusCache.ageMs + now() - statusCache.checkedAt <= 150000)) return statusCache.value;
        const request = ++statusRequest;
        const { status, body } = await callBridge(force ? '/internal/login-status' : '/internal/config');
        const info = body?.loginStatus;
        let value = { state: 'unknown' };
        if (status === 200 && info && Number.isFinite(info.ageMs) && info.ageMs >= 0 && info.ageMs <= 150000) {
            if (info.state === 'detached') value = { state: 'detached' };
            else if (info.state === 'active' && providerTypes.includes(info.type) && typeof info.name === 'string'
                && /^[A-Za-z0-9_.-]{1,128}$/.test(info.name) && info.name === body.loginProvider?.name && info.type === body.loginProvider?.type) {
                value = { state: 'active', type: info.type, name: info.name };
            }
        }
        if (request === statusRequest) statusCache = { value, ageMs: info?.ageMs, checkedAt: now(), expiresAt: now() + (value.state === 'unknown' ? 5000 : 15000) };
        return value;
    }

    async function options() {
        const status = await loginStatus();
        return { v: 1, mode: status.state, generic: true, email: 'unknown', providers: providerTypes.map(type => ({ type, state: status.state === 'unknown' ? 'unknown' : status.state === 'active' && type === status.type ? 'active' : 'inactive' })) };
    }

    const call = (url, init = {}) => fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(init.timeout || 10000) });

    async function endpoints() {
        if (discovery && discovery.expiresAt > now()) return discovery.value;
        let response;
        try { response = await call(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } }); }
        catch { throw new LoginError('unavailable'); }
        if (!response.ok) throw new LoginError('unavailable');
        const value = await response.json().catch(() => null);
        // Exact issuer match, and every endpoint we use must live on the issuer's own origin.
        if (value?.issuer !== issuer) { log({ event: 'discovery_refused', reason: 'issuer' }); throw new LoginError('unavailable'); }
        for (const name of ['authorization_endpoint', 'token_endpoint', 'end_session_endpoint']) {
            if (typeof value[name] !== 'string' || !sameOrigin(value[name], issuerOrigin)) { log({ event: 'discovery_refused', reason: name }); throw new LoginError('unavailable'); }
        }
        discovery = { value, expiresAt: now() + DISCOVERY_MS };
        return value;
    }

    async function callBridge(path, accessToken, workEmailNonce) {
        let response;
        try {
            response = await call(`${bridgeRoot}${path}`, { headers: { 'x-internal-token': bridge.token, accept: 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...(workEmailNonce ? { 'x-qyos-work-email-nonce': workEmailNonce } : {}) }, timeout: 15000 });
        } catch { return { status: 0, body: null }; }
        return { status: response.status, body: await response.json().catch(() => null) };
    }

    /** Casdoor provider to preselect (provider_hint); best effort, cached, never blocks login. */
    async function providerHint() {
        if (hint && hint.expiresAt > now()) return hint.value;
        const { status, body } = await callBridge('/internal/config');
        const name = status === 200 ? body?.loginProvider?.name : null;
        const value = typeof name === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(name) ? name : null;
        hint = { value, expiresAt: now() + (status === 200 ? HINT_MS : HINT_FAILURE_MS) };
        return value;
    }

    function prune() {
        for (const [state, txn] of transactions) if (txn.expiresAt <= now()) transactions.delete(state);
        while (transactions.size >= maxTransactions) transactions.delete(transactions.keys().next().value);
    }

    /** Starts a login; returns the authorize URL and the state (the caller sets it as the transaction cookie). */
    async function start({ app = null, method = null, provider = null } = {}) {
        let selectedName = null;
        let dingTalk = provider === 'dingtalk' && method !== 'email';
        if (provider) {
            const selected = await loginStatus(true);
            if (selected.state !== 'active' || selected.type !== provider) throw new LoginError('provider_changed');
            selectedName = selected.name;
        }
        if (method === 'enterprise' && !provider) {
            const selected = await loginStatus(true);
            if (selected.state === 'active' && selected.type === 'dingtalk') {
                selectedName = selected.name;
                dingTalk = true;
            }
        }
        const { authorization_endpoint: authorize } = await endpoints();
        prune();
        const state = randomBytes(32).toString('base64url');
        const verifier = randomBytes(48).toString('base64url');
        const nonce = randomBytes(32).toString('base64url');
        transactions.set(state, { verifier, nonce, app, redirectUri, dingTalk, expiresAt: now() + TXN_MS });
        const providerName = method === 'email' ? null : selectedName ?? await providerHint();
        const url = new URL(authorize);
        url.search = new URLSearchParams({
            client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, state, nonce,
            code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
            ...(providerName ? { provider_hint: providerName } : {}),
            ...(dingTalk ? { prompt: 'login' } : {}),
        }).toString();
        return { location: url.toString(), state };
    }

    /**
     * Finishes a login. The transaction is consumed before any network call, so a code/state pair can be
     * used once only. Returns the identity (no tokens) and the app the employee asked for.
     */
    async function finish({ query, cookieState, onAccepted = () => {} }) {
        const state = query.get('state');
        const shaped = typeof state === 'string' && STATE_SHAPE.test(state);
        const txn = shaped ? transactions.get(state) : undefined;
        if (txn) transactions.delete(state);
        if (!shaped || !sameText(state, cookieState) || !txn || txn.expiresAt <= now()) throw new LoginError(query.get('error') ? 'failed' : 'state');
        // From here on this is a genuine login attempt of this browser (its own state cookie and transaction):
        // the caller ends any portal identity the browser still holds, whatever the outcome.
        onAccepted();
        if (query.get('error')) throw new LoginError('failed');
        const code = query.get('code');
        if (!code || code.length > 4096) throw new LoginError('failed');
        const { token_endpoint: tokenUrl } = await endpoints();
        let response;
        try {
            response = await call(tokenUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: txn.redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: txn.verifier }).toString(),
            });
        } catch { throw new LoginError('unavailable'); }
        if (!response.ok) throw new LoginError('failed');
        const tokens = await response.json().catch(() => null);
        if (typeof tokens?.access_token !== 'string' || typeof tokens?.id_token !== 'string') throw new LoginError('failed');
        let claims;
        try { claims = await verifyIdToken(tokens.id_token, { nonce: txn.nonce }); }
        catch (error) { log({ event: 'login_refused', code: 'id_token', reason: error.reason || 'invalid' }); throw new LoginError('failed'); }
        const { status, body } = await callBridge('/internal/me', tokens.access_token, txn.dingTalk ? txn.nonce : undefined);
        if (status !== 200) {
            const bridgeCode = body?.error?.code;
            if (status === 403 && BRIDGE_CODES.has(bridgeCode)) throw new LoginError(bridgeCode);
            throw new LoginError(status === 401 ? 'failed' : 'unavailable');
        }
        if (body?.instance !== bridge.japiInstance) { log({ event: 'login_refused', code: 'instance' }); throw new LoginError('unavailable'); }
        // The access token (os-bridge) and the ID token (portal) must describe the same Casdoor user.
        if (typeof body?.casdoorId !== 'string' || body.casdoorId !== claims.sub) { log({ event: 'login_refused', code: 'subject' }); throw new LoginError('failed'); }
        const user = body.user;
        if (!/^[1-9][0-9]{0,19}$/.test(String(user?.id)) || typeof user?.email !== 'string' || user.status !== 'active') throw new LoginError('unavailable');
        return {
            identity: { casdoorId: body.casdoorId, japiUserId: String(user.id), email: user.email.toLowerCase(), name: typeof body.name === 'string' ? body.name.slice(0, 200) : user.email, department: typeof body.department === 'string' ? body.department.slice(0, 100) : null },
            app: txn.app,
        };
    }

    /**
     * Current state of a portal session's account: "ok", "revoked" (definite answer), or "unknown"
     * (os-bridge unreachable / 5xx / malformed; the caller applies its grace period).
     */
    async function recheck(session) {
        const { status, body } = await callBridge(`/internal/users/${encodeURIComponent(session.japiUserId)}`);
        if ([401, 403, 404].includes(status)) return { result: 'revoked', reason: `bridge_${status}` };
        if (status !== 200 || !body?.user) return { result: 'unknown' };
        if (body.instance !== bridge.japiInstance) return { result: 'revoked', reason: 'instance' };
        if (body.casdoorId !== session.casdoorId) return { result: 'revoked', reason: 'binding' };
        if (String(body.user.email || '').toLowerCase() !== session.email) return { result: 'revoked', reason: 'email' };
        if (body.user.status !== 'active') return { result: 'revoked', reason: body.user.reason || 'disabled' };
        return { result: 'ok' };
    }

    /** RP-initiated logout URL without id_token_hint (Casdoor identifies the session by its cookie + client_id). */
    async function logoutUrl(state) {
        const { end_session_endpoint: endSession } = await endpoints();
        const url = new URL(endSession);
        url.search = new URLSearchParams({ client_id: clientId, post_logout_redirect_uri: `${origin}/auth/logged-out`, state }).toString();
        return url.toString();
    }

    return { start, finish, recheck, logoutUrl, transactions, options };
}
