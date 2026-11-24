import { randomUUID } from 'node:crypto';
import { validImageModel } from './image-model-control.mjs';

const IMAGE_WAIT_MS = 100_000;
const UNCERTAIN_WAIT_MS = 30_000;
const MAX_IMAGE_BATCH_COUNT = 4;
const safeRelayFailures = new Set(['upstream_invalid_image', 'upstream_rejected_request', 'upstream_auth_failed', 'upstream_model_unavailable', 'upstream_unavailable', 'upstream_network_error']);
const fail = (status, imageError, details) => Object.assign(new Error('Managed image request failed'), { status, imageError }, details);
const iso = timestamp => new Date(timestamp).toISOString();
const timeoutError = error => ['TimeoutError', 'AbortError'].includes(error?.name) || error?.code === 'ABORT_ERR';
function retryAfter(header, now) {
    const value = header?.trim() || '';
    const delay = /^[0-9]{1,8}$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now()) / 1000);
    return Number.isSafeInteger(delay) && delay >= 1 && delay <= 3600 ? delay : undefined;
}

async function classifiedRelayError(response) {
    // This channel is the authenticated Unix-socket relay. Never expose raw error text.
    try {
        if (response.headers.get('content-type') === 'application/json' && /^\d{1,3}$/.test(response.headers.get('content-length') || '')) {
            const value = await response.json();
            if (safeRelayFailures.has(value?.code)) return value.code;
        }
    } catch (error) {
        if (timeoutError(error)) throw error;
    } finally { if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {}); }
    return 'upstream_unavailable';
}
const principalId = /^[A-Za-z0-9_.:/@-]{1,256}$/;
const userId = /^[1-9][0-9]{0,19}$/;
const requestIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_RESPONSE = 24 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_REFERENCE_BASE64 = Math.ceil(MAX_REFERENCE_BYTES / 3) * 4;
const MAX_REFERENCE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_REFERENCES = 16;
export const MANAGED_IMAGE_BODY_LIMIT = 22_500_000;
const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024'];
function validOutputSize(value) {
    if (typeof value !== 'string' || !/^[1-9][0-9]{2,3}x[1-9][0-9]{2,3}$/.test(value)) return false;
    const [width, height] = value.split('x').map(Number);
    return width >= 256 && height >= 256 && width <= 4096 && height <= 4096 && width * height <= 8388608;
}
function closestSize(target, available) {
    const ratio = size => { const [width, height] = size.split('x').map(Number); return Math.log(width / height); };
    return available.includes(target) ? target : available.reduce((best, candidate) =>
        Math.abs(ratio(candidate) - ratio(target)) < Math.abs(ratio(best) - ratio(target)) ? candidate : best);
}

export function validSubject(value) {
    return typeof value === 'string' && principalId.test(value) ? value : null;
}

function correlation(headers, name, apiKey) {
    const value = headers?.get(name);
    return typeof value === 'string' && requestIdPattern.test(value) && !value.includes(apiKey) ? value : null;
}

function usage(value) {
    const result = {};
    for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) {
        if (Number.isSafeInteger(value?.[field]) && value[field] >= 0) result[field] = value[field];
    }
    return Object.keys(result).length ? result : null;
}

async function boundedJson(response) {
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw fail(502);
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE || !response.body) throw fail(502);
    let count = 0;
    const chunks = [];
    const reader = response.body.getReader();
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            count += value.byteLength;
            if (count > MAX_RESPONSE) throw fail(502);
            chunks.push(Buffer.from(value));
        }
    } finally { await reader.cancel().catch(() => {}); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fail(502); }
}

function rasterBase64(value) {
    if (typeof value !== 'string' || value.length < 16 || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    const head = Buffer.from(value.slice(0, 16), 'base64');
    return head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        head.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
        head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP';
}

export function validateReference(value) {
    if (typeof value !== 'string' || value.length > MAX_REFERENCE_BASE64 + 32) throw fail(400);
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+\/]+={0,2})$/.exec(value);
    if (!match || match[2].length % 4 !== 0) throw fail(400);
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length < 12 || bytes.length > MAX_REFERENCE_BYTES || bytes.toString('base64') !== match[2]) throw fail(400);
    const format = match[1];
    const valid = format === 'png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : format === 'jpeg' ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) throw fail(400);
    return value;
}

