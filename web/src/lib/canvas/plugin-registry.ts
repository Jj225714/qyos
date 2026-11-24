import { PLUGIN_REGISTRY_URL } from "@/constant/env";
import { isOfficialVersionTrusted } from "@/lib/canvas/plugin-integrity";

// An official registry item whose entry has been resolved to an absolute URL.
export type OfficialPluginEntry = {
    id: string;
    name: string;
    version: string;
    description?: string;
    icon?: string;
    url: string;
    /** Listed in the plugin lock of this app build; other versions cannot be installed. */
    trusted: boolean;
};

type RawEntry = { id?: string; name?: string; version?: string; description?: string; icon?: string; entry?: string; url?: string };
type RawManifest = { plugins?: RawEntry[] };

// Fetch the official registry and resolve relative entries against its URL for the existing URL installation flow.
export async function fetchOfficialPlugins(registryUrl: string = PLUGIN_REGISTRY_URL): Promise<OfficialPluginEntry[]> {
    // A relative registry (the shipped same-origin default) must be absolute before resolving entries against it.
    registryUrl = new URL(registryUrl, globalThis.location?.href || "http://localhost/").toString();
    const response = await fetch(registryUrl, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(i18n.t("canvas.pluginErrors.registryFailed", { status: response.status }));
    const data = (await response.json()) as RawManifest;
    const list = Array.isArray(data?.plugins) ? data.plugins : [];
    return list
        .filter((item): item is RawEntry & { id: string } => Boolean(item && item.id && (item.entry || item.url)))
        .map((item) => ({
            id: item.id,
            name: item.name || item.id,
            version: item.version || "0.0.0",
            description: item.description,
            icon: item.icon,
            url: item.url ? item.url : new URL(item.entry as string, registryUrl).toString(),
            trusted: isOfficialVersionTrusted(item.id, item.version || "0.0.0"),
        }));
}

// Compare semantic versions: positive means a is newer, negative means b is newer, and zero means equal.
// Compare numeric major.minor.patch components only and ignore non-numeric parts such as prerelease labels.
function compareSemver(a: string, b: string): number {
    const parse = (v: string) => v.split(".").map((part) => parseInt(part, 10) || 0);
    const [pa, pb] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

// Return whether the remote version is newer than the installed version.
export function hasUpgrade(installedVersion: string, remoteVersion: string): boolean {
    return compareSemver(remoteVersion, installedVersion) > 0;
}
import i18n from "@/i18n";
