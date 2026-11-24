// SSO-20261115-05 Chunk 1: portal display fields, department enforcement on the internal routes, and
// department loss in Casdoor sync (reconcile + webhook), including the review's boundary cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJwtVerifier } from '../src/jwt.mjs';
import { createJapiClient } from '../src/japi.mjs';
import { createCasdoorClient } from '../src/casdoor.mjs';
import { createCasdoorSync } from '../src/sync.mjs';
import { createDepartments, createProvisioner, DISABLED_MARK } from '../src/provisioner.mjs';
import { createBridgeHandler, createInternalHandler } from '../src/server.mjs';
import { AUDIENCE, ISSUER, ORG, fakeCasdoor, fakeJapi, listen, makeSigner } from './helpers.mjs';

const SECRETS = { webhookSecret: 'hook-secret', internalToken: 'internal-secret' };
const DEPTS = [{ code: 'sales', groups: ['acme/sales'], japiGroupId: 3 }, { code: 'ops', groups: ['acme/ops'], japiGroupId: 5 }];
const OK = '{status:"ok", msg:""}';
const alice = { email: 'alice@acme.cn', displayName: '张三', id: 'cas-1', groups: ['acme/sales'] };

/**
 * A bridge whose department directory comes from a controllable Jadmin feed (`directory.fail`, `directory.feed`),
 * refreshed on every request, and whose Casdoor reads can be made to fail (`casdoorDown`).
 */
async function setup({ requireDepartment = true, disableWithoutDepartment, requireEmailVerified = 'auto', jadminFeed = true } = {}) {
    const signer = makeSigner();
    const jwks = await listen((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(signer.jwks)); });
    const japi = await fakeJapi();
    const casdoorApi = await fakeCasdoor();
    const logs = [];
    const log = line => logs.push(line);
    const directory = { fail: false, feed: { departments: DEPTS, assignments: {}, loginProvider: { type: 'lark', name: 'provider_lark' } } };
    const departments = jadminFeed
        ? createDepartments({ load: async () => { if (directory.fail) throw new Error('jadmin down'); return structuredClone(directory.feed); }, refreshMs: 0, log })
        : createDepartments({ departments: DEPTS, loginProvider: { type: 'lark', name: 'provider_lark' } });
    const provisioner = createProvisioner({ japi: createJapiClient({ baseUrl: japi.url, adminKey: 'admin-key', wait: async () => {} }), departments, requireDepartment, requireEmailVerified, log, ...(disableWithoutDepartment === undefined ? {} : { disableWithoutDepartment }) });
    const real = createCasdoorClient({ baseUrl: casdoorApi.url, organization: ORG, clientId: 'bridge-app', clientSecret: 'bridge-secret' });
    const flags = { casdoorDown: false };
    const casdoor = {
        organization: ORG,
        userById: async id => { if (flags.casdoorDown) throw Object.assign(new Error('Casdoor unreachable'), { status: 503 }); return real.userById(id); },
        userByName: name => real.userByName(name),
        users: () => real.users(),
    };
    const sync = createCasdoorSync({ casdoor, provisioner, log });
    const verifyToken = createJwtVerifier({ issuer: ISSUER, jwksUrls: [`${jwks.url}/.well-known/portal/jwks`], audiences: [AUDIENCE] });
    const bridge = await listen(createBridgeHandler({ verifyToken, provisioner, departments, sync, japiBaseUrl: japi.url, secrets: SECRETS, log }));
    const internal = await listen(createInternalHandler({ verifyToken, provisioner, departments, casdoor, sync, instance: 'japi-prod', secrets: SECRETS, log, casdoorCacheMs: 0 }));
    const close = () => Promise.all([jwks.close(), japi.close(), casdoorApi.close(), bridge.close(), internal.close()]);
    const get = (path, headers = {}) => fetch(`${internal.url}${path}`, { headers: { 'x-internal-token': SECRETS.internalToken, ...headers } });
    const me = claims => get('/internal/me', { authorization: `Bearer ${signer.token(claims)}` });
    const chat = claims => fetch(`${bridge.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${signer.token(claims)}`, 'content-type': 'application/json' }, body: '{}' });
    const hook = record => fetch(`${bridge.url}/webhooks/casdoor`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-os-bridge-secret': SECRETS.webhookSecret }, body: JSON.stringify(record) }).then(r => r.json());
    const person = (fields = {}) => { const user = { owner: ORG, name: 'alice', id: 'cas-1', email: 'alice@acme.cn', emailVerified: true, displayName: '张三', groups: ['acme/sales'], isForbidden: false, isDeleted: false, ...fields }; casdoorApi.state.users.push(user); return user; };
    return { signer, japi, casdoorApi, directory, flags, logs, sync, provisioner, get, me, chat, hook, person, close };
}

