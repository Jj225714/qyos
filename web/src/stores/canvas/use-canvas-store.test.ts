import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
    getItemStrict: vi.fn<(key: string) => Promise<string | null>>(async () => null),
    setItem: vi.fn(async (_key: string, _value: string) => undefined),
}));
vi.mock("@/lib/localforage-storage", () => ({ getItemStrict: storage.getItemStrict, localForageStorage: { getItem: vi.fn(), setItem: storage.setItem, removeItem: vi.fn() } }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

import { useCanvasStore } from "./use-canvas-store";
import { StoreNotReadyError } from "@/lib/store-hydration";

const saved = (projects: Array<{ id: string; title: string }>) => JSON.stringify({ version: 0, state: { projects: projects.map((p) => ({ ...p, createdAt: "", updatedAt: "", nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } })), deletedProjects: [] } });

beforeEach(() => {
    vi.useFakeTimers();
    storage.getItemStrict.mockReset();
    storage.setItem.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

async function rehydrateWith(read: () => Promise<string | null>) {
    storage.getItemStrict.mockImplementationOnce(read);
    await useCanvasStore.persist.rehydrate();
}

describe("canvas store hydration", () => {
    it.each([
        ["read rejection", () => Promise.reject(new Error("IndexedDB read failed"))],
        ["corrupt JSON", async () => "{broken"],
        ["invalid shape", async () => JSON.stringify({ state: { projects: {} } })],
    ])("after %s: error status, nothing written even after delayed timers, mutations refused", async (_name, read) => {
        await rehydrateWith(read as () => Promise<string | null>);
        const state = useCanvasStore.getState();
        expect(state).toMatchObject({ hydrated: false, hydrationStatus: "error" });
        expect(state.hydrationError).toContain("原有数据未被修改");
        expect(() => state.createProject("x")).toThrow(StoreNotReadyError);
        expect(() => state.replaceProjects([])).toThrow(StoreNotReadyError);
        state.updateProject("a", { nodes: [] });
        state.deleteProjects(["a"]);
        useCanvasStore.setState({ projects: [] }); // even a raw persisting setState must not reach storage
        await vi.advanceTimersByTimeAsync(5000);
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it("slow first read: nothing is written while loading, saved data is not overwritten", async () => {
        let resolve!: (value: string) => void;
        storage.getItemStrict.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
        const pending = useCanvasStore.persist.rehydrate();
        expect(useCanvasStore.getState().hydrationStatus).toBe("loading");
        expect(() => useCanvasStore.getState().createProject("early")).toThrow(StoreNotReadyError);
        useCanvasStore.setState({ projects: [] });
        await vi.advanceTimersByTimeAsync(5000);
        expect(storage.setItem).not.toHaveBeenCalled();
        resolve(saved([{ id: "a", title: "A" }, { id: "b", title: "B" }]));
        await pending;
        expect(useCanvasStore.getState()).toMatchObject({ hydrated: true, hydrationStatus: "ready" });
        expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual(["a", "b"]);
        await vi.advanceTimersByTimeAsync(1000);
        expect(storage.setItem).not.toHaveBeenCalled();
        useCanvasStore.getState().createProject("C");
        await vi.advanceTimersByTimeAsync(399);
        expect(storage.setItem).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(storage.setItem).toHaveBeenCalledTimes(1);
        const written = JSON.parse(storage.setItem.mock.calls[0][1] as string);
        expect(written.state.projects.map((p: { id: string }) => p.id).slice(1)).toEqual(["a", "b"]);
    });

    it("retry after an error restores the saved projects; retry while ready does nothing", async () => {
        await rehydrateWith(() => Promise.reject(new Error("transient")));
        expect(useCanvasStore.getState().hydrationStatus).toBe("error");
        storage.getItemStrict.mockResolvedValueOnce(saved([{ id: "kept", title: "Kept" }]));
        await useCanvasStore.getState().retryHydration();
        expect(useCanvasStore.getState()).toMatchObject({ hydrated: true, hydrationStatus: "ready" });
        expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual(["kept"]);
        storage.getItemStrict.mockClear();
        await useCanvasStore.getState().retryHydration();
        expect(storage.getItemStrict).not.toHaveBeenCalled();
    });

    it("a pending debounced write from before a failed re-read is dropped", async () => {
        storage.getItemStrict.mockResolvedValueOnce(saved([{ id: "a", title: "A" }]));
        await useCanvasStore.persist.rehydrate();
        useCanvasStore.getState().renameProject("a", "Renamed");
        await rehydrateWith(() => Promise.reject(new Error("broken")));
        await vi.advanceTimersByTimeAsync(5000);
        expect(storage.setItem).not.toHaveBeenCalled();
    });
});
