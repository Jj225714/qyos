import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ idb: new Map<string, unknown>(), fail: false, local: new Map<string, string>() }));
vi.mock("localforage", () => ({
    default: {
        config: () => undefined,
        getItem: async (key: string) => {
            if (fake.fail) throw new Error("IndexedDB read failed");
            return fake.idb.has(key) ? fake.idb.get(key) : null;
        },
        setItem: async () => undefined,
        removeItem: async () => undefined,
    },
}));
import { getItemStrict, localForageStorage } from "./localforage-storage";

beforeEach(() => {
    fake.idb.clear();
    fake.local.clear();
    fake.fail = false;
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => fake.local.get(key) ?? null } });
});

describe("getItemStrict", () => {
    it("fails closed on an IndexedDB read error even when an (older) localStorage fallback exists", async () => {
        fake.local.set("k", JSON.stringify({ state: { projects: ["stale"] } }));
        fake.fail = true;
        await expect(getItemStrict("k")).rejects.toThrow("IndexedDB read failed");
        // The permissive reader used by other stores would have returned the stale copy.
        await expect(localForageStorage.getItem("k")).resolves.toContain("stale");
    });

    it("prefers the newer IndexedDB value over a stale fallback", async () => {
        fake.idb.set("k", JSON.stringify({ state: { projects: ["new"] } }));
        fake.local.set("k", JSON.stringify({ state: { projects: ["stale"] } }));
        await expect(getItemStrict("k")).resolves.toContain("new");
    });

    it("uses the fallback copy only when IndexedDB reports the key absent", async () => {
        fake.local.set("k", "only-copy");
        await expect(getItemStrict("k")).resolves.toBe("only-copy");
        await expect(getItemStrict("missing")).resolves.toBeNull();
    });

    it("rejects a non-string IndexedDB value", async () => {
        fake.idb.set("k", { not: "a string" });
        await expect(getItemStrict("k")).rejects.toThrow();
    });
});
