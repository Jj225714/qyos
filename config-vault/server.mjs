import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, open, opendir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSettingsService } from './settings.mjs';
import { createAssetService } from './asset-service.mjs';
import { createMembershipService } from './membership-service.mjs';
import { createEnterpriseSso, OIDC_COOKIE, OIDC_STATE_DIR, STATE_MS } from './enterprise-sso.mjs';

const PREFIX = '/api/config-vault';
const COOKIE = '__Secure-config_vault';
const TASK_COOKIE = '__Secure-provider_tasks';
const SESSION_MS = 7 * 86400000;
/** Fixed id of the enterprise-managed channel; it carries a per-employee key and is never stored in personal settings. */
export const MANAGED_CHANNEL_ID = 'managed-enterprise';
/** Upper bound of pending-login records examined per cleanup pass. */
const OIDC_PRUNE_SCAN = 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
export function encrypt(value, key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}
export function decrypt(value, key) {
    const envelope = JSON.parse(value);
    if (envelope.v !== 1) throw new Error('Invalid record');
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]).toString('utf8'));
}
export async function writeEncrypted(path, value, key) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
    try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(encrypt(value, key)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, path);
        if (process.platform !== 'win32') {
            const directory = await open(dirname(path), 'r');
            try { await directory.sync(); } finally { await directory.close(); }
        }
    } finally { await unlink(temporary).catch(() => {}); }
}
const fault = status => Object.assign(new Error('Request failed'), { status });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, max = 32768) => typeof value === 'string' && value.length <= max;
const fields = new Set('channelMode baseUrl apiKey apiFormat channels model imageModel videoModel textModel audioModel audioVoice audioFormat audioSpeed audioInstructions videoSeconds vquality videoGenerateAudio videoWatermark videoMode systemPrompt reasoningEffort models quality size background count canvasImageCount editorBindings'.split(' '));
function cleanConfig(value) {
    if (!plain(value) || !Array.isArray(value.channels) || value.channels.length > 100) throw fault(400);
    const config = {};
    // The managed channel is fetched per session; it must never be persisted with personal settings.
    value = { ...value, channels: value.channels.filter(channel => !(plain(channel) && channel.id === MANAGED_CHANNEL_ID)) };
    for (const [name, field] of Object.entries(value)) {
        if (['managedPrincipalId', 'proxyEnabled', 'proxyUrl'].includes(name)) continue;
        if (!fields.has(name)) throw fault(400);
        config[name] = field;
    }
    for (const [name, field] of Object.entries(config)) {
        if (['channels', 'models', 'editorBindings'].includes(name)) continue;
        if (!string(field)) throw fault(400);
    }
    if (config.models !== undefined && (!Array.isArray(config.models) || config.models.length > 1000 || !config.models.every(v => string(v, 512)))) throw fault(400);
    if (config.editorBindings !== undefined && (!plain(config.editorBindings) || Object.keys(config.editorBindings).length > 100 || !Object.values(config.editorBindings).every(v => string(v, 1024)))) throw fault(400);
    const ids = new Set();
    for (const channel of config.channels) {
        if (!plain(channel) || !string(channel.id, 128) || !channel.id || ids.has(channel.id) || !string(channel.name, 512) || !string(channel.baseUrl, 4096) || !string(channel.apiKey) || !['openai', 'gemini'].includes(channel.apiFormat) || !Array.isArray(channel.models) || channel.models.length > 1000) throw fault(400);
        ids.add(channel.id);
        if (channel.baseUrl) { try { if (!['http:', 'https:'].includes(new URL(channel.baseUrl).protocol)) throw Error(); } catch { throw fault(400); } }
        if (Object.keys(channel).some(k => !['id', 'name', 'baseUrl', 'apiKey', 'apiFormat', 'models', 'provider'].includes(k)) || (channel.provider !== undefined && !string(channel.provider, 128))) throw fault(400);
        for (const model of channel.models) {
            if (!plain(model) || (model.supportsImageInput !== undefined && typeof model.supportsImageInput !== 'boolean') || !string(model.name, 512) || !['image', 'video', 'text', 'audio'].includes(model.capability) || (model.script !== undefined && !string(model.script)) || (model.editorOperations !== undefined && (!Array.isArray(model.editorOperations) || model.editorOperations.length > 100 || !model.editorOperations.every(v => string(v, 128)))) || Object.keys(model).some(k => !['name', 'capability', 'supportsImageInput', 'script', 'editorOperations'].includes(k))) throw fault(400);
        }
    }
    return config;
}

