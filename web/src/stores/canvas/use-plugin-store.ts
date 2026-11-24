import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { localForageStorage } from "@/lib/localforage-storage";

export type InstalledPlugin = {
    id: string;
    name: string;
    version: string;
    description?: string;
    url: string; // Installation source used for updates.
    source: string; // Cached plugin source for offline use and pinned versions.
    enabled: boolean;
    local?: boolean; // Local plugin discovered in web/public/plugins; disabled by default and refetched from its URL when enabled.
    official?: boolean; // Installed from the official registry and grouped accordingly in the manager.
    /** Third-party code the user explicitly trusted: exactly these bytes (SHA-256) may run. */
    trust?: { kind: "user"; sha256: string; trustedAt: string };
    installedAt: string;
};

/** Why an installed plugin was not run on this page (not persisted; recomputed on every load). */
export type PluginBlockReason = "tampered" | "unverified" | "not-in-lock" | "local-not-approved";

type PluginStore = {
    plugins: InstalledPlugin[];
    blocked: Record<string, PluginBlockReason>;
    upsert: (plugin: Omit<InstalledPlugin, "installedAt"> & { installedAt?: string }) => void;
    setEnabled: (id: string, enabled: boolean) => void;
    remove: (id: string) => void;
    setBlocked: (id: string, reason?: PluginBlockReason) => void;
};

export const usePluginStore = create<PluginStore>()(
    persist(
        (set) => ({
            plugins: [],
            blocked: {},
            upsert: (plugin) =>
                set((state) => {
                    const installedAt = plugin.installedAt || new Date().toISOString();
                    const exists = state.plugins.some((item) => item.id === plugin.id);
                    const next = { ...plugin, installedAt };
                    return { plugins: exists ? state.plugins.map((item) => (item.id === plugin.id ? next : item)) : [next, ...state.plugins] };
                }),
            setEnabled: (id, enabled) => set((state) => ({ plugins: state.plugins.map((item) => (item.id === id ? { ...item, enabled } : item)) })),
            remove: (id) => set((state) => ({ plugins: state.plugins.filter((item) => item.id !== id) })),
            setBlocked: (id, reason) =>
                set((state) => {
                    const blocked = { ...state.blocked };
                    if (reason) blocked[id] = reason;
                    else delete blocked[id];
                    return { blocked };
                }),
        }),
        {
            name: "infinite-canvas:plugin_store",
            storage: createJSONStorage(() => localForageStorage),
            // Same stored shape as before ({ plugins }); block reasons are per page load only.
            partialize: (state) => ({ plugins: state.plugins }) as unknown as PluginStore,
        },
    ),
);
