import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import axios from "axios";
import { useConfigStore, withLocalProxy } from "@/stores/use-config-store";
import { installLocalProxyAuth, PROXY_TOKEN_HEADER, PROXY_TOKEN_STORAGE_KEY, resetLocalProxyAuthForTests, setLocalProxyToken } from "./local-proxy-auth";
import { isWorkspaceKey } from "@/services/workspace-transfer";
import { localProxyCommand, proxyTargets } from "@/components/layout/config-local-proxy";

const BASE = "http://127.0.0.1:23210";
const TOKEN = "cp_test_token_0123456789abcdefghijklmnop";
const original = useConfigStore.getState().config;
type Call = { url: string; headers: Headers };

function stubFetch(handshake: { status: number; body: unknown } = { status: 200, body: { proxy: "canvas-proxy", version: "0.2.0", protocol: 2, authorized: true } }) {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, headers: new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)) });
        if (url.endsWith("/__canvas-proxy/handshake")) return new Response(JSON.stringify(handshake.body), { status: handshake.status });
        return new Response("ok");
    });
    return calls;
}

beforeEach(() => {
    const local = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => local.set(k, v), removeItem: (k: string) => local.delete(k) });
    useConfigStore.setState({ config: { ...original, proxyEnabled: true, proxyUrl: BASE } });
});
afterEach(() => {
    resetLocalProxyAuthForTests();
    useConfigStore.setState({ config: original });
    vi.unstubAllGlobals();
});

describe("central local proxy authentication", () => {
    it("adds the token header (never the URL) to proxied fetches after a successful handshake", async () => {
        const calls = stubFetch();
        installLocalProxyAuth();
        setLocalProxyToken(TOKEN);
        const url = withLocalProxy("https://api.example.test/v1/models");
        expect(url).toBe(`${BASE}/https://api.example.test/v1/models`);
        expect(url).not.toContain(TOKEN);
        await fetch(url, { headers: { authorization: "Bearer sk-test" } });
        await fetch(new Request(withLocalProxy("https://cdn.example.test/image.png")));
        expect(calls.map((c) => c.url)).toEqual([`${BASE}/__canvas-proxy/handshake`, url, `${BASE}/https://cdn.example.test/image.png`]);
        expect(calls[1].headers.get(PROXY_TOKEN_HEADER)).toBe(TOKEN);
        expect(calls[1].headers.get("authorization")).toBe("Bearer sk-test");
        expect(calls[2].headers.get(PROXY_TOKEN_HEADER)).toBe(TOKEN);
    });

    it("leaves requests that do not go through the proxy untouched", async () => {
        const calls = stubFetch();
        installLocalProxyAuth();
        setLocalProxyToken(TOKEN);
        await fetch("/api/providers/fal/jobs");
        useConfigStore.setState({ config: { ...original, proxyEnabled: false, proxyUrl: BASE } });
        await fetch(`${BASE}/https://api.example.test/`);
        expect(calls.every((c) => !c.headers.has(PROXY_TOKEN_HEADER))).toBe(true);
        expect(calls.some((c) => c.url.includes("handshake"))).toBe(false);
    });

    it("fails closed without a token: nothing is sent to the proxy", async () => {
        const calls = stubFetch();
        installLocalProxyAuth();
        await expect(fetch(withLocalProxy("https://api.example.test/v1/models"))).rejects.toThrow(/启动令牌/);
        expect(calls).toEqual([]);
    });

    it("refuses an old proxy without token protection, with upgrade guidance, and sends it nothing else", async () => {
        const calls = stubFetch({ status: 200, body: { app: "infinite-canvas", proxy: "@basketikun/canvas-proxy", version: "0.1.0", usage: "/<full-target-url>" } });
        installLocalProxyAuth();
        setLocalProxyToken(TOKEN);
        await expect(fetch(withLocalProxy("https://api.example.test/v1/models"))).rejects.toThrow(/旧版本地代理.*node canvas-proxy\/index\.js/);
        expect(calls.map((c) => c.url)).toEqual([`${BASE}/__canvas-proxy/handshake`]);
    });

    it("refuses a token the proxy rejects", async () => {
        stubFetch({ status: 401, body: { protocol: 2, authorized: false } });
        installLocalProxyAuth();
        setLocalProxyToken("cp_wrong_token_0123456789abcdefghijkl");
        await expect(fetch(withLocalProxy("https://api.example.test/"))).rejects.toThrow(/令牌无效/);
    });

    it("adds the header to axios requests (downloads) through the same interceptor", async () => {
        stubFetch();
        installLocalProxyAuth();
        setLocalProxyToken(TOKEN);
        let seen: string | undefined;
        await axios.get(withLocalProxy("https://cdn.example.test/video.mp4"), {
            adapter: async (config) => {
                seen = String(config.headers.get(PROXY_TOKEN_HEADER));
                return { data: "ok", status: 200, statusText: "OK", headers: {}, config };
            },
        });
        expect(seen).toBe(TOKEN);
    });

    it("removes the token from the config callers receive on success and on failure", async () => {
        stubFetch();
        installLocalProxyAuth();
        setLocalProxyToken(TOKEN);
        let sent: string | undefined;
        const ok = await axios.get(withLocalProxy("https://cdn.example.test/ok"), {
            adapter: async (config) => {
                sent = String(config.headers.get(PROXY_TOKEN_HEADER));
                return { data: "ok", status: 200, statusText: "OK", headers: {}, config };
            },
        });
        expect(sent).toBe(TOKEN);
        expect(JSON.stringify(ok.config.headers)).not.toContain(TOKEN);
        const failure = await axios
            .get(withLocalProxy("https://cdn.example.test/fail"), {
                adapter: async (config) => {
                    const error = new axios.AxiosError("Request failed", "ERR_BAD_RESPONSE", config, undefined, { data: "no", status: 500, statusText: "x", headers: {}, config });
                    throw error;
                },
            })
            .then(
                () => ({}) as { config?: { headers?: unknown }; response?: { config?: { headers?: unknown } } },
                (error: unknown) => error as { config?: { headers?: unknown }; response?: { config?: { headers?: unknown } } },
            );
        expect(failure.config).toBeDefined();
        expect(JSON.stringify(failure.config?.headers)).not.toContain(TOKEN);
        expect(JSON.stringify(failure.response?.config?.headers)).not.toContain(TOKEN);
    });

    it("keeps the token out of configuration, workspace archives and the start command", () => {
        setLocalProxyToken(TOKEN);
        expect(JSON.stringify(useConfigStore.getState().config)).not.toContain(TOKEN);
        expect(isWorkspaceKey(PROXY_TOKEN_STORAGE_KEY)).toBe(false);
        expect(isWorkspaceKey("infinite-canvas:local-proxy-token")).toBe(false);
        const config = { ...original, baseUrl: "https://api.example.test/v1", channels: [{ ...original.channels[0], baseUrl: "http://127.0.0.1:11434/v1" }], proxyUrl: BASE };
        expect(proxyTargets(config, { url: "https://dav.example.test/remote.php" })).toEqual(["https://api.example.test", "http://127.0.0.1:11434", "https://dav.example.test"]);
        const command = localProxyCommand(config);
        expect(command).toMatch(/^node canvas-proxy\/index\.js --allow-origin /);
        expect(command).toContain("--allow-target https://api.example.test");
        expect(command).not.toContain(TOKEN);
    });
});
