// SSO-20261115-05 local review regressions (portal-auth-review.md A/B, browser-logout-review.md), adapted to the
// owned suite. Mock Casdoor/os-bridge only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, Jar, call, ORIGIN } from './helpers.mjs';

for (const [code, setup] of [
    ['NO_DEPARTMENT', r => r.bridge.state.people.set('access-2', { error: { status: 403, code: 'NO_DEPARTMENT' } })],
    ['ADMIN_ACCOUNT', r => r.bridge.state.people.set('access-2', { error: { status: 403, code: 'ADMIN_ACCOUNT' } })],
    ['IDENTITY_MISMATCH', r => r.bridge.state.people.set('access-2', { error: { status: 403, code: 'IDENTITY_MISMATCH' } })],
    ['BINDING_REQUIRED', r => r.bridge.state.people.set('access-2', { error: { status: 403, code: 'BINDING_REQUIRED' } })],
    ['failed', r => r.person(2, { casdoorId: 'cas-other' })], // id_token sub ≠ bridge casdoorId
]) {
    test(`review A: refused replacement login (${code}) ends the previous portal identity`, async t => {
        const r = await rig(); t.after(r.close);
        r.person(1);
        setup(r);
        const jar = new Jar();
        await r.login(jar, 1);
        const oldCookie = jar.values.get('__Host-qyos_portal');
        assert.equal((await r.me(jar)).status, 200);
        const denied = await r.login(jar, 2);
        assert.equal(denied.done.location, `/?login_error=${code}`);
        assert.ok(denied.done.cookies.some(c => c.startsWith('__Host-qyos_portal=;') && c.includes('Max-Age=0')), 'session cookie cleared');
        const after = await r.me(jar);
        assert.equal(after.status, 401);
        assert.deepEqual(after.json(), { signedIn: false });
        const stale = new Jar(); stale.values.set('__Host-qyos_portal', oldCookie);
        assert.equal((await r.me(stale)).status, 401, 'the old session is gone server-side, not just from the browser');
    });
}

test('review A: a forged/invalid callback (wrong state) does NOT end the current session (no logout CSRF)', async t => {
    const r = await rig(); t.after(r.close);
    r.person(1);
    const jar = new Jar();
    await r.login(jar, 1);
    const forged = await call(r.portal.url, '/auth/callback?code=x&state=' + 'A'.repeat(43), { headers: { cookie: jar.header() } });
    assert.equal(forged.location, '/?login_error=state');
    assert.equal((await r.me(jar)).status, 200);
});

test('review B: logged-out return requires a valid, non-empty, unambiguous matching state', async t => {
    const r = await rig(); t.after(r.close);
    r.person(1);
    const jar = new Jar();
    await r.login(jar, 1);
    const session = jar.header();
    const good = 'Q'.repeat(32);
    const cases = [
        ['neither supplied', '/auth/logged-out', session],
        ['both empty', '/auth/logged-out?state=', `${session}; __Host-qyos_portal_logout=`],
        ['missing cookie', `/auth/logged-out?state=${good}`, session],
        ['missing query', '/auth/logged-out', `${session}; __Host-qyos_portal_logout=${good}`],
        ['mismatch', `/auth/logged-out?state=${'R'.repeat(32)}`, `${session}; __Host-qyos_portal_logout=${good}`],
        ['ambiguous cookies, missing query', '/auth/logged-out', `${session}; __Host-qyos_portal_logout=a; __Host-qyos_portal_logout=b`],
        ['ambiguous cookies, matching query', `/auth/logged-out?state=${good}`, `${session}; __Host-qyos_portal_logout=${good}; __Host-qyos_portal_logout=${good}`],
        ['wrong shape', '/auth/logged-out?state=short', `${session}; __Host-qyos_portal_logout=short`],
        ['malformed unicode', `/auth/logged-out?state=${encodeURIComponent('é'.repeat(32))}`, `${session}; __Host-qyos_portal_logout=${'e'.repeat(32)}`],
        ['lone surrogate', '/auth/logged-out?state=%ED%A0%80' + 'a'.repeat(29), `${session}; __Host-qyos_portal_logout=${'a'.repeat(32)}`],
    ];
    for (const [name, path, cookie] of cases) {
        const result = await call(r.portal.url, path, { headers: { cookie } });
        assert.equal(result.status, 303, name);
        assert.equal(result.location, '/', `${name}: no signed-out banner`);
    }
    assert.equal((await r.me(jar)).status, 200, 'unsolicited returns did not log anybody out');
    const ok = await call(r.portal.url, `/auth/logged-out?state=${good}`, { headers: { cookie: `__Host-qyos_portal_logout=${good}` } });
    assert.equal(ok.location, '/?signed_out=1');
    assert.ok(ok.cookies.some(c => c.startsWith('__Host-qyos_portal_logout=;')));
});

test('callback state with malformed unicode fails safely (no 500)', async t => {
    const r = await rig(); t.after(r.close);
    const res = await call(r.portal.url, `/auth/callback?code=x&state=${encodeURIComponent('é'.repeat(43))}`, { headers: { cookie: `__Host-qyos_portal_txn=${'e'.repeat(43)}` } });
    assert.equal(res.status, 303);
    assert.equal(res.location, '/?login_error=state');
});

test('browser logout: Origin null (what a no-referrer page sends) is still refused; the exact portal Origin works', async t => {
    const r = await rig(); t.after(r.close);
    r.person(1);
    const jar = new Jar();
    await r.login(jar, 1);
    const form = { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', cookie: jar.header() };
    assert.equal((await call(r.portal.url, '/auth/logout', { method: 'POST', headers: { ...form, origin: 'null' }, body: '' })).status, 403);
    assert.equal((await r.me(jar)).status, 200);
    const out = await call(r.portal.url, '/auth/logout', { method: 'POST', headers: { ...form, origin: ORIGIN }, body: '' });
    assert.equal(out.status, 303);
});

test('review C (server side): logout retry without a portal session still ends the Casdoor session', async t => {
    const r = await rig(); t.after(r.close);
    const out = await call(r.portal.url, '/auth/logout', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    assert.equal(out.status, 303);
    const target = new URL(out.location);
    assert.equal(`${target.origin}${target.pathname}`, `${r.casdoor.issuer}/api/logout`);
    assert.ok(out.cookies.some(c => c.startsWith('__Host-qyos_portal_logout=') && !c.startsWith('__Host-qyos_portal_logout=;')));
});
