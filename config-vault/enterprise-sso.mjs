import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Enterprise single sign-on for the vault: Casdoor (OIDC, code + PKCE) proves who the employee is,
// os-bridge maps that person to their JAPI account. Session ownership keeps using JAPI user IDs,
// so settings, assets and memberships of existing accounts carry over unchanged. Because of that,
// os-bridge must resolve users in the very same JAPI (Sub2API) instance the vault's --auth-base uses:
// every identity answer carries an instance label that must equal `bridge.japiInstance`.

export const OIDC_COOKIE = '__Secure-config_vault_oidc';
export const STATE_MS = 10 * 60000;
/** Directory (inside the vault store) holding one encrypted record per pending login. */
export const OIDC_STATE_DIR = 'oidc';
const BRIDGE_CONFIG_MS = 5 * 60000;
const BRIDGE_CONFIG_FAILURE_MS = 60000;
const DEFAULT_SESSION_MAX_HOURS = 12;
const fault = status => Object.assign(new Error('Request failed'), { status });
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** `<文本模型名>`-style placeholders copied verbatim from the example config. */
export const isPlaceholder = value => typeof value === 'string' && /^\s*<.*>\s*$/.test(value);

/** Only same-site absolute paths may be used after login; anything else returns to "/". */
export function safeReturnPath(value) {
    return typeof value === 'string' && value.length <= 2048 && /^\/(?![/\\])[^\s\\]*$/.test(value) ? value : '/';
}

