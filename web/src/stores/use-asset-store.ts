import type { AssetGenerationInfo } from "@/pages/assets/generation-info";
import { create, type StateCreator } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { getItemStrict, localForageStorage } from "@/lib/localforage-storage";
import { createPersistGate, hydrationErrorMessage, StoreNotReadyError, type HydrationStatus } from "@/lib/store-hydration";
import { cleanupUnusedImages, ensureImagePreview, previewUrlFor, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    generation?: AssetGenerationInfo;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    /** True only after the saved assets were read successfully (same meaning as hydrationStatus === "ready"). */
    hydrated: boolean;
    hydrationStatus: HydrationStatus;
    hydrationError?: string;
    /** Assets whose stored file could not be resolved on load; their saved records are kept unchanged. */
    unresolvedAssetIds: string[];
    retryHydration: () => Promise<void>;
    assets: Asset[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

// 卡片用缩略图渲染，自定义封面（远程地址或单独上传的封面）保持原样。
export function assetCoverUrl(asset: Asset) {
    const own = asset.kind === "image" ? asset.data.dataUrl : "";
    const cover = asset.coverUrl || own;
    return asset.kind === "image" && cover === own ? previewUrlFor(asset.data.storageKey) || cover : cover;
}

const ASSET_STORE_KEY = "infinite-canvas:asset_store";

/** Stable namespace for this browser library; account identity belongs to the server mapping. */
export async function getLocalAssetLibraryId(): Promise<string> {
    const key = "infinite-canvas:asset-library-id:v1";
    const getOrCreate = () => {
        const existing = localStorage.getItem(key);
        if (existing) return existing;
        const id = crypto.randomUUID();
        localStorage.setItem(key, id);
        if (localStorage.getItem(key) !== id) throw new Error("本地资产库标识未持久保存，迁移未开始");
        return id;
    };
    return navigator.locks ? navigator.locks.request(key, getOrCreate) : getOrCreate();
}

const NOT_READY = "我的资产尚未读取完成，请稍后重试；读取失败时请先点击“重试读取”";
const gate = createPersistGate();
let unresolvedOnLoad: string[] = [];

/** Resolves one saved asset; on any failure the saved record is returned unchanged (nothing is lost on save). */
async function resolveAsset(asset: Asset, unresolved: string[]): Promise<Asset> {
    try {
        if (asset.kind === "video" && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
        if (asset.kind !== "image") return asset;
        if (asset.data.storageKey) {
            void Promise.resolve(ensureImagePreview(asset.data.storageKey)).catch(() => undefined);
            return {
                ...asset,
                coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(asset.data.storageKey, asset.coverUrl) : asset.coverUrl,
                data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
            };
        }
        if (typeof asset.data.dataUrl !== "string" || !asset.data.dataUrl.startsWith("data:image/")) return asset;
        const image = await uploadImage(asset.data.dataUrl);
        return { ...asset, coverUrl: asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
    } catch (error) {
        console.warn(`[assets] 素材 ${String(asset?.id)} 暂时无法读取，已保留原记录`, error);
        unresolved.push(String(asset?.id));
        return asset;
    }
}

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const value = await getItemStrict(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        if (!parsed || typeof parsed !== "object" || !parsed.state || !Array.isArray(parsed.state.assets)) throw new Error("我的资产数据格式无效");
        const unresolved: string[] = [];
        parsed.state.assets = await Promise.all(parsed.state.assets.map((asset) => resolveAsset(asset, unresolved)));
        unresolvedOnLoad = unresolved;
        return parsed;
    },
    setItem: async (name, value) => {
        // Nothing is written until the saved assets were read successfully.
        if (!gate.isOpen()) return;
        await localForageStorage.setItem(name, JSON.stringify(value));
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

function requireReady() {
    if (useAssetStore.getState().hydrationStatus !== "ready") throw new StoreNotReadyError(NOT_READY);
}

export const useAssetStore = create<AssetStore>()(((rawSet, get, api) =>
    persist<AssetStore>(
        (set) => ({
            hydrated: false,
            hydrationStatus: "loading",
            hydrationError: undefined,
            unresolvedAssetIds: [],
            retryHydration: async () => {
                if (get().hydrationStatus !== "error") return;
                await useAssetStore.persist.rehydrate();
            },
            assets: [],
            addAsset: (asset) => {
                requireReady();
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                return id;
            },
            updateAsset: (id, patch) => {
                requireReady();
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                }));
            },
            removeAsset: (id) => {
                requireReady();
                set((state) => ({ assets: state.assets.filter((asset) => asset.id !== id) }));
                get().cleanupImages();
            },
            replaceAssets: (assets) => {
                requireReady();
                set({ assets });
            },
            cleanupImages: (extra) => {
                window.setTimeout(async () => {
                    const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
                    // Cleanup needs complete knowledge of what is still used: never run on unread stores.
                    if (get().hydrationStatus !== "ready" || useCanvasStore.getState().hydrationStatus !== "ready") {
                        console.warn("[storage-gc] 画布或素材尚未读取完成，已跳过图片清理");
                        return;
                    }
                    await cleanupUnusedImages({ assets: get().assets, projects: useCanvasStore.getState().projects, extra }).catch((error) => console.warn("[storage-gc] 图片清理已中止", error));
                }, 0);
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets }) as StorageValue<AssetStore>["state"],
            // Status changes use the raw setter, so they never trigger a write.
            onRehydrateStorage: () => {
                gate.close();
                unresolvedOnLoad = [];
                rawSet({ hydrated: false, hydrationStatus: "loading", hydrationError: undefined });
                return (state, error) => {
                    if (error !== undefined || !state) {
                        rawSet({ hydrated: false, hydrationStatus: "error", hydrationError: hydrationErrorMessage(error, "我的资产") });
                        return;
                    }
                    gate.open();
                    rawSet({ hydrated: true, hydrationStatus: "ready", hydrationError: undefined, unresolvedAssetIds: unresolvedOnLoad });
                };
            },
        },
    )(rawSet, get, api)) as StateCreator<AssetStore, [], [["zustand/persist", AssetStore]]>,
);
