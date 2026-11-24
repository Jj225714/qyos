import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createBuiltInPolicyPack, createDefaultBrand, defaultModelRoles } from "@/lib/commerce/defaults";
import { DEFAULT_PROMPT_SOURCES } from "./api/prompt-source-presets";

const DB = "infinite-canvas";
const caches = new Set(["image_previews", "prompt_cache"]);
const limit = 512 * 1024 ** 2;
export type RawStore = { name: string; keyPath: string | string[] | null; autoIncrement: boolean; records: { key: IDBValidKey; value: unknown }[] };
export type Snapshot = { stores: RawStore[]; local: [string, string][] };
export type MigrationPayload = { server: string; name: string; token: string };
type Node = { t: string; v?: unknown; [key: string]: unknown };
function check(ok: unknown, message = "归档格式无效或不受支持"): asserts ok {
    if (!ok) throw new Error(message);
}
export function isWorkspaceKey(key: string) {
    // The local proxy token is a per-run secret of this computer: never archived.
    return /^(infinite-canvas(?::|-)|canvas-)/.test(key) && !/workspace[-_:]?(transfer|migration)|migration[-_:]?credential|proxy[-_:]?(session[-_:]?)?token/i.test(key);
}
export async function hash(bytes: Uint8Array) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)))
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("");
}
const views = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };

export async function encodeArchive(snapshot: Snapshot): Promise<Uint8Array> {
    const files: Record<string, Uint8Array> = Object.create(null);
    const ancestors = new Set<object>();
    let binaryId = 0;
    async function encode(value: unknown): Promise<Node> {
        if (value === null || typeof value === "string" || typeof value === "boolean") return { t: "scalar", v: value };
        if (typeof value === "number") return { t: "number", v: Object.is(value, -0) ? "-0" : String(value) };
        if (typeof value === "undefined") return { t: "undefined" };
        if (typeof value === "bigint") return { t: "bigint", v: String(value) };
        check(typeof value === "object", "归档包含不支持的数据类型");
        check(!ancestors.has(value), "归档包含循环引用，未导出任何部分数据");
        if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            const bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            const path = `binary/${binaryId++}`;
            files[path] = bytes.slice();
            const file = typeof File !== "undefined" && value instanceof File;
            return {
                t: "binary",
                path,
                hash: await hash(bytes),
                size: bytes.length,
                kind: file ? "File" : value instanceof Blob ? "Blob" : value instanceof ArrayBuffer ? "ArrayBuffer" : value.constructor.name,
                mime: value instanceof Blob ? value.type : "",
                ...(file ? { name: value.name, modified: value.lastModified } : {}),
            };
        }
        if (value instanceof Date) {
            check(Number.isFinite(value.getTime()));
            return { t: "date", v: value.toISOString() };
        }
        check(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "归档包含不支持的对象");
        check(
            Reflect.ownKeys(value).every((key) => typeof key === "string"),
            "归档包含 Symbol 属性",
        );
        ancestors.add(value);
        let result: Node;
        if (Array.isArray(value)) {
            check(Object.keys(value).length === value.length && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean) && Object.getOwnPropertyNames(value).length === value.length + 1, "不支持稀疏数组或附加数组属性");
            const items = [];
            for (const item of value) items.push(await encode(item));
            result = { t: "array", v: items };
        } else {
            const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
            check(
                entries.every(([, d]) => d.enumerable && "value" in d),
                "不支持访问器或隐藏属性",
            );
            const items = [];
            for (const [key, d] of entries) items.push([key, await encode(d.value)]);
            result = { t: "object", v: items };
        }
        ancestors.delete(value);
        return result;
    }
    // Sequential traversal also permits repeated (non-cyclic) references.
    const stores = [];
    for (const store of snapshot.stores) {
        const records = [];
        for (const record of store.records) records.push({ key: await encode(record.key), value: await encode(record.value) });
        stores.push({ ...store, records });
    }
    files["manifest.json"] = strToU8(JSON.stringify({ format: "infinite-canvas-workspace", version: 1, stores, local: snapshot.local }));
    const archive = zipSync(files, { level: 0, mtime: new Date(1980, 0, 1) });
    check(archive.length <= limit, "归档超过服务器 512MB 限制");
    return archive;
}

