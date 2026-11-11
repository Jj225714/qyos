import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertApplicationJwks, createJwtVerifier } from '../src/jwt.mjs';
import { createJapiClient } from '../src/japi.mjs';
import { createCasdoorClient } from '../src/casdoor.mjs';
import { createCasdoorSync } from '../src/sync.mjs';
import { createDepartments, createProvisioner, DISABLED_MARK, jadminDepartmentLoader } from '../src/provisioner.mjs';
import { configPathFromArgs, createBridgeHandler, createInternalHandler } from '../src/server.mjs';
import { AUDIENCE, ISSUER, ORG, fakeCasdoor, fakeJapi, fakeRagflow, listen, makeSigner } from './helpers.mjs';

const SECRETS = { webhookSecret: 'hook-secret', internalToken: 'internal-secret' };
const DEPTS = [{ code: 'sales', groups: ['acme/sales'], japiGroupId: 3 }, { code: 'rd', groups: ['acme/rd'], japiGroupId: 4 }, { code: 'ops', groups: ['acme/ops'], japiGroupId: 5 }];

async function setup({ supportsCreateKey = true, supportsKeyStatus = true, requireDepartment = true, ragflowReject = null } = {}) {
    const signer = makeSigner();
    const jwks = await listen((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(signer.jwks)); });
    const japi = await fakeJapi({ supportsCreateKey, supportsKeyStatus });
    const ragflow = await fakeRagflow({ rejectKey: ragflowReject });
    const casdoorApi = await fakeCasdoor();
    const departments = createDepartments({ departments: DEPTS, loginProvider: { type: 'lark', name: 'provider_lark' }, ragflowKeys: { sales: 'rag-sales', rd: 'rag-rd' } });
    const provisioner = createProvisioner({ japi: createJapiClient({ baseUrl: japi.url, adminKey: 'admin-key', wait: async () => {} }), departments, requireDepartment, newUser: { balance: 10, concurrency: 3, rpmLimit: 30 } });
    const casdoor = createCasdoorClient({ baseUrl: casdoorApi.url, organization: ORG, clientId: 'bridge-app', clientSecret: 'bridge-secret' });
    const sync = createCasdoorSync({ casdoor, provisioner });
    const verifyToken = createJwtVerifier({ issuer: ISSUER, jwksUrls: [`${jwks.url}/.well-known/jchat/jwks`], audiences: [AUDIENCE] });
    const bridge = await listen(createBridgeHandler({ verifyToken, provisioner, departments, sync, japiBaseUrl: japi.url, ragflowMcpUrl: `${ragflow.url}/api/v1/mcp`, secrets: SECRETS }));
    const internal = await listen(createInternalHandler({ verifyToken, provisioner, departments, casdoor, sync, instance: 'japi-prod', secrets: SECRETS, casdoorCacheMs: 0 }));
    const close = () => Promise.all([jwks.close(), japi.close(), ragflow.close(), casdoorApi.close(), bridge.close(), internal.close()]);
    const chat = (claims, extra = {}) => fetch(`${bridge.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${signer.token(claims)}`, 'content-type': 'application/json', ...extra }, body: '{}' });
    const hook = (record, secret = SECRETS.webhookSecret) => fetch(`${bridge.url}/webhooks/casdoor`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-os-bridge-secret': secret }, body: JSON.stringify(record) }).then(r => r.json());
    const person = (fields = {}) => { const user = { owner: ORG, name: 'alice', id: 'cas-1', email: 'alice@acme.cn', emailVerified: true, displayName: '张三', groups: ['acme/sales'], isForbidden: false, isDeleted: false, ...fields }; casdoorApi.state.users.push(user); return user; };
    return { signer, japi, ragflow, casdoorApi, bridge, internal, sync, provisioner, chat, hook, person, close };
}

const alice = { email: 'Alice@Acme.cn', displayName: '张三', id: 'cas-1', groups: ['acme/sales'] };
const OK = '{status:"ok", msg:""}';

