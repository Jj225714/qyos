import axios, { AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import { normalizeLocalProxyUrl, useConfigStore } from "@/stores/use-config-store";

/**
 * Central authentication for the optional local forwarding proxy (canvas-proxy). Every request whose URL starts with
 * the configured proxy address gets the startup token in the X-Canvas-Proxy-Token header, after a one-time handshake
 * proved the proxy is the protected version. The token is kept in this browser only: never in the URL, never in the
 * synced/exported configuration, never in workspace archives (the key is outside their prefix).
 */
export const PROXY_TOKEN_HEADER = "X-Canvas-Proxy-Token";
export const PROXY_HANDSHAKE_PATH = "/__canvas-proxy/handshake";
export const PROXY_TOKEN_STORAGE_KEY = "local-proxy-session-token:v1";
const MIN_PROTOCOL = 2;

export class LocalProxyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LocalProxyError";
    }
}

export function getLocalProxyToken() {
    try {
        return globalThis.localStorage?.getItem(PROXY_TOKEN_STORAGE_KEY) || "";
    } catch {
        return "";
    }
}

export function setLocalProxyToken(token: string) {
    handshake = null;
    const value = token.trim();
    try {
        if (value) globalThis.localStorage?.setItem(PROXY_TOKEN_STORAGE_KEY, value);
        else globalThis.localStorage?.removeItem(PROXY_TOKEN_STORAGE_KEY);
    } catch {
        /* storage unavailable: requests will fail closed */
    }
}

function activeProxyBase() {
    const { proxyEnabled, proxyUrl } = useConfigStore.getState().config;
    return proxyEnabled ? normalizeLocalProxyUrl(proxyUrl) : "";
}

export function isLocalProxyRequest(url: string) {
    const base = activeProxyBase();
    return Boolean(base) && (url === base || url.startsWith(`${base}/`));
}

const upgradeHint = () => `请改用项目内的新版代理：node canvas-proxy/index.js --allow-origin ${globalThis.location?.origin || "<站点地址>"} --allow-target <渠道地址>，并把它打印的令牌填入「配置 → 本地代理」。`;

/** Verifies the proxy is the protected version and accepts this token; throws an actionable error otherwise. */
export async function verifyLocalProxy(base: string, token: string, fetchImpl: typeof fetch = originalFetch()) {
    if (!base) throw new LocalProxyError("请先填写本地代理地址。");
    if (!token) throw new LocalProxyError(`本地代理需要启动令牌，已阻止请求。${upgradeHint()}`);
    let response: Response;
    try {
        response = await fetchImpl(`${base}${PROXY_HANDSHAKE_PATH}`, { cache: "no-store", headers: { [PROXY_TOKEN_HEADER]: token } });
    } catch {
        throw new LocalProxyError("无法连接本地代理，请确认代理已启动、地址正确，且以 --allow-origin 允许了当前站点。");
    }
    const data = (await response.json().catch(() => null)) as { proxy?: string; version?: string; protocol?: number; authorized?: boolean } | null;
    if (!data || typeof data.protocol !== "number" || data.protocol < MIN_PROTOCOL) throw new LocalProxyError(`检测到旧版本地代理（没有令牌和来源保护），已拒绝使用。${upgradeHint()}`);
    if (response.status === 401 || data.authorized !== true) throw new LocalProxyError("本地代理令牌无效。代理每次启动都会生成新令牌，请把终端里最新打印的令牌填入「配置 → 本地代理」。");
    if (!response.ok) throw new LocalProxyError(`本地代理握手失败（HTTP ${response.status}）。`);
    return { proxy: data.proxy || "canvas-proxy", version: data.version || "?" };
}

let handshake: { key: string; promise: Promise<unknown> } | null = null;

async function ensureVerified(base: string, token: string) {
    const key = JSON.stringify([base, token]);
    if (!handshake || handshake.key !== key) {
        const promise = verifyLocalProxy(base, token);
        handshake = { key, promise };
        promise.catch(() => {
            if (handshake?.promise === promise) handshake = null;
        });
    }
    await handshake.promise;
}

/** Header value for a proxied request (after the handshake); throws instead of letting it go out unauthenticated. */
export async function authorizeLocalProxyRequest(url: string) {
    if (!isLocalProxyRequest(url) || url.startsWith(`${activeProxyBase()}${PROXY_HANDSHAKE_PATH}`)) return null;
    const token = getLocalProxyToken();
    await ensureVerified(activeProxyBase(), token);
    return token;
}

let savedFetch: typeof fetch | null = null;
function originalFetch() {
    return savedFetch || globalThis.fetch.bind(globalThis);
}

function requestUrl(input: RequestInfo | URL) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

let installed = false;

/** Installs the fetch wrapper and the axios interceptor once (app start). */
export function installLocalProxyAuth() {
    if (installed) return;
    installed = true;
    savedFetch = globalThis.fetch.bind(globalThis);
    const base = savedFetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const token = await authorizeLocalProxyRequest(requestUrl(input));
        if (!token) return base(input, init);
        if (input instanceof Request && !init) {
            const request = new Request(input);
            request.headers.set(PROXY_TOKEN_HEADER, token);
            return base(request);
        }
        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
        headers.set(PROXY_TOKEN_HEADER, token);
        return base(input, { ...init, headers });
    }) as typeof fetch;
    axios.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
        const token = await authorizeLocalProxyRequest(axios.getUri(config));
        if (token) {
            config.headers = AxiosHeaders.from(config.headers || {});
            config.headers.set(PROXY_TOKEN_HEADER, token);
        }
        return config;
    });
    // Callers sometimes log AxiosError/response.config: the token must not survive into what they receive.
    const scrub = (config?: InternalAxiosRequestConfig) => {
        const headers = config?.headers as unknown;
        if (!headers) return;
        if (headers instanceof AxiosHeaders) headers.delete(PROXY_TOKEN_HEADER);
        else for (const key of Object.keys(headers as object)) if (key.toLowerCase() === PROXY_TOKEN_HEADER.toLowerCase()) delete (headers as Record<string, unknown>)[key];
    };
    axios.interceptors.response.use(
        (response) => {
            scrub(response.config);
            return response;
        },
        (error: unknown) => {
            const failure = error as { config?: InternalAxiosRequestConfig; request?: unknown } | undefined;
            scrub(failure?.config);
            return Promise.reject(error);
        },
    );
}

/** Test hook. */
export function resetLocalProxyAuthForTests() {
    if (savedFetch) globalThis.fetch = savedFetch;
    savedFetch = null;
    installed = false;
    handshake = null;
}