/** Every key at any depth of a JSON value. */
const deepKeys = value => (value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => [k, ...deepKeys(v)]) : []);

test('E1 /internal/me: portal display fields, never a key or token', async t => {
    const s = await setup(); t.after(s.close);
    s.person();
    const response = await s.me(alice);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { user: { id: 1, email: 'alice@acme.cn', status: 'active' }, instance: 'japi-prod', casdoorId: 'cas-1', name: '张三', department: 'sales' });
    const keys = deepKeys(body).map(k => k.toLowerCase());
    for (const banned of ['key', 'apikey', 'token', 'access_token', 'id_token']) assert.ok(!keys.includes(banned), banned);
    assert.ok(!JSON.stringify(body).includes('sk-user'), 'the JAPI key value never appears');
});

test('E2 /internal/me keeps every existing refusal code', async t => {
    const s = await setup(); t.after(s.close);
    const code = async claims => { const r = await s.me(claims); assert.equal(r.status, 403); return (await r.json()).error.code; };
    assert.equal(await code({ ...alice, groups: ['acme/finance'] }), 'NO_DEPARTMENT');
    assert.equal(await code({ ...alice, isForbidden: true }), 'FORBIDDEN');
    s.japi.state.users.push({ id: 40, email: 'boss@acme.cn', notes: '', status: 'active', role: 'admin' });
    assert.equal(await code({ ...alice, id: 'cas-boss', email: 'boss@acme.cn' }), 'ADMIN_ACCOUNT');
    s.japi.state.users.push({ id: 41, email: 'taken@acme.cn', notes: 'os-bridge casdoor:cas-other', status: 'active' });
    assert.equal(await code({ ...alice, id: 'cas-t', email: 'taken@acme.cn' }), 'IDENTITY_MISMATCH');
    s.japi.state.users.push({ id: 42, email: 'off@acme.cn', notes: 'os-bridge casdoor:cas-off', status: 'disabled' });
    assert.equal(await code({ ...alice, id: 'cas-off', email: 'off@acme.cn' }), 'USER_DISABLED');
    assert.equal(await code({ ...alice, id: 'cas-u', email: 'unverified@acme.cn', email_verified: false }), 'EMAIL_UNVERIFIED');
    const relaxed = await setup({ requireEmailVerified: false }); t.after(relaxed.close);
    relaxed.japi.state.users.push({ id: 43, email: 'legacy@acme.cn', notes: 'legacy', status: 'active' });
    const r = await relaxed.me({ ...alice, id: 'cas-l', email: 'legacy@acme.cn', email_verified: false });
    assert.equal((await r.json()).error.code, 'BINDING_REQUIRED');
});

test('E3 /internal/users/:id: department rule, casdoorId, reason; Casdoor errors keep the documented fail-open', async t => {
    const s = await setup(); t.after(s.close);
    const casUser = s.person();
    assert.equal((await s.me(alice)).status, 200);
    const status = async () => (await s.get('/internal/users/1')).json();
    assert.deepEqual(await status(), { user: { id: 1, email: 'alice@acme.cn', status: 'active' }, instance: 'japi-prod', casdoorId: 'cas-1' });
    // Removed from every department (Casdoor group change): reported disabled with the reason.
    casUser.groups = ['acme/finance'];
    assert.deepEqual((await status()).user, { id: 1, email: 'alice@acme.cn', status: 'disabled', reason: 'NO_DEPARTMENT' });
    // ... or by Jadmin (directory change) while the Casdoor groups stay the same.
    casUser.groups = ['acme/sales'];
    assert.equal((await status()).user.status, 'active');
    s.directory.feed.departments = [{ code: 'ops', groups: ['acme/ops'], japiGroupId: 5 }];
    assert.equal((await status()).user.reason, 'NO_DEPARTMENT');
    s.directory.feed.departments = DEPTS;
    // Forbidden keeps its existing meaning, now with a reason.
    casUser.isForbidden = true;
    assert.deepEqual((await status()).user, { id: 1, email: 'alice@acme.cn', status: 'disabled', reason: 'FORBIDDEN' });
    casUser.isForbidden = false;
    assert.equal((await status()).user.status, 'active');
    // Casdoor unreachable: unchanged fail-open — the last answer (here "active") is kept even though the person
    // has meanwhile lost the department, and the failure is logged. Documented limitation, not fixed here.
    s.flags.casdoorDown = true;
    casUser.groups = ['acme/finance'];
    assert.equal((await status()).user.status, 'active');
    assert.ok(s.logs.some(line => line.event === 'casdoor_status_failed'));
    // A person the bridge never answered for: no cached answer → "active" (same as before this change).
    s.japi.state.users.push({ id: 77, email: 'never@acme.cn', notes: 'os-bridge casdoor:cas-never', status: 'active' });
    assert.equal((await (await s.get('/internal/users/77')).json()).user.status, 'active');
});