test('model call: first request provisions a JAPI user (with balance and limits) and key, then forwards', async t => {
    const s = await setup(); t.after(s.close);
    const response = await s.chat(alice);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user_id, 1);
    const user = s.japi.state.users[0];
    assert.equal(user.email, 'alice@acme.cn');
    assert.deepEqual(user.allowed_groups, [3]);
    assert.deepEqual([user.balance, user.concurrency, user.rpm_limit], [10, 3, 30]);
    assert.equal(s.japi.state.keys[0].group_id, 3);
    const before = s.japi.state.calls.filter(c => c.includes('/admin/')).length;
    await (await s.chat(alice)).json();
    assert.equal(s.japi.state.calls.filter(c => c.includes('/admin/')).length, before, 'second call served from cache');
});

test('LibreChat style: token in X-OS-Access-Token, placeholder key in Authorization', async t => {
    const s = await setup(); t.after(s.close);
    const response = await fetch(`${s.bridge.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer os-bridge', 'x-os-access-token': s.signer.token(alice), 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
});

test('concurrent first calls create exactly one user and one key', async t => {
    const s = await setup(); t.after(s.close);
    await Promise.all([1, 2, 3, 4].map(() => s.chat(alice).then(r => r.json())));
    assert.equal(s.japi.state.users.length, 1);
    assert.equal(s.japi.state.keys.length, 1);
});

test('streaming responses pass through', async t => {
    const s = await setup(); t.after(s.close);
    const response = await fetch(`${s.bridge.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${s.signer.token(alice)}`, 'content-type': 'application/json' }, body: JSON.stringify({ stream: true }) });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.match(await response.text(), /"user_id":1[\s\S]*\[DONE\]/);
});

test('rejects bad tokens: signature, issuer, audience, expiry, id/refresh tokens, untyped, HS256, missing', async t => {
    const s = await setup(); t.after(s.close);
    const other = makeSigner();
    const cases = [
        other.token(alice),
        s.signer.token({ ...alice, iss: 'https://evil.test' }),
        s.signer.token({ ...alice, aud: ['other-client'] }),
        s.signer.token({ ...alice, exp: Math.floor(Date.now() / 1000) - 3600 }),
        s.signer.token({ ...alice, tokenType: 'refresh-token' }),
        s.signer.token({ ...alice, tokenType: 'id-token' }),
        s.signer.token({ ...alice, tokenType: undefined }),
        s.signer.token(alice, { alg: 'HS256' }),
    ];
    for (const [index, token] of cases.entries()) {
        const response = await fetch(`${s.bridge.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
        assert.equal(response.status, 401, `token case ${index}`);
    }
    assert.equal((await fetch(`${s.bridge.url}/v1/chat/completions`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal(s.japi.state.users.length, 0);
});

test('refused: forbidden, no email, unverified email, no department', async t => {
    const s = await setup(); t.after(s.close);
    const cases = [[{ ...alice, isForbidden: true }, 'FORBIDDEN'], [{ ...alice, email: '' }, 'NO_EMAIL'], [{ ...alice, email_verified: false }, 'EMAIL_UNVERIFIED'], [{ ...alice, groups: ['acme/finance'] }, 'NO_DEPARTMENT']];
    for (const [claims, code] of cases) {
        const response = await s.chat(claims);
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error.code, code);
    }
    assert.equal(s.japi.state.users.length, 0);
});

test('email verification: "auto" relaxes it only while WeCom is the chosen IM', async t => {
    const japi = await fakeJapi(); t.after(japi.close);
    let loginProvider = { type: 'lark', name: 'provider_lark' };
    const departments = { ...createDepartments({ departments: DEPTS }), loginProvider: async () => loginProvider };
    const provisioner = createProvisioner({ japi: createJapiClient({ baseUrl: japi.url, adminKey: 'admin-key' }), departments });
    const unverified = { email: 'w@acme.cn', emailVerified: false, casdoorId: 'cas-w', name: 'w', groups: ['acme/sales'], forbidden: false };
    await assert.rejects(provisioner.ensure(unverified), { code: 'EMAIL_UNVERIFIED' });
    loginProvider = { type: 'wecom', name: 'provider_wecom' };
    assert.equal((await provisioner.ensure(unverified)).user.email, 'w@acme.cn');
});

test('without requireDepartment, people outside departments get the default group', async t => {
    const signer = makeSigner();
    const japi = await fakeJapi(); t.after(japi.close);
    const departments = createDepartments({ departments: DEPTS, defaultJapiGroupId: 9 });
    const provisioner = createProvisioner({ japi: createJapiClient({ baseUrl: japi.url, adminKey: 'admin-key' }), departments, requireDepartment: false });
    await provisioner.ensure({ email: 'eve@acme.cn', emailVerified: true, casdoorId: 'cas-e', name: 'eve', groups: [], forbidden: false });
    assert.deepEqual(japi.state.users[0].allowed_groups, [9]);
    assert.ok(signer);
});

test('only allow-listed model paths and methods are proxied; internal routes are not on the public port', async t => {
    const s = await setup(); t.after(s.close);
    const auth = { authorization: `Bearer ${s.signer.token(alice)}`, 'x-internal-token': SECRETS.internalToken };
    assert.equal((await fetch(`${s.bridge.url}/v1/admin/users`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${s.bridge.url}/v1/chat/completions`, { headers: auth })).status, 405);
    assert.equal((await fetch(`${s.bridge.url}/v1/models`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${s.bridge.url}/internal/me`, { headers: auth })).status, 404);
});

test('missing JAPI patch is reported clearly (plain-text 404), unlike a JSON 404', async t => {
    const s = await setup({ supportsCreateKey: false }); t.after(s.close);
    const response = await s.chat(alice);
    assert.equal(response.status, 503);
});

test('JAPI rate limiting (429) is retried', async t => {
    const s = await setup(); t.after(s.close);
    s.japi.state.rateLimitNext = 2;
    assert.equal((await s.chat(alice)).status, 200);
});

test('exact email match even when the search returns many look-alikes', async t => {
    const s = await setup(); t.after(s.close);
    for (let i = 0; i < 1500; i++) s.japi.state.users.push({ id: s.japi.state.nextUser++, email: `x${i}alice@acme.cn`, notes: '', status: 'active' });
    s.japi.state.users.push({ id: s.japi.state.nextUser++, email: 'alice@acme.cn', notes: 'os-bridge casdoor:cas-1', status: 'active', allowed_groups: [3] });
    const response = await s.chat(alice);
    assert.equal((await response.json()).user_id, 1501);
    assert.equal(s.japi.state.users.filter(u => u.email === 'alice@acme.cn').length, 1);
});

test('knowledge: department key injected; departed employees and no-knowledge departments handled', async t => {
    const s = await setup(); t.after(s.close);
    const send = (claims, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') => fetch(`${s.bridge.url}/mcp/knowledge`, { method: 'POST', headers: { authorization: `Bearer ${s.signer.token(claims)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'sess-0' }, body });
    const sales = await send(alice);
    assert.equal(sales.status, 200);
    assert.equal(sales.headers.get('mcp-session-id'), 'sess-1');
    assert.equal(s.ragflow.seen[0].auth, 'Bearer rag-sales');
    assert.equal(s.ragflow.seen[0].session, 'sess-0');
    assert.ok(s.ragflow.seen.every(seen => !seen.auth.includes('.')), 'the employee token never reaches RAGFlow');
    // A department without a knowledge base: a valid, empty MCP server instead of an HTTP error.
    const ops = { ...alice, id: 'cas-2', email: 'ops@acme.cn', groups: ['acme/ops'] };
    const init = await (await send(ops, '{"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}')).json();
    assert.equal(init.result.serverInfo.name, 'enterprise-knowledge');
    assert.deepEqual((await (await send(ops)).json()).result.tools, []);
    assert.equal((await send(ops, '{"jsonrpc":"2.0","method":"notifications/initialized"}')).status, 202);
    assert.equal(s.ragflow.seen.length, 1);
    // Outside any department: refused like model calls.
    assert.equal((await send({ ...alice, id: 'cas-3', email: 'eve@acme.cn', groups: ['acme/finance'] })).status, 403);
    // A JAPI-disabled employee with a still-valid token loses the knowledge base too.
    s.japi.state.users[0].status = 'disabled';
    s.provisioner.forget('alice@acme.cn');
    assert.equal((await send(alice)).status, 403);
});

test('knowledge: RAGFlow rejecting the department key (HTTP 200 + code) becomes 502', async t => {
    const s = await setup({ ragflowReject: 'rag-sales' }); t.after(s.close);
    const response = await fetch(`${s.bridge.url}/mcp/knowledge`, { method: 'POST', headers: { authorization: `Bearer ${s.signer.token(alice)}`, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'RAGFLOW_REJECTED');
});

test('webhook: forged bodies are ignored; the person is always re-read from Casdoor', async t => {
    const s = await setup(); t.after(s.close);
    s.person();
    assert.equal((await s.chat(alice)).status, 200);
    assert.equal((await fetch(`${s.bridge.url}/webhooks/casdoor`, { method: 'POST', headers: { 'x-os-bridge-secret': 'wrong' }, body: '{}' })).status, 401);
    // An anonymous failed /api/login whose body claims isForbidden (Casdoor still sends the record).
    const forged = await s.hook({ action: 'login', organization: 'built-in', user: '', object: JSON.stringify({ email: 'alice@acme.cn', isForbidden: true, id: 'x' }), response: '{status:"error", msg:"wrong password"}' });
    assert.match(forged.result, /did not succeed/);
    // A "successful" update whose extendedUser (the acting admin) or body says forbidden: Casdoor says active.
    await s.hook({ action: 'update-user', organization: 'built-in', user: 'admin', object: JSON.stringify({ owner: ORG, name: 'alice', isForbidden: true }), extendedUser: { email: 'alice@acme.cn', isForbidden: true }, response: OK });
    assert.equal(s.japi.state.users[0].status, 'active');
    // Another organization's user is ignored.
    assert.match((await s.hook({ action: 'update-user', object: JSON.stringify({ owner: 'other', name: 'alice' }), response: OK })).result, /other organization/);
});

test('webhook: admin disables in Casdoor -> JAPI user and key disabled; re-enabled -> restored', async t => {
    const s = await setup(); t.after(s.close);
    const casUser = s.person();
    assert.equal((await s.chat(alice)).status, 200);
    casUser.isForbidden = true;
    await s.hook({ action: 'update-user', organization: 'built-in', user: 'admin', object: JSON.stringify({ owner: ORG, name: 'alice' }), extendedUser: { name: 'admin', email: 'admin@example.com' }, response: OK });
    assert.equal(s.japi.state.users[0].status, 'disabled');
    assert.ok(s.japi.state.users[0].notes.includes(DISABLED_MARK));
    assert.equal(s.japi.state.keys[0].status, 'disabled');
    assert.equal((await s.chat(alice)).status, 403, 'a still-valid token no longer works');
    casUser.isForbidden = false;
    await s.hook({ action: 'update-user', organization: 'built-in', user: 'admin', object: JSON.stringify({ owner: ORG, name: 'alice' }), response: OK });
    assert.equal(s.japi.state.users[0].status, 'active');
    assert.equal(s.japi.state.keys[0].status, 'active');
    assert.ok(!s.japi.state.users[0].notes.includes(DISABLED_MARK));
    assert.equal((await s.chat(alice)).status, 200);
});

test('webhook login pre-provisions from the Casdoor record user, not from the body', async t => {
    const s = await setup(); t.after(s.close);
    s.person();
    const result = await s.hook({ action: 'login', organization: ORG, user: 'alice', object: JSON.stringify({ username: 'mallory', email: 'evil@acme.cn' }), response: OK });
    assert.equal(result.result.japiUserId, 1);
    assert.equal(s.japi.state.users[0].email, 'alice@acme.cn');
    assert.equal(s.japi.state.users[0].notes, 'os-bridge casdoor:cas-1');
});

test('an administrator\'s manual block in JAPI is never lifted; unbound and admin accounts are never touched', async t => {
    const s = await setup(); t.after(s.close);
    s.person();
    await s.chat(alice);
    s.japi.state.users[0].status = 'disabled';
    await s.hook({ action: 'update-user', object: JSON.stringify({ owner: ORG, name: 'alice' }), response: OK });
    assert.equal(s.japi.state.users[0].status, 'disabled');
    // A JAPI admin with the same email as a Casdoor user that gets deleted: untouched (no binding).
    s.japi.state.users.push({ id: 50, email: 'boss@acme.cn', notes: '', status: 'active', role: 'admin' });
    s.person({ name: 'boss', id: 'cas-boss', email: 'boss@acme.cn', isForbidden: true });
    await s.hook({ action: 'update-user', object: JSON.stringify({ owner: ORG, name: 'boss' }), response: OK });
    assert.equal(s.japi.state.users.find(u => u.id === 50).status, 'active');
    // ... and it is never bound to a Casdoor user automatically.
    const response = await s.chat({ ...alice, id: 'cas-boss2', email: 'boss@acme.cn' });
    assert.equal((await response.json()).error.code, 'ADMIN_ACCOUNT');
});

test('reconcile: deleted / forbidden Casdoor users are disabled even without a webhook; guard against mass disable', async t => {
    const s = await setup(); t.after(s.close);
    s.person();
    const bob = s.person({ name: 'bob', id: 'cas-2', email: 'bob@acme.cn' });
    await s.chat(alice);
    await s.chat({ ...alice, id: 'cas-2', email: 'bob@acme.cn' });
    s.casdoorApi.state.users.splice(s.casdoorApi.state.users.indexOf(bob), 1);
    const run = await s.sync.reconcileAll();
    assert.equal(run.disabled, 1);
    assert.equal(s.japi.state.users[1].status, 'disabled');
    assert.equal(s.japi.state.users[0].status, 'active');
    // An empty or foreign organization answer must not disable everyone.
    s.casdoorApi.state.users.length = 0;
    await assert.rejects(s.sync.reconcileAll(), /no users/);
    for (let i = 0; i < 10; i++) { s.japi.state.users.push({ id: 100 + i, email: `p${i}@acme.cn`, notes: `os-bridge casdoor:cas-p${i}`, status: 'active' }); }
    s.person({ name: 'other', id: 'cas-x', email: 'x@acme.cn' });
    await assert.rejects(s.sync.reconcileAll(), /refusing/);
    assert.ok(s.japi.state.users.slice(2).every(u => u.status === 'active'));
});

test('internal API: separate listener, token, config, identity, Casdoor-aware status, key; no ?key=1', async t => {
    const s = await setup(); t.after(s.close);
    const casUser = s.person();
    const internal = (path, headers = {}) => fetch(`${s.internal.url}${path}`, { headers: { 'x-internal-token': SECRETS.internalToken, ...headers } });
    assert.equal((await fetch(`${s.internal.url}/internal/config`)).status, 401);
    assert.deepEqual(await (await internal('/internal/config')).json(), { instance: 'japi-prod', loginProvider: { type: 'lark', name: 'provider_lark' } });
    const me = await (await internal('/internal/me?key=1', { authorization: `Bearer ${s.signer.token(alice)}` })).json();
    assert.deepEqual(me, { user: { id: 1, email: 'alice@acme.cn', status: 'active' }, instance: 'japi-prod' });
    assert.equal((await (await internal('/internal/users/1')).json()).user.status, 'active');
    const key = await (await internal('/internal/users/1/key')).json();
    assert.match(key.apiKey, /^sk-user1-/);
    // Forbidden in Casdoor before any webhook arrives: the vault sees "disabled" right away.
    casUser.isForbidden = true;
    assert.equal((await (await internal('/internal/users/1')).json()).user.status, 'disabled');
    assert.equal((await internal('/internal/users/999')).status, 404);
    assert.equal((await internal('/internal/users/abc')).status, 404);
});

test('internal key lookup: only os-bridge-managed, active keys; never creates a key', async t => {
    const s = await setup(); t.after(s.close);
    const key = id => fetch(`${s.internal.url}/internal/users/${id}/key`, { headers: { 'x-internal-token': SECRETS.internalToken } });
    s.japi.state.users.push({ id: 1, email: 'root@acme.cn', notes: '', status: 'active', role: 'admin' });
    s.japi.state.users.push({ id: 2, email: 'new@acme.cn', notes: 'os-bridge casdoor:cas-9', status: 'active' });
    s.japi.state.users.push({ id: 3, email: 'old@acme.cn', notes: 'os-bridge casdoor:cas-8', status: 'active' });
    s.japi.state.keys.push({ id: 1, user_id: 3, key: 'sk-old', name: 'enterprise-os', status: 'quota_exhausted' });
    assert.equal((await (await key(1)).json()).error.code, 'NOT_MANAGED');
    assert.equal((await key(2)).status, 404);
    assert.equal((await (await key(3)).json()).error.code, 'KEY_DISABLED');
    assert.equal(s.japi.state.keys.length, 1, 'no key was created');
});

test('accounts are bound to the Casdoor user ID; an existing unbound account is bound on first use', async t => {
    const s = await setup(); t.after(s.close);
    s.japi.state.users.push({ id: 7, email: 'alice@acme.cn', notes: 'legacy', status: 'active', allowed_groups: null });
    s.japi.state.nextUser = 8;
    assert.equal((await (await s.chat(alice)).json()).user_id, 7);
    assert.equal(s.japi.state.users[0].notes, 'legacy os-bridge casdoor:cas-1');
    assert.deepEqual(s.japi.state.users[0].allowed_groups, [3], 'null allowed_groups is treated as empty');
    const intruder = await s.chat({ ...alice, id: 'cas-intruder' });
    assert.equal((await intruder.json()).error.code, 'IDENTITY_MISMATCH');
    assert.equal((await s.chat({ ...alice, id: undefined, sub: undefined })).status, 403);
});

test('a key an administrator disabled (or that ran out) is never silently replaced', async t => {
    const s = await setup(); t.after(s.close);
    await s.chat(alice);
    s.japi.state.keys[0].status = 'quota_exhausted';
    s.provisioner.forget('alice@acme.cn');
    const response = await s.chat(alice);
    assert.equal((await response.json()).error.code, 'KEY_DISABLED');
    assert.equal(s.japi.state.keys.length, 1);
});

test('a department change moves the key and swaps the department group, keeping other groups', async t => {
    const japi = await fakeJapi(); t.after(japi.close);
    let feed = { departments: DEPTS, assignments: {} };
    const departments = createDepartments({ load: async () => feed, refreshMs: 0 });
    const provisioner = createProvisioner({ japi: createJapiClient({ baseUrl: japi.url, adminKey: 'admin-key' }), departments });
    const identity = { email: 'alice@acme.cn', emailVerified: true, casdoorId: 'cas-1', name: '张三', groups: ['acme/sales'], forbidden: false };
    const first = await provisioner.ensure(identity);
    japi.state.users[0].allowed_groups = [3, 42]; // 42: added by an administrator, belongs to no department
    const calls = japi.state.calls.length;
    await provisioner.ensure(identity);
    assert.equal(japi.state.calls.length, calls, 'cached');
    feed = { ...feed, assignments: { 'alice@acme.cn': 'rd' } };
    const moved = await provisioner.ensure(identity);
    assert.equal(moved.key, first.key);
    assert.equal(japi.state.keys[0].group_id, 4);
    assert.deepEqual(japi.state.users[0].allowed_groups.sort(), [4, 42]);
});

test('departments from Jadmin: manual assignment wins, refresh interval, last good copy, login provider', async t => {
    let feed = { departments: DEPTS, assignments: { 'bob@acme.cn': 'rd' }, loginProvider: { type: 'dingtalk', name: 'provider_dingtalk' } };
    let fail = false; let hits = 0;
    const jadmin = await listen((req, res) => {
        hits++;
        if (req.headers['x-internal-token'] !== 'jadmin-token') { res.statusCode = 401; return res.end('{}'); }
        if (fail) { res.statusCode = 500; return res.end('{}'); }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(feed));
    });
    t.after(jadmin.close);
    let clock = 0;
    const departments = createDepartments({ load: jadminDepartmentLoader({ baseUrl: jadmin.url, token: 'jadmin-token' }), ragflowKeys: { sales: 'rag-sales', rd: 'rag-rd' }, refreshMs: 60000, now: () => clock });
    assert.deepEqual(await departments.resolve({ email: 'alice@acme.cn', groups: ['acme/sales'] }), { name: 'sales', japiGroupId: 3, ragflowKey: 'rag-sales' });
    assert.equal((await departments.resolve({ email: 'BOB@acme.cn', groups: ['acme/sales'] })).name, 'rd');
    assert.deepEqual(await departments.resolve({ email: 'eve@acme.cn', groups: [] }), { name: null, japiGroupId: null, ragflowKey: null });
    assert.deepEqual(await departments.loginProvider(), { type: 'dingtalk', name: 'provider_dingtalk' });
    assert.equal(hits, 1, 'cached within the refresh interval');
    feed = { departments: [{ code: 'sales', groups: ['acme/sales', 'acme/new'], japiGroupId: 3 }], assignments: {} };
    clock += 61000;
    assert.equal((await departments.resolve({ email: 'x@acme.cn', groups: ['acme/new'] })).name, 'sales');
    fail = true; clock += 61000;
    assert.equal((await departments.resolve({ email: 'x@acme.cn', groups: ['acme/new'] })).name, 'sales', 'keeps last good copy');
    await assert.rejects(jadminDepartmentLoader({ baseUrl: jadmin.url, token: 'wrong' })());
});

test('JWKS: global endpoint refused; refresh failure keeps the loaded keys; key rotation is picked up', async t => {
    assert.throws(() => assertApplicationJwks(['https://sso.example.test/.well-known/jwks']), /global/);
    assert.doesNotThrow(() => assertApplicationJwks(['https://sso.example.test/.well-known/jchat/jwks']));
    const first = makeSigner('k1'); const second = makeSigner('k2');
    let served = first.jwks; let down = false;
    const jwks = await listen((req, res) => { if (down) { res.statusCode = 503; return res.end(); } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(served)); });
    t.after(jwks.close);
    let clock = Date.now();
    const verify = createJwtVerifier({ issuer: ISSUER, jwksUrls: [`${jwks.url}/.well-known/jchat/jwks`], audiences: [AUDIENCE], now: () => clock, cacheMs: 1000, refetchMs: 10 });
    assert.equal((await verify(first.token(alice))).email, alice.email);
    down = true; clock += 5000;
    assert.equal((await verify(first.token(alice))).email, alice.email, 'stale keys still work while Casdoor is down');
    down = false; served = { keys: [...first.jwks.keys, ...second.jwks.keys] }; clock += 5000;
    assert.equal((await verify(second.token(alice))).email, alice.email);
});

test('--config parsing', () => {
    assert.equal(configPathFromArgs(['node', 'server.mjs', '--config', '/etc/x.json']), '/etc/x.json');
    assert.equal(configPathFromArgs(['node', 'server.mjs']), null);
    assert.equal(configPathFromArgs(['node', 'server.mjs', '--config']), null);
    assert.equal(configPathFromArgs(['node', 'server.mjs', '--config', '--other']), null);
});
