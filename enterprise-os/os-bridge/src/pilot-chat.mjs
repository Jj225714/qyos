import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { once } from 'node:events';
import { CHAT_MODEL as MODEL, createChatModelControl } from './chat-model-control.mjs';

export const CHAT_PILOT_PATH = '/pilot-chat/v1/chat/completions';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,191}$/;
const SECRET = /^[A-Za-z0-9._~+/=:\-]{16,512}$/;
const GATEWAY_ROOT = 'http://127.0.0.1:8080';
const FORWARD_TIMEOUT = 90_000;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function readPrivateText(filePath, limit, expectedUid = undefined) {
    if (!isAbsolute(filePath)) throw new Error('Use an absolute path');
    const fd = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
        const stat = await fd.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit ||
            (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (expectedUid !== undefined && stat.uid !== expectedUid)))) {
            throw new Error('Private file invalid');
        }
        const buffer = Buffer.alloc(limit + 1);
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
        if (bytesRead > limit) throw new Error('Private file exceeded limit');
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await fd.close(); }
}

function sameSecret(actual, expected) {
    if (!SECRET.test(actual || '') || !SECRET.test(expected || '')) return false;
    const hash = value => createHash('sha256').update(value).digest();
    return timingSafeEqual(hash(actual), hash(expected));
}

export function createPilotLedger(filePath) {
    if (!isAbsolute(filePath)) throw new Error('Use an absolute ledger path');
    let tail = Promise.resolve();
    return row => {
        const write = tail.then(async () => {
            const fd = await open(filePath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY |
                (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0), 0o600);
            try {
                const stat = await fd.stat();
                if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== 'win32' &&
                    ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw new Error('Invalid ledger file');
                await fd.writeFile(`${JSON.stringify(row)}\n`, 'utf8');
                await fd.sync();
            } finally { await fd.close(); }
        });
        tail = write.catch(() => {});
        return write;
    };
}

export function createPilotAuthorization({ organization, audience, verifyToken, loadEmployee, loadGatewayUser, bindingOf }) {
    if (typeof organization !== 'string' || !ID.test(organization) || typeof audience !== 'string' || !audience ||
        [verifyToken, loadEmployee, loadGatewayUser, bindingOf].some(fn => typeof fn !== 'function')) throw new Error('Pilot identity configuration missing');
    return async (token, roster) => {
        let claims;
        try { claims = await verifyToken(token); }
        catch (e) { throw e?.status === 401 ? fail(401, 'INVALID_SESSION') : fail(503, 'IDENTITY_UNAVAILABLE'); }
        const subject = claims?.sub;
        if (typeof subject !== 'string' || !ID.test(subject) || (claims.id !== undefined && claims.id !== subject) ||
            ![claims.aud].flat().includes(audience) || claims.azp !== audience ||
            (claims.owner !== undefined && claims.owner !== organization) || claims.isForbidden === true ||
            claims.isDisabled === true || claims.isDeleted === true) throw fail(403, 'PILOT_DENIED');
        const selected = roster.filter(row => row.organization === organization && row.subject === subject);
        if (selected.length !== 1) throw fail(403, 'PILOT_DENIED');
        const mapping = selected[0];
        let person, gatewayUser;
        try {
            [person, gatewayUser] = await Promise.all([loadEmployee(subject), loadGatewayUser(mapping.japiUserId)]);
        } catch { throw fail(503, 'IDENTITY_UNAVAILABLE'); }
        if (person?.id !== subject || person.owner !== organization || person.isForbidden === true ||
            person.isDisabled === true || person.isDeleted === true || gatewayUser?.id !== mapping.japiUserId ||
            gatewayUser?.status !== 'active' || gatewayUser.role !== 'user' || bindingOf(gatewayUser) !== subject ||
            [...String(gatewayUser.notes || '').matchAll(/(?:^|\s)os-bridge casdoor:(\S+)/g)].length !== 1) throw fail(403, 'PILOT_DENIED');
        return { organization, subject, japiUserId: mapping.japiUserId };
    };
}

async function readJson(req, limit) {
    if ((req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw fail(415, 'JSON_REQUIRED');
    if (Number(req.headers['content-length']) > limit) throw fail(413, 'BODY_TOO_LARGE');
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > limit) { req.resume(); throw fail(413, 'BODY_TOO_LARGE'); }
        chunks.push(chunk);
    }
    try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!isObject(data)) throw new Error();
        return data;
    } catch { throw fail(400, 'INVALID_JSON'); }
}

