import { registerNodeDefinitions, unregisterPluginNodes } from "@/lib/canvas/node-registry";
import { getPluginRuntime } from "@/lib/canvas/plugin-runtime";
import { evaluatePluginSource } from "@/lib/canvas/plugin-evaluate";
import { decideTrust, localPluginPath, officialLockEntry, sha256Hex, type TrustResult } from "@/lib/canvas/plugin-integrity";
import { usePluginStore, type InstalledPlugin } from "@/stores/canvas/use-plugin-store";
import type { CanvasPlugin } from "@/types/canvas-plugin";
import i18n from "@/i18n";

const cleanups = new Map<string, () => void>();

export function activatePlugin(plugin: CanvasPlugin) {
    registerNodeDefinitions(plugin.nodes, plugin.id);
    const runtime = getPluginRuntime();
    const disposers: Array<() => void> = [];
    // Inject declared styles when enabled and remove them when disabled or uninstalled.
    if (plugin.css) disposers.push(runtime.injectCSS(plugin.css, plugin.id));
    const cleanup = plugin.setup?.(runtime);
    if (typeof cleanup === "function") disposers.push(cleanup);
    if (disposers.length) cleanups.set(plugin.id, () => disposers.forEach((dispose) => dispose()));
}

export function deactivatePlugin(pluginId: string) {
    cleanups.get(pluginId)?.();
    cleanups.delete(pluginId);
    unregisterPluginNodes(pluginId);
}

async function fetchPluginSource(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(i18n.t("canvas.pluginErrors.downloadFailed", { status: response.status }));
    return response.text();
}

/**
 * Same-origin local files (manifest and bundles): redirects are refused and the effective response URL must still
 * be the approved same-origin path, so a redirect to other code can never be run as a "local" plugin.
 */
async function fetchLocalFile(path: string, init: RequestInit = {}) {
    const response = await fetch(withCacheBust(path), { ...init, redirect: "error" });
    if (response.redirected || (response.url && localPluginPathOrManifest(response.url) !== path)) throw new Error("本地插件请求被重定向，已阻止");
    if (!response.ok) throw new Error(i18n.t("canvas.pluginErrors.downloadFailed", { status: response.status }));
    return response;
}

function localPluginPathOrManifest(url: string) {
    try {
        const parsed = new URL(url, globalThis.location?.origin);
        if (parsed.origin !== globalThis.location?.origin) return null;
        return parsed.pathname === "/plugins/index.json" ? parsed.pathname : localPluginPath(parsed.href);
    } catch {
        return null;
    }
}

