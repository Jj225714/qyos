import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    stores: new Map<string, Map<string, unknown>>(),
    failIterate: new Set<string>(),
    failRemove: new Set<string>(),
}));
vi.mock("localforage", () => {
    const instance = (storeName: string) => {
        if (!fake.stores.has(storeName)) fake.stores.set(storeName, new Map());
        const data = () => fake.stores.get(storeName)!;
        return {
            getItem: async (key: string) => (data().has(key) ? structuredClone(data().get(key)) : null),
            setItem: async (key: string, value: unknown) => {
                data().set(key, structuredClone(value));
                return value;
            },
            removeItem: async (key: string) => {
                if (fake.failRemove.has(key)) throw new Error(`remove failed: ${key}`);
                data().delete(key);
            },
            keys: async () => Array.from(data().keys()),
            iterate: async (fn: (value: unknown, key: string) => unknown) => {
                if (fake.failIterate.has(storeName)) throw new Error(`iterate failed: ${storeName}`);
                for (const [key, value] of data()) fn(value, key);
            },
        };
    };
    return { default: { createInstance: ({ storeName }: { storeName: string }) => instance(storeName), config: () => undefined, ...instance("app_state") } };
});
vi.mock("@/lib/localforage-storage", () => ({
    getItemStrict: async (key: string) => {
        if (fake.failIterate.has(`app_state:${key}`)) throw new Error(`read failed: ${key}`);
        const value = fake.stores.get("app_state")?.get(key);
        return typeof value === "string" ? value : null;
    },
}));

import { collectGarbage, GC_CANDIDATES_KEY, GC_LAST_RUN_KEY, requestStorageMaintenance, startStorageSession, STORAGE_GC_GRACE_MS } from "./storage-gc";
import { holdTabPresence, PRESENCE_LOCK, PROTECT_PREFIX, resetStorageCoordinationForTests, type LockManagerLike } from "./storage-coordination";
import { APP_STATE_REFERENCE_KEYS, REFERENCE_STORES } from "./image-reference-sources";

const H = 60 * 60 * 1000;
const set = (storeName: string, key: string, value: unknown) => {
    if (!fake.stores.has(storeName)) fake.stores.set(storeName, new Map());
    fake.stores.get(storeName)!.set(key, value);
};
const has = (storeName: string, key: string) => Boolean(fake.stores.get(storeName)?.has(key));

/** Minimal Web Locks implementation with shared/exclusive modes, ifAvailable and FIFO waiting. */
function lockManager() {
    const held: Array<{ name: string; mode: string }> = [];
    const queue: Array<{ name: string; mode: string; grant: () => void }> = [];
    const compatible = (name: string, mode: string) => held.filter((l) => l.name === name).every((l) => mode === "shared" && l.mode === "shared");
    const pump = () => {
        for (const item of [...queue]) {
            if (!compatible(item.name, item.mode)) break;
            queue.splice(queue.indexOf(item), 1);
            item.grant();
        }
    };
    const manager: LockManagerLike & { held: typeof held } = {
        held,
        async request(name, options, callback) {
            const mode = options.mode || "exclusive";
            if (!compatible(name, mode) || queue.some((q) => q.name === name)) {
                if (options.ifAvailable) return callback(null);
                await new Promise<void>((resolve) => queue.push({ name, mode, grant: resolve }));
            }
            const lock = { name, mode };
            held.push(lock);
            try {
                return await callback(lock);
            } finally {
                held.splice(held.indexOf(lock), 1);
                pump();
            }
        },
    };
    return manager;
}

beforeEach(() => {
    fake.stores.clear();
    fake.failIterate.clear();
    fake.failRemove.clear();
    resetStorageCoordinationForTests();
});

function seedReferences() {
    set("image_files", "image:canvas", "blob");
    set("image_files", "image:asset", "blob");
    set("image_files", "image:white", "blob");
    set("image_files", "image:commerce", "blob");
    set("image_files", "image:draft-original", "blob");
    set("image_files", "image:draft-layer", "blob");
    set("image_files", "image:draft-mask", "blob");
    set("image_files", "image:job-reference", "blob");
    set("image_files", "image:log", "blob");
    set("media_files", "video:log", "blob");
    set("image_files", "image:orphan", "blob");
    set("image_previews", "image:orphan", "preview");
    set("media_files", "video:orphan", "blob");
    set("app_state", "infinite-canvas:canvas_store", JSON.stringify({ state: { projects: [{ nodes: [{ data: { storageKey: "image:canvas" } }] }] } }));
    set("app_state", "infinite-canvas:asset_store", JSON.stringify({ state: { assets: [{ data: { storageKey: "image:asset" } }] } }));
    set("app_state", "infinite-canvas:product-white", JSON.stringify({ state: { records: [{ image: { storageKey: "image:white" } }] } }));
    set("app_state", "infinite-canvas:commerce_store", JSON.stringify({ state: { jobs: [{ skus: [{ assets: [{ image: { storageKey: "image:commerce" } }] }] }] } }));
    set("image_edit_documents", "draft", { version: 1, original: { storageKey: "image:draft-original" }, layers: [{ image: { storageKey: "image:draft-layer" }, maskBase: { storageKey: "image:draft-mask" } }] });
    set("image_generation_jobs", "job", { id: "job", status: "queued", references: [{ id: "r", storageKey: "image:job-reference" }] });
    set("image_generation_logs", "log", { images: [{ storageKey: "image:log" }] });
    set("video_generation_logs", "log", { video: { storageKey: "video:log" } });
}

