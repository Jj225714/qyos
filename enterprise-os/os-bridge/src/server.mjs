import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { assertApplicationJwks, createJwtVerifier, identityFromClaims, TokenError } from './jwt.mjs';
import { createJapiClient } from './japi.mjs';
import { createCasdoorClient } from './casdoor.mjs';
import { createCasdoorSync } from './sync.mjs';
import { createDepartments, createProvisioner, jadminDepartmentLoader } from './provisioner.mjs';

// OpenAI-compatible paths that employees may call through the bridge.
const MODEL_PATHS = new Map([
    ['/v1/models', ['GET']],
    ['/v1/chat/completions', ['POST']],
    ['/v1/responses', ['POST']],
    ['/v1/embeddings', ['POST']],
    ['/v1/images/generations', ['POST']],
    ['/v1/images/edits', ['POST']],
]);
const MODEL_REQUEST_HEADERS = ['content-type', 'accept', 'openai-beta'];
const MODEL_RESPONSE_HEADERS = ['content-type', 'cache-control', 'x-request-id'];
const MCP_REQUEST_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const MCP_RESPONSE_HEADERS = ['content-type', 'cache-control', 'mcp-session-id'];
const MCP_PROTOCOL = '2025-06-18';

const fault = (status, code) => Object.assign(new Error(code || 'Request failed'), { status, code });
const digest = value => createHash('sha256').update(String(value)).digest();
const sameSecret = (given, expected) => typeof given === 'string' && typeof expected === 'string' && expected.length > 0 && timingSafeEqual(digest(given), digest(expected));
const bearer = req => /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];

async function readBody(req, limit) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw fault(413, 'BODY_TOO_LARGE'); chunks.push(chunk); }
    return Buffer.concat(chunks);
}

function pick(headers, names) {
    const out = {};
    for (const name of names) { const value = headers[name]; if (typeof value === 'string') out[name] = value; }
    return out;
}

function respond(res, log) {
    const send = (value, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    const fail = error => {
        const status = error instanceof TokenError ? 401 : error.status && error.status < 600 ? error.status : 500;
        if (status >= 500) log({ event: 'error', message: error.message, code: error.code });
        if (!res.headersSent) send({ error: { code: error.code || (status === 401 ? 'UNAUTHORIZED' : 'FAILED'), message: status >= 500 ? 'Upstream failure' : error.message } }, status);
        else res.destroy();
    };
    return { send, fail };
}

/**
 * MCP answers for an employee whose department has no knowledge base: an empty tool list rather than
 * an HTTP error, so chat clients keep working and simply offer no knowledge tool.
 */
function emptyMcp(message) {
    const reply = result => ({ jsonrpc: '2.0', id: message.id ?? null, result });
    switch (message?.method) {
        case 'initialize': return reply({ protocolVersion: message.params?.protocolVersion || MCP_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'enterprise-knowledge', version: '1.0.0' } });
        case 'tools/list': return reply({ tools: [] });
        case 'ping': return reply({});
        default: return message?.id === undefined ? null : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'No knowledge base for your department' } };
    }
}

/**
 * Public side of os-bridge (reachable from containers):
 *  - /v1/*              OpenAI-compatible proxy; Casdoor access token in, the employee's own JAPI key out
 *  - /mcp/knowledge     RAGFlow MCP proxy; the department's RAGFlow key is chosen server-side
 *  - /webhooks/casdoor  "someone changed" hints from Casdoor; the person is re-read from Casdoor
 */
