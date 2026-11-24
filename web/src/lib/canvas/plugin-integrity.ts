import lock from "@/constant/official-plugin-lock.json";
import type { InstalledPlugin } from "@/stores/canvas/use-plugin-store";

/**
 * Trust decisions for plugin code. Nothing persisted in the browser is trusted by itself (records can be edited by
 * any same-origin script); every execution is preceded by hashing the exact bytes about to run.
 *  - official: SHA-256 must appear in the lock compiled into this app build (official-plugin-lock.json);
 *  - user-trusted third-party: SHA-256 must equal the hash the user confirmed for those exact bytes;
 *  - local: fetched fresh from this site's own /plugins/ directory and listed in /plugins/index.json.
 */
export type PluginLockEntry = { id: string; version: string; sha256: string };
export const OFFICIAL_PLUGIN_LOCK: PluginLockEntry[] = (lock as { plugins: PluginLockEntry[] }).plugins;

export async function sha256Hex(source: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function officialLockEntry(id: string, sha256: string, entries: PluginLockEntry[] = OFFICIAL_PLUGIN_LOCK) {
    return entries.find((entry) => entry.id === id && entry.sha256 === sha256) || null;
}

export function isOfficialVersionTrusted(id: string, version: string, entries: PluginLockEntry[] = OFFICIAL_PLUGIN_LOCK) {
    return entries.some((entry) => entry.id === id && entry.version === version);
}

/** Same-origin path of a local plugin file, or null when the URL points anywhere else. */
export function localPluginPath(url: string, origin = globalThis.location?.origin) {
    try {
        const parsed = new URL(url, origin);
        if (!origin || parsed.origin !== origin) return null;
        return /^\/plugins\/[A-Za-z0-9._-]+\.js$/.test(parsed.pathname) && !parsed.pathname.includes("..") ? parsed.pathname : null;
    } catch {
        return null;
    }
}

export type TrustResult = { ok: true; kind: "official" | "user" | "local" } | { ok: false; reason: "tampered" | "unverified" | "not-in-lock" | "local-not-approved" };

/** Decides whether `source` may run for `record`. `approvedLocalPaths` comes from a fresh /plugins/index.json. */
export async function decideTrust(record: Pick<InstalledPlugin, "id" | "official" | "local" | "trust" | "url">, source: string, approvedLocalPaths: Set<string> = new Set()): Promise<TrustResult> {
    if (record.local) {
        const path = localPluginPath(record.url);
        return path && approvedLocalPaths.has(path) ? { ok: true, kind: "local" } : { ok: false, reason: "local-not-approved" };
    }
    const hash = await sha256Hex(source);
    if (record.trust?.kind === "user") return hash === record.trust.sha256 ? { ok: true, kind: "user" } : { ok: false, reason: "tampered" };
    if (record.official) return officialLockEntry(record.id, hash) ? { ok: true, kind: "official" } : { ok: false, reason: "not-in-lock" };
    return { ok: false, reason: "unverified" };
}
