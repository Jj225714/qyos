import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OFFICIAL = "export default { id: 'markdown', nodes: [{}] } // official bytes";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/localforage-storage", () => ({ localForageStorage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("@/lib/canvas/node-registry", () => ({ registerNodeDefinitions: vi.fn(), unregisterPluginNodes: vi.fn() }));
vi.mock("@/lib/canvas/plugin-runtime", () => ({ getPluginRuntime: () => ({ injectCSS: () => () => undefined }) }));
vi.mock("@/constant/official-plugin-lock.json", async () => {
    const { createHash: digest } = await import("node:crypto");
    return { default: { version: 1, plugins: [{ id: "markdown", version: "1.1.0", sha256: digest("sha256").update("export default { id: 'markdown', nodes: [{}] } // official bytes").digest("hex") }] } };
});
const evaluated = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/canvas/plugin-evaluate", () => ({
    evaluatePluginSource: vi.fn(async (source: string) => {
        evaluated.push(source);
        const id = /id: '([^']+)'/.exec(source)?.[1] || "unknown";
        return { id, name: id, version: "1.0.0", nodes: [{}] };
    }),
}));

import { ensurePluginsLoaded, installOfficialPlugin, installReviewedPlugin, resetPluginLoaderForTests, reviewPluginUrl, setPluginEnabled, trustInstalledPlugin } from "./plugin-loader";
import { usePluginStore, type InstalledPlugin } from "@/stores/canvas/use-plugin-store";
import { decideTrust, localPluginPath } from "./plugin-integrity";

const ORIGIN = "https://app.example.test";
let files: Record<string, string>;

beforeEach(() => {
    evaluated.length = 0;
    files = {};
    resetPluginLoaderForTests();
    usePluginStore.setState({ plugins: [], blocked: {} });
    vi.stubGlobal("location", { origin: ORIGIN });
    vi.stubGlobal("fetch", async (input: string) => {
        const url = new URL(input, ORIGIN);
        const key = url.origin === ORIGIN ? url.pathname : `${url.origin}${url.pathname}`;
        return key in files ? new Response(files[key]) : new Response("missing", { status: 404 });
    });
});
afterEach(() => vi.unstubAllGlobals());

const record = (extra: Partial<InstalledPlugin>): InstalledPlugin => ({ id: "x", name: "x", version: "1.0.0", url: "https://cdn.example.test/x.js", source: "export default { id: 'x', nodes: [{}] }", enabled: true, installedAt: "", ...extra });