describe("collectGarbage (startup maintenance)", () => {
    it("keeps everything any reference store mentions and deletes orphans only after the grace period", async () => {
        seedReferences();
        let now = 1_000 * H;
        const first = await collectGarbage({ now: () => now });
        expect(first).toMatchObject({ status: "skipped", deleted: [] });
        expect(fake.stores.get("app_state")!.get(GC_CANDIDATES_KEY)).toEqual({ "image:orphan": now, "video:orphan": now });
        now += STORAGE_GC_GRACE_MS - 1;
        expect((await collectGarbage({ now: () => now })).deleted).toEqual([]);
        now += 1;
        const due = await collectGarbage({ now: () => now });
        expect(due.status).toBe("deleted");
        expect(due.deleted.sort()).toEqual(["image:orphan", "video:orphan"]);
        expect(has("image_previews", "image:orphan")).toBe(false);
        for (const key of ["image:canvas", "image:asset", "image:white", "image:commerce", "image:draft-original", "image:draft-layer", "image:draft-mask", "image:job-reference", "image:log"]) expect(has("image_files", key), key).toBe(true);
        expect(has("media_files", "video:log")).toBe(true);
    });

    it("forgets a candidate that became referenced again before its grace period ended", async () => {
        seedReferences();
        let now = 1_000 * H;
        await collectGarbage({ now: () => now });
        set("image_edit_documents", "later", { version: 1, original: { storageKey: "image:orphan" }, layers: [] });
        now += STORAGE_GC_GRACE_MS * 2;
        expect((await collectGarbage({ now: () => now })).deleted).toEqual(["video:orphan"]);
        expect(has("image_files", "image:orphan")).toBe(true);
        fake.stores.get("image_edit_documents")!.delete("later");
        now += STORAGE_GC_GRACE_MS - 1;
        expect((await collectGarbage({ now: () => now })).deleted).toEqual([]);
    });

    it.each([...REFERENCE_STORES.map((name) => ["store", name]), ...APP_STATE_REFERENCE_KEYS.map((key) => ["app_state", `app_state:${key}`])])("aborts without deleting anything when %s %s cannot be read", async (_kind, source) => {
        seedReferences();
        let now = 1_000 * H;
        await collectGarbage({ now: () => now });
        now += STORAGE_GC_GRACE_MS * 2;
        fake.failIterate.add(source);
        const result = await collectGarbage({ now: () => now });
        expect(result).toMatchObject({ status: "aborted", deleted: [] });
        expect(has("image_files", "image:orphan")).toBe(true);
        expect(has("media_files", "video:orphan")).toBe(true);
    });

    it("aborts on a damaged saved store (corrupt JSON) without deleting", async () => {
        seedReferences();
        set("app_state", GC_CANDIDATES_KEY, { "image:orphan": 0 });
        set("app_state", "infinite-canvas:commerce_store", "{broken");
        expect(await collectGarbage({ now: () => 1_000 * H })).toMatchObject({ status: "aborted", deleted: [] });
        expect(has("image_files", "image:orphan")).toBe(true);
    });

    it("keeps freshly written files that carry a protection marker", async () => {
        seedReferences();
        const now = 1_000 * H;
        set("app_state", GC_CANDIDATES_KEY, { "image:orphan": 0, "video:orphan": 0 });
        set("app_state", PROTECT_PREFIX + "image:orphan", now - H);
        set("app_state", PROTECT_PREFIX + "image:stale-marker", now - 48 * H);
        const result = await collectGarbage({ now: () => now });
        expect(result.deleted).toEqual(["video:orphan"]);
        expect(has("image_files", "image:orphan")).toBe(true);
        expect(has("app_state", PROTECT_PREFIX + "image:stale-marker")).toBe(false);
    });

    it("reports files already removed when a later deletion fails", async () => {
        seedReferences();
        set("image_files", "image:orphan-2", "blob");
        set("app_state", GC_CANDIDATES_KEY, { "image:orphan": 0, "image:orphan-2": 0, "video:orphan": 0 });
        fake.failRemove.add("image:orphan-2");
        const result = await collectGarbage({ now: () => 1_000 * H });
        expect(result.status).toBe("aborted");
        expect(result.deleted).toEqual(["image:orphan"]);
        expect(fake.stores.get("app_state")!.get(GC_CANDIDATES_KEY)).toHaveProperty("image:orphan-2");
    });

    it("live cleanup requests never delete, they only schedule the next startup maintenance", async () => {
        seedReferences();
        set("app_state", GC_CANDIDATES_KEY, { "image:orphan": 0 });
        expect(await requestStorageMaintenance({ assets: [] })).toMatchObject({ status: "skipped", deleted: [] });
        expect(has("image_files", "image:orphan")).toBe(true);
    });
});

