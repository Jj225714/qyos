import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getItemStrict: vi.fn<(key: string) => Promise<string | null>>(async () => null),
    setItem: vi.fn(async (_key: string, _value: string) => undefined),
    resolveImageUrl: vi.fn(async (key: string, _fallback?: string) => `blob:resolved-${key}`),
    uploadImage: vi.fn(),
    resolveMediaUrl: vi.fn(async (key: string) => `blob:media-${key}`),
    cleanupUnusedImages: vi.fn(async () => undefined),
}));
vi.mock("@/lib/localforage-storage", () => ({ getItemStrict: mocks.getItemStrict, localForageStorage: { getItem: vi.fn(), setItem: mocks.setItem, removeItem: vi.fn() } }));
vi.mock("@/services/image-storage", () => ({ cleanupUnusedImages: mocks.cleanupUnusedImages, ensureImagePreview: vi.fn(async () => undefined), previewUrlFor: () => undefined, resolveImageUrl: mocks.resolveImageUrl, uploadImage: mocks.uploadImage }));
vi.mock("@/services/file-storage", () => ({ resolveMediaUrl: mocks.resolveMediaUrl }));
vi.mock("@/stores/canvas/use-canvas-store", () => ({ useCanvasStore: { getState: () => ({ hydrationStatus: canvasStatus.value, projects: [] }) } }));
const canvasStatus = vi.hoisted(() => ({ value: "ready" }));

import { useAssetStore, type Asset } from "./use-asset-store";
import { StoreNotReadyError } from "@/lib/store-hydration";

const image = (id: string, extra: Partial<Asset["data"]> = {}) => ({ id, kind: "image", title: id, coverUrl: "blob:old", tags: [], createdAt: "", updatedAt: "", data: { dataUrl: "blob:old", storageKey: `image:${id}`, width: 1, height: 1, bytes: 1, mimeType: "image/png", ...extra } });

beforeEach(() => {
    vi.stubGlobal("window", { setTimeout: (fn: () => void) => setTimeout(fn, 0) });
    mocks.getItemStrict.mockReset();
    mocks.setItem.mockReset().mockResolvedValue(undefined);
    mocks.resolveImageUrl.mockReset().mockImplementation(async (key: string) => `blob:resolved-${key}`);
    mocks.uploadImage.mockReset();
    mocks.cleanupUnusedImages.mockClear();
    canvasStatus.value = "ready";
});
afterEach(() => vi.unstubAllGlobals());

describe("asset store hydration", () => {
    it("read failure: error status, no writes, mutations refused", async () => {
        mocks.getItemStrict.mockRejectedValueOnce(new Error("IndexedDB read failed"));
        await useAssetStore.persist.rehydrate();
        expect(useAssetStore.getState()).toMatchObject({ hydrated: false, hydrationStatus: "error" });
        expect(() => useAssetStore.getState().addAsset({ kind: "text", title: "x", coverUrl: "", tags: [], data: { content: "x" } })).toThrow(StoreNotReadyError);
        useAssetStore.setState({ assets: [] });
        await new Promise((r) => setTimeout(r, 10));
        expect(mocks.setItem).not.toHaveBeenCalled();
    });

    it("one unreadable asset does not fail the library and is saved back unchanged", async () => {
        const bad = image("bad");
        mocks.resolveImageUrl.mockImplementation(async (key: string) => {
            if (key === "image:bad") throw new Error("decode failed");
            return `blob:resolved-${key}`;
        });
        mocks.getItemStrict.mockResolvedValueOnce(JSON.stringify({ version: 0, state: { assets: [image("good-1"), bad, image("good-2")] } }));
        await useAssetStore.persist.rehydrate();
        const state = useAssetStore.getState();
        expect(state.hydrationStatus).toBe("ready");
        expect(state.unresolvedAssetIds).toEqual(["bad"]);
        expect(state.assets.find((a) => a.id === "good-1")!.kind === "image" && (state.assets.find((a) => a.id === "good-1") as { data: { dataUrl: string } }).data.dataUrl).toBe("blob:resolved-image:good-1");
        expect(state.assets.find((a) => a.id === "bad")).toEqual(bad);
        state.updateAsset("good-1", { title: "renamed" });
        await vi.waitFor(() => expect(mocks.setItem).toHaveBeenCalled());
        const written = JSON.parse(mocks.setItem.mock.calls.at(-1)![1] as string);
        expect(written.state.assets.find((a: { id: string }) => a.id === "bad")).toEqual(bad);
    });

    it("a legacy inline image whose migration fails is kept with its data URL", async () => {
        const legacy = { ...image("legacy"), coverUrl: "data:image/png;base64,AAA", data: { dataUrl: "data:image/png;base64,AAA", width: 1, height: 1, bytes: 1, mimeType: "image/png" } };
        mocks.uploadImage.mockRejectedValueOnce(new Error("quota"));
        mocks.getItemStrict.mockResolvedValueOnce(JSON.stringify({ version: 0, state: { assets: [legacy] } }));
        await useAssetStore.persist.rehydrate();
        expect(useAssetStore.getState().hydrationStatus).toBe("ready");
        expect(useAssetStore.getState().assets[0]).toEqual(legacy);
        expect(useAssetStore.getState().unresolvedAssetIds).toEqual(["legacy"]);
    });

    it("cleanup never runs while canvas or assets are not ready", async () => {
        mocks.getItemStrict.mockResolvedValueOnce(JSON.stringify({ version: 0, state: { assets: [] } }));
        await useAssetStore.persist.rehydrate();
        canvasStatus.value = "error";
        useAssetStore.getState().cleanupImages();
        await new Promise((r) => setTimeout(r, 10));
        expect(mocks.cleanupUnusedImages).not.toHaveBeenCalled();
        canvasStatus.value = "ready";
        useAssetStore.getState().cleanupImages();
        await vi.waitFor(() => expect(mocks.cleanupUnusedImages).toHaveBeenCalledTimes(1));
    });
});
