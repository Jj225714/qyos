/**
 * Reads users from Casdoor with an application credential (Basic clientId:clientSecret).
 * The credential belongs to an application of the employees' organization, which Casdoor treats as an
 * administrator of that organization only. Casdoor stays the source of truth for who is employed:
 * webhook payloads are never trusted, every decision is made on a fresh read from here.
 */
export function createCasdoorClient({ baseUrl, organization, clientId, clientSecret, fetchImpl = fetch, timeoutMs = 15000 }) {
    if (!baseUrl || !organization || !clientId || !clientSecret) throw new Error('Casdoor client needs baseUrl, organization, clientId and clientSecret');
    const root = baseUrl.replace(/\/+$/, '');
    const auth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

    async function get(path) {
        let response;
        try { response = await fetchImpl(`${root}${path}`, { headers: { authorization: auth, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) }); }
        catch { throw Object.assign(new Error('Casdoor unreachable'), { status: 503 }); }
        let body = null;
        try { body = await response.json(); } catch { /* handled below */ }
        if (!response.ok || body?.status !== 'ok') throw Object.assign(new Error(`Casdoor ${path.split('?')[0]} failed: ${body?.msg || response.status}`), { status: 503 });
        return body.data;
    }

    return {
        organization,
        /** The user with this Casdoor user ID (`id` claim / `sub`), or null when it no longer exists. */
        userById: async id => (await get(`/api/get-user?owner=${encodeURIComponent(organization)}&userId=${encodeURIComponent(id)}`)) || null,
        /** The user `<organization>/<name>`, or null. */
        userByName: async name => (await get(`/api/get-user?id=${encodeURIComponent(`${organization}/${name}`)}`)) || null,
        /** Every user of the organization (soft-deleted ones included, flagged isDeleted). */
        async users() {
            const data = await get(`/api/get-users?owner=${encodeURIComponent(organization)}`);
            if (!Array.isArray(data)) throw Object.assign(new Error('Casdoor get-users returned no list'), { status: 503 });
            return data;
        },
    };
}

/** The identity fields os-bridge relies on, from a Casdoor user object (API) or JWT claims. */
export function identityFromCasdoorUser(user) {
    const email = typeof user?.email === 'string' ? user.email.trim().toLowerCase() : '';
    return {
        casdoorId: String(user?.id || user?.sub || ''),
        email,
        emailVerified: user?.emailVerified === true || user?.email_verified === true,
        name: String(user?.displayName || user?.name || user?.preferred_username || email),
        groups: Array.isArray(user?.groups) ? user.groups.filter(group => typeof group === 'string') : [],
        forbidden: user?.isForbidden === true || user?.isDeleted === true,
    };
}