export function createVaultHandler({ origin, authBaseUrl, storeDir, key, fetchImpl = fetch, adminUsersFile, publicRulesDir, assetQuotaBytes, enterpriseSso, ssoRecheckMs = 60000, oidcPruneIntervalMs = 60000 }) {
    const expected = new URL(origin);
    if (expected.origin !== origin || key.length !== 32) throw new Error('Invalid settings');
    const sso = enterpriseSso ? createEnterpriseSso({ origin, prefix: PREFIX, fetchImpl, ...enterpriseSso }) : null;
    const locks = new Map();
    const rates = new Map();
    const path = name => join(storeDir, `${name}.enc`);
    const read = async name => { try { return decrypt(await readFile(path(name), 'utf8'), key); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
    async function locked(name, work) {
        const previous = locks.get(name) || Promise.resolve();
        const current = previous.catch(() => {}).then(work);
        locks.set(name, current);
        try { return await current; } finally { if (locks.get(name) === current) locks.delete(name); }
    }
    const upstream = async (route, options) => {
        let response;
        try { response = await fetchImpl(`${authBaseUrl}${route}`, { ...options, signal: AbortSignal.timeout(10000) }); } catch { throw fault(503); }
        if (!response.ok) throw fault([400, 401, 403].includes(response.status) ? 401 : 503);
        try { return (await response.json()).data; } catch { throw fault(503); }
    };
    const post = data => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const validUser = user => {
        if (!user || !/^[1-9][0-9]{0,19}$/.test(String(user.id)) || !string(user.email, 512) || user.status !== 'active') throw fault(401);
        return { id: user.id, email: user.email };
    };
    const cookie = (id, age, cookiePath = PREFIX, name = COOKIE) => `${name}=${id}; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
    const setSessionCookie = (res, id, age) => res.setHeader('Set-Cookie', [
        cookie(id, age),
        cookie(id, age, '/api/providers', TASK_COOKIE),
        // Remove the broad-path cookie from the withdrawn migration design.
        cookie('', 0, '/api'),
    ]);
    function presentedIds(req) {
        return (req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${COOKIE}=`) || v.startsWith(`${TASK_COOKIE}=`)).map(v => v.slice(v.indexOf('=') + 1));
    }
    async function revokePresented(req) {
        const ids = [...new Set(presentedIds(req).filter(id => /^[A-Za-z0-9_-]{43}$/.test(id)))];
        for (const id of ids) await locked(`session-${hash(id)}`, async () => {
            try { await unlink(path(`session-${hash(id)}`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        });
    }
    async function createSession(auth, req, res) {
        const user = validUser(await upstream('/auth/me', { headers: { authorization: `Bearer ${auth.access_token}` } }));
        if (!string(auth.access_token) || !string(auth.refresh_token) || String(user.id) !== String(auth.user?.id)) throw fault(401);
        // Switching accounts rotates identity and invalidates both old-path and new-path sessions.
        await revokePresented(req);
        const id = randomBytes(32).toString('base64url');
        await writeEncrypted(path(`session-${hash(id)}`), { user, auth, expiresAt: Date.now() + SESSION_MS, tokenExpiresAt: Date.now() + Number(auth.expires_in || 3600) * 1000 }, key);
        setSessionCookie(res, id, SESSION_MS / 1000);
        return user;
    }
    // SSO sessions hold no JAPI tokens: identity is re-checked against JAPI through os-bridge.
    // They also have an absolute lifetime (sessionMaxHours), after which enterprise login is required again.
    async function createSsoSession(rawUser, req, res, extraCookies) {
        const user = validUser(rawUser);
        await revokePresented(req);
        const id = randomBytes(32).toString('base64url');
        const createdAt = Date.now();
        const lifetime = Math.min(SESSION_MS, sso.sessionMs);
        await writeEncrypted(path(`session-${hash(id)}`), { kind: 'sso', user, createdAt, expiresAt: createdAt + lifetime, checkedAt: createdAt }, key);
        setSessionCookie(res, id, Math.floor(lifetime / 1000));
        res.setHeader('Set-Cookie', [...res.getHeader('Set-Cookie'), ...extraCookies]);
        return user;
    }
    function sessionName(req) {
        const ids = presentedIds(req);
        // Cookie headers omit Path: never select the first of ambiguous account cookies.
        const id = ids.length === 1 ? ids[0] : null;
        return id && /^[A-Za-z0-9_-]{43}$/.test(id) ? `session-${hash(id)}` : null;
    }
    async function authenticate(req) {
        const name = sessionName(req);
        if (!name) throw fault(401);
        return locked(name, async () => {
            const session = await read(name);
            if (!session) throw fault(401);
            try {
                if (session.expiresAt <= Date.now()) throw fault(401);
                if (session.kind === 'sso') {
                    if (!sso) throw fault(401);
                    // Also enforces a lowered sessionMaxHours on sessions issued before the change.
                    if (!Number.isFinite(session.createdAt) || session.createdAt + sso.sessionMs <= Date.now()) throw fault(401);
                    if (session.checkedAt + ssoRecheckMs <= Date.now()) {
                        const current = validUser(await sso.status(session.user.id));
                        if (String(current.id) !== String(session.user.id) || current.email.toLowerCase() !== session.user.email.toLowerCase()) throw fault(401);
                        session.checkedAt = Date.now();
                        await writeEncrypted(path(name), session, key);
                    }
                    return { user: session.user, name, expiresAt: session.expiresAt, sso: true };
                }
                let refreshed = false;
                async function refresh() {
                    const auth = await upstream('/auth/refresh', post({ refresh_token: session.auth.refresh_token }));
                    if (!string(auth?.access_token) || !string(auth?.refresh_token)) throw fault(401);
                    session.auth = auth;
                    session.tokenExpiresAt = Date.now() + Number(auth.expires_in || 3600) * 1000;
                    refreshed = true;
                }
                if (session.tokenExpiresAt <= Date.now() + 30000) await refresh();
                let current;
                try { current = await upstream('/auth/me', { headers: { authorization: `Bearer ${session.auth.access_token}` } }); }
                catch (error) { if (error.status !== 401 || refreshed) throw error; await refresh(); current = await upstream('/auth/me', { headers: { authorization: `Bearer ${session.auth.access_token}` } }); }
                const user = validUser(current);
                if (String(user.id) !== String(session.user.id)) throw fault(401);
                if (refreshed) await writeEncrypted(path(name), session, key);
                return { user, name, expiresAt: session.expiresAt };
            } catch (error) { if (error.status === 401) await unlink(path(name)).catch(() => {}); throw error; }
        });
    }
    async function body(req, limit = 256 * 1024) {
        if (!req.headers['content-type']?.startsWith('application/json')) throw fault(415);
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > limit) throw fault(413); chunks.push(chunk); }
        try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!plain(value)) throw Error(); return value; } catch { throw fault(400); }
    }
    function rateLimit(req) {
        const address = req.socket.remoteAddress;
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
        const ip = local && typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'] : address;
        const now = Date.now();
        for (const [ip, record] of rates) if (record.until <= now) rates.delete(ip);
        let record = rates.get(ip);
        if (!record) { if (rates.size >= 10000) throw fault(429); record = { count: 0, until: now + 60000 }; rates.set(ip, record); }
        if (++record.count > 10) throw fault(429);
    }
    // Pending-login records never consumed (abandoned logins) are removed by file age, a bounded batch per pass.
    let lastOidcPrune = 0;
    async function pruneOidcStates() {
        lastOidcPrune = Date.now();
        let directory;
        try { directory = await opendir(join(storeDir, OIDC_STATE_DIR)); } catch { return 0; }
        let scanned = 0; let removed = 0;
        try {
            for await (const entry of directory) {
                if (++scanned > OIDC_PRUNE_SCAN) break;
                if (!entry.isFile() || !/^[0-9a-f]{64}\.enc$/.test(entry.name)) continue;
                const file = join(storeDir, OIDC_STATE_DIR, entry.name);
                try {
                    if ((await stat(file)).mtimeMs + STATE_MS < Date.now()) { await unlink(file); removed++; }
                } catch { /* consumed concurrently */ }
            }
        } finally { await directory.close().catch(() => {}); }
        return removed;
    }
    const pruneOidcStatesSoon = () => { if (Date.now() - lastOidcPrune >= oidcPruneIntervalMs) pruneOidcStates().catch(() => {}); };
    const oidcPruned = sso ? pruneOidcStates().catch(() => 0) : Promise.resolve(0);
    const settings = createSettingsService({ read, write: (name, value) => writeEncrypted(path(name), value, key), locked, body, cleanConfig, adminUsersFile, publicRulesDir });
    const memberships = createMembershipService({ storeDir, read, write: (name, value) => writeEncrypted(path(name), value, key), body });
    const assets = createAssetService({ storeDir, read, write: (name, value) => writeEncrypted(path(name), value, key), body, memberships, quotaBytes: assetQuotaBytes });
    const handler = async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const send = value => res.end(JSON.stringify(value));
        try {
            if (sso && req.method === 'GET' && req.headers.host === expected.host && (req.url.startsWith(`${PREFIX}/oidc/start?`) || req.url === `${PREFIX}/oidc/start` || req.url.startsWith(`${PREFIX}/oidc/callback?`))) {
                // Top-level navigations: no Origin header; protected by state cookie + single-use state record + PKCE.
                const url = new URL(req.url, origin);
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                const redirect = (location, cookies = []) => { res.statusCode = 302; res.setHeader('Location', location); if (cookies.length) res.setHeader('Set-Cookie', [...(res.getHeader('Set-Cookie') || []), ...cookies]); res.end(); };
                const clearState = `${OIDC_COOKIE}=; Path=${PREFIX}/oidc; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
                if (url.pathname === `${PREFIX}/oidc/start`) {
                    rateLimit(req);
                    pruneOidcStatesSoon();
                    // Start is a same-site top-level navigation, so SameSite=Strict session cookies arrive here
                    // (unlike on the cross-site callback): end the session this browser holds before switching.
                    if (presentedIds(req).length) { await revokePresented(req); setSessionCookie(res, '', 0); }
                    const started = await sso.start({ returnTo: url.searchParams.get('return'), write: (name, value) => writeEncrypted(path(name), value, key) });
                    return redirect(started.location, [started.cookie]);
                }
                const cookieState = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${OIDC_COOKIE}=`))?.slice(OIDC_COOKIE.length + 1);
                try {
                    const result = await sso.finish({ query: url.searchParams, cookieState, consume: name => locked(name, async () => { const value = await read(name); await unlink(path(name)).catch(() => {}); return value; }) });
                    await createSsoSession(result.user, req, res, [clearState]);
                    return redirect(result.returnTo);
                } catch (error) {
                    return redirect(`/#server-config-sso=${error.status === 503 ? 'unavailable' : 'failed'}`, [clearState]);
                }
            }
            if (req.headers.host !== expected.host || (req.headers.origin !== origin && !(req.method === 'GET' && !req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin'))) throw fault(403);
            const route = req.url;
            if (req.method === 'POST' && route === `${PREFIX}/login`) {
                rateLimit(req); const input = await body(req);
                if (!string(input.email, 512) || !string(input.password, 4096) || !input.email || !input.password) throw fault(400);
                const auth = await upstream('/auth/login', post({ email: input.email, password: input.password }));
                return send({ user: await createSession(auth, req, res) });
            }
            if (req.method === 'POST' && route === `${PREFIX}/bootstrap`) {
                rateLimit(req); const input = await body(req);
                if (!/^[A-Za-z0-9_-]{43}$/.test(input.code)) throw fault(400);
                return await locked(`bootstrap-${hash(input.code)}`, async () => {
                    const name = `bootstrap-${hash(input.code)}`;
                    const record = await read(name);
                    if (!record || new Date(record.expiresAt).getTime() <= Date.now() || !Number.isFinite(new Date(record.expiresAt).getTime())) throw fault(401);
                    // Consume before issuing a session so crashes cannot replay a bootstrap.
                    await unlink(path(name));
                    const user = await createSession(record.auth, req, res);
                    send({ user, bootstrapRevision: record.revision });
                });
            }
            if (req.method === 'POST' && route === `${PREFIX}/logout`) {
                await revokePresented(req);
                setSessionCookie(res, '', 0); return send({ ok: true });
            }
            if (presentedIds(req).length > 1) { setSessionCookie(res, '', 0); throw fault(401); }
            // The task-cookie name is an identity-check transport, not another public vault API.
            if (req.headers.cookie?.split(';').some(v => v.trim().startsWith(`${TASK_COOKIE}=`)) && !(req.method === 'GET' && route === `${PREFIX}/session`)) throw fault(401);
            const session = await authenticate(req);
            // Also migrate existing sessions after live /auth/me validation; do not extend expiry.
            setSessionCookie(res, presentedIds(req)[0], Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)));
            if (route === `${PREFIX}/memberships` || route.startsWith(`${PREFIX}/memberships/`) || route.startsWith(`${PREFIX}/memberships?`)) {
                return await locked(session.name, async () => {
                    if (!(await read(session.name))) throw fault(401);
                    return memberships.handle(req, res, session, send);
                });
            }
            if (route === `${PREFIX}/asset-library` || route.startsWith(`${PREFIX}/asset-library/`) || route.startsWith(`${PREFIX}/asset-library?`)) {
                return await locked(session.name, async () => {
                    if (!(await read(session.name))) throw fault(401);
                    return assets.handle(req, res, session, send);
                });
            }
            if (req.method === 'GET' && route === `${PREFIX}/session`) return send({ user: session.sso ? { ...session.user, managed: true } : session.user });
            if (req.method === 'GET' && route === `${PREFIX}/managed-channel`) {
                if (!session.sso || !sso) throw fault(404);
                return send(await sso.channelFile(session.user.id));
            }
            if (route.startsWith(`${PREFIX}/settings`) || route.startsWith(`${PREFIX}/assets`)) {
                return await settings.handle(req, res, session, send);
            }
            const name = `user-${session.user.id}`;
            if (req.method === 'GET' && route === `${PREFIX}/config`) {
                const record = await read(name);
                return send(record ? { revision: record.revision, config: record.config, savedAt: record.savedAt } : { revision: 0, config: null, savedAt: null });
            }
            if (req.method === 'PUT' && route === `${PREFIX}/config`) {
                const input = await body(req);
                if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw fault(400);
                const config = cleanConfig(input.config);
                return await locked(session.name, () => locked(name, async () => {
                    if (!(await read(session.name))) throw fault(401);
                    const old = await read(name);
                    if ((old?.revision || 0) !== input.revision) throw fault(409);
                    const savedAt = new Date().toISOString(); const revision = input.revision + 1;
                    await writeEncrypted(path(name), { ...old, revision, config, savedAt, source: 'browser', channelCount: config.channels.length, updatedAt: savedAt }, key);
                    send({ revision, savedAt });
                }));
            }
            throw fault(404);
        } catch (error) { if (!res.writableEnded) { res.statusCode = error.status || 500; send({ error: res.statusCode === 409 ? 'Configuration conflict' : res.statusCode === 422 ? error.message : 'Request failed' }); } }
    };
    // For tests and maintenance: the startup cleanup pass, and a manual trigger.
    handler.oidcPruned = oidcPruned;
    handler.pruneOidcStates = pruneOidcStates;
    return handler;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const args = Object.fromEntries(Array.from({ length: Math.floor((process.argv.length - 2) / 2) }, (_, index) => process.argv.slice(index * 2 + 2, index * 2 + 4)));
    const key = await readFile(args['--key-file']);
    // Optional enterprise SSO (Casdoor + os-bridge): enabled only when --sso-config is given.
    const enterpriseSso = args['--sso-config'] ? await (async () => {
        const config = JSON.parse(await readFile(args['--sso-config'], 'utf8'));
        const secret = file => readFile(file, 'utf8').then(v => v.trim());
        return { oidc: { ...config.oidc, clientSecret: await secret(config.oidc.clientSecretFile) }, bridge: { baseUrl: config.bridge.baseUrl, japiInstance: config.bridge.japiInstance, token: await secret(config.bridge.tokenFile) }, managedChannel: config.managedChannel, sessionMaxHours: config.sessionMaxHours };
    })() : undefined;
    createServer(createVaultHandler({ origin: args['--origin'], authBaseUrl: args['--auth-base'], storeDir: args['--store'], key, adminUsersFile: args['--admin-users-file'], publicRulesDir: args['--public-rules-dir'], enterpriseSso })).listen(Number(args['--port'] || 3183), '127.0.0.1');
}
