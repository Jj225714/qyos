import { diagnose } from "./diagnostics";
import localforage from "localforage";
import { nanoid } from "nanoid";

import { withLocalProxy } from "@/stores/use-config-store";
import { protectStorageKey } from "./storage-coordination";
import { requestStorageMaintenance } from "./storage-gc";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();

async function uploadMediaFileImpl(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(withLocalProxy(input))).blob() : input;
    const storageKey = `${prefix}:${nanoid()}`;
    await writeProtectedBlob(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

async function resolveMediaUrlImpl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

async function getMediaBlobImpl(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

/** A fresh blob gets a protection marker first, so startup cleanup keeps it even before anything references it. */
async function writeProtectedBlob(storageKey: string, blob: Blob) {
    await protectStorageKey(storageKey);
    await store.setItem(storageKey, blob);
}

async function setMediaBlobImpl(storageKey: string, blob: Blob) {
    await writeProtectedBlob(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

async function deleteStoredMediaImpl(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

/** Same pass as image cleanup (storage-gc.ts): media referenced anywhere, including logs and drafts, is kept. */
async function cleanupUnusedMediaImpl(usedData: unknown) {
    return requestStorageMaintenance(usedData);
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}


export async function uploadMediaFile(...args: Parameters<typeof uploadMediaFileImpl>): Promise<Awaited<ReturnType<typeof uploadMediaFileImpl>>> { return diagnose("uploadMediaFile", () => uploadMediaFileImpl(...args)); }

export async function resolveMediaUrl(...args: Parameters<typeof resolveMediaUrlImpl>): Promise<Awaited<ReturnType<typeof resolveMediaUrlImpl>>> { return diagnose("resolveMediaUrl", () => resolveMediaUrlImpl(...args)); }

export async function getMediaBlob(...args: Parameters<typeof getMediaBlobImpl>): Promise<Awaited<ReturnType<typeof getMediaBlobImpl>>> { return diagnose("getMediaBlob", () => getMediaBlobImpl(...args)); }

export async function setMediaBlob(...args: Parameters<typeof setMediaBlobImpl>): Promise<Awaited<ReturnType<typeof setMediaBlobImpl>>> { return diagnose("setMediaBlob", () => setMediaBlobImpl(...args)); }

export async function deleteStoredMedia(...args: Parameters<typeof deleteStoredMediaImpl>): Promise<Awaited<ReturnType<typeof deleteStoredMediaImpl>>> { return diagnose("deleteStoredMedia", () => deleteStoredMediaImpl(...args)); }

export async function cleanupUnusedMedia(...args: Parameters<typeof cleanupUnusedMediaImpl>): Promise<Awaited<ReturnType<typeof cleanupUnusedMediaImpl>>> { return diagnose("cleanupUnusedMedia", () => cleanupUnusedMediaImpl(...args)); }
