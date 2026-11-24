import { readFile } from 'node:fs/promises';

export const APP_IDS = ['chat', 'image', 'api'];
const isPlaceholder = value => typeof value === 'string' && /<[^>]*>/.test(value);

function httpsOrigin(value, name) {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute https URL`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`${name} must be an https URL without credentials, query or fragment`);
    return url;
}

function bounded(value, fallback, min, max, name) {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${name} must be between ${min} and ${max}`);
    return number;
}

/**
 * Validates config.json (see config.example.json) and returns normalized settings. Refuses placeholders,
 * non-https public URLs, non-loopback bridge URLs and out-of-range lifetimes.
 */
export function validateConfig(config) {
    if (!config || typeof config !== 'object') throw new Error('config must be an object');
    const text = JSON.stringify(config);
    if (isPlaceholder(text)) throw new Error('config still contains <...> placeholders');
    const origin = httpsOrigin(config.origin, 'origin');
    if (origin.pathname !== '/') throw new Error('origin must not have a path');
    const issuer = httpsOrigin(config.issuer, 'issuer');
    const jwks = httpsOrigin(config.jwksUrl, 'jwksUrl');
    if (jwks.origin !== issuer.origin) throw new Error('jwksUrl must be on the issuer origin');
    if (/\/\.well-known\/jwks\/?$/.test(jwks.pathname)) throw new Error('jwksUrl must be the portal application JWKS (/.well-known/<application>/jwks), not the global one');
    if (typeof config.clientId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(config.clientId)) throw new Error('clientId is required');
    if (typeof config.clientSecretFile !== 'string' || !config.clientSecretFile.startsWith('/')) throw new Error('clientSecretFile must be an absolute path');
    const bridge = config.bridge || {};
    let bridgeUrl;
    try { bridgeUrl = new URL(bridge.baseUrl); } catch { throw new Error('bridge.baseUrl must be a URL'); }
    if (bridgeUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(bridgeUrl.hostname)) throw new Error('bridge.baseUrl must be the loopback os-bridge internal listener (http://127.0.0.1:3291)');
    if (typeof bridge.tokenFile !== 'string' || !bridge.tokenFile.startsWith('/')) throw new Error('bridge.tokenFile must be an absolute path');
    if (typeof bridge.japiInstance !== 'string' || !bridge.japiInstance.trim()) throw new Error('bridge.japiInstance is required (same value as os-bridge japi.instance)');
    const apps = {};
    for (const [id, app] of Object.entries(config.apps || {})) {
        if (!APP_IDS.includes(id)) throw new Error(`apps.${id}: unknown application id (allowed: ${APP_IDS.join(', ')})`);
        const url = httpsOrigin(app?.launchUrl?.split('?')[0], `apps.${id}.launchUrl`);
        if (url.origin === origin.origin) throw new Error(`apps.${id}.launchUrl must be the application's own site`);
        apps[id] = { launchUrl: app.launchUrl };
    }
    if (Object.keys(apps).length === 0) throw new Error('apps must configure at least one of chat, image, api');
    const work = config.workCalendar ?? {};
    if (typeof work !== 'object' || Array.isArray(work)) throw new Error('workCalendar must be an object');
    const unknownWork = Object.keys(work).filter(key => key !== 'enabled');
    if (unknownWork.length) throw new Error(`workCalendar.${unknownWork[0]} is not configurable (the employee socket path is fixed in code)`);
    if (work.enabled !== undefined && typeof work.enabled !== 'boolean') throw new Error('workCalendar.enabled must be true or false');
    return {
        origin: origin.origin,
        issuer: config.issuer.replace(/\/+$/, ''),
        jwksUrl: jwks.href,
        clientId: config.clientId,
        clientSecretFile: config.clientSecretFile,
        scope: typeof config.scope === 'string' && config.scope.split(' ').includes('openid') ? config.scope : 'openid profile email',
        bridge: { baseUrl: bridgeUrl.origin, tokenFile: bridge.tokenFile, japiInstance: bridge.japiInstance.trim() },
        listen: { host: config.listen?.host || '127.0.0.1', port: bounded(config.listen?.port, 3292, 1, 65535, 'listen.port') },
        sessionMs: bounded(config.sessionMaxHours, 8, 0.25, 24, 'sessionMaxHours') * 3600000,
        recheckMs: bounded(config.recheckMs, 60000, 10000, 600000, 'recheckMs'),
        recheckGraceMs: bounded(config.recheckGraceMs, 300000, 0, 1800000, 'recheckGraceMs'),
        apps,
        ...(config.workCalendar !== undefined ? { workCalendar: { enabled: work.enabled === true } } : {}),
    };
}

/** Reads a one-line secret file; refuses empty files and placeholders. */
export async function readSecret(path, name) {
    let value;
    try { value = (await readFile(path, 'utf8')).trim(); } catch { throw new Error(`${name}: cannot read ${path}`); }
    if (!value || isPlaceholder(value)) throw new Error(`${name}: ${path} is empty or a placeholder`);
    return value;
}