export async function decodeArchive(bytes: Uint8Array): Promise<Snapshot> {
    check(bytes.length <= limit, "归档过大");
    let total = 0;
    const names = new Set<string>();
    const files = unzipSync(bytes, {
        filter: (entry) => {
            check(!names.has(entry.name) && /^(manifest\.json|binary\/\d+)$/.test(entry.name));
            names.add(entry.name);
            total += entry.originalSize;
            check(total <= limit && names.size <= 100000, "归档解压大小超限");
            return true;
        },
    });
    check(files["manifest.json"] && files["manifest.json"].length < 128 * 1024 ** 2);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    check(manifest.format === "infinite-canvas-workspace" && manifest.version === 1 && Array.isArray(manifest.stores) && Array.isArray(manifest.local));
    const used = new Set(["manifest.json"]);
    async function decode(node: Node, depth = 0): Promise<unknown> {
        check(node && typeof node === "object" && depth < 150);
        const v = node.v;
        switch (node.t) {
            case "scalar":
                check(v === null || typeof v === "string" || typeof v === "boolean");
                return v;
            case "undefined":
                return undefined;
            case "number":
                check(typeof v === "string" && /^(NaN|-?Infinity|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i.test(v));
                return Number(v);
            case "bigint":
                check(typeof v === "string" && /^-?\d+$/.test(v));
                return BigInt(v);
            case "date":
                check(typeof v === "string" && Number.isFinite(Date.parse(v)));
                return new Date(v);
            case "array":
                check(Array.isArray(v));
                return Promise.all(v.map((item) => decode(item, depth + 1)));
            case "object": {
                check(Array.isArray(v));
                const result: Record<string, unknown> = {};
                for (const pair of v) {
                    check(Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && !Object.hasOwn(result, pair[0]));
                    Object.defineProperty(result, pair[0], { value: await decode(pair[1], depth + 1), enumerable: true, writable: true, configurable: true });
                }
                return result;
            }
            case "binary": {
                check(typeof node.path === "string" && /^binary\/\d+$/.test(node.path));
                const data = files[node.path];
                check(data && data.length === node.size && (await hash(data)) === node.hash, "二进制附件缺失或校验失败");
                used.add(node.path);
                const buffer = data.slice().buffer;
                check(typeof node.mime === "string");
                if (node.kind === "Blob") return new Blob([buffer], { type: node.mime });
                if (node.kind === "File") {
                    check(typeof node.name === "string" && Number.isFinite(node.modified));
                    return new File([buffer], node.name, { type: node.mime, lastModified: node.modified as number });
                }
                if (node.kind === "ArrayBuffer") return buffer;
                check(typeof node.kind === "string" && Object.hasOwn(views, node.kind));
                const View = views[node.kind as keyof typeof views] as new (buffer: ArrayBuffer) => ArrayBufferView;
                return new View(buffer);
            }
            default:
                throw new Error("未知归档数据类型");
        }
    }
    const stores: RawStore[] = [];
    const storeNames = new Set<string>();
    for (const store of manifest.stores) {
        check(store && typeof store.name === "string" && /^[\w-]+$/.test(store.name) && !storeNames.has(store.name) && !caches.has(store.name));
        check(store.keyPath === null || typeof store.keyPath === "string" || (Array.isArray(store.keyPath) && store.keyPath.every((k: unknown) => typeof k === "string")));
        check(typeof store.autoIncrement === "boolean" && Array.isArray(store.records));
        storeNames.add(store.name);
        const records = [];
        for (const record of store.records) records.push({ key: (await decode(record.key)) as IDBValidKey, value: await decode(record.value) });
        stores.push({ name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, records });
    }
    const localNames = new Set();
    for (const pair of manifest.local) {
        check(Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && isWorkspaceKey(pair[0]) && typeof pair[1] === "string" && !localNames.has(pair[0]));
        localNames.add(pair[0]);
    }
    check(used.size === names.size, "归档包含未声明的附件");
    return { stores, local: manifest.local };
}

function openDatabase(version?: number, stores: RawStore[] = []): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB, version);
        request.onupgradeneeded = () => {
            for (const store of stores) if (!request.result.objectStoreNames.contains(store.name)) request.result.createObjectStore(store.name, { keyPath: store.keyPath, autoIncrement: store.autoIncrement });
        };
        request.onerror = () => reject(request.error);
        let blocked = false;
        request.onblocked = () => {
            blocked = true;
            reject(new Error("请关闭此站点的其他标签页后重试"));
        };
        request.onsuccess = () => {
            if (blocked) request.result.close();
            else resolve(request.result);
        };
    });
}
function readStores(transaction: IDBTransaction): Promise<RawStore[]> {
    return Promise.all(
        Array.from(transaction.objectStoreNames)
            .filter((name) => !caches.has(name))
            .map(
                (name) =>
                    new Promise<RawStore>((resolve, reject) => {
                        const store = transaction.objectStore(name);
                        const records: RawStore["records"] = [];
                        const request = store.openCursor();
                        request.onerror = () => reject(request.error);
                        request.onsuccess = () => {
                            const cursor = request.result;
                            if (cursor) {
                                records.push({ key: cursor.key, value: cursor.value });
                                cursor.continue();
                            } else resolve({ name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, records });
                        };
                    }),
            ),
    );
}
function localSnapshot(): [string, string][] {
    return Object.keys(localStorage)
        .filter(isWorkspaceKey)
        .map((key) => [key, localStorage.getItem(key)!]);
}
export async function snapshotWorkspace(): Promise<Snapshot> {
    const db = await openDatabase();
    try {
        const names = Array.from(db.objectStoreNames);
        if (!names.length) return { stores: [], local: localSnapshot() };
        const tx = db.transaction(names, "readonly");
        const done = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
        });
        const stores = await readStores(tx);
        const local = localSnapshot();
        await done;
        return { stores, local };
    } finally {
        db.close();
    }
}

