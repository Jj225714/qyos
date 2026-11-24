import { strToU8, zipSync } from "fflate";
import { decodeArchive, destinationStatus, encodeArchive, hash, restoreWorkspace, snapshotWorkspace, transferHeaders, transferUrl, validatePayload, type MigrationPayload } from "./services/workspace-transfer";
import { holdTabPresence } from "./services/storage-coordination";

// This page writes the same stores as the app: it may only act after joining the presence group, i.e. after any
// startup cleanup in another tab finished; app tabs then see it and do not clean up while it is open.
const presence = holdTabPresence();

const pendingKey = "workspace-transfer-pending";
const status = document.querySelector<HTMLElement>("#status")!;
const retry = document.querySelector<HTMLButtonElement>("#retry")!;
const exportButton = document.querySelector<HTMLButtonElement>("#export")!;
const input = document.querySelector<HTMLInputElement>("#import")!;
const style = document.createElement("style");
style.textContent =
    "body{font:16px system-ui;background:#f7f5f1;color:#292524;margin:0}main{max-width:600px;margin:12vh auto;padding:32px;background:white;border-radius:16px}h1{font-size:24px}button,input{font:inherit;margin:8px 0}button{padding:8px 16px;cursor:pointer}#status{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#785b42}";
document.head.append(style);
let pending: MigrationPayload | undefined;
let busy = false;
input.disabled = exportButton.disabled = retry.disabled = true;
presence.then(
    () => {
        if (!busy) input.disabled = exportButton.disabled = retry.disabled = false;
    },
    () => {
        status.textContent = "无法与其他标签页协调本地存储，请关闭其他标签页后刷新本页。";
    },
);
const fragment = location.hash.slice(1);
history.replaceState(null, "", location.pathname + location.search);
try {
    if (fragment) {
        pending = validatePayload(JSON.parse(atob(fragment.replace(/-/g, "+").replace(/_/g, "/"))));
        sessionStorage.setItem(pendingKey, JSON.stringify(pending));
    } else if (sessionStorage.getItem(pendingKey)) pending = validatePayload(JSON.parse(sessionStorage.getItem(pendingKey)!));
    if (pending && pending.server !== location.origin) throw new Error("请在迁移目标站点打开此页面");
} catch {
    pending = undefined;
    sessionStorage.removeItem(pendingKey);
    status.textContent = "迁移链接无效，可手动导入归档。";
}

async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    input.disabled = exportButton.disabled = retry.disabled = true;
    retry.hidden = true;
    try {
        await presence;
        await action();
    } catch (error) {
        status.textContent = error instanceof Error ? error.message : "迁移失败，请重试";
        retry.hidden = !pending;
    } finally {
        busy = false;
        input.disabled = exportButton.disabled = retry.disabled = false;
    }
}
async function restore(bytes: Uint8Array) {
    status.textContent = "正在校验归档和附件…";
    const snapshot = await decodeArchive(bytes);
    const state = destinationStatus(await snapshotWorkspace());
    if (state === "occupied") throw new Error("此站点已有业务数据或配置，无法覆盖。请使用空白浏览器配置文件恢复。");
    const allowDefaults = state === "defaults" && (!!pending || confirm("目标工作区仅有初始默认设置。是否用归档替换这些默认设置？"));
    if (state === "defaults" && !allowDefaults) throw new Error("已取消恢复，本地数据未更改。");
    status.textContent = "正在恢复，请勿关闭页面…";
    await restoreWorkspace(snapshot, allowDefaults);
    const receiptTarget = pending;
    sessionStorage.removeItem(pendingKey);
    pending = undefined;
    if (receiptTarget) {
        status.textContent = "恢复完成，正在发送完成回执…";
        try {
            const restored = await snapshotWorkspace();
            const counts = { jobs: 0, canvases: 0, rulePacks: 0, assets: 0, whiteRecords: 0 };
            for (const record of restored.stores.find((s) => s.name === "app_state")?.records || []) {
                if (typeof record.value !== "string") continue;
                try {
                    const state = JSON.parse(record.value).state;
                    if (record.key === "infinite-canvas:commerce_store") {
                        counts.jobs = state.jobs?.length || 0;
                        counts.rulePacks = state.policyPacks?.length || 0;
                    }
                    if (record.key === "infinite-canvas:canvas_store") counts.canvases = state.projects?.length || 0;
                    if (record.key === "infinite-canvas:asset_store") counts.assets = state.assets?.length || 0;
                    if (record.key === "infinite-canvas:product-white") counts.whiteRecords = state.records?.length || 0;
                } catch {
                    /* Receipt contains metadata only. */
                }
            }
            const receipt = {
                status: "restored",
                source: receiptTarget.name,
                sourceSha256: await hash(bytes),
                restoredAt: new Date().toISOString(),
                counts,
                stores: restored.stores.map((s) => ({ name: s.name, records: s.records.length })),
                localKeys: restored.local.length,
            };
            const archive = zipSync({ "result.json": strToU8(JSON.stringify(receipt)) });
            await fetch(transferUrl({ ...receiptTarget, name: receiptTarget.name.replace(/\.zip$/, "-restored.zip") }), {
                method: "PUT",
                headers: { ...transferHeaders(receiptTarget), "Content-Type": "application/zip" },
                body: archive.slice().buffer,
                credentials: "omit",
                redirect: "error",
                signal: AbortSignal.timeout(10000),
            });
        } catch {
            /* The committed restore succeeds even when the optional receipt cannot be uploaded. */
        }
    }
    status.textContent = "恢复完成，正在进入设置…";
    location.replace("/commerce/settings");
}
async function download() {
    if (!pending) return;
    status.textContent = "正在下载加密连接中的归档…";
    const response = await fetch(transferUrl(pending), { headers: transferHeaders(pending), cache: "no-store", credentials: "omit", redirect: "error" });
    if (!response.ok) throw new Error(`下载失败（${response.status}），请重试或手动导入。`);
    await restore(new Uint8Array(await response.arrayBuffer()));
}
retry.onclick = () => void run(download);
input.onchange = () => {
    const file = input.files?.[0];
    if (file) void run(async () => restore(new Uint8Array(await file.arrayBuffer())));
};
exportButton.onclick = () =>
    void run(async () => {
        status.textContent = "正在导出完整工作区…";
        const bytes = await encodeArchive(await snapshotWorkspace());
        const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "application/zip" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `snapshot-${Date.now()}.zip`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        status.textContent = "归档已导出，原数据全部保留。";
    });
if (pending) void run(download);
else if (status.textContent === "正在检查…") status.textContent = "可导出当前工作区，或选择归档恢复。";