describe("official plugins", () => {
    it("the committed lock is real: one non-empty SHA-256 per official plugin", () => {
        const lock = JSON.parse(readFileSync(join(__dirname, "../../constant/official-plugin-lock.json"), "utf8"));
        const build = readFileSync(join(__dirname, "../../../../plugins/canvas/registry/build.mjs"), "utf8");
        const ids = [...build.matchAll(/\{ id: "([a-z-]+)", dir:/g)].map((m) => m[1]);
        expect(ids.length).toBeGreaterThan(0);
        expect(lock.plugins.map((p: { id: string }) => p.id).sort()).toEqual([...ids].sort());
        for (const entry of lock.plugins) expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("installs bytes that match the compiled lock", async () => {
        files["https://cdn.example.test/markdown.js"] = OFFICIAL;
        await installOfficialPlugin({ id: "markdown", url: "https://cdn.example.test/markdown.js" });
        expect(evaluated).toEqual([OFFICIAL]);
        expect(usePluginStore.getState().plugins[0]).toMatchObject({ id: "markdown", official: true, version: "1.1.0" });
    });

    it("refuses tampered bytes from the (mutable) registry without running them", async () => {
        files["https://cdn.example.test/markdown.js"] = `${OFFICIAL} // tampered`;
        await expect(installOfficialPlugin({ id: "markdown", url: "https://cdn.example.test/markdown.js" })).rejects.toThrow(/官方插件校验失败/);
        expect(evaluated).toEqual([]);
        expect(usePluginStore.getState().plugins).toEqual([]);
    });

    it("refuses an id that is not in the lock", async () => {
        files["https://cdn.example.test/other.js"] = OFFICIAL;
        await expect(installOfficialPlugin({ id: "other", url: "https://cdn.example.test/other.js" })).rejects.toThrow();
        expect(evaluated).toEqual([]);
    });
});

describe("startup and enable always verify the bytes that run", () => {
    it("legacy third-party records (no trust) are kept but not run; official legacy records matching the lock run", async () => {
        usePluginStore.setState({ plugins: [record({ id: "legacy" , source: "export default { id: 'legacy', nodes: [{}] }" }), record({ id: "markdown", official: true, source: OFFICIAL })] });
        await ensurePluginsLoaded();
        expect(evaluated).toEqual([OFFICIAL]);
        expect(usePluginStore.getState().plugins.map((p) => p.id)).toEqual(["legacy", "markdown"]);
        expect(usePluginStore.getState().blocked).toEqual({ legacy: "unverified" });
    });

    it("a forged official record with other code is blocked", async () => {
        usePluginStore.setState({ plugins: [record({ id: "markdown", official: true, source: "export default { id: 'markdown', nodes: [{}] } // evil" })] });
        await ensurePluginsLoaded();
        expect(evaluated).toEqual([]);
        expect(usePluginStore.getState().blocked.markdown).toBe("not-in-lock");
    });

    it("a user-trusted record whose cached bytes changed is blocked on startup and on enable", async () => {
        const trusted = "export default { id: 'third', nodes: [{}] }";
        const changed = record({ id: "third", source: `${trusted} // changed`, trust: { kind: "user", sha256: hash(trusted), trustedAt: "" } });
        usePluginStore.setState({ plugins: [changed] });
        await ensurePluginsLoaded();
        await expect(setPluginEnabled(changed, true)).rejects.toThrow(/不一致/);
        expect(evaluated).toEqual([]);
    });

    it("forged local records: a cross-origin URL or a path not published by the site never runs", async () => {
        files["/plugins/index.json"] = JSON.stringify(["/plugins/approved.js"]);
        files["/plugins/approved.js"] = "export default { id: 'approved', nodes: [{}] }";
        files["/plugins/secret.js"] = "export default { id: 'secret', nodes: [{}] }";
        files["https://evil.example/plugins/x.js"] = "export default { id: 'cross', nodes: [{}] }";
        const crossOrigin = record({ id: "cross", local: true, url: "https://evil.example/plugins/x.js", source: "export default { id: 'cross', nodes: [{}] }" });
        const unlisted = record({ id: "secret", local: true, url: "/plugins/secret.js", source: "export default { id: 'secret', nodes: [{}] }" });
        usePluginStore.setState({ plugins: [crossOrigin, unlisted] });
        await ensurePluginsLoaded();
        expect(evaluated.some((s) => s.includes("'cross'") || s.includes("'secret'"))).toBe(false);
        expect(usePluginStore.getState().blocked).toMatchObject({ cross: "local-not-approved", secret: "local-not-approved" });
        // The approved same-origin file was discovered (disabled by default) and runs once enabled.
        const approved = usePluginStore.getState().plugins.find((p) => p.id === "approved")!;
        evaluated.length = 0;
        await setPluginEnabled(approved, true);
        expect(evaluated).toEqual(["export default { id: 'approved', nodes: [{}] }"]);
    });

    it("a local record never runs its persisted source, only the fresh same-origin file", async () => {
        files["/plugins/index.json"] = JSON.stringify(["/plugins/tool.js"]);
        files["/plugins/tool.js"] = "export default { id: 'tool', nodes: [{}] } // deployed";
        const forged = record({ id: "tool", local: true, url: "/plugins/tool.js", source: "export default { id: 'tool', nodes: [{}] } // injected", enabled: false });
        await setPluginEnabled(forged, true);
        expect(evaluated).toEqual(["export default { id: 'tool', nodes: [{}] } // deployed"]);
    });
});

describe("local plugin requests never follow redirects", () => {
    it("a local bundle that redirects (or answers from another origin) is not run", async () => {
        files["/plugins/index.json"] = JSON.stringify(["/plugins/tool.js"]);
        const redirected = new Response("export default { id: 'tool', nodes: [{}] } // cross-origin");
        Object.defineProperty(redirected, "redirected", { value: true });
        Object.defineProperty(redirected, "url", { value: "https://evil.example/tool.js" });
        const realFetch = globalThis.fetch;
        const seenModes: Array<string | undefined> = [];
        vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
            seenModes.push(init?.redirect);
            return new URL(input, ORIGIN).pathname === "/plugins/tool.js" ? redirected : realFetch(input, init);
        });
        const local = record({ id: "tool", local: true, url: "/plugins/tool.js", enabled: false });
        await expect(setPluginEnabled(local, true)).rejects.toThrow(/重定向/);
        expect(evaluated).toEqual([]);
        expect(seenModes.every((mode) => mode === "error")).toBe(true);
    });

    it("a redirected local manifest approves nothing", async () => {
        const realFetch = globalThis.fetch;
        files["/plugins/tool.js"] = "export default { id: 'tool', nodes: [{}] }";
        vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
            if (new URL(input, ORIGIN).pathname === "/plugins/index.json") {
                if (init?.redirect === "error") throw new TypeError("redirect refused");
                return new Response(JSON.stringify(["/plugins/tool.js"]));
            }
            return realFetch(input, init);
        });
        await expect(setPluginEnabled(record({ id: "tool", local: true, url: "/plugins/tool.js", enabled: false }), true)).rejects.toThrow(/不在本站/);
        expect(evaluated).toEqual([]);
    });
});

