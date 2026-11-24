import { constants, createPublicKey, verify } from 'node:crypto';

// ID-token verification for the portal's own Casdoor application. Only asymmetric algorithms;
// "none" and HMAC are never accepted.
const ALGORITHMS = {
    RS256: { hash: 'sha256' },
    PS256: { hash: 'sha256', padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' },
};
export const ALLOWED_ALGORITHMS = Object.keys(ALGORITHMS);

export class IdTokenError extends Error {
    constructor(reason) { super(`Invalid ID token: ${reason}`); this.reason = reason; }
}

const decodePart = part => {
    try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { throw new IdTokenError('malformed'); }
};

/**
 * Verifies ID tokens: signature (application JWKS), alg allowlist, iss, aud/azp, exp/iat/nbf, nonce.
 * The JWKS is fetched without following redirects; an unknown `kid` triggers at most one refetch per `refetchMs`.
 */
export function createIdTokenVerifier({ issuer, clientId, jwksUrl, fetchImpl = fetch, now = () => Date.now(), cacheMs = 3600000, refetchMs = 60000, skewSec = 120 }) {
    if (!issuer || !clientId || !jwksUrl) throw new Error('ID token verifier needs issuer, clientId and jwksUrl');
    let keys = new Map();
    let loadedAt = -Infinity;
    let lastFetch = -Infinity;
    let loading = null;

    async function load() {
        lastFetch = now();
        let response;
        try { response = await fetchImpl(jwksUrl, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
        catch { throw new IdTokenError('jwks unavailable'); }
        if (!response.ok) throw new IdTokenError('jwks unavailable');
        const body = await response.json().catch(() => null);
        const next = new Map();
        for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
            if (jwk.use && jwk.use !== 'sig') continue;
            try { next.set(jwk.kid || '', { key: createPublicKey({ key: jwk, format: 'jwk' }), alg: jwk.alg }); } catch { /* unusable key */ }
        }
        if (next.size === 0) throw new IdTokenError('jwks empty');
        keys = next;
        loadedAt = now();
    }

    async function keyFor(kid) {
        const refresh = async () => { loading ??= load().finally(() => { loading = null; }); try { await loading; } catch (error) { if (keys.size === 0) throw error; } };
        if (now() - loadedAt > cacheMs && now() - lastFetch > refetchMs) await refresh();
        const pick = () => (kid ? keys.get(kid) : keys.size === 1 ? [...keys.values()][0] : undefined);
        let found = pick();
        if (!found && now() - lastFetch > refetchMs) { await refresh(); found = pick(); }
        if (!found) throw new IdTokenError('unknown key');
        return found;
    }

    return async function verifyIdToken(token, { nonce }) {
        if (typeof token !== 'string' || token.length > 16384) throw new IdTokenError('missing');
        const parts = token.split('.');
        if (parts.length !== 3) throw new IdTokenError('malformed');
        const header = decodePart(parts[0]);
        const claims = decodePart(parts[1]);
        const algorithm = ALGORITHMS[header.alg];
        if (!algorithm) throw new IdTokenError('algorithm');
        const { key, alg } = await keyFor(header.kid);
        if (alg && alg !== header.alg) throw new IdTokenError('algorithm');
        const options = { key };
        if (algorithm.dsaEncoding) options.dsaEncoding = algorithm.dsaEncoding;
        if (algorithm.padding) Object.assign(options, { padding: algorithm.padding, saltLength: algorithm.saltLength });
        let ok = false;
        try { ok = verify(algorithm.hash, Buffer.from(`${parts[0]}.${parts[1]}`), options, Buffer.from(parts[2], 'base64url')); } catch { ok = false; }
        if (!ok) throw new IdTokenError('signature');
        const seconds = now() / 1000;
        if (claims.iss !== issuer) throw new IdTokenError('issuer');
        const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!aud.includes(clientId)) throw new IdTokenError('audience');
        if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) throw new IdTokenError('azp');
        if (typeof claims.exp !== 'number' || claims.exp + skewSec < seconds) throw new IdTokenError('expired');
        if (typeof claims.iat !== 'number' || claims.iat - skewSec > seconds) throw new IdTokenError('iat');
        if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - skewSec > seconds)) throw new IdTokenError('nbf');
        if (typeof nonce !== 'string' || !nonce || claims.nonce !== nonce) throw new IdTokenError('nonce');
        // Casdoor labels its token kinds; anything other than an ID token (when labelled) is refused.
        if (claims.tokenType !== undefined && claims.tokenType !== 'id-token') throw new IdTokenError('token type');
        if (typeof claims.sub !== 'string' || !claims.sub) throw new IdTokenError('subject');
        return claims;
    };
}
