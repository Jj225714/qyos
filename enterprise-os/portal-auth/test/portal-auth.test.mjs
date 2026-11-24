// SSO-20261115-05 Chunk 3: portal-auth against a fake Casdoor and a fake os-bridge (mock tests, not live).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, readSecret } from '../src/config.mjs';
import { configPathFromArgs } from '../src/server.mjs';
import { BRIDGE_TOKEN, CLIENT_ID, CLIENT_SECRET, INSTANCE, Jar, ORIGIN, call, listen, rig } from './helpers.mjs';

const secretsIn = text => [CLIENT_SECRET, BRIDGE_TOKEN, 'access-1', 'access-2', 'refresh-cas', 'eyJ'].filter(secret => text.includes(secret));

test('P1 /auth/me without a session: 401, no-store, no-referrer', async t => {
    const r = await rig(); t.after(r.close);
    const res = await r.me(new Jar());
    assert.equal(res.status, 401);
    assert.deepEqual(res.json(), { signedIn: false });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
});

test('P2 /auth/login: authorize parameters, provider_hint, transaction cookie', async t => {
    const r = await rig(); t.after(r.close);
    const jar = new Jar();
    const { start, authorize } = await r.login(jar, 1, { mutate: () => {} }).catch(() => ({}));
    assert.equal(start.status, 302);
    assert.equal(authorize.origin + authorize.pathname, `${r.casdoor.issuer}/login/oauth/authorize`);
    const p = authorize.searchParams;
    assert.equal(p.get('client_id'), CLIENT_ID);
    assert.equal(p.get('redirect_uri'), `${ORIGIN}/auth/callback`);
    assert.equal(p.get('response_type'), 'code');
    assert.equal(p.get('scope'), 'openid profile email');
    assert.equal(p.get('code_challenge_method'), 'S256');
    assert.ok(Buffer.from(p.get('state'), 'base64url').length >= 32);
    assert.ok(Buffer.from(p.get('nonce'), 'base64url').length >= 32);
    assert.equal(p.get('provider_hint'), 'provider_lark');
    assert.ok(!p.has('client_secret'));
    const txn = start.cookies.find(c => c.startsWith('__Host-qyos_portal_txn='));
    assert.match(txn, /; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
    // provider_hint is best effort: omitted when os-bridge /internal/config fails.
    r.bridge.state.configDown = true;
    const r2 = await rig(); t.after(r2.close);
    r2.bridge.state.configDown = true;
    const second = await call(r2.portal.url, '/auth/login');
    assert.equal(second.status, 302);
    assert.ok(!new URL(second.location).searchParams.has('provider_hint'));
});

test('P3 callback negatives: missing/mismatched cookie, unknown/expired/replayed state, IdP error → no session', async t => {
    const r = await rig(); t.after(r.close);
    r.person(1);
    const expectRefused = async (outcome, code) => {
        assert.equal(outcome.done.status, 303);
        assert.equal(outcome.done.location, `/?login_error=${code}`);
        assert.ok(outcome.done.cookies.some(c => c.startsWith('__Host-qyos_portal_txn=;')), 'transaction cookie cleared');
        assert.ok(!outcome.done.cookies.some(c => c.startsWith('__Host-qyos_portal=') && !c.startsWith('__Host-qyos_portal=;')), 'no session cookie');
    };
    await expectRefused(await r.login(new Jar(), 1, { mutate: (q, jar) => jar.values.delete('__Host-qyos_portal_txn') }), 'state');
    await expectRefused(await r.login(new Jar(), 1, { mutate: (q, jar) => jar.values.set('__Host-qyos_portal_txn', 'x'.repeat(43)) }), 'state');
    await expectRefused(await r.login(new Jar(), 1, { mutate: (q, jar) => { q.set('state', 'y'.repeat(43)); jar.values.set('__Host-qyos_portal_txn', 'y'.repeat(43)); } }), 'state');
    await expectRefused(await r.login(new Jar(), 1, { mutate: q => q.set('error', 'access_denied') }), 'failed');
    // Expired transaction (> 10 minutes between login and callback).
    const jar = new Jar();
    const late = await r.login(jar, 1, { mutate: () => { r.clock.now += 11 * 60000; } });
    await expectRefused(late, 'state');
    r.clock.now = Date.now();
    // Replay: the same code + state after a successful login is refused, and Casdoor's token endpoint is not called again.
    const ok = new Jar();
    const first = await r.login(ok, 1);
    assert.equal(first.done.location, '/');
    const before = r.casdoor.state.tokenRequests.length;
    const replay = await call(r.portal.url, `/auth/callback?${first.query}`, { headers: { cookie: `__Host-qyos_portal_txn=${first.query.get('state')}` } });
    assert.equal(replay.location, '/?login_error=state');
    assert.equal(r.casdoor.state.tokenRequests.length, before);
    // A state that failed once is consumed too (cannot be retried with the right cookie).
    const jar2 = new Jar();
    const bad = await r.login(jar2, 1, { mutate: (q, j) => { j.values.set('__Host-qyos_portal_txn', 'z'.repeat(43)); } });
    const retry = await call(r.portal.url, `/auth/callback?${bad.query}`, { headers: { cookie: `__Host-qyos_portal_txn=${bad.query.get('state')}` } });
    assert.equal(retry.location, '/?login_error=state');
});

test('P4 success: token request bound to the transaction; fresh session; old session revoked', async t => {
    const r = await rig(); t.after(r.close);
    r.person(1);
    const jar = new Jar();
    const first = await r.login(jar, 1);
    assert.equal(first.done.status, 303);
    assert.equal(first.done.location, '/');
    const request = r.casdoor.state.tokenRequests.at(-1);
    assert.equal(request.grant_type, 'authorization_code');
    assert.equal(request.redirect_uri, `${ORIGIN}/auth/callback`);
    assert.equal(request.client_secret, CLIENT_SECRET);
    assert.equal(request.code, first.code);
    assert.ok(request.code_verifier && request.code_verifier.length >= 43);
    const meCall = r.bridge.state.calls.find(c => c.path === '/internal/me');
    assert.equal(meCall.auth, 'Bearer access-1');
    assert.equal(meCall.internal, BRIDGE_TOKEN);
    const sessionCookie = first.done.cookies.find(c => c.startsWith('__Host-qyos_portal='));
    assert.match(sessionCookie, /^__Host-qyos_portal=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800$/);
    const oldId = jar.values.get('__Host-qyos_portal');
    assert.equal((await r.me(jar)).status, 200);
    // Logging in again in the same browser yields a new session ID and ends the old one.
    const old = new Jar(); old.values.set('__Host-qyos_portal', oldId);
    await r.login(jar, 1);
    assert.notEqual(jar.values.get('__Host-qyos_portal'), oldId);
    assert.equal((await r.me(old)).status, 401);
    assert.equal((await r.me(jar)).status, 200);
});

test('P5 ID token negatives (nonce, aud, azp, iss, exp, iat, signature, alg, kid, tokenType, sub mismatch, instance)', async t => {
    const r = await rig(); t.after(r.close);
    r.person(1);
    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const now = () => Math.floor(Date.now() / 1000);
    const forgeries = {
        nonce: (c, k) => k.signJwt({ ...c, nonce: 'wrong' }),
        missingNonce: (c, k) => k.signJwt({ ...c, nonce: undefined }),
        audience: (c, k) => k.signJwt({ ...c, aud: ['other-app'], azp: 'other-app' }),
        azpMulti: (c, k) => k.signJwt({ ...c, aud: [CLIENT_ID, 'other-app'], azp: 'other-app' }),
        azpMissingMulti: (c, k) => k.signJwt({ ...c, aud: [CLIENT_ID, 'other-app'], azp: undefined }),
        issuer: (c, k) => k.signJwt({ ...c, iss: 'https://evil.example.test' }),
        expired: (c, k) => k.signJwt({ ...c, exp: now() - 3600 }),
        future: (c, k) => k.signJwt({ ...c, iat: now() + 3600 }),
        signature: (c, k) => k.signJwt(c, { key: otherKey }),
        algNone: (c, k) => k.signJwt(c, { alg: 'none' }),
        algHs256: (c, k) => k.signJwt(c, { alg: 'HS256' }),
        unknownKid: (c, k) => k.signJwt(c, { kid: 'nope' }),
        tokenType: (c, k) => k.signJwt({ ...c, tokenType: 'access-token' }),
        subMismatch: (c, k) => k.signJwt({ ...c, sub: 'cas-someone-else' }),
    };
    for (const [name, forge] of Object.entries(forgeries)) {
        r.casdoor.state.idTokenFor = forge;
        const outcome = await r.login(new Jar(), 1);
        assert.equal(outcome.done.location, '/?login_error=failed', name);
        assert.ok(!outcome.done.cookies.some(c => /^__Host-qyos_portal=[^;]/.test(c)), `${name}: no session`);
    }
    // ES256 and PS256 are accepted when correctly signed.
    for (const alg of ['ES256', 'PS256']) {
        r.casdoor.state.idTokenFor = (c, k) => k.signJwt(c, { alg, kid: alg === 'ES256' ? 'ec1' : 'rsa1' });
        assert.equal((await r.login(new Jar(), 1)).done.location, '/', alg);
    }
    r.casdoor.state.idTokenFor = null;
    // The os-bridge answer for another JAPI instance is refused.
    r.person(2, { instance: 'japi-other' });
    assert.equal((await r.login(new Jar(), 2)).done.location, '/?login_error=unavailable');
});

test('P6 discovery: issuer mismatch or off-origin endpoints → unavailable, no redirect to Casdoor', async t => {
    const r = await rig(); t.after(r.close);
    r.casdoor.state.discoveryOverride = { issuer: 'https://evil.example.test', authorization_endpoint: `${r.casdoor.issuer}/a`, token_endpoint: `${r.casdoor.issuer}/t`, end_session_endpoint: `${r.casdoor.issuer}/l` };
    let res = await call(r.portal.url, '/auth/login');
    assert.equal(res.location, '/?login_error=unavailable');
    const r2 = await rig(); t.after(r2.close);
    r2.casdoor.state.discoveryOverride = { issuer: r2.casdoor.issuer, authorization_endpoint: `${r2.casdoor.issuer}/a`, token_endpoint: 'https://evil.example.test/token', end_session_endpoint: `${r2.casdoor.issuer}/l` };
    res = await call(r2.portal.url, '/auth/login');
    assert.equal(res.location, '/?login_error=unavailable');
    assert.ok(r2.logs.some(l => l.event === 'discovery_refused' && l.reason === 'token_endpoint'));
});

test('P7 redirects are never followed: the redirect target receives nothing (token endpoint, bridge, JWKS)', async t => {
    const evil = { hits: [] };
    const trap = await listen(async (req, res) => { const chunks = []; for await (const c of req) chunks.push(c); evil.hits.push({ path: req.url, body: Buffer.concat(chunks).toString(), headers: req.headers }); res.end('{}'); });
    t.after(trap.close);
    // Token endpoint answers 302 to the trap.
    const r = await rig(); t.after(r.close);
    r.person(1);
    r.casdoor.state.tokenRedirect = `${trap.url}/steal`;
    const outcome = await r.login(new Jar(), 1);
    assert.equal(outcome.done.location, '/?login_error=unavailable');
    // os-bridge /internal/me (carrying the employee's access token) answers 302 to the trap.
    const rb = await rig(); t.after(rb.close);
    rb.person(1);
    rb.bridge.state.redirect = { path: '/internal/me', location: `${trap.url}/steal` };
    assert.equal((await rb.login(new Jar(), 1)).done.location, '/?login_error=unavailable');
    // The JWKS answers 302 to the trap (attacker-chosen keys would otherwise be loaded).
    const rj = await rig(); t.after(rj.close);
    rj.person(1);
    rj.casdoor.state.jwksRedirect = `${trap.url}/keys`;
    assert.equal((await rj.login(new Jar(), 1)).done.location, '/?login_error=failed');
    assert.deepEqual(evil.hits, [], 'no request (and so no secret) reached the redirect target');
});

test('P8 ?app= launch: allowlisted ids only', async t => {
    const r = await rig(); t.after(r.close);
    r.person(1);
    assert.equal((await r.login(new Jar(), 1, { app: 'chat' })).done.location, 'https://jchat.example.test/oauth/openid');
    assert.equal((await r.login(new Jar(), 1, { app: 'api' })).done.location, 'https://japi.example.test/api/v1/auth/oauth/oidc/start?redirect=%2Fdashboard');
    for (const app of ['https://evil.example.test', '__proto__', 'constructor', 'unknown', '']) {
        assert.equal((await r.login(new Jar(), 1, { app })).done.location, '/', app);
    }
});

test('P9 os-bridge refusals map to fixed codes; anything else is unavailable/failed', async t => {
    const r = await rig(); t.after(r.close);
    for (const code of ['NO_DEPARTMENT', 'ADMIN_ACCOUNT', 'IDENTITY_MISMATCH', 'BINDING_REQUIRED', 'USER_DISABLED', 'KEY_DISABLED', 'FORBIDDEN', 'EMAIL_UNVERIFIED', 'NO_EMAIL']) {
        r.bridge.state.people.set('access-9', { error: { status: 403, code } });
        assert.equal((await r.login(new Jar(), 9)).done.location, `/?login_error=${code}`);
    }
    r.bridge.state.people.set('access-9', { error: { status: 403, code: 'SOMETHING<script>' } });
    assert.equal((await r.login(new Jar(), 9)).done.location, '/?login_error=unavailable');
    r.bridge.state.people.set('access-9', { error: { status: 500, code: 'FAILED' } });
    assert.equal((await r.login(new Jar(), 9)).done.location, '/?login_error=unavailable');
    r.bridge.state.people.delete('access-9');
    assert.equal((await r.login(new Jar(), 9)).done.location, '/?login_error=failed');
});

test('P10 /auth/me returns display fields only; no token or secret in any response or log', async t => {
    const r = await rig(); t.after(r.close);
    r.person(1);
    const jar = new Jar();
    const flow = await r.login(jar, 1);
    const res = await r.me(jar);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['apps', 'expiresAt', 'signedIn', 'user']);
    assert.deepEqual(Object.keys(body.user).sort(), ['department', 'email', 'name']);
    assert.deepEqual(body.user, { name: '员工1', email: 'e1@acme.cn', department: 'sales' });
    assert.deepEqual(body.apps, ['chat', 'image', 'api']);
    const everything = [flow.start, flow.done, res].map(x => `${JSON.stringify(x.headers)}${x.text}`).join('\n') + JSON.stringify(r.logs);
    assert.deepEqual(secretsIn(everything), []);
});