function usageOf(data) {
    const usage = data?.usage;
    if (!isObject(usage)) return null;
    const numeric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const usageFields = { inputTokens: numeric(usage.prompt_tokens), outputTokens: numeric(usage.completion_tokens),
        totalTokens: numeric(usage.total_tokens), cachedInputTokens: numeric(usage.prompt_tokens_details?.cached_tokens) };
    return Object.values(usageFields).some(value => value !== null) ? usageFields : null;
}

function checkFrame(value) {
    if (!isObject(value) || value.error || !Array.isArray(value.choices)) throw fail(502, 'INVALID_GATEWAY_RESPONSE');
}

async function consumeJson(upstream, allowedModel, serviceKey) {
    if (!upstream.body) throw fail(502, 'INVALID_GATEWAY_RESPONSE');
    const chunks = [];
    let size = 0;
    for await (const chunk of upstream.body) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw fail(502, 'RESPONSE_TOO_LARGE');
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.includes(serviceKey)) throw fail(502, 'INVALID_GATEWAY_RESPONSE');
    let data;
    try { data = JSON.parse(raw); } catch { throw fail(502, 'INVALID_GATEWAY_RESPONSE'); }
    checkFrame(data);
    if (!data.choices.length || !data.choices.every(choice => isObject(choice?.message))) throw fail(502, 'INVALID_GATEWAY_RESPONSE');
    if (data.model !== undefined && (typeof data.model !== 'string' || !MODEL.test(data.model))) throw fail(502, 'INVALID_GATEWAY_RESPONSE');
    return { raw, servedModel: data.model || allowedModel, usage: usageOf(data) };
}

async function streamFrames(upstream, res, signal, serviceKey) {
    if (!upstream.body) throw fail(502, 'INVALID_GATEWAY_STREAM');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '', done = false, choicesSeen = false, finishSeen = false, usage = null, servedModel = null, total = 0;
    const write = async value => { if (!res.write(value)) await once(res, 'drain', { signal }); };
    for await (const chunk of upstream.body) {
        total += chunk.length;
        if (total > 16 * 1024 * 1024) throw fail(502, 'RESPONSE_TOO_LARGE');
        pending += decoder.decode(chunk, { stream: true });
        for (let split = /\r?\n\r?\n/.exec(pending); split; split = /\r?\n\r?\n/.exec(pending)) {
            const frame = pending.slice(0, split.index);
            pending = pending.slice(split.index + split[0].length);
            if (frame.length > 1024 * 1024 || frame.includes(serviceKey)) throw fail(502, 'INVALID_GATEWAY_STREAM');
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            if (done) throw fail(502, 'INVALID_GATEWAY_STREAM');
            if (data === '[DONE]') {
                if (!choicesSeen || !finishSeen) throw fail(502, 'INCOMPLETE_GATEWAY_STREAM');
                done = true;
                continue; // Deliver terminal frame only after the final ledger append.
            }
            let value;
            try { value = JSON.parse(data); } catch { throw fail(502, 'INVALID_GATEWAY_STREAM'); }
            checkFrame(value);
            if (value.model !== undefined && (typeof value.model !== 'string' || !MODEL.test(value.model) || (servedModel && servedModel !== value.model))) throw fail(502, 'INVALID_GATEWAY_STREAM');
            servedModel ||= value.model || null;
            choicesSeen ||= value.choices.some(choice => isObject(choice?.delta));
            finishSeen ||= value.choices.some(choice => typeof choice?.finish_reason === 'string' && choice.finish_reason !== '');
            usage = usageOf(value) || usage;
            const normalized = JSON.stringify(value);
            if (normalized.includes(serviceKey)) throw fail(502, 'INVALID_GATEWAY_STREAM');
            await write(`data: ${normalized}\n\n`);
        }
        if (pending.length > 1024 * 1024) throw fail(502, 'INVALID_GATEWAY_STREAM');
    }
    pending += decoder.decode();
    if (!done || pending.trim()) throw fail(502, 'INCOMPLETE_GATEWAY_STREAM');
    return { servedModel, usage };
}

function publicError(res, status, code) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code, message: code } }));
}

function readRoster(data, organization) {
    if (!isObject(data) || typeof data.enabled !== 'boolean' || !Array.isArray(data.employees) || data.employees.length > 1 ||
        data.employees.some(row => !isObject(row) || row.organization !== organization || typeof row.subject !== 'string' ||
            !ID.test(row.subject) || !Number.isSafeInteger(row.japiUserId) || row.japiUserId < 1)) throw new Error('Invalid pilot cohort');
    if (!data.enabled || data.employees.length !== 1) return null;
    return data.employees;
}

function safeResponseId(upstream, name, serviceKey) {
    const value = upstream.headers.get(name);
    return CORRELATION.test(value || '') && !value.includes(serviceKey) ? value : null;
}

