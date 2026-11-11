import { createPublicKey, verify } from 'node:crypto';
import { identityFromCasdoorUser } from './casdoor.mjs';

// Casdoor signs access tokens with RS256 by default; the others are accepted when the
// application certificate uses them. "none" and HMAC algorithms are never accepted.
const ALGORITHMS = {
    RS256: { hash: 'sha256' },
    RS384: { hash: 'sha384' },
    RS512: { hash: 'sha512' },
    ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' },
    ES384: { hash: 'sha384', dsaEncoding: 'ieee-p1363' },
    ES512: { hash: 'sha512', dsaEncoding: 'ieee-p1363' },
};

export class TokenError extends Error {
    constructor(reason) { super(`Invalid token: ${reason}`); this.reason = reason; this.status = 401; }
}

const decodePart = part => {
    try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { throw new TokenError('malformed'); }
};

/**
 * Casdoor's global `/.well-known/jwks` lists the certificates of EVERY organization, and an organization
 * administrator can add a certificate whose private key they hold. Only per-application JWKS
 * (`/.well-known/<application>/jwks`) may be trusted.
 */
export function assertApplicationJwks(urls) {
    for (const url of urls) {
        if (/\/\.well-known\/jwks\/?$/.test(new URL(url).pathname)) throw new Error(`Refusing the global Casdoor JWKS ${url}: use /.well-known/<application>/jwks for each application`);
    }
}

/**
 * Verifies Casdoor-issued access tokens against the applications' JWKS.
 * Keys are cached; an unknown `kid` triggers at most one refetch per `refetchMs`.
 * When a refresh fails, the keys already loaded stay in use (Casdoor hiccups must not stop every call).
 */
export function createJwtVerifier({ issuer, jwksUrls, jwksUrl, audiences, fetchImpl = fetch, now = () => Date.now(), cacheMs = 600000, refetchMs = 30000, leewaySec = 60, log = () => {} }) {
    const urls = jwksUrls || (jwksUrl ? [jwksUrl] : []);
    if (!issuer || urls.length === 0 || !Array.isArray(audiences) || audiences.length === 0) throw new Error('JWT verifier needs issuer, jwksUrls and audiences');
    let keys = new Map();
    let loadedAt = 0;
    let lastFetch = 0;
    let loading = null;

    async function load() {
        lastFetch = now();
        const next = new Map();
        for (const url of urls) {
            const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw Object.assign(new Error('JWKS unavailable'), { status: 503 });
            const body = await response.json();
            for (const jwk of body?.keys || []) {
                if (jwk.use && jwk.use !== 'sig') continue;
                try { next.set(jwk.kid || '', { key: createPublicKey({ key: jwk, format: 'jwk' }), alg: jwk.alg }); } catch { /* skip unusable keys */ }
            }
        }
        keys = next;
        loadedAt = now();
    }

    async function refresh() {
        loading ??= load().catch(error => {
            if (keys.size === 0) throw error;
            log({ event: 'jwks_refresh_failed', message: error.message });
        }).finally(() => { loading = null; });
        return loading;
    }

    async function keyFor(kid) {
        if (now() - loadedAt > cacheMs && now() - lastFetch > refetchMs) await refresh();
        const pick = () => kid ? keys.get(kid) : (keys.size === 1 ? [...keys.values()][0] : undefined);
        let found = pick();
        if (!found && now() - lastFetch > refetchMs) { await refresh(); found = pick(); }
        if (!found) throw new TokenError('unknown key');
        return found;
    }

    return async function verifyAccessToken(token) {
        if (typeof token !== 'string' || token.length > 16384) throw new TokenError('missing');
        const parts = token.split('.');
        if (parts.length !== 3) throw new TokenError('malformed');
        const header = decodePart(parts[0]);
        const claims = decodePart(parts[1]);
        const algorithm = ALGORITHMS[header.alg];
        if (!algorithm) throw new TokenError('algorithm');
        const { key, alg } = await keyFor(header.kid);
        if (alg && alg !== header.alg) throw new TokenError('algorithm');
        const signature = Buffer.from(parts[2], 'base64url');
        const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
        const ok = verify(algorithm.hash, signed, algorithm.dsaEncoding ? { key, dsaEncoding: algorithm.dsaEncoding } : key, signature);
        if (!ok) throw new TokenError('signature');
        const seconds = now() / 1000;
        if (claims.iss !== issuer) throw new TokenError('issuer');
        const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!aud.some(value => audiences.includes(value))) throw new TokenError('audience');
        if (typeof claims.exp !== 'number' || claims.exp + leewaySec < seconds) throw new TokenError('expired');
        if (typeof claims.nbf === 'number' && claims.nbf - leewaySec > seconds) throw new TokenError('not yet valid');
        // Casdoor marks token kinds (access-token / id-token / refresh-token); only access tokens may call APIs.
        if (claims.tokenType !== 'access-token') throw new TokenError('token type');
        return claims;
    };
}

/** Normalizes the identity fields os-bridge relies on from a Casdoor JWT ("JWT" token format). */
export const identityFromClaims = claims => identityFromCasdoorUser(claims);
