import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';

export const ISSUER = 'https://sso.example.test';
export const AUDIENCE = 'jchat-client-id';
export const ORG = 'acme';

export function makeSigner(kid = 'k1') {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
    const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = (claims = {}, header = {}) => {
        const now = Math.floor(Date.now() / 1000);
        const head = b64({ alg: 'RS256', typ: 'JWT', kid, ...header });
        const body = b64({ iss: ISSUER, aud: [AUDIENCE], exp: now + 600, iat: now, tokenType: 'access-token', email_verified: true, ...claims });
        return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
    };
    return { jwks: { keys: [jwk] }, token };
}

export function listen(handler) {
    return new Promise(resolve => {
        const server = createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) }));
    });
}

const readJson = async req => { const chunks = []; for await (const c of req) chunks.push(c); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null; };

/** In-memory stand-in for the Sub2API admin API and gateway (with japi-patch/0001 unless told otherwise). */
export async function fakeJapi({ adminKey = 'admin-key', supportsCreateKey = true, supportsKeyStatus = true, pageLimit = 1000 } = {}) {
    const state = { users: [], keys: [], nextUser: 1, nextKey: 1, calls: [], rateLimitNext: 0 };
    const ok = (res, data, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, message: 'success', data })); };
    const err = (res, status) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: status, message: 'error' })); };
    const noRoute = res => { res.statusCode = 404; res.setHeader('content-type', 'text/plain'); res.end('404 page not found'); };
    const view = user => ({ allowed_groups: null, role: 'user', ...user });
    const app = await listen(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        state.calls.push(`${req.method} ${url.pathname}`);
        if (url.pathname.startsWith('/v1/')) {
            const key = state.keys.find(k => `Bearer ${k.key}` === req.headers.authorization);
            const owner = key && state.users.find(u => u.id === key.user_id);
            if (!key || key.status !== 'active' || owner?.status !== 'active') return err(res, 401);
            const body = await readJson(req);
            if (body?.stream) {
                res.setHeader('content-type', 'text/event-stream');
                res.write(`data: ${JSON.stringify({ user_id: key.user_id })}\n\n`);
                return setTimeout(() => res.end('data: [DONE]\n\n'), 20);
            }
            res.setHeader('content-type', 'application/json');
            return res.end(JSON.stringify({ user_id: key.user_id, path: url.pathname, model: body?.model }));
        }
        if (req.headers['x-api-key'] !== adminKey) return err(res, 401);
        if (state.rateLimitNext > 0) { state.rateLimitNext--; res.statusCode = 429; res.setHeader('retry-after', '0'); return res.end('{}'); }
        let m;
        if (req.method === 'GET' && url.pathname === '/api/v1/admin/users') {
            const q = (url.searchParams.get('search') || '').toLowerCase();
            const size = Number(url.searchParams.get('page_size'));
            const pageSize = size >= 1 && size <= pageLimit ? size : 20;
            const page = Number(url.searchParams.get('page')) || 1;
            const all = state.users.filter(u => `${u.email} ${u.username || ''} ${u.notes || ''}`.toLowerCase().includes(q));
            return ok(res, { items: all.slice((page - 1) * pageSize, page * pageSize).map(view), total: all.length, page, page_size: pageSize, pages: Math.ceil(all.length / pageSize) });
        }
        if (req.method === 'POST' && url.pathname === '/api/v1/admin/users') {
            const body = await readJson(req);
            const user = { id: state.nextUser++, email: body.email, username: body.username, notes: body.notes, status: 'active', role: 'user', allowed_groups: body.allowed_groups || null, balance: body.balance ?? 0, concurrency: body.concurrency ?? 0, rpm_limit: body.rpm_limit ?? 0 };
            state.users.push(user); return ok(res, view(user));
        }
        if ((m = /^\/api\/v1\/admin\/users\/(\d+)$/.exec(url.pathname))) {
            const user = state.users.find(u => u.id === Number(m[1]));
            if (!user) return err(res, 404);
            if (req.method === 'PUT') Object.assign(user, await readJson(req));
            return ok(res, view(user));
        }
        if (req.method === 'PUT' && (m = /^\/api\/v1\/admin\/api-keys\/(\d+)\/status$/.exec(url.pathname))) {
            if (!supportsKeyStatus) return noRoute(res);
            const key = state.keys.find(k => k.id === Number(m[1]));
            if (!key) return err(res, 404);
            key.status = (await readJson(req)).status;
            return ok(res, key);
        }
        if (req.method === 'PUT' && (m = /^\/api\/v1\/admin\/api-keys\/(\d+)$/.exec(url.pathname))) {
            const key = state.keys.find(k => k.id === Number(m[1]));
            if (!key) return err(res, 404);
            key.group_id = (await readJson(req)).group_id ?? null;
            return ok(res, { api_key: key });
        }
        if ((m = /^\/api\/v1\/admin\/users\/(\d+)\/api-keys$/.exec(url.pathname))) {
            if (req.method === 'GET') return ok(res, { items: state.keys.filter(k => k.user_id === Number(m[1])) });
            if (req.method === 'POST' && supportsCreateKey) {
                const user = state.users.find(u => u.id === Number(m[1]));
                if (!user) return err(res, 404);
                const body = await readJson(req);
                const key = { id: state.nextKey++, user_id: Number(m[1]), key: `sk-user${m[1]}-${state.nextKey}`, name: body.name, group_id: body.group_id ?? null, status: 'active' };
                state.keys.push(key); return ok(res, key);
            }
        }
        return noRoute(res);
    });
    return { ...app, state };
}

/** Stand-in for Casdoor's user API (application credential = Basic clientId:secret). */
export async function fakeCasdoor({ clientId = 'bridge-app', clientSecret = 'bridge-secret' } = {}) {
    const state = { users: [], calls: [] };
    const expected = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
    const app = await listen((req, res) => {
        const url = new URL(req.url, 'http://x');
        state.calls.push(`${url.pathname}?${url.searchParams}`);
        res.setHeader('content-type', 'application/json');
        if (req.headers.authorization !== expected) return res.end(JSON.stringify({ status: 'error', msg: 'unauthorized' }));
        if (url.pathname === '/api/get-users') return res.end(JSON.stringify({ status: 'ok', data: state.users.filter(u => u.owner === url.searchParams.get('owner')) }));
        if (url.pathname === '/api/get-user') {
            const id = url.searchParams.get('id');
            const userId = url.searchParams.get('userId');
            const found = state.users.find(u => (id && `${u.owner}/${u.name}` === id) || (userId && u.id === userId && u.owner === url.searchParams.get('owner')));
            return res.end(JSON.stringify({ status: 'ok', data: found || null }));
        }
        res.end(JSON.stringify({ status: 'error', msg: 'unknown' }));
    });
    return { ...app, state };
}

/** Stand-in for RAGFlow's MCP endpoint: echoes which key reached it. */
export async function fakeRagflow({ rejectKey = null } = {}) {
    const seen = [];
    const app = await listen(async (req, res) => {
        const chunks = []; for await (const c of req) chunks.push(c);
        seen.push({ method: req.method, auth: req.headers.authorization, session: req.headers['mcp-session-id'], body: Buffer.concat(chunks).toString() });
        res.setHeader('content-type', 'application/json');
        if (rejectKey && req.headers.authorization === `Bearer ${rejectKey}`) return res.end(JSON.stringify({ code: 102, message: 'Authentication error: API key is invalid!' }));
        res.setHeader('mcp-session-id', 'sess-1');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { auth: req.headers.authorization } }));
    });
    return { ...app, seen };
}
