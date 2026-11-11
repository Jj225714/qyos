import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVaultHandler } from './server.mjs';
import { createEnterpriseSso, isPlaceholder, safeReturnPath } from './enterprise-sso.mjs';

async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
const readBody = async req => { let raw = ''; for await (const chunk of req) raw += chunk; return raw; };
const ORIGIN = 'https://vault.example';
const INSTANCE = 'japi-prod';

/** Casdoor + os-bridge + JAPI stand-ins around one vault. */
async function setup(t, { vaultOptions = {}, ssoOptions = {}, storeDir: givenStore } = {}) {
    const storeDir = givenStore || await mkdtemp(join(tmpdir(), 'config-vault-sso-'));
    const key = randomBytes(32);
    const codes = new Map(); // code -> { challenge, email }
    const people = new Map([['alice@acme.cn', { id: 41, email: 'alice@acme.cn', status: 'active' }], ['bob@acme.cn', { id: 42, email: 'bob@acme.cn', status: 'active' }]]);
    const env = { bridgeCalls: 0, configCalls: 0, instance: INSTANCE, bridgeConfig: { instance: INSTANCE, loginProvider: { type: 'lark', name: 'provider_lark' } }, bridgeConfigStatus: 200, logs: [], people };

    const casdoor = createServer(async (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/.well-known/openid-configuration') return res.end(JSON.stringify({ authorization_endpoint: `${casdoorUrl}/login/oauth/authorize`, token_endpoint: `${casdoorUrl}/api/login/oauth/access_token` }));
        if (req.url === '/api/login/oauth/access_token') {
            const form = new URLSearchParams(await readBody(req));
            const grant = codes.get(form.get('code'));
            const challenge = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
            if (!grant || form.get('client_secret') !== 'client-secret' || form.get('client_id') !== 'jimage' || form.get('redirect_uri') !== `${ORIGIN}/api/config-vault/oidc/callback` || grant.challenge !== challenge) { res.statusCode = 400; return res.end('{}'); }
            codes.delete(form.get('code'));
            return res.end(JSON.stringify({ access_token: `at:${grant.email}`, token_type: 'Bearer' }));
        }
        res.statusCode = 404; res.end('{}');
    });
    const casdoorUrl = await listen(casdoor);

    const bridge = createServer((req, res) => {
        env.bridgeCalls++;
        res.setHeader('content-type', 'application/json');
        if (req.headers['x-internal-token'] !== 'bridge-token') { res.statusCode = 401; return res.end('{}'); }
        if (req.url === '/internal/config') {
            env.configCalls++;
            res.statusCode = env.bridgeConfigStatus;
            return res.end(JSON.stringify(env.bridgeConfig));
        }
        if (req.url === '/internal/me') {
            const person = people.get(req.headers.authorization?.replace('Bearer at:', ''));
            if (!person || person.status !== 'active') { res.statusCode = 403; return res.end('{}'); }
            return res.end(JSON.stringify({ user: person, instance: env.instance }));
        }
        const match = /^\/internal\/users\/(\d+)(\/key)?$/.exec(req.url);
        const person = match && [...people.values()].find(p => p.id === Number(match[1]));
        if (!person) { res.statusCode = 404; return res.end('{}'); }
        return res.end(JSON.stringify(match[2] ? { apiKey: `sk-${person.id}` } : { user: person, instance: env.instance }));
    });
    const bridgeUrl = await listen(bridge);

    const authApi = createServer((req, res) => { res.statusCode = 401; res.end('{}'); });
    const authBaseUrl = await listen(authApi);
    const managedChannel = { name: '企业模型网关', baseUrl: 'https://llm.example/v1', models: [{ name: 'gpt-image-2', capability: 'image' }, { name: 'gpt-5', capability: 'text' }] };
    const handler = createVaultHandler({ origin: ORIGIN, authBaseUrl, storeDir, key, ssoRecheckMs: 0, ...vaultOptions, enterpriseSso: { oidc: { issuer: casdoorUrl, clientId: 'jimage', clientSecret: 'client-secret' }, bridge: { baseUrl: bridgeUrl, token: 'bridge-token', japiInstance: INSTANCE }, managedChannel, log: message => env.logs.push(message), ...ssoOptions } });
    const vault = createServer(handler);
    const base = await listen(vault);
    t.after(async () => { await Promise.all([close(vault), close(casdoor), close(bridge), close(authApi)]); await rm(storeDir, { recursive: true, force: true }); });

    const request = (route, { cookie, origin: sendOrigin = true, method = 'GET', body } = {}) => new Promise((resolve, reject) => {
        const headers = { host: 'vault.example', ...(sendOrigin ? { origin: ORIGIN } : {}), ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
        const req = httpRequest(base + route, { method, headers }, res => {
            let raw = ''; res.on('data', chunk => raw += chunk);
            res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, cookies: res.headers['set-cookie'] || [], body: raw && res.headers['content-type']?.includes('json') ? JSON.parse(raw) : raw }));
        });
        req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
    // Simulates the employee approving the login at Casdoor: returns the callback URL Casdoor redirects to.
    const approve = (location, email) => {
        const url = new URL(location);
        const code = randomBytes(16).toString('hex');
        codes.set(code, { challenge: url.searchParams.get('code_challenge'), email });
        return `/api/config-vault/oidc/callback?code=${code}&state=${encodeURIComponent(url.searchParams.get('state'))}`;
    };
    const cookieValue = (cookies, name) => cookies.map(c => c.split(';')[0]).find(c => c.startsWith(`${name}=`));
    /** Full login; returns the callback response and the new session cookie. */
    const login = async (email, { cookie } = {}) => {
        const started = await request('/api/config-vault/oidc/start?return=%2Fimage', { origin: false, cookie });
        const state = cookieValue(started.cookies, '__Secure-config_vault_oidc');
        const done = await request(approve(started.location, email), { origin: false, cookie: state });
        return { started, done, session: cookieValue(done.cookies, '__Secure-config_vault') };
    };
    return { env, storeDir, handler, request, approve, cookieValue, login, managedChannel };
}

