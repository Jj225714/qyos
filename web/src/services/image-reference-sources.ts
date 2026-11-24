import localforage from "localforage";
import { getItemStrict } from "@/lib/localforage-storage";

/**
 * Every persisted place that can reference a stored file (`storageKey`). Image/media cleanup reads ALL of them and
 * aborts if any read fails. A new localforage store or persisted app_state key must be added either here or to
 * NON_REFERENCE_STORES (image-reference-sources.test.ts enforces this).
 */
export const APP_STATE_REFERENCE_KEYS = [
    "infinite-canvas:canvas_store",
    "infinite-canvas:asset_store",
    "infinite-canvas:product-white",
    "infinite-canvas:commerce_store",
    // Legacy locations of generation logs (before their own stores); older browsers may still hold them.
    "infinite-canvas:image_generation_logs",
    "infinite-canvas:video_generation_logs",
] as const;
export const REFERENCE_STORES = ["image_edit_documents", "image_generation_jobs", "image_generation_logs", "video_generation_logs"] as const;

/** Stores/keys reviewed as never holding file references, with the reason. */
export const NON_REFERENCE_STORES: Record<string, string> = {
    image_files: "the image blobs themselves",
    image_previews: "thumbnails keyed by the image key; removed with their image",
    media_files: "the media blobs themselves",
    prompt_cache: "prompt text cache",
    asset_migration_receipts: "server migration receipts (ids only)",
    app_state: "checked key by key (APP_STATE_REFERENCE_KEYS); other keys hold settings",
    "infinite-canvas:plugin_store": "plugin sources and metadata",
    "infinite-canvas:theme_store": "theme preference",
    "infinite-canvas:ai_config_store": "model/channel settings",
};

/** Collects storage keys ("prefix:id") from any JSON-like value. */
export function collectStorageKeys(value: unknown, keys = new Set<string>(), depth = 0): Set<string> {
    if (!value || typeof value !== "object" || depth > 64) return keys;
    if (Array.isArray(value)) {
        value.forEach((item) => collectStorageKeys(item, keys, depth + 1));
        return keys;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.storageKey === "string" && record.storageKey.includes(":")) keys.add(record.storageKey);
    Object.values(record).forEach((item) => collectStorageKeys(item, keys, depth + 1));
    return keys;
}

type IterableStore = { iterate: <T, U>(callback: (value: T, key: string) => U) => Promise<U> };

export type ReferenceSourceDeps = {
    readAppState?: (key: string) => Promise<string | null>;
    store?: (storeName: string) => IterableStore;
};

/** Reads every persisted reference source; rejects on the first failure (callers must then delete nothing). */
export async function collectPersistedReferences(deps: ReferenceSourceDeps = {}) {
    const readAppState = deps.readAppState || getItemStrict;
    const store = deps.store || ((storeName: string) => localforage.createInstance({ name: "infinite-canvas", storeName }) as unknown as IterableStore);
    const keys = new Set<string>();
    for (const key of APP_STATE_REFERENCE_KEYS) {
        const value = await readAppState(key);
        if (value) collectStorageKeys(JSON.parse(value), keys);
    }
    for (const storeName of REFERENCE_STORES) {
        await store(storeName).iterate((value: unknown) => {
            collectStorageKeys(value, keys);
        });
    }
    return keys;
}