export function createChatPilotHandler({ organization, model, allowsModel = requested => requested === model, authorize, loadRoster, loadGatewayKey, loadBridgeSecret,
    appendLedger, fetchImpl = fetch, log = () => {}, bodyLimit = 1024 * 1024, timeoutMs = FORWARD_TIMEOUT }) {
    if (typeof organization !== 'string' || !ID.test(organization) || typeof model !== 'string' || !MODEL.test(model) ||
        [authorize, loadRoster, loadGatewayKey, loadBridgeSecret, appendLedger].some(fn => typeof fn !== 'function')) throw new Error('Invalid chat pilot configuration');
    return async (req, res) => {
        res.setHeader('cache-control', 'no-store');
        const attemptId = randomUUID();
        let attempt, responseStatus = null, upstreamRequestId = null, gatewayClientRequestId = null, settled = false, upstream;
        const disconnect = new AbortController();
        res.once('close', () => { if (!res.writableFinished) disconnect.abort(); });
        const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(timeoutMs)]);
        const finish = async (state, reason, servedModel = null, usage = null) => {
            if (!attempt || settled) return;
            await appendLedger({ ...attempt, state, reason, httpStatus: responseStatus, gatewayRequestId: upstreamRequestId,
                gatewayClientRequestId, servedModel, usage, at: new Date().toISOString() });
            settled = true;
        };
        try {
            if (req.url !== CHAT_PILOT_PATH) throw fail(404, 'NOT_FOUND');
            if (req.method !== 'POST') { res.setHeader('allow', 'POST'); throw fail(405, 'METHOD_NOT_ALLOWED'); }
            if (req.headers.origin) throw fail(403, 'SERVER_ONLY');
            let roster;
            try { roster = readRoster(await loadRoster(), organization); } catch { throw fail(503, 'PILOT_UNAVAILABLE'); }
            if (!roster) throw fail(403, 'PILOT_DISABLED');
            const bearerHeaders = req.headersDistinct.authorization || [];
            const accessHeaders = req.headersDistinct['x-os-access-token'] || [];
            if (bearerHeaders.length !== 1 || accessHeaders.length !== 1) throw fail(401, 'AUTH_REQUIRED');
            const bearer = /^Bearer ([A-Za-z0-9._~+/=:\-]{16,512})$/i.exec(bearerHeaders[0])?.[1];
            const token = accessHeaders[0];
            if (!bearer || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw fail(401, 'AUTH_REQUIRED');
            let bridgeSecret;
            try { bridgeSecret = await loadBridgeSecret(); } catch { throw fail(503, 'PILOT_UNAVAILABLE'); }
            if (!sameSecret(bearer, bridgeSecret)) throw fail(401, 'AUTH_REQUIRED');
            const actor = await authorize(token, roster);
            if (disconnect.signal.aborted) return;
            const request = await readJson(req, bodyLimit);
            const requestedModel = request.model;
            if (!allowsModel(requestedModel)) throw fail(403, 'MODEL_NOT_ALLOWED');
            if (!Array.isArray(request.messages) || request.messages.length === 0 ||
                (request.stream !== undefined && typeof request.stream !== 'boolean')) throw fail(400, 'INVALID_REQUEST');
            const streaming = request.stream === true;
            delete request.user; delete request.metadata; delete request.safety_identifier;
            if (streaming) request.stream_options = { include_usage: true };
            else delete request.stream_options;
            let serviceKey;
            try { serviceKey = await loadGatewayKey(); } catch { throw fail(503, 'PILOT_UNAVAILABLE'); }
            if (!SECRET.test(serviceKey || '') || sameSecret(serviceKey, bridgeSecret)) throw fail(503, 'PILOT_UNAVAILABLE');
            const started = { schema: 'qyos.pilot.model-attempt.v1', source: 'internal', module: 'chat', attemptId,
                requestedModel, organization: actor.organization, subject: actor.subject, japiUserId: actor.japiUserId };
            try { await appendLedger({ ...started, state: 'started', at: new Date().toISOString() }); }
            catch { throw fail(503, 'LEDGER_UNAVAILABLE'); }
            attempt = started;
            signal.throwIfAborted();
            try {
                upstream = await fetchImpl(`${GATEWAY_ROOT}/v1/chat/completions`, {
                    method: 'POST', redirect: 'error', signal, body: JSON.stringify(request),
                    headers: { authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json',
                        accept: streaming ? 'text/event-stream' : 'application/json' },
                });
            } catch { throw fail(502, 'GATEWAY_UNAVAILABLE'); }
            responseStatus = upstream.status;
            upstreamRequestId = safeResponseId(upstream, 'x-request-id', serviceKey);
            gatewayClientRequestId = safeResponseId(upstream, 'x-client-request-id', serviceKey);
            const mime = upstream.headers.get('content-type')?.split(';', 1)[0].toLowerCase().trim();
            if (upstream.status !== 200) throw fail(upstream.status === 429 ? 429 : 502, 'GATEWAY_REJECTED');
            if (mime !== (streaming ? 'text/event-stream' : 'application/json')) throw fail(502, 'INVALID_GATEWAY_RESPONSE');
            if (streaming) {
                res.setHeader('content-type', 'text/event-stream');
                res.setHeader('x-accel-buffering', 'no');
                const result = await streamFrames(upstream, res, signal, serviceKey);
                signal.throwIfAborted();
                await finish('success', null, result.servedModel || requestedModel, result.usage);
                return res.end('data: [DONE]\n\n');
            }
            const result = await consumeJson(upstream, requestedModel, serviceKey);
            signal.throwIfAborted();
            await finish('success', null, result.servedModel, result.usage);
            res.setHeader('content-type', 'application/json');
            return res.end(result.raw);
        } catch (error) {
            const aborted = disconnect.signal.aborted;
            const timeout = signal.aborted && !aborted;
            const code = aborted ? 'CLIENT_ABORT' : timeout ? 'DEADLINE_EXCEEDED' : error.code || 'PILOT_FAILURE';
            const status = timeout ? 504 : error.status || 502;
            try { await finish(aborted ? 'aborted' : 'failed', code); }
            catch { log({ event: 'chat_pilot_ledger_error', attemptId }); }
            if (!aborted) publicError(res, status, code);
        } finally {
            if (upstream?.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {});
        }
    };
}