// Add a cache-busting parameter so watch builds load the latest output.
function withCacheBust(url: string) {
    return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

const BLOCK_MESSAGES: Record<Exclude<TrustResult, { ok: true }>["reason"], string> = {
    tampered: "插件代码与已确认的版本不一致，已阻止运行",
    unverified: "插件尚未确认信任，已阻止运行；请在插件管理中核对哈希后确认，或重新安装",
    "not-in-lock": "官方插件校验失败（不在当前应用版本登记的哈希中），已阻止运行",
    "local-not-approved": "本地插件不在本站 /plugins 目录清单中，已阻止运行",
};

export function blockMessage(reason: keyof typeof BLOCK_MESSAGES) {
    return BLOCK_MESSAGES[reason];
}

/** Same-origin local plugin paths published by this site (/plugins/index.json), read fresh. */
async function approvedLocalPaths() {
    try {
        const response = await fetchLocalFile("/plugins/index.json", { cache: "no-store" });
        const urls = (await response.json()) as unknown;
        return new Set((Array.isArray(urls) ? urls : []).map((url) => (typeof url === "string" ? localPluginPath(url) : null)).filter((path): path is string => Boolean(path)));
    } catch {
        return new Set<string>();
    }
}

/** The only path to execution for installed records: fetch (local) or cached bytes, verify, then evaluate exactly them. */
async function verifiedPluginFor(record: InstalledPlugin, approved?: Set<string>) {
    const local = record.local ? localPluginPath(record.url) : null;
    const source = local ? await (await fetchLocalFile(local)).text() : record.source;
    const decision = await decideTrust(record, source, record.local ? approved || (await approvedLocalPaths()) : undefined);
    if (!decision.ok) {
        usePluginStore.getState().setBlocked(record.id, decision.reason);
        throw new Error(BLOCK_MESSAGES[decision.reason]);
    }
    const plugin = await evaluatePluginSource(source);
    if (plugin.id !== record.id) throw new Error("插件代码声明的 id 与已安装记录不一致，已阻止运行");
    usePluginStore.getState().setBlocked(record.id);
    return plugin;
}

/** Official install/update: the downloaded bytes must match the lock compiled into this app before they run. */
export async function installOfficialPlugin(entry: { id: string; url: string }) {
    const source = await fetchPluginSource(withCacheBust(entry.url));
    const lockEntry = officialLockEntry(entry.id, await sha256Hex(source));
    if (!lockEntry) throw new Error(BLOCK_MESSAGES["not-in-lock"]);
    const plugin = await evaluatePluginSource(source);
    if (plugin.id !== entry.id) throw new Error("插件代码声明的 id 与官方清单不一致，已阻止运行");
    deactivatePlugin(plugin.id);
    usePluginStore.getState().upsert({ id: plugin.id, name: plugin.name || plugin.id, version: lockEntry.version, description: plugin.description, url: entry.url, source, enabled: true, official: true });
    usePluginStore.getState().setBlocked(plugin.id);
    activatePlugin(plugin);
    return plugin;
}

export type PluginReview = { url: string; source: string; sha256: string; bytes: number };

/** Downloads third-party code for review WITHOUT running it. */
export async function reviewPluginUrl(url: string): Promise<PluginReview> {
    const source = await fetchPluginSource(url);
    return { url, source, sha256: await sha256Hex(source), bytes: new TextEncoder().encode(source).length };
}

/** Runs and stores exactly the bytes the user confirmed (the hash is recomputed; nothing is fetched again). */
export async function installReviewedPlugin(review: PluginReview, confirmedSha256: string) {
    const sha256 = await sha256Hex(review.source);
    if (sha256 !== confirmedSha256 || sha256 !== review.sha256) throw new Error("待安装的代码与已核对的哈希不一致，已取消安装");
    const plugin = await evaluatePluginSource(review.source);
    deactivatePlugin(plugin.id);
    usePluginStore.getState().upsert({ id: plugin.id, name: plugin.name || plugin.id, version: plugin.version || "0.0.0", description: plugin.description, url: review.url, source: review.source, enabled: true, trust: { kind: "user", sha256, trustedAt: new Date().toISOString() } });
    usePluginStore.getState().setBlocked(plugin.id);
    activatePlugin(plugin);
    return plugin;
}

/** Explicitly trusts the cached bytes of an installed record (legacy installs), after the user saw their hash. */
export async function trustInstalledPlugin(record: InstalledPlugin, confirmedSha256: string) {
    const sha256 = await sha256Hex(record.source);
    if (sha256 !== confirmedSha256) throw new Error("插件代码与已核对的哈希不一致，未信任");
    const trusted: InstalledPlugin = { ...record, trust: { kind: "user", sha256, trustedAt: new Date().toISOString() } };
    const plugin = await verifiedPluginFor(trusted);
    deactivatePlugin(record.id);
    usePluginStore.getState().upsert({ ...trusted, enabled: true });
    activatePlugin(plugin);
    return plugin;
}

export async function setPluginEnabled(record: InstalledPlugin, enabled: boolean) {
    if (!enabled) {
        usePluginStore.getState().setEnabled(record.id, false);
        deactivatePlugin(record.id);
        return;
    }
    const plugin = await verifiedPluginFor(record);
    usePluginStore.getState().setEnabled(record.id, true);
    activatePlugin(plugin);
}

export function uninstallPlugin(id: string) {
    deactivatePlugin(id);
    usePluginStore.getState().remove(id);
    usePluginStore.getState().setBlocked(id);
}

let loaded = false;

// Load installed and enabled plugins at application startup; every record is verified before it runs.
export async function ensurePluginsLoaded() {
    if (loaded) return;
    loaded = true;
    await usePluginStore.persist.rehydrate();
    const approved = await approvedLocalPaths();
    await loadLocalPlugins(approved); // Discover disabled local plugins first, then activate all enabled records.
    const records = usePluginStore.getState().plugins.filter((record) => record.enabled);
    await Promise.all(
        records.map(async (record) => {
            try {
                activatePlugin(await verifiedPluginFor(record, approved));
            } catch (error) {
                console.error(`[plugin] Failed to load: ${record.id}`, error);
            }
        }),
    );
    await loadDevPlugins();
}

// Discover local plugins from this site's /plugins/index.json, add them disabled, and expose them in the manager.
// Same-origin files deployed with the app; enabled state is preserved, other persisted fields are refreshed.
async function loadLocalPlugins(approved: Set<string>) {
    if (!approved.size) return;
    const store = usePluginStore.getState();
    await Promise.all(
        [...approved].map(async (path) => {
            try {
                const source = await (await fetchLocalFile(path)).text();
                const plugin = await evaluatePluginSource(source);
                const existing = store.plugins.find((item) => item.id === plugin.id);
                // Never let a discovered local file take over an official or third-party record with the same id.
                if (existing && !existing.local) return;
                store.upsert({ id: plugin.id, name: plugin.name || plugin.id, version: plugin.version || "0.0.0", description: plugin.description, url: path, source, enabled: existing?.enabled ?? false, local: true });
            } catch (error) {
                console.error(`[plugin] Failed to discover local plugin: ${path}`, error);
            }
        }),
    );
}

// During local development only, refetch VITE_DEV_PLUGINS URLs without caching or persistence on every startup.
async function loadDevPlugins() {
    if (!import.meta.env.DEV) return;
    const raw = import.meta.env.VITE_DEV_PLUGINS;
    if (!raw) return;
    const urls = raw.split(",").map((item) => item.trim()).filter(Boolean);
    await Promise.all(
        urls.map(async (url) => {
            try {
                const source = await fetchPluginSource(withCacheBust(url));
                const plugin = await evaluatePluginSource(source);
                deactivatePlugin(plugin.id);
                activatePlugin(plugin);
                console.info(`[plugin] Dev plugin loaded: ${plugin.id} (${url})`);
            } catch (error) {
                console.error(`[plugin] Failed to load dev plugin: ${url}`, error);
            }
        }),
    );
}

/** Test hook. */
export function resetPluginLoaderForTests() {
    loaded = false;
    cleanups.clear();
}
