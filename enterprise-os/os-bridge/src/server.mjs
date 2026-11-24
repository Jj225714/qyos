import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { assertApplicationJwks, createJwtVerifier, identityFromClaims, TokenError } from './jwt.mjs';
import { createJapiClient } from './japi.mjs';
import { CHAT_PILOT_PATH, loadChatPilot } from './pilot-chat.mjs';
import { chatModelSocketFd } from './chat-model-control.mjs';
import { createCasdoorClient, identityFromCasdoorUser } from './casdoor.mjs';
import { createWorkEmailCheck } from './work-email.mjs';
import { createCasdoorSync } from './sync.mjs';
import { bindingOf, createDepartments, createProvisioner, jadminDepartmentLoader } from './provisioner.mjs';

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
export function createBridgeHandler({ verifyToken, provisioner, departments, checkWorkEmail = null, sync = null, chatPilot = null, japiBaseUrl, ragflowMcpUrl, secrets, fetchImpl = fetch, log = () => {}, bodyLimit = 32 * 1024 * 1024 }) {
    const japiRoot = japiBaseUrl.replace(/\/+$/, '');

    async function employee(req) {
        // LibreChat sends the token in X-OS-Access-Token (its OpenAI client owns Authorization).
        const token = typeof req.headers['x-os-access-token'] === 'string' ? req.headers['x-os-access-token'] : bearer(req);
        if (!token) throw fault(401, 'NO_TOKEN');
        const claims = await verifyToken(token);
        const identity = identityFromClaims(claims);
        return { identity, checkExistingWorkEmail: !identity.emailVerified && checkWorkEmail ?
            (async () => await checkWorkEmail(claims, identity, { existing: true })) : null };
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
        const { identity, checkExistingWorkEmail } = await employee(req);
        const entry = await provisioner.ensure(identity, { checkExistingWorkEmail });
        log({ event: 'model_call', path, japiUserId: entry.user.id });
        return forward(req, res, `${japiRoot}${path}`, { ...pick(req.headers, MODEL_REQUEST_HEADERS), authorization: `Bearer ${entry.key}` }, MODEL_RESPONSE_HEADERS);
    }

    async function handleKnowledge(req, res, send) {
        if (!['GET', 'POST', 'DELETE'].includes(req.method)) throw fault(405);
        if (!ragflowMcpUrl) throw fault(404);
        const { identity, checkExistingWorkEmail } = await employee(req);
        // Same gate as model calls: a disabled or departed employee loses the knowledge base too,
        // even while their (long-lived) Casdoor token is still valid.
        await provisioner.ensure(identity, { checkExistingWorkEmail });
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
            if (chatPilot && path === CHAT_PILOT_PATH) return await chatPilot(req, res);
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
export function createInternalHandler({ verifyToken, provisioner, departments, casdoor = null, checkWorkEmail = null, sync = null, instance, secrets, log = () => {}, casdoorCacheMs = 60000, now = () => Date.now() }) {
    const casdoorStatus = new Map();
    const ACTIVE = Object.freeze({ active: true, reason: null });

    /**
     * Whether the bound Casdoor user may still use the bridge: exists, not forbidden/deleted and, when
     * provisioning.requireDepartment is on and the Jadmin directory has loaded, in a department (same rule as
     * model calls). Cached briefly. On Casdoor errors the last answer (or "active") is kept: this deliberate
     * fail-open is unchanged, so a Casdoor outage never locks everybody out of Jimage.
     */
    async function casdoorEntitlement(casdoorId) {
        if (!casdoor || !casdoorId) return ACTIVE;
        const cached = casdoorStatus.get(casdoorId);
        if (cached && now() - cached.at < casdoorCacheMs) return cached.value;
        let person;
        try { person = await casdoor.userById(casdoorId); }
        catch (error) {
            log({ event: 'casdoor_status_failed', message: error.message });
            return cached ? cached.value : ACTIVE;
        }
        let value;
        if (!person || person.isForbidden === true || person.isDeleted === true) value = { active: false, reason: 'FORBIDDEN' };
        else if (provisioner.access) {
            const verdict = await provisioner.access(identityFromCasdoorUser(person));
            value = verdict.ok ? ACTIVE : { active: false, reason: verdict.reason };
        } else value = ACTIVE;
        casdoorStatus.set(casdoorId, { value, at: now() });
        if (casdoorStatus.size > 10000) casdoorStatus.delete(casdoorStatus.keys().next().value);
        return value;
    }

    /**
     * Active employees whose department (same rule as model calls) is `code`: the reference list for a
     * hand-managed LibreChat group. Inherits the resolver's last-good Jadmin directory on refresh failure.
     */
    async function roster(code) {
        if (!casdoor) throw fault(503, 'CASDOOR_NOT_CONFIGURED');
        let people;
        // Casdoor error messages can carry upstream text; only a fixed code reaches the log and the client.
        try { people = await casdoor.users(); } catch { throw fault(503, 'CASDOOR_UNAVAILABLE'); }
        const members = [];
        const excluded = { inactive: 0, noEmail: 0 };
        for (const person of people) {
            const identity = identityFromCasdoorUser(person);
            if (identity.forbidden) { excluded.inactive += 1; continue; }
            if (!identity.email) { excluded.noEmail += 1; continue; }
            if ((await departments.resolve(identity)).name === code) members.push({ casdoorId: identity.casdoorId, email: identity.email, name: identity.name });
        }
        members.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
        log({ event: 'roster', department: code, members: members.length });
        return { department: code, generatedAt: new Date(now()).toISOString(), members, excluded, ...(members.length === 0 ? { warning: 'NO_ACTIVE_MEMBERS' } : {}) };
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
            if (path === '/internal/config') return send({ instance, loginProvider: await departments.loginProvider(), loginStatus: await departments.loginStatus?.() || null });
            if (path === '/internal/login-status') return send({ instance, ...await departments.freshLoginStatus() });
            const liveImageUser = /^\/internal\/managed-image\/users\/([1-9][0-9]{0,19})$/.exec(path);
            if (liveImageUser) {
                // Paid routes never use the legacy, cached and deliberately fail-open entitlement check.
                const { casdoorId, ...user } = await provisioner.status(liveImageUser[1]);
                if (user.status !== 'active' || !casdoorId) throw fault(403, 'IMAGE_IDENTITY_DENIED');
                if (!casdoor || !provisioner.access) throw fault(503, 'IMAGE_IDENTITY_UNAVAILABLE');
                let person;
                try { person = await casdoor.userById(casdoorId); }
                catch { throw fault(503, 'IMAGE_IDENTITY_UNAVAILABLE'); }
                const identity = identityFromCasdoorUser(person);
                if (identity.casdoorId !== casdoorId || identity.forbidden || person?.owner !== casdoor.organization) throw fault(403, 'IMAGE_IDENTITY_DENIED');
                const verdict = await provisioner.access(identity);
                if (!verdict.ok || verdict.skipped) throw fault(403, 'IMAGE_IDENTITY_DENIED');
                return send({ user, instance, casdoorId, identityMode: 'strict-live-image-v1' });
            }
            if (path === '/internal/me') {
                const token = bearer(req);
                if (!token) throw fault(401, 'NO_TOKEN');
                const claims = await verifyToken(token);
                const identity = identityFromClaims(claims);
                const nonce = req.headers['x-qyos-work-email-nonce'];
                const workEmailConfirmed = !identity.emailVerified && checkWorkEmail && typeof nonce === 'string' &&
                    /^[A-Za-z0-9_-]{43}$/.test(nonce) && claims.nonce === nonce && await checkWorkEmail(claims, identity);
                const checkExistingWorkEmail = !identity.emailVerified && checkWorkEmail ?
                    () => checkWorkEmail(claims, identity, { existing: true }) : null;
                const entry = await provisioner.ensure(identity, { workEmailConfirmed, checkExistingWorkEmail });
                // Display fields for the portal; never the key.
                return send({ user: entry.user, instance, casdoorId: entry.casdoorId, name: identity.name, department: entry.department?.name ?? null });
            }
            const rosterMatch = /^\/internal\/departments\/([a-z0-9][a-z0-9_-]{0,63})\/roster$/.exec(path);
            if (rosterMatch) return send(await roster(rosterMatch[1]));
            const match = /^\/internal\/users\/([1-9][0-9]{0,19})(\/key)?$/.exec(path);
            if (!match) throw fault(404);
            if (match[2]) {
                const authorize = async casdoorId => {
                    const verdict = await casdoorEntitlement(casdoorId);
                    if (!verdict.active) throw fault(403, verdict.reason);
                };
                return send({ apiKey: await provisioner.keyForUserId(match[1], { authorize }) });
            }
            const { casdoorId, ...user } = await provisioner.status(match[1]);
            if (user.status === 'active') {
                const verdict = await casdoorEntitlement(casdoorId);
                if (!verdict.active) Object.assign(user, { status: 'disabled', reason: verdict.reason });
            }
            // casdoorId lets callers (portal, vault) confirm the account is still bound to the same person.
            return send({ user, instance, casdoorId });
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
    const provisioner = createProvisioner({ japi, departments, keyName: config.japi.keyName || 'enterprise-os', requireDepartment: provisioning.requireDepartment !== false, disableWithoutDepartment: provisioning.disableWithoutDepartment !== false, requireEmailVerified: config.casdoor.requireEmailVerified ?? 'auto', newUser, log });
    const verifyToken = createJwtVerifier({ issuer: config.casdoor.issuer, jwksUrls, audiences: config.casdoor.audiences, fetchImpl, log });
    const casdoor = config.casdoor.organization && config.casdoor.clientId && secrets.casdoorClientSecret
        ? createCasdoorClient({ baseUrl: config.casdoor.apiBaseUrl || config.casdoor.issuer, organization: config.casdoor.organization, clientId: config.casdoor.clientId, clientSecret: secrets.casdoorClientSecret, fetchImpl })
        : null;
    const checkWorkEmail = casdoor && config.jadmin?.url && secrets.jadminToken && config.casdoor.workEmailPortalAudience &&
        config.casdoor.audiences.includes(config.casdoor.workEmailPortalAudience)
        ? createWorkEmailCheck({ casdoor, departments, baseUrl: config.jadmin.url, token: secrets.jadminToken,
            portalAudience: config.casdoor.workEmailPortalAudience,
            boundAudiences: [config.casdoor.workEmailChatAudience, config.casdoor.workEmailImageAudience]
                .filter(a => typeof a === 'string' && a && a !== config.casdoor.workEmailPortalAudience && config.casdoor.audiences.includes(a)), fetchImpl }) : null;
    if (!casdoor) log({ event: 'casdoor_sync_disabled', message: 'casdoor.organization/clientId or secrets.casdoorClientSecret missing: webhooks are ignored and nobody is disabled automatically' });
    const sync = casdoor ? createCasdoorSync({ casdoor, provisioner, log, maxDisableRatio: config.reconcile?.maxDisableRatio ?? 0.2 }) : null;
    let chatPilot = null;
    try {
        chatPilot = await loadChatPilot({ config: config.chatPilot, organization: config.casdoor.organization,
            audience: config.casdoor.workEmailChatAudience, verifyToken, casdoor, japi, bindingOf, fetchImpl, log });
    } catch { log({ event: 'chat_pilot_invalid_config' }); }
    const stopSync = sync ? sync.start(config.reconcile?.intervalMs ?? 600000) : () => {};
    return {
        handler: createBridgeHandler({ verifyToken, provisioner, departments, checkWorkEmail, sync, chatPilot: chatPilot?.handler, japiBaseUrl: config.japi.baseUrl, ragflowMcpUrl: config.ragflow?.mcpUrl, secrets, fetchImpl, log }),
        internalHandler: createInternalHandler({ verifyToken, provisioner, departments, casdoor, checkWorkEmail, sync, instance: config.japi.instance, secrets, log }),
        chatAdminHandler: chatPilot?.adminHandler ?? ((req, res) => {
            res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end('{"code":"MODEL_CONTROL_UNAVAILABLE"}');
        }),
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
    const { handler, internalHandler, chatAdminHandler, stop } = await loadBridge(config);
    const listen = (server, host, port, name) => new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(port, host, () => { server.off('error', fail); console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'listening', name, host, port })); ok(); });
    });
    const publicServer = createServer(handler);
    const internalServer = createServer(internalHandler);
    await listen(publicServer, config.listen?.host || '127.0.0.1', config.listen?.port || 3290, 'public');
    await listen(internalServer, config.internal?.host || '127.0.0.1', config.internal?.port || 3291, 'internal');
    const chatFd = chatModelSocketFd();
    let chatAdminServer;
    if (chatFd !== null) {
        chatAdminServer = createServer({ headersTimeout: 5000, requestTimeout: 5000, connectionsCheckingInterval: 1000,
            keepAliveTimeout: 5000, maxHeaderSize: 8192 }, chatAdminHandler);
        await new Promise((ok, fail) => {
            chatAdminServer.once('error', fail);
            chatAdminServer.listen({ fd: chatFd }, () => { chatAdminServer.off('error', fail); ok(); });
        });
    }
    const shutdown = () => { stop(); publicServer.close(); internalServer.close(); chatAdminServer?.close(); setTimeout(() => process.exit(0), 5000).unref(); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
