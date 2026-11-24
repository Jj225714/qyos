import localforage from "localforage";

/**
 * Cross-tab coordination for deleting stored blobs (image_files, media_files). Keeping data has priority over
 * reclaiming space, so files are physically deleted ONLY in a startup maintenance phase:
 *
 * - Every app tab and the workspace restore page hold the shared Web Lock PRESENCE_LOCK for their lifetime.
 * - At startup, BEFORE any store reads data or any file is written, the app asks for PRESENCE_LOCK exclusively
 *   with ifAvailable. Granted means no other app/restore tab is active and none can start (their shared request
 *   waits until maintenance releases the lock). Only then does cleanup run; otherwise it is skipped.
 * - Without Web Locks nothing is ever deleted.
 *
 * Freshly written blobs additionally get a protection marker, so a file written moments before a session ended
 * (and not yet referenced by anything saved) is not deleted for PROTECT_TTL_MS.
 */

export const PRESENCE_LOCK = "infinite-canvas:tab-presence";
export const PROTECT_PREFIX = "infinite-canvas:storage-gc-protect:";
export const PROTECT_TTL_MS = 24 * 60 * 60 * 1000;

export type LockManagerLike = {
    request: (name: string, options: { mode?: "shared" | "exclusive"; ifAvailable?: boolean }, callback: (lock: unknown) => Promise<unknown> | unknown) => Promise<unknown>;
};

export function lockManager(): LockManagerLike | null {
    const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
    return locks && typeof locks.request === "function" ? locks : null;
}

const appState = () => localforage.createInstance({ name: "infinite-canvas", storeName: "app_state" });

let presence: Promise<void> | null = null;

/**
 * Joins the presence group for this page's lifetime; resolves once granted (i.e. after any running maintenance).
 * Rejects if the lock request fails while Web Locks exist: the page must then not touch app data, because another
 * tab could be deleting files without knowing about it.
 */
export function holdTabPresence(locks: LockManagerLike | null = lockManager()): Promise<void> {
    if (!locks) return Promise.resolve();
    presence ||= new Promise<void>((resolve, reject) => {
        let granted = false;
        locks
            .request(PRESENCE_LOCK, { mode: "shared" }, () => {
                granted = true;
                resolve();
                return new Promise<never>(() => undefined);
            })
            .catch((error) => {
                presence = null;
                if (!granted) reject(error instanceof Error ? error : new Error(String(error)));
            });
    });
    return presence;
}

/** Marks a key as freshly written. A failed marker never blocks the write (the file is then only quarantined). */
export async function protectStorageKey(key: string, now = Date.now()) {
    try {
        await appState().setItem(PROTECT_PREFIX + key, now);
    } catch (error) {
        console.warn("[storage-gc] 无法记录新文件保护标记", error);
    }
}

/** Fresh protection markers; expired markers are returned separately so maintenance can drop them. */
export async function readProtections(now = Date.now()) {
    const store = appState();
    const fresh = new Set<string>();
    const expired: string[] = [];
    for (const markerKey of await store.keys()) {
        if (!markerKey.startsWith(PROTECT_PREFIX)) continue;
        const at = await store.getItem<number>(markerKey);
        const key = markerKey.slice(PROTECT_PREFIX.length);
        if (typeof at === "number" && Number.isFinite(at) && now - at < PROTECT_TTL_MS && at <= now + 60_000) fresh.add(key);
        else expired.push(markerKey);
    }
    return { fresh, expired };
}

export async function dropProtectionMarkers(markerKeys: string[]) {
    const store = appState();
    await Promise.all(markerKeys.map((key) => store.removeItem(key).catch(() => undefined)));
}

/** Test hook. */
export function resetStorageCoordinationForTests() {
    presence = null;
}