export function createBridgeHandler({ verifyToken, provisioner, departments, sync = null, japiBaseUrl, ragflowMcpUrl, secrets, fetchImpl = fetch, log = () => {}, bodyLimit = 32 * 1024 * 1024 }) {
    const japiRoot = japiBaseUrl.replace(/\/+$/, '');

    async function employee(req) {
        // LibreChat sends the token in X-OS-Access-Token (its OpenAI client owns Authorization).
        const token = typeof req.headers['x-os-access-token'] === 'string' ? req.headers['x-os-access-token'] : bearer(req);
        if (!token) throw fault(401, 'NO_TOKEN');
        return identityFromClaims(await verifyToken(token));
    }

    async function forward(req, res, url, headers, responseHeaders, { body, inspect } = {}) {
        const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
        const payload = hasBody ? (body ?? await readBody(req, bodyLimit)) : undefined;
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableFinished) controller.abort(); });
        let upstream;
        try { upstream = await fetchImpl(url, { method: req.method, headers, body: payload, signal: controller.signal }); }
        catch { throw fault(502, 'UPSTREAM_UNREACHABLE'); }
        if (inspect && /application\/json/i.test(upstream.headers.get('content-type') || '')) {
            const text = await upstream.text();
            const problem = inspect(upstream.status, text);
            if (problem) throw problem;
            res.statusCode = upstream.status;
            for (const name of responseHeaders) { const value = upstream.headers.get(name); if (value) res.setHeader(name, value); }
            return res.end(text);
        }
        res.statusCode = upstream.status;
        for (const name of responseHeaders) { const value = upstream.headers.get(name); if (value) res.setHeader(name, value); }
        if (!upstream.body) return res.end();
        Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
    }

    async function handleWebhook(req, send) {
        if (req.method !== 'POST') throw fault(405);
        if (!sameSecret(req.headers['x-os-bridge-secret'], secrets.webhookSecret)) throw fault(401, 'BAD_SECRET');
        let record;
        try { record = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')); } catch (error) { throw error.status ? error : fault(400, 'BAD_JSON'); }
        if (!sync) return send({ ok: true, result: 'ignored: Casdoor sync not configured' });
        return send({ ok: true, ...(await sync.handleRecord(record)) });
    }

    async function handleModels(req, res, path) {
        const methods = MODEL_PATHS.get(path);
        if (!methods) throw fault(404);
        if (!methods.includes(req.method)) throw fault(405);
        const entry = await provisioner.ensure(await employee(req));
        log({ event: 'model_call', path, japiUserId: entry.user.id });
        return forward(req, res, `${japiRoot}${path}`, { ...pick(req.headers, MODEL_REQUEST_HEADERS), authorization: `Bearer ${entry.key}` }, MODEL_RESPONSE_HEADERS);
    }

    async function handleKnowledge(req, res, send) {
        if (!['GET', 'POST', 'DELETE'].includes(req.method)) throw fault(405);
        if (!ragflowMcpUrl) throw fault(404);
        const identity = await employee(req);
        // Same gate as model calls: a disabled or departed employee loses the knowledge base too,
        // even while their (long-lived) Casdoor token is still valid.
        await provisioner.ensure(identity);
        const dept = await departments.resolve(identity);
        if (!dept.ragflowKey) {
            if (req.method !== 'POST') throw fault(405);
            let message;
            try { message = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')); } catch { throw fault(400, 'BAD_JSON'); }
            const replies = (Array.isArray(message) ? message : [message]).map(emptyMcp).filter(Boolean);
            if (replies.length === 0) { res.statusCode = 202; return res.end(); }
            return send(Array.isArray(message) ? replies : replies[0]);
        }
        log({ event: 'knowledge_call', department: dept.name, method: req.method });
        // RAGFlow answers a bad API key with HTTP 200 and {"code":102,...}; surface it as an error.
        const inspect = (status, text) => {
            let body; try { body = JSON.parse(text); } catch { return null; }
            if (body && !Array.isArray(body) && body.jsonrpc === undefined && typeof body.code === 'number' && body.code !== 0) {
                log({ event: 'ragflow_rejected', department: dept.name, code: body.code });
                return fault(502, 'RAGFLOW_REJECTED');
            }
            return null;
        };
        return forward(req, res, ragflowMcpUrl, { ...pick(req.headers, MCP_REQUEST_HEADERS), authorization: `Bearer ${dept.ragflowKey}` }, MCP_RESPONSE_HEADERS, { inspect });
    }

    return async (req, res) => {
        const { send, fail } = respond(res, log);
        res.setHeader('cache-control', 'no-store');
        try {
            const url = new URL(req.url, 'http://bridge.local');
            const path = url.pathname;
            if (path === '/healthz') return send({ ok: true });
            if (path === '/webhooks/casdoor') return await handleWebhook(req, send);
            if (path.startsWith('/v1/')) return await handleModels(req, res, path);
            if (path === '/mcp/knowledge') return await handleKnowledge(req, res, send);
            throw fault(404);
        } catch (error) { fail(error); }
    };
}

/**
 * Internal side of os-bridge (loopback only): identity lookups for the Jimage config vault, guarded by a
 * shared token. Kept off the container-reachable listener, because it hands out employees' keys.
 */
export function createInternalHandler({ verifyToken, provisioner, departments, casdoor = null, sync = null, instance, secrets, log = () => {}, casdoorCacheMs = 60000, now = () => Date.now() }) {
    const casdoorStatus = new Map();

    /** Whether the Casdoor user still exists and is not forbidden (cached briefly; unknown on Casdoor errors). */
    async function casdoorActive(casdoorId) {
        if (!casdoor || !casdoorId) return true;
        const cached = casdoorStatus.get(casdoorId);
        if (cached && now() - cached.at < casdoorCacheMs) return cached.active;
        try {
            const person = await casdoor.userById(casdoorId);
            const active = Boolean(person) && person.isForbidden !== true && person.isDeleted !== true;
            casdoorStatus.set(casdoorId, { active, at: now() });
            if (casdoorStatus.size > 10000) casdoorStatus.delete(casdoorStatus.keys().next().value);
            return active;
        } catch (error) {
            log({ event: 'casdoor_status_failed', message: error.message });
            return cached ? cached.active : true;
        }
    }

    return async (req, res) => {
        const { send, fail } = respond(res, log);
        res.setHeader('cache-control', 'no-store');
        try {
            const path = new URL(req.url, 'http://bridge.local').pathname;
            if (path === '/healthz') return send({ ok: true, reconcile: sync?.status() || null });
            if (!path.startsWith('/internal/')) throw fault(404);
            if (!sameSecret(req.headers['x-internal-token'], secrets.internalToken)) throw fault(401, 'BAD_INTERNAL_TOKEN');
            if (req.method !== 'GET') throw fault(405);
            if (path === '/internal/config') return send({ instance, loginProvider: await departments.loginProvider() });
            if (path === '/internal/me') {
                const token = bearer(req);
                if (!token) throw fault(401, 'NO_TOKEN');
                const entry = await provisioner.ensure(identityFromClaims(await verifyToken(token)));
                return send({ user: entry.user, instance });
            }
            const match = /^\/internal\/users\/([1-9][0-9]{0,19})(\/key)?$/.exec(path);
            if (!match) throw fault(404);
            if (match[2]) return send({ apiKey: await provisioner.keyForUserId(match[1]) });
            const { casdoorId, ...user } = await provisioner.status(match[1]);
            if (user.status === 'active' && !(await casdoorActive(casdoorId))) user.status = 'disabled';
            return send({ user, instance });
        } catch (error) { fail(error); }
    };
}

/** Builds both handlers from the config file (see config.example.json). */
export async function loadBridge(config, { fetchImpl = fetch, log = line => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`) } = {}) {
    const secrets = JSON.parse(await readFile(config.secretsFile, 'utf8'));
    const jwksUrls = config.casdoor.jwksUrls || (config.casdoor.jwksUrl ? [config.casdoor.jwksUrl] : []);
    assertApplicationJwks(jwksUrls);
    if (!config.japi.instance) throw new Error('config.japi.instance is required (the same value goes into the Jimage vault sso-config bridge.japiInstance)');
    const provisioning = config.provisioning || {};
    // Departments are maintained in Jadmin; `config.departments` is only a fallback when Jadmin is not configured.
    const load = config.jadmin?.url ? jadminDepartmentLoader({ baseUrl: config.jadmin.url, token: secrets.jadminToken, fetchImpl }) : null;
    const departments = createDepartments({ load, departments: config.departments || [], assignments: config.assignments || {}, defaultJapiGroupId: provisioning.requireDepartment === false ? (config.japi.defaultGroupId ?? null) : null, defaultRagflowKey: secrets.ragflowKeys?.['*'] || null, ragflowKeys: secrets.ragflowKeys || {}, log });
    const japi = createJapiClient({ baseUrl: config.japi.baseUrl, adminKey: secrets.japiAdminKey, fetchImpl });
    const newUser = { balance: config.japi.newUser?.balance, concurrency: config.japi.newUser?.concurrency, rpmLimit: config.japi.newUser?.rpmLimit };
    const provisioner = createProvisioner({ japi, departments, keyName: config.japi.keyName || 'enterprise-os', requireDepartment: provisioning.requireDepartment !== false, requireEmailVerified: config.casdoor.requireEmailVerified ?? 'auto', newUser, log });
    const verifyToken = createJwtVerifier({ issuer: config.casdoor.issuer, jwksUrls, audiences: config.casdoor.audiences, fetchImpl, log });
    const casdoor = config.casdoor.organization && config.casdoor.clientId && secrets.casdoorClientSecret
        ? createCasdoorClient({ baseUrl: config.casdoor.apiBaseUrl || config.casdoor.issuer, organization: config.casdoor.organization, clientId: config.casdoor.clientId, clientSecret: secrets.casdoorClientSecret, fetchImpl })
        : null;
    if (!casdoor) log({ event: 'casdoor_sync_disabled', message: 'casdoor.organization/clientId or secrets.casdoorClientSecret missing: webhooks are ignored and nobody is disabled automatically' });
    const sync = casdoor ? createCasdoorSync({ casdoor, provisioner, log, maxDisableRatio: config.reconcile?.maxDisableRatio ?? 0.2 }) : null;
    const stopSync = sync ? sync.start(config.reconcile?.intervalMs ?? 600000) : () => {};
    return {
        handler: createBridgeHandler({ verifyToken, provisioner, departments, sync, japiBaseUrl: config.japi.baseUrl, ragflowMcpUrl: config.ragflow?.mcpUrl, secrets, fetchImpl, log }),
        internalHandler: createInternalHandler({ verifyToken, provisioner, departments, casdoor, sync, instance: config.japi.instance, secrets, log }),
        stop: stopSync,
    };
}

export function configPathFromArgs(argv) {
    const index = argv.indexOf('--config');
    const value = index >= 0 ? argv[index + 1] : undefined;
    return value && !value.startsWith('--') ? value : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const configPath = configPathFromArgs(process.argv);
    if (!configPath) { console.error('usage: node src/server.mjs --config /etc/os-bridge/config.json'); process.exit(2); }
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const { handler, internalHandler, stop } = await loadBridge(config);
    const listen = (server, host, port, name) => new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(port, host, () => { server.off('error', fail); console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'listening', name, host, port })); ok(); });
    });
    const publicServer = createServer(handler);
    const internalServer = createServer(internalHandler);
    await listen(publicServer, config.listen?.host || '127.0.0.1', config.listen?.port || 3290, 'public');
    await listen(internalServer, config.internal?.host || '127.0.0.1', config.internal?.port || 3291, 'internal');
    const shutdown = () => { stop(); publicServer.close(); internalServer.close(); setTimeout(() => process.exit(0), 5000).unref(); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