test('E3 /internal/users/:id: requireDepartment:false never applies the department rule', async t => {
    const s = await setup({ requireDepartment: false }); t.after(s.close);
    s.person({ groups: [] });
    assert.equal((await s.me({ ...alice, groups: [] })).status, 200);
    assert.equal((await (await s.get('/internal/users/1')).json()).user.status, 'active');
});

test('E3 /internal/users/:id: a directory that never loaded does not enforce the department', async t => {
    const s = await setup(); t.after(s.close);
    s.person({ groups: ['acme/finance'] });
    s.japi.state.users.push({ id: 9, email: 'alice@acme.cn', notes: 'os-bridge casdoor:cas-1', status: 'active' });
    s.directory.fail = true;
    const body = await (await s.get('/internal/users/9')).json();
    assert.equal(body.user.status, 'active');
    assert.equal(body.casdoorId, 'cas-1');
});

test('E4 /internal/users/:id/key: no department → 403 before the key is read; department → key', async t => {
    const s = await setup(); t.after(s.close);
    const casUser = s.person();
    assert.equal((await s.me(alice)).status, 200);
    const ok = await (await s.get('/internal/users/1/key')).json();
    assert.match(ok.apiKey, /^sk-user1-/);
    casUser.groups = ['acme/finance'];
    s.japi.state.calls.length = 0;
    const refused = await s.get('/internal/users/1/key');
    assert.equal(refused.status, 403);
    const body = await refused.json();
    assert.equal(body.error.code, 'NO_DEPARTMENT');
    assert.ok(!JSON.stringify(body).includes('sk-user'));
    assert.ok(!s.japi.state.calls.some(call => call.includes('/api-keys')), 'the key list was never read');
    casUser.groups = ['acme/sales'];
    casUser.isForbidden = true;
    assert.equal((await (await s.get('/internal/users/1/key')).json()).error.code, 'FORBIDDEN');
});

test('E5 reconcile: department loss disables with the mark, restoration re-enables; counts logged', async t => {
    const s = await setup(); t.after(s.close);
    const amy = s.person();
    const bob = s.person({ name: 'bob', id: 'cas-2', email: 'bob@acme.cn' });
    s.person({ name: 'cy', id: 'cas-3', email: 'cy@acme.cn', groups: ['acme/ops'] });
    for (const claims of [alice, { ...alice, id: 'cas-2', email: 'bob@acme.cn' }, { ...alice, id: 'cas-3', email: 'cy@acme.cn', groups: ['acme/ops'] }]) assert.equal((await s.chat(claims)).status, 200);
    bob.groups = ['acme/finance'];
    const run = await s.sync.reconcileAll();
    assert.equal(run.disabled, 1);
    assert.equal(run.disabledNoDepartment, 1);
    const bobAccount = s.japi.state.users.find(u => u.email === 'bob@acme.cn');
    assert.equal(bobAccount.status, 'disabled');
    assert.ok(bobAccount.notes.includes(DISABLED_MARK));
    assert.equal(s.japi.state.keys.find(k => k.user_id === bobAccount.id).status, 'disabled');
    assert.equal(s.japi.state.users.find(u => u.email === 'alice@acme.cn').status, 'active');
    const done = s.logs.find(line => line.event === 'reconcile_done');
    assert.deepEqual(Object.keys(done).sort(), ['accounts', 'at', 'disabled', 'disabledNoDepartment', 'event', 'ms', 'reactivated']);
    // Department back → reactivated (mark removed, key enabled).
    bob.groups = ['acme/sales'];
    assert.equal((await s.sync.reconcileAll()).reactivated, 1);
    const restored = s.japi.state.users.find(u => u.email === 'bob@acme.cn');
    assert.equal(restored.status, 'active');
    assert.ok(!restored.notes.includes(DISABLED_MARK));
    assert.equal(s.japi.state.keys.find(k => k.user_id === restored.id).status, 'active');
    assert.equal((await s.chat({ ...alice, id: 'cas-2', email: 'bob@acme.cn' })).status, 200);
    assert.ok(amy);
});