test('P11 rechecks: disabled/binding/email/instance revoke; outage within grace keeps lastOkAt; after grace revoked', async t => {
    const r = await rig(); t.after(r.close);
    const cases = [
        ['disabled', a => { a.user.status = 'disabled'; a.user.reason = 'NO_DEPARTMENT'; }, 'NO_DEPARTMENT'],
        ['binding', a => { a.casdoorId = 'cas-other'; }, 'binding'],
        ['email', a => { a.user.email = 'other@acme.cn'; }, 'email'],
        ['instance', a => { a.instance = 'japi-other'; }, 'instance'],
        ['missing', null, 'bridge_404'],
    ];
    for (const [name, change, reason] of cases) {
        r.person(1);
        const jar = new Jar();
        await r.login(jar, 1);
        assert.equal((await r.me(jar)).status, 200, name);
        if (change) change(r.bridge.state.users.get('1')); else r.bridge.state.users.delete('1');
        // Not yet due: the session is still served from memory.
        r.clock.now += 59000;
        assert.equal((await r.me(jar)).status, 200, `${name}: before recheck`);
        r.clock.now += 1000;
        assert.equal((await r.me(jar)).status, 401, `${name}: revoked at recheck`);
        assert.ok(r.logs.some(l => l.event === 'recheck_revoked' && l.reason === reason), name);
        r.clock.now = Date.now();
    }
    // Outage: within grace still signed in, lastOkAt not advanced by failures; after grace revoked.
    r.person(1);
    const jar = new Jar();
    await r.login(jar, 1);
    r.bridge.state.down = true;
    r.clock.now += 60000;
    assert.equal((await r.me(jar)).status, 200, 'first failure inside grace');
    r.clock.now += 200000; // 260 s since last success
    assert.equal((await r.me(jar)).status, 200, 'still inside 300 s grace');
    r.clock.now += 50000; // 310 s since last success
    assert.equal((await r.me(jar)).status, 401, 'grace measured from the last success, not the last attempt');
    // Recovery inside grace advances lastOkAt.
    r.bridge.state.down = false;
    r.clock.now = Date.now();
    const jar2 = new Jar();
    await r.login(jar2, 1);
    r.bridge.state.down = true;
    r.clock.now += 240000;
    assert.equal((await r.me(jar2)).status, 200);
    r.bridge.state.down = false;
    r.clock.now += 60000;
    assert.equal((await r.me(jar2)).status, 200, 'recovered');
    r.bridge.state.down = true;
    r.clock.now += 240000; // 240 s after the recovery success
    assert.equal((await r.me(jar2)).status, 200, 'grace restarted at the recovery');
});