function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
            ? Object.fromEntries(
                  Object.keys(item)
                      .sort()
                      .map((key) => [key, item[key]]),
              )
            : item,
    );
}
function defaultRecord(key: unknown, value: unknown): boolean {
    if (typeof key !== "string" || typeof value !== "string") return false;
    try {
        const parsed = JSON.parse(value);
        const state = parsed.state;
        if (!state || typeof state !== "object") return false;
        if (key === "infinite-canvas:commerce_store") {
            const normalize = (item: Record<string, unknown>, brand = false) => Object.fromEntries(Object.entries(item).filter(([k]) => !["createdAt", "updatedAt", "publishedAt", ...(brand ? ["id"] : [])].includes(k)));
            const expected = {
                jobs: [],
                brands: [normalize(createDefaultBrand() as unknown as Record<string, unknown>, true)],
                policyPacks: [normalize(createBuiltInPolicyPack() as unknown as Record<string, unknown>)],
                modelRoles: defaultModelRoles,
                operatorName: "操作员",
                audit: [],
            };
            const actual = { ...state, brands: state.brands?.map((b: Record<string, unknown>) => normalize(b, true)), policyPacks: state.policyPacks?.map((p: Record<string, unknown>) => normalize(p)) };
            return canonical(actual) === canonical(expected);
        }
        if (key === "infinite-canvas:ai_config_store") {
            // Pure snapshot of the shipped defaults. Never import a live Zustand store here.
            const models = [
                { name: "gpt-image-2", capability: "image" },
                { name: "grok-imagine-video", capability: "video" },
                { name: "gpt-5.5", capability: "text" },
                { name: "gpt-4o-mini-tts", capability: "audio" },
            ];
            const config = {
                channelMode: "local",
                baseUrl: "https://api.openai.com",
                apiKey: "",
                apiFormat: "openai",
                channels: [{ id: "default", name: "默认渠道", baseUrl: "https://api.openai.com", apiKey: "", apiFormat: "openai", models }],
                model: "default::gpt-image-2",
                imageModel: "default::gpt-image-2",
                videoModel: "default::grok-imagine-video",
                textModel: "default::gpt-5.5",
                audioModel: "default::gpt-4o-mini-tts",
                audioVoice: "alloy",
                audioFormat: "mp3",
                audioSpeed: "1",
                audioInstructions: "",
                videoSeconds: "6",
                vquality: "720",
                videoGenerateAudio: "true",
                videoWatermark: "false",
                videoMode: "frames",
                systemPrompt: "",
                reasoningEffort: "auto",
                models: models.map((m) => `default::${m.name}`),
                quality: "auto",
                size: "1:1",
                background: "",
                count: "1",
                canvasImageCount: "3",
                proxyEnabled: false,
                proxyUrl: "http://127.0.0.1:23210",
            };
            if (state.config?.channels?.[0]?.name === "Default provider") config.channels[0].name = "Default provider";
            return canonical(state) === canonical({ config, webdav: { url: "", username: "", password: "", directory: "infinite-canvas", lastSyncedAt: "" } });
        }
        if (key === "infinite-canvas:prompt_source_store_v2") {
            const lastFetchedAt = state.schedule?.lastFetchedAt;
            if (typeof lastFetchedAt !== "string") return false;
            if (lastFetchedAt !== "" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(lastFetchedAt) || !Number.isFinite(Date.parse(lastFetchedAt)) || new Date(lastFetchedAt).toISOString() !== lastFetchedAt)) return false;
            return canonical(state) === canonical({ sources: DEFAULT_PROMPT_SOURCES, schedule: { intervalMinutes: 30, lastFetchedAt } });
        }
        const defaults: Record<string, unknown> = {
            "infinite-canvas:canvas_store": { projects: [], deletedProjects: [] },
            "infinite-canvas:asset_store": { assets: [] },
            "infinite-canvas:product-white": { records: [] },
            "infinite-canvas:plugin_store": { plugins: [] },
            "infinite-canvas:prompt_source_store_v2": { sources: DEFAULT_PROMPT_SOURCES, schedule: { intervalMinutes: 30, lastFetchedAt: "" } },
        };
        return Object.hasOwn(defaults, key) && canonical(state) === canonical(defaults[key]);
    } catch {
        return false;
    }
}
export function destinationStatus(snapshot: Snapshot): "empty" | "defaults" | "occupied" {
    let defaults = false;
    for (const store of snapshot.stores)
        for (const record of store.records) {
            if (store.name === "local-forage-detect-blob-support" && record.key === "key" && record.value instanceof Blob && record.value.size === 0) {
                defaults = true;
                continue;
            }
            if (store.name !== "app_state" || !defaultRecord(record.key, record.value)) return "occupied";
            defaults = true;
        }
    for (const [key, value] of snapshot.local) {
        if (/^infinite-canvas:(theme_store|locale)$/.test(key) || /^canvas-(side-panel|agent-panel-width)/.test(key) || defaultRecord(key, value)) defaults = true;
        else return "occupied";
    }
    return defaults ? "defaults" : "empty";
}

