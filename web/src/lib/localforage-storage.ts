import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

/**
 * Read for stores that must never mistake a failed read for "no data" (canvas, assets, image cleanup).
 * An IndexedDB read error is thrown: the localStorage copy written by an earlier failed setItem may be older
 * than the IndexedDB value, so it is never used to cover a failure. Only when IndexedDB answered that the key
 * does not exist is that fallback copy (the only copy left) returned.
 */
export async function getItemStrict(name: string): Promise<string | null> {
    if (typeof window === "undefined") throw new Error("浏览器存储不可用");
    const value = await localforage.getItem<string>(name);
    if (value !== null && value !== undefined) {
        if (typeof value !== "string") throw new Error("本地数据格式无效");
        return value;
    }
    return window.localStorage.getItem(name);
}

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            return (await localforage.getItem<string>(name)) || null;
        } catch {
            return window.localStorage.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
        } catch {
            window.localStorage.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            window.localStorage.removeItem(name);
        }
    },
};