describe("shipped same-origin official plugins", () => {
    it("every shipped bundle matches the compiled lock byte for byte, and the manifest lists exactly them", () => {
        const dir = join(__dirname, "../../../public/official-plugins");
        const lock = JSON.parse(readFileSync(join(__dirname, "../../constant/official-plugin-lock.json"), "utf8"));
        const manifest = JSON.parse(readFileSync(join(dir, "official-plugins.json"), "utf8"));
        expect(manifest.plugins.map((p: { id: string }) => p.id).sort()).toEqual(lock.plugins.map((p: { id: string }) => p.id).sort());
        for (const entry of lock.plugins) {
            const bytes = readFileSync(join(dir, `${entry.id}.js`));
            expect(createHash("sha256").update(bytes).digest("hex"), entry.id).toBe(entry.sha256);
            expect(manifest.plugins.find((p: { id: string }) => p.id === entry.id)).toMatchObject({ version: entry.version, entry: `${entry.id}.js` });
        }
    });
});

describe("third-party trust binds the exact reviewed bytes", () => {
    it("review never runs code; install runs exactly the reviewed bytes and pins their hash", async () => {
        files["https://cdn.example.test/third.js"] = "export default { id: 'third', nodes: [{}] }";
        const review = await reviewPluginUrl("https://cdn.example.test/third.js");
        expect(evaluated).toEqual([]);
        // The server changes the file after review: install must not refetch it.
        files["https://cdn.example.test/third.js"] = "export default { id: 'third', nodes: [{}] } // swapped";
        await installReviewedPlugin(review, review.sha256);
        expect(evaluated).toEqual(["export default { id: 'third', nodes: [{}] }"]);
        expect(usePluginStore.getState().plugins[0].trust).toMatchObject({ kind: "user", sha256: hash("export default { id: 'third', nodes: [{}] }") });
    });

    it("bytes changed between review and install are refused", async () => {
        files["https://cdn.example.test/third.js"] = "export default { id: 'third', nodes: [{}] }";
        const review = await reviewPluginUrl("https://cdn.example.test/third.js");
        await expect(installReviewedPlugin({ ...review, source: `${review.source} // changed` }, review.sha256)).rejects.toThrow(/不一致/);
        await expect(installReviewedPlugin(review, hash("something else"))).rejects.toThrow(/不一致/);
        expect(evaluated).toEqual([]);
    });

    it("explicit trust of a legacy record pins its cached bytes", async () => {
        const legacy = record({ id: "legacy", source: "export default { id: 'legacy', nodes: [{}] }", enabled: false });
        usePluginStore.setState({ plugins: [legacy] });
        await expect(trustInstalledPlugin(legacy, hash("other"))).rejects.toThrow();
        await trustInstalledPlugin(legacy, hash(legacy.source));
        expect(usePluginStore.getState().plugins[0]).toMatchObject({ enabled: true, trust: { kind: "user", sha256: hash(legacy.source) } });
        expect(evaluated).toEqual([legacy.source]);
    });
});

describe("integrity helpers", () => {
    it("local paths must be same-origin /plugins/*.js", () => {
        expect(localPluginPath("/plugins/a.js", ORIGIN)).toBe("/plugins/a.js");
        expect(localPluginPath(`${ORIGIN}/plugins/a.js?t=1`, ORIGIN)).toBe("/plugins/a.js");
        expect(localPluginPath("https://evil.example/plugins/a.js", ORIGIN)).toBeNull();
        expect(localPluginPath("/plugins/../x.js", ORIGIN)).toBeNull();
        expect(localPluginPath("/other/a.js", ORIGIN)).toBeNull();
    });

    it("unknown trust kinds are untrusted", async () => {
        const forged = { id: "x", url: "u", trust: { kind: "local", sha256: "x" } } as unknown as InstalledPlugin;
        expect(await decideTrust(forged, "code")).toEqual({ ok: false, reason: "unverified" });
    });
});