test('E5 reconcile: an administrator-disabled account (no mark) is never re-enabled after restoration', async t => {
    const s = await setup(); t.after(s.close);
    const bob = s.person({ name: 'bob', id: 'cas-2', email: 'bob@acme.cn' });
    s.person();
    await s.chat(alice);
    await s.chat({ ...alice, id: 'cas-2', email: 'bob@acme.cn' });
    const account = s.japi.state.users.find(u => u.email === 'bob@acme.cn');
    account.status = 'disabled'; // administrator's own block in JAPI, no os-bridge mark
    bob.groups = ['acme/finance'];
    await s.sync.reconcileAll();
    bob.groups = ['acme/sales'];
    const run = await s.sync.reconcileAll();
    assert.equal(run.reactivated, 0);
    assert.equal(account.status, 'disabled');
    assert.ok(!String(account.notes).includes(DISABLED_MARK));
});

test('E5 reconcile: disableWithoutDepartment:false ignores department loss but still disables forbidden/deleted', async t => {
    const s = await setup({ disableWithoutDepartment: false }); t.after(s.close);
    const amy = s.person();
    const bob = s.person({ name: 'bob', id: 'cas-2', email: 'bob@acme.cn' });
    const cy = s.person({ name: 'cy', id: 'cas-3', email: 'cy@acme.cn' });
    for (const claims of [alice, { ...alice, id: 'cas-2', email: 'bob@acme.cn' }, { ...alice, id: 'cas-3', email: 'cy@acme.cn' }]) assert.equal((await s.chat(claims)).status, 200);
    amy.groups = ['acme/finance'];
    bob.isForbidden = true;
    s.casdoorApi.state.users.splice(s.casdoorApi.state.users.indexOf(cy), 1);
    const run = await s.sync.reconcileAll();
    assert.equal(run.disabled, 2);
    assert.equal(run.disabledNoDepartment, 0);
    const by = email => s.japi.state.users.find(u => u.email === email).status;
    assert.equal(by('alice@acme.cn'), 'active');
    assert.equal(by('bob@acme.cn'), 'disabled');
    assert.equal(by('cy@acme.cn'), 'disabled');
    // The model-call gate still applies (requireDepartment, from the token's groups), independently of account disabling.
    assert.equal((await (await s.chat({ ...alice, groups: ['acme/finance'] })).json()).error.code, 'NO_DEPARTMENT');
});

test('E5 reconcile: directory failing before its first load → department rule skipped (no disable, no re-enable)', async t => {
    const s = await setup(); t.after(s.close);
    s.person({ groups: ['acme/finance'] });
    s.person({ name: 'bob', id: 'cas-2', email: 'bob@acme.cn', isForbidden: true });
    // Pre-existing bound accounts; the second carries an os-bridge mark from an earlier department loss.
    s.japi.state.users.push({ id: 1, email: 'alice@acme.cn', notes: 'os-bridge casdoor:cas-1', status: 'active', role: 'user' });
    s.japi.state.users.push({ id: 2, email: 'held@acme.cn', notes: `os-bridge casdoor:cas-h ${DISABLED_MARK}`, status: 'disabled', role: 'user' });
    s.japi.state.users.push({ id: 3, email: 'bob@acme.cn', notes: 'os-bridge casdoor:cas-2', status: 'active', role: 'user' });
    s.person({ name: 'held', id: 'cas-h', email: 'held@acme.cn', groups: ['acme/sales'] });
    s.directory.fail = true;
    const run = await s.sync.reconcileAll();
    assert.equal(s.japi.state.users[0].status, 'active', 'not disabled for department reasons');
    assert.equal(s.japi.state.users[1].status, 'disabled', 'not re-enabled while the directory is unknown');
    assert.equal(s.japi.state.users[2].status, 'disabled', 'forbidden still disables');
    assert.equal(run.disabled, 1);
    assert.equal(run.reactivated, 0);
    assert.ok(s.logs.some(line => line.event === 'department_rule_skipped'));
});

test('E5 reconcile: directory failing after a successful load keeps the last good directory', async t => {
    const s = await setup(); t.after(s.close);
    const bob = s.person({ name: 'bob', id: 'cas-2', email: 'bob@acme.cn' });
    s.person();
    await s.chat(alice);
    await s.chat({ ...alice, id: 'cas-2', email: 'bob@acme.cn' });
    s.directory.fail = true;
    bob.groups = ['acme/finance'];
    const run = await s.sync.reconcileAll();
    assert.equal(run.disabledNoDepartment, 1, 'last good directory still says finance is no department');
    assert.equal(s.japi.state.users.find(u => u.email === 'alice@acme.cn').status, 'active');
    assert.ok(!s.logs.some(line => line.event === 'department_rule_skipped'));
    assert.ok(s.logs.some(line => line.event === 'departments_refresh_failed'));
});

