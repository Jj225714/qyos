import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_STATE_REFERENCE_KEYS, collectStorageKeys, NON_REFERENCE_STORES, REFERENCE_STORES } from "./image-reference-sources";

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sources(path);
        return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
}

describe("file reference source registry", () => {
    it("classifies every persisted store and persisted state key of the app database", () => {
        const classified = new Set<string>([...APP_STATE_REFERENCE_KEYS, ...REFERENCE_STORES, ...Object.keys(NON_REFERENCE_STORES)]);
        const found = new Set<string>();
        for (const file of sources(join(__dirname, ".."))) {
            const text = readFileSync(file, "utf8");
            for (const match of text.matchAll(/createInstance\(\{\s*name:\s*"infinite-canvas",\s*storeName:\s*"([^"]+)"/g)) found.add(match[1]);
            for (const match of text.matchAll(/(?:\bname:|STORE_KEY\s*=)\s*"(infinite-canvas:[a-z_-]+)"/g)) found.add(match[1]);
        }
        expect(found.size).toBeGreaterThan(8);
        const unclassified = [...found].filter((name) => !classified.has(name));
        expect(unclassified, "add new stores to image-reference-sources.ts (reference or non-reference)").toEqual([]);
    });

    it("collects storage keys at any depth, including media keys", () => {
        expect([...collectStorageKeys({ a: [{ b: { storageKey: "image:1" } }, { storageKey: "video:2" }], c: { storageKey: "not-a-key" } })].sort()).toEqual(["image:1", "video:2"]);
    });
});
