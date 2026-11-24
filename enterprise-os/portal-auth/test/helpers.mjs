import { createServer, request } from 'node:http';
import { constants, generateKeyPairSync, sign } from 'node:crypto';
import { createPortalHandler } from '../src/server.mjs';

export const ORIGIN = 'https://os.example.test';
export const CLIENT_ID = 'portal-client';
export const CLIENT_SECRET = 'portal-secret-for-tests';
export const BRIDGE_TOKEN = 'bridge-internal-token-for-tests';
export const INSTANCE = 'japi-test';

export function listen(handler) {
    return new Promise(done => {
        const server = createServer(handler);
        server.listen(0, '127.0.0.1', () => done({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) }));
    });
}

const readBody = async req => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks).toString(); };
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Signing keys for ID tokens (RS256 default; ES256/PS256 available). */
export function makeKeys() {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwks = { keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa1', use: 'sig' }, { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec1', use: 'sig', alg: 'ES256' }] };
    const signJwt = (claims, { alg = 'RS256', kid = alg === 'ES256' ? 'ec1' : 'rsa1', key } = {}) => {
        const head = b64({ alg, typ: 'JWT', kid });
        const body = b64(claims);
        const data = Buffer.from(`${head}.${body}`);
        let signature;
        if (alg === 'ES256') signature = sign('sha256', data, { key: key || ec.privateKey, dsaEncoding: 'ieee-p1363' });
        else if (alg === 'PS256') signature = sign('sha256', data, { key: key || rsa.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
        else if (alg === 'none') signature = Buffer.alloc(0);
        else signature = sign('sha256', data, key || rsa.privateKey);
        return `${head}.${body}.${signature.toString('base64url')}`;
    };
    return { jwks, signJwt, rsa, ec };
}

/**
 * Fake Casdoor: discovery, application JWKS, token endpoint. `state.codes` maps a code to the identity it was
 * issued for; tests mutate `state.idTokenFor` to forge bad ID tokens.
 */
export async function fakeCasdoor({ keys = makeKeys() } = {}) {
    const state = { codes: new Map(), tokenRequests: [], discoveryOverride: null, tokenRedirect: null, jwksRedirect: null, idTokenFor: null, calls: [] };
    let issuer;
    const app = await listen(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        state.calls.push(`${req.method} ${url.pathname}`);
        res.setHeader('content-type', 'application/json');
        if (url.pathname === '/.well-known/openid-configuration') {
            return res.end(JSON.stringify(state.discoveryOverride || { issuer, authorization_endpoint: `${issuer}/login/oauth/authorize`, token_endpoint: `${issuer}/api/login/oauth/access_token`, end_session_endpoint: `${issuer}/api/logout`, jwks_uri: `${issuer}/.well-known/jwks` }));
        }
        if (url.pathname === '/.well-known/portal/jwks') {
            if (state.jwksRedirect) { res.statusCode = 302; res.setHeader('location', state.jwksRedirect); return res.end(); }
            return res.end(JSON.stringify(keys.jwks));
        }
        if (url.pathname === '/api/login/oauth/access_token' && req.method === 'POST') {
            const form = new URLSearchParams(await readBody(req));
            state.tokenRequests.push(Object.fromEntries(form));
            if (state.tokenRedirect) { res.statusCode = 302; res.setHeader('location', state.tokenRedirect); return res.end(); }
            const grant = state.codes.get(form.get('code'));
            if (!grant || form.get('client_secret') !== CLIENT_SECRET || form.get('client_id') !== CLIENT_ID) { res.statusCode = 400; return res.end('{"error":"invalid_grant"}'); }
            state.codes.delete(form.get('code'));
            const seconds = Math.floor(Date.now() / 1000);
            const claims = { iss: issuer, aud: [CLIENT_ID], azp: CLIENT_ID, sub: grant.sub, exp: seconds + 3600, iat: seconds, nonce: grant.nonce, tokenType: 'id-token' };
            const idToken = state.idTokenFor ? state.idTokenFor(claims, keys) : keys.signJwt(claims);
            return res.end(JSON.stringify({ access_token: grant.accessToken, id_token: idToken, refresh_token: `refresh-${grant.sub}`, token_type: 'Bearer', expires_in: 3600 }));
        }
        res.statusCode = 404; res.end('{}');
    });
    issuer = app.url;
    return { ...app, state, keys, issuer };
}

/**
 * Fake os-bridge internal listener. `state.people` maps an access token to {casdoorId, user, name, department}
 * or to {error: {status, code}}; `state.users` maps a JAPI user id to the /internal/users answer.
 */