test('E5 reconcile: mass department loss above the ratio is refused (guard counts department disables)', async t => {
    const s = await setup(); t.after(s.close);
    const people = [];
    for (let i = 0; i < 8; i++) {
        people.push(s.person({ name: `p${i}`, id: `cas-p${i}`, email: `p${i}@acme.cn` }));
        assert.equal((await s.chat({ ...alice, id: `cas-p${i}`, email: `p${i}@acme.cn` })).status, 200);
    }
    // A Jadmin mistake: the department that holds everybody disappears.
    s.directory.feed.departments = [{ code: 'ops', groups: ['acme/ops'], japiGroupId: 5 }];
    await assert.rejects(s.sync.reconcileAll(), /refusing/);
    assert.ok(s.japi.state.users.every(u => u.status === 'active'));
    assert.ok(people.length === 8);
});

test('E6 webhook update-user: department lost → disabled; regained → re-enabled', async t => {
    const s = await setup(); t.after(s.close);
    const casUser = s.person();
    assert.equal((await s.chat(alice)).status, 200);
    casUser.groups = ['acme/finance'];
    await s.hook({ action: 'update-user', organization: 'built-in', user: 'admin', object: JSON.stringify({ owner: ORG, name: 'alice' }), response: OK });
    assert.equal(s.japi.state.users[0].status, 'disabled');
    assert.ok(s.japi.state.users[0].notes.includes(DISABLED_MARK));
    assert.equal(s.japi.state.keys[0].status, 'disabled');
    casUser.groups = ['acme/sales'];
    await s.hook({ action: 'update-user', organization: 'built-in', user: 'admin', object: JSON.stringify({ owner: ORG, name: 'alice' }), response: OK });
    assert.equal(s.japi.state.users[0].status, 'active');
    assert.equal(s.japi.state.keys[0].status, 'active');
    assert.equal((await s.chat(alice)).status, 200);
});

test('E6 webhook with a never-loaded directory: forbidden still disables, department change is held', async t => {
    const s = await setup(); t.after(s.close);
    const casUser = s.person();
    assert.equal((await s.chat(alice)).status, 200);
    s.directory.fail = true;
    s.directory.feed.departments = [];
    // A fresh provisioner/sync over a directory that has never loaded, sharing the same JAPI.
    const fresh = await setup(); t.after(fresh.close);
    fresh.directory.fail = true;
    fresh.japi.state.users.push({ ...s.japi.state.users[0] });
    fresh.person({ groups: ['acme/finance'] });
    await fresh.hook({ action: 'update-user', object: JSON.stringify({ owner: ORG, name: 'alice' }), response: OK });
    assert.equal(fresh.japi.state.users[0].status, 'active');
    assert.ok(fresh.logs.some(line => line.event === 'department_rule_skipped'));
    fresh.casdoorApi.state.users[0].isForbidden = true;
    await fresh.hook({ action: 'update-user', object: JSON.stringify({ owner: ORG, name: 'alice' }), response: OK });
    assert.equal(fresh.japi.state.users[0].status, 'disabled');
    assert.ok(casUser);
});

test('static departments (no Jadmin loader) count as loaded', async t => {
    const s = await setup({ jadminFeed: false }); t.after(s.close);
    const casUser = s.person();
    assert.equal((await s.chat(alice)).status, 200);
    casUser.groups = ['acme/finance'];
    assert.equal((await s.sync.reconcileAll()).disabledNoDepartment, 1);
});

test('new log events carry no emails, names or keys', async t => {
    const s = await setup(); t.after(s.close);
    const bob = s.person({ name: 'bob', id: 'cas-2', email: 'bob@acme.cn' });
    s.person();
    await s.chat(alice);
    await s.chat({ ...alice, id: 'cas-2', email: 'bob@acme.cn' });
    bob.groups = ['acme/finance'];
    await s.sync.reconcileAll();
    await s.get('/internal/users/2/key');
    const text = JSON.stringify(s.logs);
    for (const secret of ['bob@acme.cn', 'alice@acme.cn', '张三', 'sk-user']) assert.ok(!text.includes(secret), secret);
});
