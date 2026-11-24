import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDepartments, createProvisioner } from '../src/provisioner.mjs';

const DEPTS = [{ code: 'sales', groups: ['acme/sales'], japiGroupId: 3 }, { code: 'rd', groups: ['acme/rd'], japiGroupId: 4 }];

/** In-process JAPI stand-in whose lookups can be held open, so interleavings are deterministic. */
function memoryJapi() {
    const state = { users: [], keys: [], nextUser: 1, nextKey: 1, calls: [], gates: [] };
    const hold = () => new Promise(release => state.gates.push(release));
    const japi = {
        state,
        holdNextLookup: false,
        async findUserByEmail(email) {
            state.calls.push(`find ${email}`);
            if (japi.holdNextLookup) { japi.holdNextLookup = false; await hold(); }
            const user = state.users.find(u => u.email === email.toLowerCase());
            return user ? structuredClone(user) : null;
        },
        async createUser({ email, username, notes, groupIds }) {
            state.calls.push('createUser');
            const user = { id: state.nextUser++, email: email.toLowerCase(), username, notes, status: 'active', role: 'user', allowed_groups: [...groupIds] };
            state.users.push(user);
            return structuredClone(user);
        },
        async getUser(id) { const user = state.users.find(u => u.id === Number(id)); return user ? structuredClone(user) : null; },
        async updateUser(id, patch) { state.calls.push(`updateUser ${id}`); Object.assign(state.users.find(u => u.id === id), patch); },
        async listKeys(userId) { return state.keys.filter(k => k.user_id === userId).map(k => ({ ...k })); },
        async createKey(userId, { name, groupId }) {
            state.calls.push('createKey');
            const key = { id: state.nextKey++, user_id: userId, key: `sk-fake-user${userId}-${state.nextKey}`, name, group_id: groupId ?? null, status: 'active' };
            state.keys.push(key);
            return { ...key };
        },
        async updateKeyGroup(id, groupId) { state.calls.push(`updateKeyGroup ${groupId}`); state.keys.find(k => k.id === id).group_id = groupId; },
        async setKeyStatus() {},
        async searchUsers() { return []; },
    };
    return japi;
}

const until = async check => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setImmediate(r)); } throw new Error('condition timed out'); };
const person = (casdoorId, extra = {}) => ({ email: 'shared@acme.cn', emailVerified: true, casdoorId, name: casdoorId, groups: ['acme/sales'], forbidden: false, ...extra });

function setup({ loginProvider = { type: 'lark' } } = {}) {
    const japi = memoryJapi();
    const departments = { ...createDepartments({ departments: DEPTS }), loginProvider: async () => loginProvider };
    const provisioner = createProvisioner({ japi, departments });
    return { japi, provisioner };
}

for (const order of [['cas-A', 'cas-B'], ['cas-B', 'cas-A']]) {
    test(`concurrent identities sharing an email: only the bound identity gets the key (${order.join(' then ')})`, async () => {
        const { japi, provisioner } = setup();
        japi.state.users.push({ id: 1, email: 'shared@acme.cn', notes: 'os-bridge casdoor:cas-A', status: 'active', role: 'user', allowed_groups: [3] });
        japi.state.nextUser = 2;
        japi.holdNextLookup = true;
        const first = provisioner.ensure(person(order[0]));
        await until(() => japi.state.gates.length === 1);
        const second = provisioner.ensure(person(order[1]));
        // The second request waits for the email lock; it has not touched JAPI yet.
        for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
        assert.equal(japi.state.calls.filter(c => c.startsWith('find')).length, 1);
        japi.state.gates.shift()();
        const results = await Promise.allSettled([first, second]);
        const byId = Object.fromEntries(order.map((id, i) => [id, results[i]]));
        assert.equal(byId['cas-A'].status, 'fulfilled');
        assert.equal(byId['cas-A'].value.casdoorId, 'cas-A');
        assert.match(byId['cas-A'].value.key, /^sk-fake-user1-/);
        assert.equal(byId['cas-B'].status, 'rejected');
        assert.equal(byId['cas-B'].reason.code, 'IDENTITY_MISMATCH');
        assert.equal(japi.state.users[0].notes, 'os-bridge casdoor:cas-A');
    });
}