export async function restoreWorkspace(snapshot: Snapshot, allowDefaults = false): Promise<void> {
    const before = destinationStatus(await snapshotWorkspace());
    check(before !== "occupied", "目标站点已有业务数据或配置，已停止，未覆盖任何记录");
    check(before !== "defaults" || allowDefaults, "目标包含初始设置，请确认后重试");
    let db = await openDatabase();
    if (snapshot.stores.some((s) => !db.objectStoreNames.contains(s.name))) {
        const version = db.version + 1;
        db.close();
        db = await openDatabase(version, snapshot.stores);
    }
    try {
        check(db.objectStoreNames.length > 0, "归档没有数据库记录");
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(Array.from(db.objectStoreNames), "readwrite");
            let previous: [string, string][] | undefined;
            let failure: unknown;
            tx.oncomplete = () => resolve();
            tx.onabort = () => {
                try {
                    if (previous) {
                        for (const key of Object.keys(localStorage).filter(isWorkspaceKey)) localStorage.removeItem(key);
                        for (const [key, value] of previous) localStorage.setItem(key, value);
                    }
                } catch {
                    failure = new Error("数据库已回滚，但浏览器设置回滚失败，请检查存储空间后重试");
                }
                reject(failure || tx.error || new Error("恢复事务已回滚"));
            };
            // All reads are queued before writes, on the same transaction: no check/write race.
            void readStores(tx)
                .then((stores) => {
                    try {
                        const current = { stores, local: localSnapshot() };
                        const status = destinationStatus(current);
                        check(status !== "occupied", "目标站点已有业务数据或配置，已停止，未覆盖任何记录");
                        check(status !== "defaults" || allowDefaults, "目标包含初始设置，请确认后重试");
                        for (const store of snapshot.stores) {
                            const target = tx.objectStore(store.name);
                            check(canonical(target.keyPath) === canonical(store.keyPath) && target.autoIncrement === store.autoIncrement, "数据库结构不兼容");
                            for (const record of store.records) {
                                indexedDB.cmp(record.key, record.key);
                            }
                        }
                        for (const name of Array.from(tx.objectStoreNames)) tx.objectStore(name).clear();
                        for (const store of snapshot.stores)
                            for (const record of store.records) {
                                const target = tx.objectStore(store.name);
                                if (target.keyPath === null) target.add(record.value, record.key);
                                else target.add(record.value);
                            }
                        previous = current.local;
                        for (const [key] of previous) localStorage.removeItem(key);
                        for (const [key, value] of snapshot.local) localStorage.setItem(key, value);
                    } catch (error) {
                        failure = error;
                        tx.abort();
                    }
                })
                .catch((error) => {
                    failure = error;
                    tx.abort();
                });
        });
    } finally {
        db.close();
    }
}

export function validatePayload(value: unknown): MigrationPayload {
    const p = value as MigrationPayload;
    check(p && typeof p.server === "string" && typeof p.name === "string" && typeof p.token === "string");
    const url = new URL(p.server);
    check(url.protocol === "https:" && url.origin === p.server && !url.username && !url.password && /^snapshot-[A-Za-z0-9-]+\.zip$/.test(p.name) && /^[\x21-\x7e]{16,512}$/.test(p.token), "迁移地址或凭据无效");
    return { server: p.server, name: p.name, token: p.token };
}
export function transferUrl(payload: MigrationPayload) {
    return `${payload.server}/private-data/${encodeURIComponent(payload.name)}`;
}
export function transferHeaders(payload: MigrationPayload) {
    return { Authorization: `Basic ${btoa(`owner:${payload.token}`)}` };
}
export function payloadHash(payload: MigrationPayload) {
    return btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
