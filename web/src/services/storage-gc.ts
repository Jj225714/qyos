import localforage from "localforage";
import { collectPersistedReferences, collectStorageKeys, type ReferenceSourceDeps } from "./image-reference-sources";
import { dropProtectionMarkers, holdTabPresence, lockManager, PRESENCE_LOCK, readProtections, type LockManagerLike } from "./storage-coordination";

/** An unreferenced file is deleted only after it stayed unreferenced (and unprotected) for this long. */
export const STORAGE_GC_GRACE_MS = 24 * 60 * 60 * 1000;
/** Startup maintenance runs at most this often. */
export const STORAGE_GC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Maintenance stops deleting after this long, so other tabs waiting to start are not held up. */
export const STORAGE_GC_BUDGET_MS = 15_000;
export const GC_CANDIDATES_KEY = "infinite-canvas:storage-gc-candidates:v1";
export const GC_LAST_RUN_KEY = "infinite-canvas:storage-gc-last-run:v1";
export const GC_REQUESTED_KEY = "infinite-canvas:storage-gc-requested:v1";

type KeyStore = { keys: () => Promise<string[]>; removeItem: (key: string) => Promise<void> };
type ValueStore = { getItem: <T>(key: string) => Promise<T | null>; setItem: <T>(key: string, value: T) => Promise<T> };

export type StorageGcDeps = ReferenceSourceDeps & {
    now?: () => number;
    images?: KeyStore;
    previews?: KeyStore;
    media?: KeyStore;
    state?: ValueStore;
    readProtections?: typeof readProtections;
    dropProtectionMarkers?: typeof dropProtectionMarkers;
};

export type StorageGcResult = { status: "deleted" | "skipped" | "aborted"; reason?: string; deleted: string[]; candidates: number };

const store = (storeName: string) => localforage.createInstance({ name: "infinite-canvas", storeName });

/**
 * Live cleanup requests (after deleting assets or projects) never delete anything while the app runs: other
 * state may still reference the files. They only ask the next startup maintenance to run regardless of interval.
 */
export async function requestStorageMaintenance(_used?: unknown): Promise<StorageGcResult> {
    await store("app_state").setItem(GC_REQUESTED_KEY, Date.now()).catch(() => undefined);
    return { status: "skipped", reason: "deferred to startup maintenance", deleted: [], candidates: 0 };
}

/**
 * Deletes image/media blobs that every persisted reference source agrees are unused, have no fresh protection
 * marker and stayed unreferenced for the grace period. MUST only be called while holding PRESENCE_LOCK
 * exclusively and before this page has read or written app data. Never throws; partial progress is reported.
 */
export async function collectGarbage(deps: StorageGcDeps = {}): Promise<StorageGcResult> {
    const now = deps.now || Date.now;
    const started = now();
    const images = deps.images || store("image_files");
    const previews = deps.previews || store("image_previews");
    const media = deps.media || store("media_files");
    const state = deps.state || (store("app_state") as unknown as ValueStore);
    const deleted: string[] = [];
    let candidates: Record<string, number> = {};
    try {
        const used = await collectPersistedReferences(deps);
        const { fresh, expired } = await (deps.readProtections || readProtections)(started);
        const previous = (await state.getItem<Record<string, number>>(GC_CANDIDATES_KEY)) || {};
        const stored = { image: await images.keys(), media: await media.keys() };
        const due: Array<{ kind: "image" | "media"; key: string }> = [];
        for (const kind of ["image", "media"] as const) {
            for (const key of stored[kind]) {
                if (used.has(key) || fresh.has(key)) continue;
                const since = typeof previous[key] === "number" && previous[key] <= started ? previous[key] : started;
                candidates[key] = since;
                if (started - since >= STORAGE_GC_GRACE_MS) due.push({ kind, key });
            }
        }
        // Save the candidate list first: if deletion stops halfway, the next run still knows the rest.
        await state.setItem(GC_CANDIDATES_KEY, candidates);
        for (const { kind, key } of due) {
            if (now() - started > STORAGE_GC_BUDGET_MS) break;
            if (kind === "image") {
                await images.removeItem(key);
                await previews.removeItem(key).catch(() => undefined);
            } else await media.removeItem(key);
            deleted.push(key);
            delete candidates[key];
        }
        const imageSet = new Set(stored.image.filter((key) => !deleted.includes(key)));
        for (const key of await previews.keys()) if (!imageSet.has(key) && !used.has(key)) await previews.removeItem(key).catch(() => undefined);
        await state.setItem(GC_CANDIDATES_KEY, candidates);
        if (expired.length) await (deps.dropProtectionMarkers || dropProtectionMarkers)(expired);
        return { status: deleted.length ? "deleted" : "skipped", reason: deleted.length ? undefined : "nothing due", deleted, candidates: Object.keys(candidates).length };
    } catch (error) {
        console.warn(`[storage-gc] 清理已中止（已删除 ${deleted.length} 个文件）`, error);
        return { status: "aborted", reason: error instanceof Error ? error.message : String(error), deleted, candidates: Object.keys(candidates).length };
    }
}

export type StartupResult = { maintenance: StorageGcResult };

/**
 * Called by the app entry BEFORE any app module that reads stored data is loaded. Runs cleanup only when this page
 * can take PRESENCE_LOCK exclusively (no other app or restore tab exists), then joins presence for its lifetime.
 */
export async function startStorageSession(options: { locks?: LockManagerLike | null; gc?: () => Promise<StorageGcResult>; now?: () => number; state?: ValueStore } = {}): Promise<StartupResult> {
    const locks = options.locks === undefined ? lockManager() : options.locks;
    const now = options.now || Date.now;
    const state = options.state || (store("app_state") as unknown as ValueStore);
    let maintenance: StorageGcResult = { status: "skipped", reason: "cross-tab locks unavailable", deleted: [], candidates: 0 };
    if (locks) {
        try {
            maintenance = (await locks.request(PRESENCE_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
                if (!lock) return { status: "skipped", reason: "another tab is open", deleted: [], candidates: 0 } satisfies StorageGcResult;
                const [last, requested] = await Promise.all([state.getItem<number>(GC_LAST_RUN_KEY), state.getItem<number>(GC_REQUESTED_KEY)]);
                if (typeof last === "number" && now() - last < STORAGE_GC_INTERVAL_MS && !(typeof requested === "number" && requested > last)) {
                    return { status: "skipped", reason: "ran recently", deleted: [], candidates: 0 } satisfies StorageGcResult;
                }
                const result = await (options.gc || collectGarbage)();
                if (result.status !== "aborted") await state.setItem(GC_LAST_RUN_KEY, now()).catch(() => undefined);
                return result;
            })) as StorageGcResult;
        } catch (error) {
            maintenance = { status: "aborted", reason: error instanceof Error ? error.message : String(error), deleted: [], candidates: 0 };
        }
    }
    await holdTabPresence(locks);
    return { maintenance };
}