test('return paths cannot leave the site', () => {
    assert.equal(safeReturnPath('/image?tab=1'), '/image?tab=1');
    for (const value of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '', null, '/a b']) assert.equal(safeReturnPath(value), '/');
});

test('config: japiInstance is required, sessionMaxHours is bounded, placeholder models are dropped', async () => {
    const base = { origin: ORIGIN, prefix: '/api/config-vault', oidc: { issuer: 'https://sso.example', clientId: 'c', clientSecret: 's' }, log: () => {} };
    assert.throws(() => createEnterpriseSso({ ...base, bridge: { baseUrl: 'http://127.0.0.1:3291', token: 't' } }), /japiInstance/);
    assert.throws(() => createEnterpriseSso({ ...base, bridge: { baseUrl: 'http://127.0.0.1:3291', token: 't', japiInstance: '<与 os-bridge 配置 japi.instance 相同的值>' } }), /japiInstance/);
    const bridge = { baseUrl: 'http://127.0.0.1:3291', token: 't', japiInstance: INSTANCE };
    assert.equal(createEnterpriseSso({ ...base, bridge }).sessionMs, 12 * 3600000);
    assert.equal(createEnterpriseSso({ ...base, bridge, sessionMaxHours: 2 }).sessionMs, 2 * 3600000);
    for (const bad of [0, -1, 1000, 'x']) assert.throws(() => createEnterpriseSso({ ...base, bridge, sessionMaxHours: bad }), /sessionMaxHours/);
    assert.ok(isPlaceholder('<文本模型名>') && !isPlaceholder('gpt-5'));
    const sso = createEnterpriseSso({ ...base, bridge, managedChannel: { baseUrl: 'https://llm.example/v1', models: [{ name: 'gpt-image-2', capability: 'image' }, { name: '<文本模型名>', capability: 'text' }] }, fetchImpl: async () => new Response(JSON.stringify({ apiKey: 'sk' }), { status: 200 }) });
    assert.deepEqual((await sso.channelFile(1)).channel.models, [{ name: 'gpt-image-2', capability: 'image' }]);
});