function normalizePolicy(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 6 || value.schema !== 1 ||
        !validImageModel(value.model) || typeof value.epoch !== 'string' || !/^[a-f0-9]{64}$/.test(value.epoch) ||
        !Array.isArray(value.sizes) || value.sizes.length < 1 || value.sizes.length > IMAGE_SIZES.length ||
        value.sizes.some(size => !IMAGE_SIZES.includes(size)) || new Set(value.sizes).size !== value.sizes.length ||
        !Array.isArray(value.referenceSizes) || value.referenceSizes.length > IMAGE_SIZES.length ||
        value.referenceSizes.some(size => !IMAGE_SIZES.includes(size)) || new Set(value.referenceSizes).size !== value.referenceSizes.length ||
        ![0, 1].includes(value.maxReferenceImages) || Boolean(value.maxReferenceImages) !== Boolean(value.referenceSizes.length)) return null;
    return { model: value.model, epoch: value.epoch, sizes: [...value.sizes], referenceSizes: [...value.referenceSizes], maxReferenceImages: value.maxReferenceImages };
}

/** Exact image endpoint and server-owned identity. The Vault rechecks employee access live. */
export function createManagedImage({ config, fetchImpl = fetch, writeReceipt, readGeneration = async () => null, writeGeneration = async () => {}, clearGeneration = async () => {}, getModel = () => config.model, adapter, routeVerified, capabilityPolicy, now = Date.now }) {
    if (!config?.enabled) return null;
    const { endpoint, model, apiKey, pilot, accessMode = 'pilot', size = '1024x1024', quality = 'low' } = config;
    if (accessMode !== 'pilot' && accessMode !== 'all-employees') throw new Error('Invalid managed Image access mode');
    const target = new URL(endpoint);
    const loopback = target.hostname === '127.0.0.1' || target.hostname === '[::1]';
    if (!((target.protocol === 'https:') || (target.protocol === 'http:' && loopback)) || target.username || target.password || target.search || target.hash || target.pathname !== '/v1/images/generations') throw new Error('Invalid managed Image gateway endpoint');
    if (typeof apiKey !== 'string' || !/^[!-~]{1,1024}$/.test(apiKey) || !validImageModel(model) || typeof writeReceipt !== 'function' || !IMAGE_SIZES.includes(size) || !['low', 'medium', 'high'].includes(quality)) throw new Error('Invalid managed Image settings');
    if (accessMode === 'pilot' && (!Array.isArray(pilot) || !pilot.length || pilot.length > 30)) throw new Error('Invalid managed Image pilot settings');
    const people = new Map();
    const seenIds = new Set();
    for (const record of accessMode === 'pilot' ? pilot : []) {
        if (!validSubject(record?.casdoorId) || typeof record?.japiUserId !== 'string' || !userId.test(record.japiUserId) || people.has(record.casdoorId) || seenIds.has(record.japiUserId)) throw new Error('Invalid managed Image pilot bindings');
        people.set(record.casdoorId, record.japiUserId);
        seenIds.add(record.japiUserId);
    }
    const enrolled = ({ user, casdoorId, sso }) => {
        const subject = validSubject(casdoorId);
        const id = String(user?.id);
        return sso === true && Boolean(subject) && userId.test(id) &&
            (accessMode === 'all-employees' || people.get(subject) === id);
    };
    const authorize = session => {
        const id = String(session.user.id);
        const subject = validSubject(session.casdoorId);
        if (!session.sso || !enrolled(session)) throw fail(403);
        return { casdoorId: subject, japiUserId: id };
    };
    const policy = normalizePolicy(capabilityPolicy);
    const active = new Map();
    const generationLocks = new Map();
    async function withGenerationLock(key, work) {
        const previous = generationLocks.get(key) || Promise.resolve();
        const current = previous.catch(() => {}).then(work);
        generationLocks.set(key, current);
        try { return await current; } finally { if (generationLocks.get(key) === current) generationLocks.delete(key); }
    }
    const generationKey = employee => employee.casdoorId;
    const describeGeneration = (entry, deadline, reason) => ({ busy: true, startedAt: iso(entry.startedAt), deadlineAt: iso(deadline), reason, requestId: entry.requestId });
    async function busyGeneration(key) {
        const entry = active.get(key);
        if (entry) return describeGeneration(entry, entry.deadlineAt, 'in_progress');
        const remaining = await readGeneration(key).catch(() => { throw fail(503, 'upstream_unavailable'); });
        if (remaining && remaining.deadlineAt > now()) return describeGeneration(remaining, remaining.deadlineAt, 'outcome_unknown');
        return { busy: false };
    }
    const generationStatus = session => {
        const key = generationKey(authorize(session));
        return withGenerationLock(key, () => busyGeneration(key));
    };
    function busyError(status) {
        const code = status.reason === 'in_progress' ? 'generation_in_progress' : 'generation_outcome_unknown';
        return fail(409, code, { startedAt: status.startedAt, deadlineAt: status.deadlineAt, requestId: status.requestId, retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(status.deadlineAt) - now()) / 1000)) });
    }
    const capabilities = (activeModel, epoch) => adapter && policy?.model === activeModel && policy.epoch === epoch && routeVerified?.(epoch) === true ? policy : null;
    const describe = session => {
        authorize(session);
        const activeModel = getModel();
        const legacy = { model: activeModel, size, quality, count: 1, maxBatchCount: MAX_IMAGE_BATCH_COUNT };
        if (!adapter) return legacy;
        return Promise.resolve().then(() => adapter.epoch()).then(epoch => {
            const policyForRoute = capabilities(activeModel, epoch);
            return routeVerified?.(epoch) === true ? { ...legacy, sizes: [...IMAGE_SIZES], referenceSizes: [...IMAGE_SIZES], maxReferenceImages: MAX_REFERENCES, customSize: true } : legacy;
        }, () => legacy);
    };
    async function runGeneration(session, input, stream) {
        const employee = authorize(session);
        const count = stream ? input?.count : 1;
        const fields = ['prompt', 'model', 'size', 'references', ...(stream ? ['count'] : [])];
        if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGE_BATCH_COUNT || !input || Object.keys(input).some(field => !fields.includes(field)) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000 || !validImageModel(input.model) ||
            ('size' in input && !validOutputSize(input.size)) || ('references' in input && (!Array.isArray(input.references) || input.references.length > MAX_REFERENCES))) throw fail(400);
        const chosenModel = getModel();
        if (input.model !== chosenModel) throw fail(409, 'image_model_changed');
        const hasReference = Boolean(input.references?.length);
        const key = generationKey(employee);
        const entry = await withGenerationLock(key, async () => {
            const state = await busyGeneration(key);
            if (state.busy) throw busyError(state);
            const startedAt = now();
            const reservation = { startedAt, deadlineAt: startedAt + count * IMAGE_WAIT_MS, requestId: randomUUID() };
            active.set(key, reservation);
            return reservation;
        });
        let leaseWritten = false;
        let uncertain = false;
        try {
            const epoch = adapter ? await adapter.epoch().catch(() => { throw fail(503, 'upstream_unavailable'); }) : null;
            if (adapter && !routeVerified(epoch)) throw fail(503, 'upstream_model_unavailable');
            const policyForRoute = capabilities(chosenModel, epoch);
            const chosenSize = input.size ?? (hasReference ? policyForRoute?.referenceSizes[0] || size : size);
            if (hasReference && !adapter) throw fail(409);
            if (!adapter && chosenSize !== size) throw fail(409);
            const providerSizes = hasReference && policyForRoute?.referenceSizes.length ? policyForRoute.referenceSizes : [...new Set([size, ...(policyForRoute?.sizes ?? [])])];
            const references = input.references?.map(validateReference);
            const bytes = value => (value.length - value.indexOf(',') - 1) * 3 / 4 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
            if (references?.reduce((total, value) => total + bytes(value), 0) > MAX_REFERENCE_TOTAL_BYTES) throw fail(413);
            const payload = { model: chosenModel, prompt: input.prompt.trim(), size: closestSize(chosenSize, providerSizes), quality, ...(references?.length ? { references } : {}) };
            const attribution = { ...employee, source: 'qyos_os' };
            let stopped;
            for (let index = 0; index < count; index++) {
                if (stream && !stream.canContinue()) return;
                if (stopped) {
                    if (!(await stream.write({ type: 'error', index, error: 'batch_not_attempted', status: stopped.status || 500, retryable: true, outcome: 'unattempted', ...(stopped.deadlineAt ? { deadlineAt: stopped.deadlineAt } : {}), ...(stopped.retryAfterSeconds ? { retryAfterSeconds: stopped.retryAfterSeconds } : {}) }))) return;
                    continue;
                }
                const requestId = index === 0 ? entry.requestId : randomUUID();
                let result;
                let dispatched = false;
                try {
                    if (index && (getModel() !== chosenModel || (adapter && !routeVerified(epoch)))) throw fail(409, 'image_model_changed');
                    const itemDeadline = Math.min(entry.deadlineAt, now() + IMAGE_WAIT_MS);
                    const recoveryDeadline = itemDeadline + UNCERTAIN_WAIT_MS;
                    // The crash lease covers the currently dispatched call, not undispatched slots.
                    await writeGeneration(key, { ...entry, requestId, deadlineAt: recoveryDeadline }).catch(() => { throw fail(503, 'upstream_unavailable'); });
                    leaseWritten = true;
                    if (stream && !stream.canContinue()) return;
                    const budget = itemDeadline - now();
                    if (budget <= 0) throw fail(504, 'upstream_timeout');
                    try {
                        result = await generateOne(payload, attribution, budget, epoch, requestId, () => {
                            if (stream && !stream.canContinue()) return false;
                            dispatched = true;
                            return true;
                        });
                        if (!result) return;
                    } catch (error) {
                        if (error.uncertain) {
                            uncertain = true;
                            error.deadlineAt = iso(recoveryDeadline);
                            error.retryAfterSeconds = Math.max(1, Math.ceil((recoveryDeadline - now()) / 1000));
                        }
                        throw error;
                    }
                } catch (error) {
                    error.requestId ||= requestId;
                    if (!stream || !leaseWritten) throw error;
                    if (error.uncertain || error.status === 429 || error.status === 409 || error.status === 503 || ['upstream_auth_failed', 'upstream_model_unavailable', 'upstream_rejected_request', 'upstream_timeout'].includes(error.imageError)) stopped = error;
                    const detail = imageGenerationError(error);
                    if (stream && detail.retryAfterSeconds && !detail.deadlineAt) detail.deadlineAt = iso(now() + detail.retryAfterSeconds * 1000);
                    if (stopped && detail.deadlineAt) stopped.deadlineAt = detail.deadlineAt;
                    if (!(await stream.write({ type: 'error', index, ...detail, status: error.status || 500, retryable: !error.uncertain, outcome: error.uncertain ? 'unknown' : dispatched ? 'failed' : 'unattempted' }))) return;
                    continue;
                }
                const image = adapter ? { ...result, size: chosenSize } : result;
                if (!stream) return image;
                if (!(await stream.write({ type: 'item', index, ...image }))) return;
            }
        } finally {
            await withGenerationLock(key, async () => {
                if (leaseWritten && !uncertain) await clearGeneration(key).catch(() => {});
                active.delete(key);
            });
        }
    }

    const generate = (session, input) => runGeneration(session, input);
    async function generateBatch(session, input, stream) {
        await runGeneration(session, input, stream);
        if (stream.canContinue()) await stream.write({ type: 'done' });
    }

    async function probe(model, epoch) {
        if (!validImageModel(model)) throw fail(400);
        await generateOne({ model, prompt: 'A simple blue circle on a plain white background.', size, quality }, { source: 'jadmin_probe' }, 97_000, epoch);
    }

    async function generateOne(payload, attribution, timeoutMs = IMAGE_WAIT_MS, epoch = null, requestId = randomUUID(), beforeDispatch = () => true) {
        const deadline = now() + timeoutMs;
        const receipt = { schema: 'qyos.internal-model-usage.v1', module: 'image', requestId, ...attribution, ...(adapter ? {routeSource: 'jadmin', routeEpoch: epoch} : {}), model: payload.model, startedAt: new Date(now()).toISOString() };
        let gatewayRequestId = null, gatewayClientRequestId = null, imageCount = null, tokens = null, providerStatus = null;
        const record = status => writeReceipt(requestId, { ...receipt, status, gatewayRequestId, gatewayClientRequestId, imageCount, usage: tokens, providerStatus, updatedAt: new Date(now()).toISOString() });
        // Persistence is mandatory before spending; failures after dispatch remain reconcilable by this receipt.
        try { await record('pending'); } catch { throw fail(503, 'upstream_unavailable'); }
        let result;
        let failure;
        try {
            const budget = deadline - now();
            if (budget <= 0) throw fail(504, 'upstream_timeout');
            if (!beforeDispatch()) {
                await record('unconfirmed').catch(() => {});
                return null;
            }
            const response = adapter ? await adapter.generate({...payload, n: 1}, requestId, epoch, budget) : await fetchImpl(target.href, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(budget),
                headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json', 'x-client-request-id': requestId },
                body: JSON.stringify({ ...payload, n: 1 }),
            });
            gatewayRequestId = correlation(response.headers, 'x-request-id', apiKey);
            gatewayClientRequestId = correlation(response.headers, 'x-client-request-id', apiKey);
            providerStatus = response.status;
            if (response.status !== 200) {
                if (adapter && providerStatus === 409) failure = fail(409, 'image_model_changed');
                else if (adapter && providerStatus === 503) failure = fail(503, 'upstream_unavailable');
                else if (providerStatus === 429) failure = fail(429, 'upstream_rate_limit', { retryAfterSeconds: retryAfter(response.headers.get('retry-after'), now) });
                else if (providerStatus === 408 || providerStatus === 504) failure = fail(504, 'upstream_timeout', { uncertain: true });
                else if (adapter && providerStatus === 502) {
                    const code = await classifiedRelayError(response);
                    failure = fail(502, code, { uncertain: code === 'upstream_network_error' || code === 'upstream_unavailable' });
                } else if (!adapter && [401, 403].includes(providerStatus)) failure = fail(502, 'upstream_auth_failed');
                else if (!adapter && providerStatus === 404) failure = fail(502, 'upstream_model_unavailable');
                else if ([400, 413, 415, 422].includes(providerStatus)) failure = fail(502, 'upstream_rejected_request');
                else failure = fail(502, 'upstream_unavailable', { uncertain: providerStatus >= 500 });
                if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
                throw failure;
            }
            result = await boundedJson(response);
            tokens = usage(result?.usage);
            if (!Array.isArray(result?.data) || result.data.length !== 1 || !rasterBase64(result.data[0]?.b64_json)) throw fail(502, 'upstream_invalid_image');
            imageCount = 1;
        } catch (error) {
            failure = failure || (error?.imageError ? error : timeoutError(error) ? fail(504, 'upstream_timeout', { uncertain: true }) : error?.status === 502 ? fail(502, 'upstream_invalid_image') : fail(502, 'upstream_network_error', { uncertain: true }));
            try { await record('unconfirmed'); } catch { throw fail(503, 'upstream_unavailable', { uncertain: failure.uncertain }); }
            throw failure;
        }
        try { await record('succeeded'); } catch { throw fail(503, 'upstream_unavailable', { uncertain: true }); }
        return { id: requestId, b64_json: result.data[0].b64_json };
    }
    return { enrolled, describe, generationStatus, generate, generateBatch, probe };
}

export function imageGenerationError(error) {
    const result = { error: error.imageError || 'upstream_unavailable' };
    for (const field of ['startedAt', 'deadlineAt', 'requestId']) if (error[field]) result[field] = error[field];
    if (Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 3600) result.retryAfterSeconds = error.retryAfterSeconds;
    return result;
}
