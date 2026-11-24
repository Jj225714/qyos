import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDepartments } from '../src/provisioner.mjs';
import { createInternalHandler } from '../src/server.mjs';
import { listen } from './helpers.mjs';

const TOKEN = 'internal-token-for-tests';
const DIRECTORY = {
    departments: [{ code: 'sales', groups: ['acme/sales'] }, { code: 'ops', groups: ['acme/ops'] }],
    assignments: { 'moved@example.test': 'ops' },
};
const USERS = [
    { id: 'c-2', name: 'bob', email: 'Bob@Example.test', displayName: '李四', groups: ['acme/sales'], isForbidden: false, isDeleted: false },
    { id: 'c-1', name: 'amy', email: 'amy@example.test', displayName: '王五', groups: ['acme/sales'], isForbidden: false, isDeleted: false },
    { id: 'c-3', name: 'gone', email: 'gone@example.test', groups: ['acme/sales'], isForbidden: true },
    { id: 'c-4', name: 'deleted', email: 'deleted@example.test', groups: ['acme/sales'], isDeleted: true },
    { id: 'c-5', name: 'noemail', email: '', groups: ['acme/sales'] },
    { id: 'c-6', name: 'moved', email: 'moved@example.test', groups: ['acme/sales'] },
    { id: 'c-7', name: 'opsy', email: 'opsy@example.test', groups: ['acme/ops'] },
];

async function setup({ casdoor = { users: async () => USERS }, departments = createDepartments(DIRECTORY) } = {}) {
    const logs = [];
    const server = await listen(createInternalHandler({ verifyToken: async () => { throw new Error('unused'); }, provisioner: {}, departments, casdoor, instance: 'japi-test', secrets: { internalToken: TOKEN }, log: line => logs.push(line) }));
    const get = (path, { token = TOKEN, method = 'GET' } = {}) => fetch(`${server.url}${path}`, { method, headers: token ? { 'x-internal-token': token } : {} });
    return { server, logs, get };
}

test('roster: internal token required', async t => {
    const s = await setup(); t.after(s.server.close);
    assert.equal((await s.get('/internal/departments/sales/roster', { token: null })).status, 401);
    assert.equal((await s.get('/internal/departments/sales/roster', { token: 'wrong' })).status, 401);
});

test('roster: only GET', async t => {
    const s = await setup(); t.after(s.server.close);
    assert.equal((await s.get('/internal/departments/sales/roster', { method: 'POST' })).status, 405);
});

test('roster: active members with email, sorted, minimal fields; manual assignment wins', async t => {
    const s = await setup(); t.after(s.server.close);
    const response = await s.get('/internal/departments/sales/roster');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.department, 'sales');
    assert.ok(!Number.isNaN(Date.parse(body.generatedAt)));
    assert.deepEqual(body.members, [
        { casdoorId: 'c-1', email: 'amy@example.test', name: '王五' },
        { casdoorId: 'c-2', email: 'bob@example.test', name: '李四' },
    ]);
    assert.deepEqual(body.excluded, { inactive: 2, noEmail: 1 });
    assert.equal(body.warning, undefined);
    const ops = await (await s.get('/internal/departments/ops/roster')).json();
    assert.deepEqual(ops.members.map(m => m.email), ['moved@example.test', 'opsy@example.test']);
});

test('roster: no active members answers an empty list with a warning', async t => {
    const s = await setup(); t.after(s.server.close);
    const body = await (await s.get('/internal/departments/finance/roster')).json();
    assert.deepEqual(body.members, []);
    assert.equal(body.warning, 'NO_ACTIVE_MEMBERS');
});

test('roster: invalid department codes are 404', async t => {
    const s = await setup(); t.after(s.server.close);
    for (const code of ['..%2Fx', 'Sales', 'a'.repeat(65), '-x']) {
        assert.equal((await s.get(`/internal/departments/${code}/roster`)).status, 404, code);
    }
});

test('roster: Casdoor not configured is 503', async t => {
    const s = await setup({ casdoor: null }); t.after(s.server.close);
    const response = await s.get('/internal/departments/sales/roster');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'CASDOOR_NOT_CONFIGURED');
});

test('roster: Casdoor failure is normalized; upstream text reaches neither body nor logs', async t => {
    const s = await setup({ casdoor: { users: async () => { throw Object.assign(new Error('Casdoor said SENTINEL_SECRET_42 in its message'), { status: 503 }); } } });
    t.after(s.server.close);
    const response = await s.get('/internal/departments/sales/roster');
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, 'CASDOOR_UNAVAILABLE');
    assert.ok(!text.includes('SENTINEL_SECRET_42'));
    assert.ok(!JSON.stringify(s.logs).includes('SENTINEL_SECRET_42'), JSON.stringify(s.logs));
});

test('roster: success log has the count, no member identities', async t => {
    const s = await setup(); t.after(s.server.close);
    await s.get('/internal/departments/sales/roster');
    const line = s.logs.find(entry => entry.event === 'roster');
    assert.deepEqual(line, { event: 'roster', department: 'sales', members: 2 });
    assert.ok(!JSON.stringify(s.logs).includes('example.test'));
});

test('roster: inherits the resolver\'s last good directory when a refresh fails (documented behaviour)', async t => {
    let fail = false;
    let clock = 0;
    const departments = createDepartments({
        load: async () => { if (fail) throw new Error('jadmin down'); return DIRECTORY; },
        refreshMs: 1000,
        now: () => clock,
    });
    const s = await setup({ departments }); t.after(s.server.close);
    assert.equal((await (await s.get('/internal/departments/sales/roster')).json()).members.length, 2);
    fail = true; clock = 5000;
    const body = await (await s.get('/internal/departments/sales/roster')).json();
    assert.equal(body.members.length, 2, 'served from the last good Jadmin directory');
});

test('roster route leaves existing internal routes unchanged', async t => {
    const departments = { ...createDepartments(DIRECTORY), loginProvider: async () => ({ type: 'Lark', name: 'lark' }) };
    const s = await setup({ departments }); t.after(s.server.close);
    const body = await (await s.get('/internal/config')).json();
    assert.deepEqual(body, { instance: 'japi-test', loginProvider: { type: 'Lark', name: 'lark' } });
    assert.equal((await s.get('/internal/departments/sales')).status, 404);
});