test('P11 absolute lifetime ends the session', async t => {
    const r = await rig(); t.after(r.close);
    r.person(1);
    const jar = new Jar();
    await r.login(jar, 1);
    r.clock.now += 8 * 3600000 + 1;
    assert.equal((await r.me(jar)).status, 401);
});

test('P12 logout: same-origin form only; 303 to end-session without id_token_hint; logged-out state check', async t => {
    const r = await rig(); t.after(r.close);
    r.person(1);
    const jar = new Jar();
    await r.login(jar, 1);
    const form = { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, 'sec-fetch-site': 'same-origin', cookie: jar.header() };
    for (const headers of [{ ...form, origin: 'https://evil.example.test' }, { ...form, origin: undefined }, { ...form, 'sec-fetch-site': 'cross-site' }, { ...form, 'content-type': 'application/json' }]) {
        const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
        assert.equal((await call(r.portal.url, '/auth/logout', { method: 'POST', headers: clean, body: 'x=1' })).status, 403);
    }
    assert.equal((await r.me(jar)).status, 200, 'refused logouts left the session alone');
    assert.equal((await call(r.portal.url, '/auth/logout', { headers: { cookie: jar.header() } })).status, 405);
    const out = await call(r.portal.url, '/auth/logout', { method: 'POST', headers: form, body: '' });
    assert.equal(out.status, 303);
    const target = new URL(out.location);
    assert.equal(`${target.origin}${target.pathname}`, `${r.casdoor.issuer}/api/logout`);
    assert.deepEqual([...target.searchParams.keys()].sort(), ['client_id', 'post_logout_redirect_uri', 'state']);
    assert.equal(target.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(target.searchParams.get('post_logout_redirect_uri'), `${ORIGIN}/auth/logged-out`);
    assert.ok(!out.location.includes('eyJ') && !out.location.includes('id_token'));
    assert.deepEqual(secretsIn(JSON.stringify(out.headers)), []);
    assert.ok(out.cookies.some(c => c.startsWith('__Host-qyos_portal=;') && c.includes('Max-Age=0')));
    const stale = new Jar(); stale.values.set('__Host-qyos_portal', jar.values.get('__Host-qyos_portal'));
    jar.take(out.cookies);
    assert.equal((await r.me(stale)).status, 401, 'server-side session gone');
    const state = target.searchParams.get('state');
    const back = await call(r.portal.url, `/auth/logged-out?state=${state}`, { headers: { cookie: jar.header() } });
    assert.equal(back.location, '/?signed_out=1');
    assert.ok(back.cookies.some(c => c.startsWith('__Host-qyos_portal_logout=;')));
    const wrong = await call(r.portal.url, '/auth/logged-out?state=forged', { headers: { cookie: jar.header() } });
    assert.equal(wrong.location, '/');
});

test('P13 wrong Host header → 421; unknown route 404; wrong method 405', async t => {
    const r = await rig(); t.after(r.close);
    assert.equal((await call(r.portal.url, '/auth/me', { headers: { host: 'evil.example.test' } })).status, 421);
    assert.equal((await call(r.portal.url, '/auth/nope')).status, 404);
    assert.equal((await call(r.portal.url, '/auth/me', { method: 'POST' })).status, 405);
    assert.equal((await call(r.portal.url, '/auth/healthz')).status, 200);
});

test('P14 limits: long URLs, long codes, transaction and session caps', async t => {
    const r = await rig(); t.after(r.close);
    assert.equal((await call(r.portal.url, `/auth/callback?code=${'a'.repeat(5000)}`)).status, 414);
    r.person(1);
    const long = await r.login(new Jar(), 1, { mutate: q => q.set('code', 'c'.repeat(4097 - 100)) });
    assert.equal(long.done.status, 303);
    const { createPortalHandler } = await import('../src/server.mjs');
    const { settingsFor, fakeCasdoor, fakeBridge } = await import('./helpers.mjs');
    const casdoor = await fakeCasdoor(); const bridge = await fakeBridge(); t.after(() => Promise.all([casdoor.close(), bridge.close()]));
    const small = await listen(createPortalHandler({ settings: settingsFor(casdoor, bridge), clientSecret: CLIENT_SECRET, bridgeToken: BRIDGE_TOKEN, maxTransactions: 3 })); t.after(small.close);
    const states = [];
    for (let i = 0; i < 5; i++) states.push(new URL((await call(small.url, '/auth/login')).location).searchParams.get('state'));
    // The oldest transactions were evicted: their callbacks are refused even with the right cookie.
    const evicted = await call(small.url, `/auth/callback?code=x&state=${states[0]}`, { headers: { cookie: `__Host-qyos_portal_txn=${states[0]}` } });
    assert.equal(evicted.location, '/?login_error=state');
});

test('P15 config validation', () => {
    const good = {
        origin: 'https://os.example.test', issuer: 'https://sso.example.test', jwksUrl: 'https://sso.example.test/.well-known/portal/jwks', clientId: 'abc123',
        clientSecretFile: '/etc/portal-auth/client-secret', bridge: { baseUrl: 'http://127.0.0.1:3291', tokenFile: '/etc/portal-auth/os-bridge-internal.token', japiInstance: 'japi-prod' },
        apps: { chat: { launchUrl: 'https://jchat.example.test/oauth/openid' } },
    };
    const settings = validateConfig(good);
    assert.equal(settings.sessionMs, 8 * 3600000);
    assert.equal(settings.recheckMs, 60000);
    assert.equal(settings.recheckGraceMs, 300000);
    const bad = [
        { origin: 'http://os.example.test' }, { origin: 'https://os.example.test/portal' }, { issuer: 'http://sso.example.test' },
        { jwksUrl: 'https://other.example.test/.well-known/portal/jwks' }, { jwksUrl: 'https://sso.example.test/.well-known/jwks' },
        { clientId: '<Casdoor 中 portal 应用的 Client ID>' }, { clientSecretFile: 'relative/path' },
        { bridge: { ...good.bridge, baseUrl: 'http://10.0.0.5:3291' } }, { bridge: { ...good.bridge, baseUrl: 'https://127.0.0.1:3291' } }, { bridge: { ...good.bridge, japiInstance: '' } },
        { apps: { chat: { launchUrl: 'http://jchat.example.test/' } } }, { apps: { mail: { launchUrl: 'https://mail.example.test/' } } }, { apps: {} },
        { apps: { chat: { launchUrl: 'https://os.example.test/x' } } },
        { sessionMaxHours: 0 }, { sessionMaxHours: 25 }, { recheckMs: 1000 }, { recheckMs: 3600000 }, { recheckGraceMs: -1 }, { recheckGraceMs: 7200000 },
    ];
    for (const change of bad) assert.throws(() => validateConfig({ ...good, ...change }), undefined, JSON.stringify(change));
    assert.equal(configPathFromArgs(['node', 'x', '--config', '/etc/a.json']), '/etc/a.json');
    assert.equal(configPathFromArgs(['node', 'x', '--config']), null);
});

test('P15 secret files: empty or placeholder refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portal-auth-test-'));
    await writeFile(join(dir, 'empty'), '\n');
    await writeFile(join(dir, 'placeholder'), '<openssl rand -hex 32>\n');
    await writeFile(join(dir, 'ok'), 'value\n');
    await assert.rejects(readSecret(join(dir, 'empty'), 's'));
    await assert.rejects(readSecret(join(dir, 'placeholder'), 's'));
    await assert.rejects(readSecret(join(dir, 'missing'), 's'));
    assert.equal(await readSecret(join(dir, 'ok'), 's'), 'value');
});