test('example config parses and points at the internal bridge port', async () => {
    const example = JSON.parse(await readFile(new URL('./sso-config.example.json', import.meta.url), 'utf8'));
    assert.equal(example.bridge.baseUrl, 'http://127.0.0.1:3291');
    assert.ok('japiInstance' in example.bridge);
    assert.equal(example.sessionMaxHours, 12);
    assert.ok(example.managedChannel.models.every(model => !isPlaceholder(model.name)));
});

test('enterprise SSO: Casdoor code flow, os-bridge identity, re-checks and managed channel', async t => {
    const { env, storeDir, request, approve, cookieValue, managedChannel } = await setup(t);

    // 1. Start: top-level navigation without Origin is accepted and redirects to Casdoor with PKCE.
    const started = await request('/api/config-vault/oidc/start?return=%2Fimage%3Fx%3D1', { origin: false });
    assert.equal(started.status, 302);
    const authorize = new URL(started.location);
    assert.equal(authorize.pathname, '/login/oauth/authorize');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('redirect_uri'), `${ORIGIN}/api/config-vault/oidc/callback`);
    const stateCookie = cookieValue(started.cookies, '__Secure-config_vault_oidc');
    assert.match(started.cookies[0], /Path=\/api\/config-vault\/oidc; HttpOnly; Secure; SameSite=Lax/);

    // 2. Callback without the browser's state cookie (login CSRF) fails.
    const forged = await request(approve(started.location, 'alice@acme.cn'), { origin: false });
    assert.equal(forged.location, '/#server-config-sso=failed');

    // 3. Proper callback creates a session and returns to the requested page.
    const again = await request('/api/config-vault/oidc/start?return=%2Fimage%3Fx%3D1', { origin: false });
    const againState = cookieValue(again.cookies, '__Secure-config_vault_oidc');
    const callback = approve(again.location, 'alice@acme.cn');
    const done = await request(callback, { origin: false, cookie: againState });
    assert.equal(done.status, 302);
    assert.equal(done.location, '/image?x=1');
    const session = cookieValue(done.cookies, '__Secure-config_vault');
    assert.ok(session);
    assert.ok(done.cookies.some(c => c.startsWith('__Secure-config_vault_oidc=;') && c.includes('Max-Age=0')));
    assert.ok(done.cookies.some(c => c.startsWith('__Secure-provider_tasks=')));
    // Default absolute lifetime: 12 hours, not the 7-day password session.
    assert.ok(done.cookies.some(c => c.startsWith('__Secure-config_vault=') && c.includes(`Max-Age=${12 * 3600}`)));

    // 4. Replaying the same callback (state already consumed) fails.
    const replay = await request(callback, { origin: false, cookie: againState });
    assert.equal(replay.location, '/#server-config-sso=failed');
    assert.ok(stateCookie !== againState);

    // 5. Session works and is flagged managed; the managed channel carries the employee's own key.
    const me = await request('/api/config-vault/session', { cookie: session });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.user, { id: 41, email: 'alice@acme.cn', managed: true });
    const channel = await request('/api/config-vault/managed-channel', { cookie: session });
    assert.deepEqual(channel.body, { app: 'infinite-canvas-channel', version: 1, channel: { ...managedChannel, apiKey: 'sk-41' } });
    // Existing vault features keep working on SSO sessions.
    assert.equal((await request('/api/config-vault/config', { cookie: session })).status, 200);

    // 6. No state or secret is stored in plaintext.
    for (const file of await readdir(storeDir, { recursive: true })) {
        if (!file.endsWith('.enc')) continue;
        const raw = await readFile(join(storeDir, file), 'utf8');
        assert.ok(!raw.includes('alice@acme.cn') && !raw.includes('sk-41'));
    }

    // 7. Unknown employees (bridge refuses) do not get a session.
    const stranger = await request('/api/config-vault/oidc/start', { origin: false });
    const strangerDone = await request(approve(stranger.location, 'eve@acme.cn'), { origin: false, cookie: cookieValue(stranger.cookies, '__Secure-config_vault_oidc') });
    assert.equal(strangerDone.location, '/#server-config-sso=failed');

    // 8. Disabled in JAPI / Casdoor (departed employee) → the next request ends the session.
    const before = env.bridgeCalls;
    env.people.get('alice@acme.cn').status = 'disabled';
    assert.equal((await request('/api/config-vault/session', { cookie: session })).status, 401);
    assert.ok(env.bridgeCalls > before);
    env.people.get('alice@acme.cn').status = 'active';
    assert.equal((await request('/api/config-vault/session', { cookie: session })).status, 401, 'deleted sessions stay deleted');
});

