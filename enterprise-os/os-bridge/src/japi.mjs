import { randomBytes } from 'node:crypto';

export class JapiError extends Error {
    constructor(message, status, code, { json = false } = {}) { super(message); this.status = status; this.code = code; this.json = json; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PAGE_SIZE = 1000; // Sub2API accepts 1..1000; larger values silently fall back to 20.
const MAX_PAGES = 50;

/**
 * Minimal client for the Sub2API (JAPI) admin API, authenticated with an admin API key
 * (`x-api-key`). Responses use Sub2API's envelope `{code, message, data}`.
 * Scoped admin keys are rate limited per key: a 429 is retried after `Retry-After` (capped).
 */
export function createJapiClient({ baseUrl, adminKey, fetchImpl = fetch, timeoutMs = 15000, retries = 2, maxRetryWaitMs = 5000, wait = sleep }) {
    if (!baseUrl || !adminKey) throw new Error('JAPI client needs baseUrl and adminKey');
    const root = baseUrl.replace(/\/+$/, '');

    async function call(method, path, body, attempt = 0) {
        let response;
        try {
            response = await fetchImpl(`${root}${path}`, {
                method,
                headers: { 'x-api-key': adminKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch { throw new JapiError(`JAPI unreachable: ${method} ${path}`, 503); }
        if (response.status === 429 && attempt < retries) {
            const seconds = Number(response.headers.get('retry-after'));
            await wait(Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000, maxRetryWaitMs));
            return call(method, path, body, attempt + 1);
        }
        let json = null;
        try { json = await response.json(); } catch { /* handled below */ }
        if (!response.ok || !json || json.code !== 0) {
            // A JSON body means the route exists and refused the request; a plain-text 404 is gin's "no such route".
            throw new JapiError(`JAPI ${method} ${path} failed (${response.status})`, response.status, json?.code, { json: Boolean(json) });
        }
        return json.data;
    }

    /** All items of a paginated admin list. */
    async function listAll(path) {
        const items = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
            const data = await call('GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}&page_size=${PAGE_SIZE}`);
            const batch = data?.items || [];
            items.push(...batch);
            const pages = Number(data?.pages) || 0;
            if (batch.length < PAGE_SIZE || (pages && page >= pages)) break;
        }
        return items;
    }

    return {
        /** Exact (case-insensitive) email match; JAPI's search is a substring match over several fields. */
        async findUserByEmail(email) {
            const wanted = email.trim().toLowerCase();
            const items = await listAll(`/api/v1/admin/users?search=${encodeURIComponent(wanted)}`);
            return items.find(user => String(user.email).trim().toLowerCase() === wanted) || null;
        },
        /** Accounts whose notes contain `marker` (substring search, then exact filter by the caller). */
        searchUsers: marker => listAll(`/api/v1/admin/users?search=${encodeURIComponent(marker)}`),
        async getUser(id) {
            try { return await call('GET', `/api/v1/admin/users/${encodeURIComponent(id)}`); }
            catch (error) { if (error.status === 404 && error.json) return null; throw error; }
        },
        createUser: ({ email, username, notes, groupIds, balance, concurrency, rpmLimit }) => call('POST', '/api/v1/admin/users', {
            email,
            // Employees never use this password: they reach JAPI only through os-bridge.
            password: randomBytes(24).toString('base64url'),
            username: username || '',
            notes: notes || '',
            role: 'user',
            ...(groupIds?.length ? { allowed_groups: groupIds } : {}),
            ...(typeof balance === 'number' ? { balance } : {}),
            ...(typeof concurrency === 'number' ? { concurrency } : {}),
            ...(typeof rpmLimit === 'number' ? { rpm_limit: rpmLimit } : {}),
        }),
        updateUser: (id, fields) => call('PUT', `/api/v1/admin/users/${encodeURIComponent(id)}`, fields),
        async listKeys(id) {
            const data = await call('GET', `/api/v1/admin/users/${encodeURIComponent(id)}/api-keys?page=1&page_size=100`);
            return data?.items || [];
        },
        // Existing Sub2API admin route (AdminAPIKeyHandler.UpdateGroup): moves a key to another group.
        updateKeyGroup: (keyId, groupId) => call('PUT', `/api/v1/admin/api-keys/${encodeURIComponent(keyId)}`, { group_id: groupId }),
        // Requires japi-patch/0001: PUT /api/v1/admin/api-keys/:id/status.
        setKeyStatus: (keyId, status) => call('PUT', `/api/v1/admin/api-keys/${encodeURIComponent(keyId)}/status`, { status }),
        // Requires japi-patch/0001: POST /api/v1/admin/users/:id/api-keys.
        createKey: (id, { name, groupId }) => call('POST', `/api/v1/admin/users/${encodeURIComponent(id)}/api-keys`, { name, ...(groupId ? { group_id: groupId } : {}) }),
    };
}