export async function fakeBridge() {
    const state = { people: new Map(), users: new Map(), calls: [], down: false, redirect: null, configDown: false, loginProvider: { type: 'lark', name: 'provider_lark' } };
    const app = await listen((req, res) => {
        const url = new URL(req.url, 'http://x');
        state.calls.push({ path: url.pathname, auth: req.headers.authorization || null, internal: req.headers['x-internal-token'] });
        res.setHeader('content-type', 'application/json');
        const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
        if (req.headers['x-internal-token'] !== BRIDGE_TOKEN) return send(401, { error: { code: 'BAD_INTERNAL_TOKEN' } });
        if (state.down) return send(503, { error: { code: 'FAILED' } });
        if (state.redirect && url.pathname === state.redirect.path) { res.statusCode = 302; res.setHeader('location', state.redirect.location); return res.end(); }
        if (url.pathname === '/internal/config') return state.configDown ? send(503, {}) : send(200, { instance: INSTANCE, loginProvider: state.loginProvider });
        if (url.pathname === '/internal/me') {
            const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
            const person = state.people.get(token);
            if (!person) return send(401, { error: { code: 'UNAUTHORIZED' } });
            if (person.error) return send(person.error.status, { error: { code: person.error.code } });
            return send(200, { user: person.user, instance: person.instance || INSTANCE, casdoorId: person.casdoorId, name: person.name, department: person.department });
        }
        const match = /^\/internal\/users\/(\d+)$/.exec(url.pathname);
        if (match) {
            const answer = state.users.get(match[1]);
            if (!answer) return send(404, { error: { code: 'NO_USER' } });
            if (answer.status) return send(answer.status, answer.body || {});
            return send(200, answer);
        }
        send(404, {});
    });
    return { ...app, state };
}

/** Raw HTTP request with an explicit Host header (fetch cannot set it). */
export function call(base, path, { method = 'GET', headers = {}, body } = {}) {
    const url = new URL(path, base);
    return new Promise((done, fail) => {
        const req = request({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers: { host: new URL(ORIGIN).host, ...headers } }, async res => {
            const text = await readBody(res);
            const cookies = res.headers['set-cookie'] || [];
            done({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text), cookies, location: res.headers.location });
        });
        req.on('error', fail);
        if (body) req.write(body);
        req.end();
    });
}

/** Cookie jar: keeps name=value pairs from Set-Cookie, removes Max-Age=0 ones. */
export class Jar {
    constructor() { this.values = new Map(); }
    take(setCookies) {
        for (const line of setCookies) {
            const [pair, ...attrs] = line.split(';').map(s => s.trim());
            const name = pair.slice(0, pair.indexOf('='));
            const value = pair.slice(pair.indexOf('=') + 1);
            if (attrs.some(a => /^max-age=0$/i.test(a)) || value === '') this.values.delete(name); else this.values.set(name, value);
        }
    }
    header() { return [...this.values].map(([k, v]) => `${k}=${v}`).join('; '); }
}

export const settingsFor = (casdoor, bridge, overrides = {}) => ({
    origin: ORIGIN,
    issuer: casdoor.issuer,
    jwksUrl: `${casdoor.issuer}/.well-known/portal/jwks`,
    clientId: CLIENT_ID,
    scope: 'openid profile email',
    bridge: { baseUrl: bridge.url, japiInstance: INSTANCE },
    sessionMs: 8 * 3600000,
    recheckMs: 60000,
    recheckGraceMs: 300000,
    apps: { chat: { launchUrl: 'https://jchat.example.test/oauth/openid' }, image: { launchUrl: 'https://jimage.example.test/api/config-vault/oidc/start?return=%2Fimage' }, api: { launchUrl: 'https://japi.example.test/api/v1/auth/oauth/oidc/start?redirect=%2Fdashboard' } },
    ...overrides,
});

/** Full test rig: fake Casdoor + fake bridge + portal handler with an injected clock and captured logs. */
export async function rig({ settings: overrides = {}, fetchImpl } = {}) {
    const casdoor = await fakeCasdoor();
    const bridge = await fakeBridge();
    const clock = { now: Date.now() };
    const logs = [];
    const settings = settingsFor(casdoor, bridge, overrides);
    const portal = await listen(createPortalHandler({ settings, clientSecret: CLIENT_SECRET, bridgeToken: BRIDGE_TOKEN, now: () => clock.now, log: line => logs.push(line), ...(fetchImpl ? { fetchImpl } : {}) }));
    const close = () => Promise.all([casdoor.close(), bridge.close(), portal.close()]);
    const person = (n = 1, extra = {}) => {
        const p = { casdoorId: `cas-${n}`, user: { id: n, email: `e${n}@acme.cn`, status: 'active' }, name: `员工${n}`, department: 'sales', ...extra };
        bridge.state.people.set(`access-${n}`, p);
        bridge.state.users.set(String(n), { user: { ...p.user }, instance: INSTANCE, casdoorId: p.casdoorId });
        return p;
    };
    /** Walks /auth/login → (Casdoor issues a code for `n`) → /auth/callback; returns the final response. */
    async function login(jar, n = 1, { app = null, sub = `cas-${n}`, mutate } = {}) {
        const start = await call(portal.url, `/auth/login${app ? `?app=${encodeURIComponent(app)}` : ''}`, { headers: { cookie: jar.header() } });
        jar.take(start.cookies);
        if (start.status !== 302) return { start };
        const authorize = new URL(start.location);
        const code = `code-${n}-${Math.random().toString(36).slice(2)}`;
        casdoor.state.codes.set(code, { sub, nonce: authorize.searchParams.get('nonce'), accessToken: `access-${n}` });
        const query = new URLSearchParams({ code, state: authorize.searchParams.get('state') });
        if (mutate) mutate(query, jar);
        const done = await call(portal.url, `/auth/callback?${query}`, { headers: { cookie: jar.header() } });
        jar.take(done.cookies);
        return { start, authorize, code, done, query };
    }
    const me = jar => call(portal.url, '/auth/me', { headers: { cookie: jar.header() } });
    return { casdoor, bridge, portal, clock, logs, settings, close, person, login, me };
}