test('JAPI instance mismatch refuses SSO logins and running SSO sessions', async t => {
    const { env, request, login } = await setup(t);
    const { session } = await login('alice@acme.cn');
    assert.equal((await request('/api/config-vault/session', { cookie: session })).status, 200);

    env.instance = 'japi-other';
    const refused = await login('bob@acme.cn');
    assert.equal(refused.done.location, '/#server-config-sso=unavailable');
    assert.equal(refused.session, undefined);
    // An existing session is re-checked against /internal/users/:id and refused too.
    assert.equal((await request('/api/config-vault/session', { cookie: session })).status, 503);
    // A missing instance label is a mismatch as well.
    env.instance = undefined;
    assert.equal((await request('/api/config-vault/session', { cookie: session })).status, 503);

    assert.ok(env.logs.length >= 2 && env.logs.every(line => /instance/.test(line)));
    for (const line of env.logs) assert.ok(!/alice|bob|@acme|bridge-token|sk-|japi-other/.test(line), 'logs carry no identities, tokens or bridge answers');

    env.instance = INSTANCE;
    assert.equal((await request('/api/config-vault/session', { cookie: session })).status, 200);
});

test('SSO sessions end after sessionMaxHours; password-session length is unaffected', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const { request, login } = await setup(t, { ssoOptions: { sessionMaxHours: 2 } });
    const { done, session } = await login('alice@acme.cn');
    assert.ok(done.cookies.some(c => c.startsWith('__Secure-config_vault=') && c.includes(`Max-Age=${2 * 3600}`)));
    t.mock.timers.tick(2 * 3600000 - 60000);
    assert.equal((await request('/api/config-vault/session', { cookie: session })).status, 200);
    t.mock.timers.tick(60000);
    assert.equal((await request('/api/config-vault/session', { cookie: session })).status, 401);
    // A fresh enterprise login is required (and works).
    const again = await login('alice@acme.cn');
    assert.equal((await request('/api/config-vault/session', { cookie: again.session })).status, 200);
});

test('expired pending-login records are cleaned up at startup and on later starts', async t => {
    const storeDir = await mkdtemp(join(tmpdir(), 'config-vault-sso-prune-'));
    await mkdir(join(storeDir, 'oidc'), { recursive: true });
    const stale = join(storeDir, 'oidc', `${'a'.repeat(64)}.enc`);
    const fresh = join(storeDir, 'oidc', `${'b'.repeat(64)}.enc`);
    const unrelated = join(storeDir, 'oidc', 'keep.txt');
    for (const file of [stale, fresh, unrelated]) await writeFile(file, '{}');
    const old = new Date(Date.now() - 3600000);
    await utimes(stale, old, old);
    await utimes(unrelated, old, old);

    const { handler, request, storeDir: dir } = await setup(t, { storeDir, vaultOptions: { oidcPruneIntervalMs: 0 } });
    assert.equal(await handler.oidcPruned, 1);
    const names = async () => (await readdir(join(dir, 'oidc'))).sort();
    assert.deepEqual(await names(), [`${'b'.repeat(64)}.enc`, 'keep.txt']);

    // A record abandoned later is removed by the cleanup that runs alongside a subsequent start.
    await utimes(fresh, old, old);
    const started = await request('/api/config-vault/oidc/start', { origin: false });
    assert.equal(started.status, 302);
    await handler.pruneOidcStates();
    const left = await names();
    assert.ok(!left.includes(`${'b'.repeat(64)}.enc`));
    assert.equal(left.filter(name => name.endsWith('.enc')).length, 1, 'the new pending login stays');
});