export function createEnterpriseSso({ origin, prefix, oidc, bridge, managedChannel, sessionMaxHours, fetchImpl = fetch, now = () => Date.now(), log = message => console.error(message) }) {
    if (!oidc?.issuer || !oidc.clientId || !oidc.clientSecret || !bridge?.baseUrl || !bridge.token) throw new Error('Enterprise SSO needs oidc.issuer/clientId/clientSecret and bridge.baseUrl/token');
    if (typeof bridge.japiInstance !== 'string' || !bridge.japiInstance.trim() || isPlaceholder(bridge.japiInstance)) throw new Error('Enterprise SSO needs bridge.japiInstance (must equal os-bridge japi.instance)');
    const maxHours = sessionMaxHours === undefined || sessionMaxHours === null ? DEFAULT_SESSION_MAX_HOURS : Number(sessionMaxHours);
    if (!Number.isFinite(maxHours) || maxHours <= 0 || maxHours > 168) throw new Error('Enterprise SSO sessionMaxHours must be > 0 and <= 168');
    const japiInstance = bridge.japiInstance.trim();
    const redirectUri = `${origin}${prefix}/oidc/callback`;
    const bridgeRoot = bridge.baseUrl.replace(/\/+$/, '');
    const models = (Array.isArray(managedChannel?.models) ? managedChannel.models : []).filter(model => {
        if (!isPlaceholder(model?.name)) return true;
        log('[config-vault] enterprise SSO: ignoring placeholder model name in managedChannel.models; fill in the real model name');
        return false;
    });
    let discovery;
    let bridgeConfig;

    async function endpoints() {
        if (discovery && discovery.expiresAt > now()) return discovery.value;
        let response;
        try { response = await fetchImpl(`${oidc.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) }); } catch { throw fault(503); }
        if (!response.ok) throw fault(503);
        const value = await response.json().catch(() => null);
        if (typeof value?.authorization_endpoint !== 'string' || typeof value?.token_endpoint !== 'string') throw fault(503);
        discovery = { value, expiresAt: now() + 3600000 };
        return value;
    }

    async function callBridge(path, accessToken, timeout = 15000) {
        let response;
        try {
            response = await fetchImpl(`${bridgeRoot}${path}`, { headers: { 'x-internal-token': bridge.token, accept: 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) }, signal: AbortSignal.timeout(timeout) });
        } catch { throw fault(503); }
        if ([401, 403, 404].includes(response.status)) throw fault(401);
        if (!response.ok) throw fault(503);
        return response.json().catch(() => { throw fault(503); });
    }

    /** User IDs are only meaningful inside one JAPI instance: refuse answers from any other instance. */
    function sameInstance(answer, route) {
        if (answer?.instance === japiInstance) return answer;
        log(`[config-vault] enterprise SSO refused: os-bridge ${route} answered for a different JAPI instance than bridge.japiInstance`);
        throw fault(503);
    }

    /** Casdoor login provider to preselect (`provider_hint`); best effort, cached, never blocks login. */
    async function loginProviderHint() {
        if (bridgeConfig && bridgeConfig.expiresAt > now()) return bridgeConfig.hint;
        let hint = null;
        try {
            const value = await callBridge('/internal/config', undefined, 3000);
            const name = value?.loginProvider?.name;
            if (typeof name === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(name)) hint = name;
            bridgeConfig = { hint, expiresAt: now() + BRIDGE_CONFIG_MS };
        } catch { bridgeConfig = { hint: null, expiresAt: now() + BRIDGE_CONFIG_FAILURE_MS }; }
        return hint;
    }

    /** Starts login: remembers state + PKCE verifier (encrypted, single use) and redirects to Casdoor. */
    async function start({ returnTo, write }) {
        const { authorization_endpoint: authorize } = await endpoints();
        const state = randomBytes(32).toString('base64url');
        const verifier = randomBytes(48).toString('base64url');
        await write(stateName(state), { verifier, returnTo: safeReturnPath(returnTo), expiresAt: now() + STATE_MS });
        const hint = await loginProviderHint();
        const url = new URL(authorize);
        url.search = new URLSearchParams({
            response_type: 'code', client_id: oidc.clientId, redirect_uri: redirectUri, scope: oidc.scope || 'openid profile email', state,
            code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
            ...(hint ? { provider_hint: hint } : {}),
        }).toString();
        return { location: url.toString(), cookie: `${OIDC_COOKIE}=${state}; Path=${prefix}/oidc; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_MS / 1000}` };
    }

    /** Finishes login: checks state against the browser cookie, exchanges the code, resolves the JAPI user. */
    async function finish({ query, cookieState, consume }) {
        const state = query.get('state'); const code = query.get('code');
        if (!state || !code || code.length > 4096 || !sameText(state, cookieState)) throw fault(401);
        const record = await consume(stateName(state));
        if (!record || record.expiresAt <= now()) throw fault(401);
        const { token_endpoint: tokenUrl } = await endpoints();
        let response;
        try {
            response = await fetchImpl(tokenUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: oidc.clientId, client_secret: oidc.clientSecret, code_verifier: record.verifier }).toString(),
                signal: AbortSignal.timeout(10000),
            });
        } catch { throw fault(503); }
        if (!response.ok) throw fault(401);
        const tokens = await response.json().catch(() => null);
        if (typeof tokens?.access_token !== 'string') throw fault(401);
        const me = sameInstance(await callBridge('/internal/me', tokens.access_token), '/internal/me');
        return { user: me.user, returnTo: record.returnTo };
    }

    /** Current JAPI status of an SSO session's account (blocks disabled / departed employees). */
    async function status(userId) {
        return sameInstance(await callBridge(`/internal/users/${encodeURIComponent(userId)}`), '/internal/users/:id').user;
    }

    /** The employee's own JAPI key packaged as a Jimage channel file (`infinite-canvas-channel` v1). */
    async function channelFile(userId) {
        if (!managedChannel?.baseUrl) throw fault(404);
        const { apiKey } = await callBridge(`/internal/users/${encodeURIComponent(userId)}/key`);
        if (typeof apiKey !== 'string' || !apiKey) throw fault(503);
        return { app: 'infinite-canvas-channel', version: 1, channel: { name: managedChannel.name || '企业模型网关', baseUrl: managedChannel.baseUrl, apiKey, models } };
    }

    return { start, finish, status, channelFile, sessionMs: Math.round(maxHours * 3600000) };
}

export function stateName(state) {
    return `${OIDC_STATE_DIR}/${createHash('sha256').update(state).digest('hex')}`;
}