export async function loadChatPilot({ config, organization, audience, verifyToken, casdoor, japi, bindingOf, fetchImpl = fetch, log }) {
    if (!config) return null;
    if (!isObject(config) || !isAbsolute(config.rosterFile || '') || !isAbsolute(config.gatewayKeyFile || '') ||
        !isAbsolute(config.bridgeSecretFile || '') || !isAbsolute(config.ledgerFile || '') || !casdoor || !japi) throw new Error('Chat pilot config invalid');
    const authorize = createPilotAuthorization({ organization, audience, verifyToken, loadEmployee: casdoor.userById,
        loadGatewayUser: japi.getUser, bindingOf });
    const loadBridgeSecret = async () => (await readPrivateText(config.bridgeSecretFile, 1024)).trim();
    const loadGatewayKey = async () => (await readPrivateText(config.gatewayKeyFile, 1024)).trim();
    const control = await createChatModelControl({ stateFile: join(dirname(config.ledgerFile), 'model-control.json'),
        initialModel: config.model, probeGateway: createChatGatewayProbe({ loadBridgeSecret, loadGatewayKey, fetchImpl }) });
    const handler = createChatPilotHandler({ organization, model: config.model, allowsModel: control.allowsModel, authorize, fetchImpl, log,
        loadRoster: async () => JSON.parse(await readPrivateText(config.rosterFile, 8192)),
        loadBridgeSecret, loadGatewayKey,
        appendLedger: createPilotLedger(config.ledgerFile) });
    return { handler, adminHandler: control.handler };
}

export function createChatGatewayProbe({ loadBridgeSecret, loadGatewayKey, fetchImpl = fetch }) {
    return async (model, signal) => {
        const serviceKey = await loadGatewayKey();
        const bridgeSecret = await loadBridgeSecret();
        if (!SECRET.test(serviceKey || '') || !SECRET.test(bridgeSecret || '') || sameSecret(serviceKey, bridgeSecret))
            throw fail(503, 'PILOT_UNAVAILABLE');
        const upstream = await fetchImpl(`${GATEWAY_ROOT}/v1/chat/completions`, {
            method: 'POST', redirect: 'error', signal,
            headers: { authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ model, stream: false, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
        });
        try {
            const mime = upstream.headers.get('content-type')?.split(';', 1)[0].toLowerCase().trim();
            if (upstream.status !== 200 || mime !== 'application/json') throw fail(502, 'INVALID_GATEWAY_RESPONSE');
            const { raw } = await consumeJson(upstream, model, serviceKey);
            const { choices } = JSON.parse(raw);
            if (!choices.some(choice => typeof choice.message.content === 'string' && choice.message.content.trim()))
                throw fail(502, 'INVALID_GATEWAY_RESPONSE');
        } finally {
            if (upstream.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {});
        }
    };
}