test('starting an enterprise login revokes the session the browser presents', async t => {
    const { request, login, cookieValue } = await setup(t);
    const first = await login('alice@acme.cn');
    assert.equal((await request('/api/config-vault/session', { cookie: first.session })).status, 200);

    // Same-site navigation to /oidc/start carries the Strict session cookie.
    const started = await request('/api/config-vault/oidc/start', { origin: false, cookie: first.session });
    assert.equal(started.status, 302);
    assert.ok(started.cookies.some(c => c.startsWith('__Secure-config_vault=;') && c.includes('Max-Age=0')));
    assert.ok(started.cookies.some(c => c.startsWith('__Secure-provider_tasks=;') && c.includes('Max-Age=0')));
    assert.ok(cookieValue(started.cookies, '__Secure-config_vault_oidc'));
    assert.equal((await request('/api/config-vault/session', { cookie: first.session })).status, 401);
});

test('authorization URL carries provider_hint from os-bridge, cached, and login works without it', async t => {
    const { env, request } = await setup(t);
    const first = await request('/api/config-vault/oidc/start', { origin: false });
    assert.equal(new URL(first.location).searchParams.get('provider_hint'), 'provider_lark');
    await request('/api/config-vault/oidc/start', { origin: false });
    assert.equal(env.configCalls, 1, 'bridge config is cached');

    const { env: env2, request: request2, login: login2 } = await setup(t);
    env2.bridgeConfigStatus = 500;
    const plain = await request2('/api/config-vault/oidc/start', { origin: false });
    assert.equal(plain.status, 302);
    assert.equal(new URL(plain.location).searchParams.has('provider_hint'), false);
    const { session } = await login2('alice@acme.cn');
    assert.equal((await request2('/api/config-vault/session', { cookie: session })).status, 200);

    const { env: env3, request: request3 } = await setup(t);
    env3.bridgeConfig = { instance: INSTANCE, loginProvider: null };
    assert.equal(new URL((await request3('/api/config-vault/oidc/start', { origin: false })).location).searchParams.has('provider_hint'), false);
});

test('the vault drops the managed channel from saved personal configuration', async t => {
    const { request, login } = await setup(t);
    const { session } = await login('alice@acme.cn');
    // The legacy /config route shares cleanConfig with /settings/personal.
    const channel = (id, apiKey) => ({ id, name: id, baseUrl: 'https://llm.example/v1', apiKey, apiFormat: 'openai', models: [] });
    const saved = await request('/api/config-vault/config', { cookie: session, method: 'PUT', body: { revision: 0, config: { channels: [channel('mine', 'sk-mine'), channel('managed-enterprise', 'sk-41')] } } });
    assert.equal(saved.status, 200);
    const stored = await request('/api/config-vault/config', { cookie: session });
    assert.deepEqual(stored.body.config.channels.map(c => c.id), ['mine']);
    assert.ok(!JSON.stringify(stored.body).includes('sk-41'));
});

test('SSO routes are absent unless configured, and managed-channel needs an SSO session', async t => {
    const storeDir = await mkdtemp(join(tmpdir(), 'config-vault-nosso-'));
    const vault = createServer(createVaultHandler({ origin: ORIGIN, authBaseUrl: 'http://127.0.0.1:9', storeDir, key: randomBytes(32) }));
    const base = await listen(vault);
    t.after(async () => { await close(vault); await rm(storeDir, { recursive: true, force: true }); });
    const status = route => new Promise((resolve, reject) => {
        const req = httpRequest(base + route, { headers: { host: 'vault.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject); req.end();
    });
    assert.equal(await status('/api/config-vault/oidc/start'), 403);
});