describe("startStorageSession (cross-tab exclusion)", () => {
    it("skips cleanup while another tab holds presence, then joins presence", async () => {
        const locks = lockManager();
        let releaseOther!: () => void;
        void locks.request(PRESENCE_LOCK, { mode: "shared" }, () => new Promise<void>((r) => (releaseOther = r)));
        const gc = vi.fn(async () => ({ status: "deleted" as const, deleted: ["x"], candidates: 0 }));
        const result = await startStorageSession({ locks, gc, state: fakeState() });
        expect(gc).not.toHaveBeenCalled();
        expect(result.maintenance).toMatchObject({ status: "skipped", reason: "another tab is open" });
        expect(locks.held.filter((l) => l.name === PRESENCE_LOCK)).toHaveLength(2);
        releaseOther();
    });

    it("a tab opened during cleanup (after scanning, before deleting) waits and never runs cleanup itself", async () => {
        const locks = lockManager();
        const events: string[] = [];
        let secondTab: Promise<unknown> | undefined;
        const gc = vi.fn(async () => {
            events.push("scan");
            // New tab starts between scan and delete: it must not be admitted until cleanup ends.
            resetStorageCoordinationForTests();
            secondTab = startStorageSession({ locks, gc: secondGc, state: fakeState() }).then((r) => {
                events.push("second tab admitted");
                return r;
            });
            await new Promise((r) => setTimeout(r, 10));
            events.push("delete");
            return { status: "deleted" as const, deleted: ["image:orphan"], candidates: 0 };
        });
        const secondGc = vi.fn();
        const first = await startStorageSession({ locks, gc, state: fakeState() });
        const second = (await secondTab) as Awaited<ReturnType<typeof startStorageSession>>;
        expect(first.maintenance.status).toBe("deleted");
        expect(second.maintenance).toMatchObject({ status: "skipped", reason: "another tab is open" });
        expect(secondGc).not.toHaveBeenCalled();
        expect(events).toEqual(["scan", "delete", "second tab admitted"]);
    });

    it("a restore page cannot act until maintenance in another tab has released the lock", async () => {
        const locks = lockManager();
        const events: string[] = [];
        let finishGc!: () => void;
        const gcDone = new Promise<void>((r) => (finishGc = r));
        const app = startStorageSession({
            locks,
            state: fakeState(),
            gc: async () => {
                events.push("gc started");
                await gcDone;
                events.push("gc finished");
                return { status: "skipped" as const, deleted: [], candidates: 0 };
            },
        });
        await vi.waitFor(() => expect(events).toEqual(["gc started"]));
        resetStorageCoordinationForTests();
        // What workspace-transfer-page.ts does before any restore action.
        const restoreAction = holdTabPresence(locks).then(() => events.push("restore may write"));
        await new Promise((r) => setTimeout(r, 20));
        expect(events).toEqual(["gc started"]);
        finishGc();
        await Promise.all([app, restoreAction]);
        expect(events).toEqual(["gc started", "gc finished", "restore may write"]);
    });

    it("a failing presence request is reported, never treated as joined", async () => {
        const failing: LockManagerLike = {
            request: async (_name, options, callback) => {
                if (options.mode === "exclusive") return callback(null);
                throw new Error("lock request rejected");
            },
        };
        await expect(holdTabPresence(failing)).rejects.toThrow("lock request rejected");
        resetStorageCoordinationForTests();
        await expect(startStorageSession({ locks: failing, state: fakeState(), gc: vi.fn() })).rejects.toThrow("lock request rejected");
    });

    it("never deletes without Web Locks", async () => {
        const gc = vi.fn();
        expect((await startStorageSession({ locks: null, gc, state: fakeState() })).maintenance.status).toBe("skipped");
        expect(gc).not.toHaveBeenCalled();
    });

    it("runs at most every interval unless a deletion requested it", async () => {
        const locks = lockManager();
        const state = fakeState();
        let now = 100 * H;
        const gc = vi.fn(async () => ({ status: "skipped" as const, deleted: [], candidates: 0 }));
        await startStorageSession({ locks, gc, state, now: () => now });
        expect(gc).toHaveBeenCalledTimes(1);
        expect(await state.getItem(GC_LAST_RUN_KEY)).toBe(now);
        now += H;
        resetStorageCoordinationForTests();
        await startStorageSession({ locks: lockManager(), gc, state, now: () => now });
        expect(gc).toHaveBeenCalledTimes(1);
        await state.setItem("infinite-canvas:storage-gc-requested:v1", now);
        now += 1;
        resetStorageCoordinationForTests();
        await startStorageSession({ locks: lockManager(), gc, state, now: () => now });
        expect(gc).toHaveBeenCalledTimes(2);
    });
});

function fakeState() {
    const data = new Map<string, unknown>();
    return {
        getItem: async <T,>(key: string) => (data.has(key) ? (data.get(key) as T) : null),
        setItem: async <T,>(key: string, value: T) => {
            data.set(key, value);
            return value;
        },
    };
}