test('concurrent unbound first use by two identities: the second one is refused, not handed the first one\'s key', async () => {
    const { japi, provisioner } = setup();
    japi.holdNextLookup = true;
    const a = provisioner.ensure(person('cas-A'));
    await until(() => japi.state.gates.length === 1);
    const b = provisioner.ensure(person('cas-B'));
    japi.state.gates.shift()();
    const [ra, rb] = await Promise.allSettled([a, b]);
    assert.equal(ra.status, 'fulfilled');
    assert.equal(rb.status, 'rejected');
    assert.equal(rb.reason.code, 'IDENTITY_MISMATCH');
    assert.equal(japi.state.users.length, 1);
    assert.equal(japi.state.keys.length, 1);
});

test('same identity concurrent first use creates exactly one user and one key', async () => {
    const { japi, provisioner } = setup();
    japi.holdNextLookup = true;
    const calls = [provisioner.ensure(person('cas-A')), provisioner.ensure(person('cas-A')), provisioner.ensure(person('cas-A'))];
    await until(() => japi.state.gates.length === 1);
    japi.state.gates.shift()();
    const results = await Promise.all(calls);
    assert.equal(japi.state.calls.filter(c => c === 'createUser').length, 1);
    assert.equal(japi.state.calls.filter(c => c === 'createKey').length, 1);
    assert.ok(results.every(r => r.key === results[0].key && r.casdoorId === 'cas-A'));
});

test('a department change during a concurrent request returns the caller\'s own department and moves the key', async () => {
    const { japi, provisioner } = setup();
    japi.holdNextLookup = true;
    const sales = provisioner.ensure(person('cas-A'));
    await until(() => japi.state.gates.length === 1);
    const rd = provisioner.ensure(person('cas-A', { groups: ['acme/rd'] }));
    japi.state.gates.shift()();
    const [a, b] = await Promise.all([sales, rd]);
    assert.equal(a.department.name, 'sales');
    assert.equal(b.department.name, 'rd');
    assert.equal(b.department.japiGroupId, 4);
    assert.equal(japi.state.keys[0].group_id, 4);
    assert.ok(japi.state.calls.includes('updateKeyGroup 4'));
    assert.deepEqual(japi.state.users[0].allowed_groups, [4]);
});

test('WeCom: an unverified email never auto-links an existing unbound account', async () => {
    const { japi, provisioner } = setup({ loginProvider: { type: 'wecom' } });
    japi.state.users.push({ id: 1, email: 'shared@acme.cn', notes: 'legacy', status: 'active', role: 'user', allowed_groups: [] });
    japi.state.nextUser = 2;
    await assert.rejects(provisioner.ensure(person('cas-w', { emailVerified: false })), err => err.code === 'BINDING_REQUIRED' && err.status === 403 && err.message.includes('os-bridge casdoor:cas-w'));
    assert.equal(japi.state.users[0].notes, 'legacy');
    assert.equal(japi.state.keys.length, 0);
    assert.ok(!japi.state.calls.some(c => c.startsWith('updateUser')));
});

test('WeCom: an administrator\'s explicit binding works; another unverified identity with that email is refused', async () => {
    const { japi, provisioner } = setup({ loginProvider: { type: 'wecom' } });
    japi.state.users.push({ id: 1, email: 'shared@acme.cn', notes: 'legacy os-bridge casdoor:cas-w', status: 'active', role: 'user', allowed_groups: [] });
    japi.state.nextUser = 2;
    const entry = await provisioner.ensure(person('cas-w', { emailVerified: false }));
    assert.equal(entry.user.id, 1);
    await assert.rejects(provisioner.ensure(person('cas-x', { emailVerified: false })), { code: 'IDENTITY_MISMATCH' });
});

test('WeCom: an unverified email still gets a new account bound to its Casdoor ID; verified emails still auto-bind', async () => {
    const { japi, provisioner } = setup({ loginProvider: { type: 'wecom' } });
    const created = await provisioner.ensure(person('cas-new', { email: 'new@acme.cn', emailVerified: false }));
    assert.equal(japi.state.users.find(u => u.id === created.user.id).notes, 'os-bridge casdoor:cas-new');
    japi.state.users.push({ id: 50, email: 'verified@acme.cn', notes: '', status: 'active', role: 'user', allowed_groups: [] });
    const bound = await provisioner.ensure(person('cas-v', { email: 'verified@acme.cn', emailVerified: true }));
    assert.equal(bound.user.id, 50);
    assert.equal(japi.state.users.find(u => u.id === 50).notes, 'os-bridge casdoor:cas-v');
});