test('P16 logs carry events and codes only', async t => {
    const r = await rig(); t.after(r.close);
    r.person(1);
    const jar = new Jar();
    await r.login(jar, 1);
    await r.login(new Jar(), 1, { mutate: q => q.set('state', 'bad') });
    await call(r.portal.url, '/auth/logout', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() } });
    const text = JSON.stringify(r.logs);
    for (const value of ['e1@acme.cn', '员工1', 'cas-1', 'code-1', CLIENT_SECRET, BRIDGE_TOKEN, 'access-1']) assert.ok(!text.includes(value), value);
    assert.ok(r.logs.every(l => typeof l.event === 'string'));
    assert.ok(INSTANCE);
});

test('account switch: E1 signs out, another employee signs in the same browser and sees only their own identity', async t => {
    const r = await rig(); t.after(r.close);
    r.person(1);
    r.person(2, { department: 'ops' });
    const jar = new Jar();
    await r.login(jar, 1);
    assert.equal((await r.me(jar)).json().user.email, 'e1@acme.cn');
    const out = await call(r.portal.url, '/auth/logout', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() } });
    jar.take(out.cookies);
    assert.equal((await r.me(jar)).status, 401);
    const second = await r.login(jar, 2, { app: 'image' });
    assert.equal(second.done.location, 'https://jimage.example.test/api/config-vault/oidc/start?return=%2Fimage', 'the tile starts a fresh authorization in the app');
    const me = (await r.me(jar)).json();
    assert.deepEqual(me.user, { name: '员工2', email: 'e2@acme.cn', department: 'ops' });
});
