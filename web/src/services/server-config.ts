import { create } from "zustand";
import { getServerConfigEnabled } from "@/constant/runtime-config";
import { normalizePersonalConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { applyManagedChannelFile } from "./channel-config-file";
import { isManagedChannel, withoutManagedChannel } from "@/lib/managed-channel";
import { localForageStorage } from "@/lib/localforage-storage";
import { registerSettingsSessionGuard } from "./settings-readiness";
import type { PersonalSettings, SettingsEnvelope, SettingsSection, SettingsUser, SettingsVersions, TeamSettings, SettingsAsset } from "@/types/settings-sync";
import { applyPersonalSettings, applyTeamSettings, captureLocalPersonalSettings, captureLocalTeamSettings, clearPersonalSettings, clearTeamSettings, subscribePersonalSettings, waitForSettingsHydration } from "./settings-data";

type Phase = "checking" | "signed-out" | "ready" | "saving" | "error" | "conflict";
type MigrationCandidate = { personal: PersonalSettings; team: TeamSettings; capturedAt: string };
type SyncState = {
    user: SettingsUser | null; phase: Phase; revision: number; savedAt: string | null; message: string;
    teamRevision: number; teamSavedAt: string | null; manageTeam: boolean; lastSyncedAt: string | null;
    serverPersonal: PersonalSettings | null; serverTeam: TeamSettings | null;
    teamDraft: SettingsSection<TeamSettings> | null; migrationCandidate: MigrationCandidate | null; dirty: boolean;
};
const emptyState: SyncState = { user: null, phase: "checking", revision: 0, savedAt: null, message: "", teamRevision: 0, teamSavedAt: null, manageTeam: false, lastSyncedAt: null, serverPersonal: null, serverTeam: null, teamDraft: null, migrationCandidate: null, dirty: false };
export const useServerConfigStore = create<SyncState>(() => ({ ...emptyState }));

// Retained for existing imports; all new sync uses the complete PersonalSettings document.
export function configurationForServer(config: AiConfig) {
    const { managedPrincipalId: _principal, proxyEnabled: _enabled, proxyUrl: _proxy, ...portable } = config;
    return portable;
}
export function mergeServerConfiguration(local: AiConfig, saved: Partial<AiConfig>): AiConfig {
    return normalizePersonalConfig({ ...local, ...saved, proxyEnabled: local.proxyEnabled, proxyUrl: local.proxyUrl });
}

export class SettingsSyncError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}
class StaleSessionError extends Error {}
let initialized: Promise<void> | undefined;
let epoch = 0;
let applying = 0;
let loaded = false;
let baseline = "";
let pending: ReturnType<typeof setTimeout> | undefined;
let saving: { epoch: number; promise: Promise<void> } | undefined;
let polling = false;
let interval: ReturnType<typeof setInterval> | undefined;
let unsubscribe: (() => void) | undefined;
let authenticationRequest: Promise<unknown> = Promise.resolve();
const OWNER_KEY = "infinite-canvas:settings-owner";
const SIGNED_OUT_KEY = "infinite-canvas:settings-explicitly-signed-out";
const snapshot = () => JSON.stringify(captureLocalPersonalSettings());
const current = (requestEpoch: number) => requestEpoch === epoch;
function ensureCurrent(requestEpoch: number) { if (!current(requestEpoch)) throw new StaleSessionError(); }
function cancelPending() { if (pending) clearTimeout(pending); pending = undefined; }

/** Last managed channel file of the current SSO session: memory only, never persisted. */
let managedChannelFile: unknown = null;
/** Ends the managed channel: forgets the cached file first so nothing re-adds it, then removes it from the live config. */
function dropManagedChannel() {
    managedChannelFile = null;
    const config = useConfigStore.getState().config;
    if (config?.channels?.some(isManagedChannel)) useConfigStore.setState({ config: withoutManagedChannel(config) });
}
/** Settings applied from the server, team or a file replace the channel list; put the session's managed channel back. */
function restoreManagedChannel() {
    if (!managedChannelFile || !useServerConfigStore.getState().user?.managed) return;
    const config = useConfigStore.getState().config;
    if (!config || config.channels?.some(isManagedChannel)) return;
    try { useConfigStore.setState({ config: applyManagedChannelFile(config, managedChannelFile, { setDefaults: false }) }); }
    catch { managedChannelFile = null; }
}

/** Every authenticated write binds to the identity observed before the request. */
export async function apiSettingsRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const requestEpoch = epoch;
    const userId = useServerConfigStore.getState().user?.id;
    const authentication = ["/login", "/logout", "/bootstrap"].includes(path);
    if (method !== "GET" && !authentication && userId === undefined) throw new SettingsSyncError(401, "请先登录后再保存配置。");
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (userId !== undefined) headers["X-Config-User"] = String(userId);
    const send = () => {
        ensureCurrent(requestEpoch);
        const timeout = path === "/assets" && method === "POST" ? 120000 : 20000;
        return fetch(`/api/config-vault${path}`, { method, credentials: "same-origin", cache: "no-store", redirect: "error", headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    };
    // Cookie-changing calls must finish in intent order, even when a prior login is slow.
    const request = authentication ? authenticationRequest.catch(() => undefined).then(send) : send();
    if (authentication) authenticationRequest = request;
    const response = await request;
    ensureCurrent(requestEpoch);
    if (!response.ok) {
        // Any rejected session ends the employee's managed channel at once.
        if (response.status === 401) dropManagedChannel();
        let message = response.status === 401 ? "登录已失效，请重新登录。" : response.status === 403 ? "当前账号没有此配置的管理权限。" : response.status === 409 ? "服务器配置已在其他设备更新，请比较本机与服务器配置后重新读取。" : response.status === 422 ? "配置或附件不完整，请检查后重试。" : response.status === 429 ? "请求过于频繁，请稍后再试。" : "服务器配置读取或保存失败，当前浏览器配置仍保留，请重试。";
        if (response.status === 422) {
            const detail: unknown = await response.json().catch(() => null);
            ensureCurrent(requestEpoch);
            if (detail && typeof detail === "object" && "error" in detail && typeof detail.error === "string" && detail.error.trim() && detail.error.length <= 1000) message = detail.error;
        }
        throw new SettingsSyncError(response.status, message);
    }
    const value = response.status === 204 ? undefined as T : await response.json() as T;
    ensureCurrent(requestEpoch);
    return value;
}

function failure(error: unknown, requestEpoch: number) {
    if (!current(requestEpoch) || error instanceof StaleSessionError) return;
    const e = error instanceof SettingsSyncError ? error : new SettingsSyncError(0, "连接服务器失败，当前浏览器配置仍保留，请重试。");
    cancelPending();
    if (e.status === 401) {
        loaded = false;
        epoch++;
        dropManagedChannel();
        useServerConfigStore.setState({ user: null, phase: "signed-out", manageTeam: false, serverPersonal: null, serverTeam: null, teamDraft: null, migrationCandidate: null, message: e.message });
    } else useServerConfigStore.setState({ phase: e.status === 409 ? "conflict" : "error", message: e.message });
}

async function captureMigrationCandidate(userId: number, requestEpoch: number, mayCapture: boolean) {
    try {
        const key = `settings-migration-candidate:${userId}`;
        const stored = await localForageStorage.getItem(key);
        ensureCurrent(requestEpoch);
        if (stored) {
            const candidate = JSON.parse(stored) as MigrationCandidate;
            if (!candidate.personal?.config || !candidate.team?.policyPack || !candidate.capturedAt) throw new Error("Invalid migration backup");
            useServerConfigStore.setState({ migrationCandidate: candidate });
        } else if (mayCapture) {
            const candidate = structuredClone({ personal: captureLocalPersonalSettings(), team: captureLocalTeamSettings(), capturedAt: new Date().toISOString() });
            // Complete durable backup before any server value can replace legacy browser data.
            await localForageStorage.setItem(key, JSON.stringify(candidate));
            ensureCurrent(requestEpoch);
            useServerConfigStore.setState({ migrationCandidate: candidate });
        }
    } catch (error) {
        if (error instanceof StaleSessionError) throw error;
        throw new SettingsSyncError(0, "本机旧配置迁移备份失败，尚未替换当前配置；请检查浏览器存储后重试。");
    }
}

async function adoptUser(user: SettingsUser, requestEpoch: number) {
    await waitForSettingsHydration();
    ensureCurrent(requestEpoch);
    const owner = localStorage.getItem(OWNER_KEY);
    const previous = useServerConfigStore.getState().user;
    const changed = (previous && previous.id !== user.id) || (owner && owner !== String(user.id));
    if (changed) {
        dropManagedChannel();
        useServerConfigStore.setState({ migrationCandidate: null, serverPersonal: null, serverTeam: null, teamDraft: null, manageTeam: false, revision: 0, teamRevision: 0, savedAt: null, teamSavedAt: null, lastSyncedAt: null, dirty: false });
        applying++;
        try { await clearPersonalSettings(() => current(requestEpoch)); ensureCurrent(requestEpoch); clearTeamSettings(); }
        finally { applying--; }
    }
    await captureMigrationCandidate(user.id, requestEpoch, !changed);
    ensureCurrent(requestEpoch);
    localStorage.setItem(OWNER_KEY, String(user.id));
    useServerConfigStore.setState({ user });
}

async function applyEnvelope(data: SettingsEnvelope, requestEpoch: number) {
    ensureCurrent(requestEpoch);
    if (data.schemaVersion !== 2 || data.user.id !== useServerConfigStore.getState().user?.id) throw new SettingsSyncError(409, "配置账号不匹配，请重新登录。");
    await waitForSettingsHydration();
    ensureCurrent(requestEpoch);
    applying++;
    try {
        // Missing v2 sections deliberately reset to defaults, never merge prior credentials.
        if (data.personal.value) await applyPersonalSettings(data.personal.value, () => current(requestEpoch));
        else await clearPersonalSettings(() => current(requestEpoch));
        ensureCurrent(requestEpoch);
        if (data.team.value) await applyTeamSettings(data.team.value, data.team.revision, () => current(requestEpoch));
        else clearTeamSettings();
        ensureCurrent(requestEpoch);
        baseline = snapshot();
        loaded = true;
        useServerConfigStore.setState({ revision: data.personal.revision, savedAt: data.personal.savedAt, teamRevision: data.team.revision, teamSavedAt: data.team.savedAt, manageTeam: data.permissions.manageTeam, serverPersonal: data.personal.value, serverTeam: data.team.value, teamDraft: data.draft ?? null, phase: "ready", dirty: false, message: data.personal.value ? "个人和团队配置已从服务器读取。" : "服务器尚无个人配置，后续修改会自动保存；也可迁移此浏览器原有配置。", lastSyncedAt: new Date().toISOString() });
    } finally { applying--; }
}

async function readAndApply(requestEpoch: number) {
    const requestedWith = snapshot();
    const data = await apiSettingsRequest<SettingsEnvelope>("/settings");
    if (snapshot() !== requestedWith) {
        useServerConfigStore.setState({ serverPersonal: data.personal.value, serverTeam: data.team.value, dirty: true });
        throw new SettingsSyncError(409, "读取期间本机配置发生修改，已保留本机内容，请比较差异后重新读取。");
    }
    await applyEnvelope(data, requestEpoch);
}

export async function reloadServerConfiguration() {
    cancelPending();
    const requestEpoch = epoch;
    if (!useServerConfigStore.getState().user) return;
    if (saving?.epoch === requestEpoch) await saving.promise;
    if (!current(requestEpoch)) return;
    useServerConfigStore.setState({ phase: "checking", message: "" });
    try { await readAndApply(requestEpoch); }
    catch (error) { failure(error, requestEpoch); }
}

/** Refresh shared rules without canceling or replacing unsaved personal settings. */
export async function reloadTeamConfiguration() {
    const requestEpoch = epoch;
    if (!useServerConfigStore.getState().user) return;
    const data = await apiSettingsRequest<SettingsEnvelope>("/settings");
    ensureCurrent(requestEpoch);
    if (data.schemaVersion !== 2 || data.user.id !== useServerConfigStore.getState().user?.id) throw new SettingsSyncError(409, "配置账号不匹配，请重新登录。");
    await waitForSettingsHydration();
    ensureCurrent(requestEpoch);
    if (data.team.value) await applyTeamSettings(data.team.value, data.team.revision, () => current(requestEpoch));
    else clearTeamSettings();
    ensureCurrent(requestEpoch);
    useServerConfigStore.setState({ teamRevision: data.team.revision, teamSavedAt: data.team.savedAt, serverTeam: data.team.value, teamDraft: data.draft ?? null, manageTeam: data.permissions.manageTeam });
}

export async function saveServerConfiguration(explicitValue?: PersonalSettings) {
    cancelPending();
    const requestEpoch = epoch;
    if (!loaded || !useServerConfigStore.getState().user) return;
    if (explicitValue && useServerConfigStore.getState().phase === "conflict") return resolvePersonalConflict(explicitValue);
    if (saving?.epoch === requestEpoch) { await saving.promise; if (!current(requestEpoch)) return; if (explicitValue) return saveServerConfiguration(explicitValue); return; }
    if (["conflict", "checking", "signed-out"].includes(useServerConfigStore.getState().phase)) return;
    const value = explicitValue ? JSON.stringify(explicitValue) : snapshot();
    const revision = useServerConfigStore.getState().revision;
    useServerConfigStore.setState({ phase: "saving", message: "" });
    const promise = (async () => {
        try {
            const result = await apiSettingsRequest<SettingsSection<PersonalSettings>>("/settings/personal", "PUT", { revision, value: JSON.parse(value) });
            ensureCurrent(requestEpoch);
            if (explicitValue) {
                applying++;
                try {
                    await applyPersonalSettings(result.value ?? explicitValue, () => current(requestEpoch));
                    ensureCurrent(requestEpoch);
                    const state = useServerConfigStore.getState();
                    if (state.serverTeam?.modelConfig) await applyTeamSettings(state.serverTeam, state.teamRevision, () => current(requestEpoch));
                }
                finally { applying--; }
                ensureCurrent(requestEpoch);
                baseline = snapshot();
            } else baseline = value;
            useServerConfigStore.setState({ revision: result.revision, savedAt: result.savedAt, serverPersonal: result.value ?? JSON.parse(value), phase: "ready", dirty: snapshot() !== baseline, message: "个人配置已保存到服务器。", lastSyncedAt: new Date().toISOString() });
        } catch (error) { failure(error, requestEpoch); }
        finally { if (saving?.epoch === requestEpoch) saving = undefined; }
        if (current(requestEpoch) && useServerConfigStore.getState().phase === "ready" && snapshot() !== baseline) queueSave();
    })();
    saving = { epoch: requestEpoch, promise };
    return promise;
}
/** Called only after the user explicitly chooses the local values in a conflict preview. */
export async function resolvePersonalConflict(value: PersonalSettings): Promise<void> {
    const requestEpoch = epoch;
    if (!loaded || !useServerConfigStore.getState().user) return;
    cancelPending();
    try {
        const remote = await apiSettingsRequest<SettingsEnvelope>("/settings");
        if (remote.user.id !== useServerConfigStore.getState().user?.id) throw new SettingsSyncError(401, "账号已切换，请重新登录。");
        useServerConfigStore.setState({ revision: remote.personal.revision, savedAt: remote.personal.savedAt, serverPersonal: remote.personal.value, phase: "ready" });
        await saveServerConfiguration(value);
    } catch (error) { failure(error, requestEpoch); }
}

/** Explicit deletion only: successful personal migration does not erase un-migrated team data. */
export async function discardMigrationCandidate() {
    const requestEpoch = epoch;
    const user = useServerConfigStore.getState().user;
    if (!user) return;
    await localForageStorage.removeItem(`settings-migration-candidate:${user.id}`);
    ensureCurrent(requestEpoch);
    useServerConfigStore.setState({ migrationCandidate: null });
}
function queueSave() {
    cancelPending();
    const requestEpoch = epoch;
    pending = setTimeout(() => { if (current(requestEpoch)) void saveServerConfiguration(); }, 1000);
}

export async function checkServerConfigurationVersions() {
    const initial = useServerConfigStore.getState();
    if (!loaded) {
        if (initial.user && initial.phase === "error") await reloadServerConfiguration();
        return;
    }
    if (polling || saving?.epoch === epoch || !initial.user || ["checking", "signed-out"].includes(initial.phase)) return;
    const requestEpoch = epoch;
    polling = true;
    try {
        const versions = await apiSettingsRequest<SettingsVersions>("/settings/versions");
        const state = useServerConfigStore.getState();
        if (versions.user.id !== state.user?.id) throw new SettingsSyncError(401, "登录账号已在其他页面切换，请重新登录。");
        useServerConfigStore.setState({ manageTeam: versions.permissions.manageTeam });
        if (versions.personal !== state.revision || versions.team !== state.teamRevision) {
            if (snapshot() !== baseline) {
                cancelPending();
                const remote = await apiSettingsRequest<SettingsEnvelope>("/settings");
                useServerConfigStore.setState({ serverPersonal: remote.personal.value, serverTeam: remote.team.value, phase: "conflict", message: "其他设备已更新配置，本机有未保存修改。请比较差异，再读取服务器配置或保留本机内容。" });
            } else await reloadServerConfiguration();
        } else if (state.phase === "error") {
            useServerConfigStore.setState({ phase: "ready", message: "已重新连接配置服务器。" });
            if (snapshot() !== baseline) queueSave();
        }
    } catch (error) { failure(error, requestEpoch); }
    finally { if (current(requestEpoch)) polling = false; }
}

/**
 * SSO accounts get their own model-gateway key from the vault on every sign-in and session restore. The channel
 * uses the fixed id `managed-enterprise`, never merges with channels the user entered, and stays out of browser
 * storage, server sync and exports. Default models are set only when it is first added and none is configured.
 */
async function applyManagedChannel(user: SettingsUser, requestEpoch: number) {
    if (!user.managed) { dropManagedChannel(); return; }
    let file: unknown;
    try { file = await apiSettingsRequest("/managed-channel"); }
    catch (error) { if (error instanceof StaleSessionError) throw error; if (error instanceof SettingsSyncError && error.status === 401) throw error; return; }
    ensureCurrent(requestEpoch);
    try {
        const config = useConfigStore.getState().config;
        const next = applyManagedChannelFile(config, file);
        managedChannelFile = file;
        if (next !== config) useConfigStore.setState({ config: next });
    } catch { /* An invalid managed channel must never block sign-in. */ }
}

/** Leaves for the vault's SSO start page; the vault redirects back here with a session cookie. */
export function startEnterpriseLogin() {
    try { localStorage.removeItem(SIGNED_OUT_KEY); } catch { /* storage may be unavailable */ }
    const back = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/api/config-vault/oidc/start?return=${encodeURIComponent(back)}`);
}

export async function loginServerConfiguration(email: string, password: string) {
    const requestEpoch = ++epoch;
    cancelPending(); loaded = false; polling = false;
    useServerConfigStore.setState({ phase: "checking", message: "" });
    try {
        await waitForSettingsHydration(); ensureCurrent(requestEpoch);
        const data = await apiSettingsRequest<{ user: SettingsUser }>("/login", "POST", { email: email.trim(), password });
        localStorage.removeItem(SIGNED_OUT_KEY);
        await adoptUser(data.user, requestEpoch);
        await readAndApply(requestEpoch);
        await applyManagedChannel(data.user, requestEpoch);
    } catch (error) { failure(error, requestEpoch); }
}

export async function logoutServerConfiguration() {
    const requestEpoch = ++epoch;
    cancelPending(); loaded = false; polling = false; baseline = "";
    try { localStorage.setItem(SIGNED_OUT_KEY, "true"); } catch { /* Storage quotas must never prevent credential clearing. */ }
    dropManagedChannel();
    // Clear immediately: an in-flight save is never allowed to resurrect this account.
    applying++;
    try { await clearPersonalSettings(() => current(requestEpoch)); ensureCurrent(requestEpoch); clearTeamSettings(); }
    catch (error) { if (error instanceof StaleSessionError) return; throw error; }
    finally { applying--; }
    if (!current(requestEpoch)) return;
    useServerConfigStore.setState({ ...emptyState, phase: "signed-out", message: "已退出，服务器配置仍保留。" });
    try { await apiSettingsRequest("/logout", "POST", {}); }
    catch (error) { if (current(requestEpoch)) useServerConfigStore.setState({ message: error instanceof SettingsSyncError ? error.message : "本机已退出，服务器会话注销失败，请重试退出。" }); }
}

export function assertSettingsReady() {
    if (!getServerConfigEnabled()) return;
    if (!loaded || !useServerConfigStore.getState().user || !["ready", "saving"].includes(useServerConfigStore.getState().phase)) throw new Error("请先登录并完成配置同步，再开始生成。");
}

/** Capture once at operation start, invoke again immediately before paid sends and result writes. */
export function captureSettingsSessionGuard(config?: Partial<AiConfig>): () => void {
    if (!getServerConfigEnabled()) return () => {};
    assertSettingsReady();
    const assertCurrentCredentials = () => { if (config) {
        const active = captureLocalPersonalSettings().config;
        // The managed channel is excluded from captured settings; compare it from the live configuration.
        const activeChannels = [...(active.channels ?? []), ...(useConfigStore.getState().config?.channels ?? []).filter(isManagedChannel)];
        const credentials = (channels: AiConfig["channels"]) => channels.map(({ id, baseUrl, apiKey, apiFormat, provider }) => ({ id, baseUrl, apiKey, apiFormat, provider: provider ?? "" })).sort((a, b) => a.id.localeCompare(b.id));
        if (config.channels && JSON.stringify(credentials(config.channels)) !== JSON.stringify(credentials(activeChannels))) throw new Error("模型渠道已随账号或配置变化，请重新发起请求。");
        if (config.apiKey && config.apiKey !== active.apiKey && !activeChannels.some((channel) => channel.apiKey === config.apiKey)) throw new Error("模型凭据已变化，请重新发起请求。");
    } };
    assertCurrentCredentials();
    const requestEpoch = epoch;
    const userId = useServerConfigStore.getState().user!.id;
    return () => {
        if (!current(requestEpoch) || userId !== useServerConfigStore.getState().user?.id) throw new Error("登录账号或会话已变化，已停止旧请求，请重新操作。");
        assertSettingsReady();
        assertCurrentCredentials();
    };
}
registerSettingsSessionGuard(captureSettingsSessionGuard);

export async function loadTeamDraft() {
    const data = await apiSettingsRequest<SettingsEnvelope>("/settings");
    const draft = data.draft ?? { revision: 0, savedAt: null, value: null };
    useServerConfigStore.setState({ teamDraft: draft, manageTeam: data.permissions.manageTeam });
    return draft;
}
export async function saveTeamDraft(value: TeamSettings, revision: number) {
    const draft = await apiSettingsRequest<SettingsSection<TeamSettings>>("/settings/team/draft", "PUT", { revision, value });
    useServerConfigStore.setState({ teamDraft: draft });
    return draft;
}
export async function publishTeamDraft(revision: number) {
    const requestEpoch = epoch;
    const result = await apiSettingsRequest<SettingsSection<TeamSettings>>("/settings/team/publish", "POST", { revision });
    if (result.value) await applyTeamSettings(result.value, result.revision, () => current(requestEpoch));
    ensureCurrent(requestEpoch);
    useServerConfigStore.setState({ teamRevision: result.revision, teamSavedAt: result.savedAt, serverTeam: result.value, lastSyncedAt: new Date().toISOString() });
    return result;
}
export async function uploadSettingsAsset(scope: "team" | "personal", name: string, blob: Blob): Promise<SettingsAsset> {
    const requestEpoch = epoch;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    ensureCurrent(requestEpoch);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return apiSettingsRequest<SettingsAsset>("/assets", "POST", { scope, name, mimeType: blob.type, data: btoa(binary) });
}

export function initializeServerConfiguration() {
    if (!getServerConfigEnabled()) return Promise.resolve();
    initialized ??= (async () => {
        const requestEpoch = epoch;
        await waitForSettingsHydration();
        if (!current(requestEpoch)) return;
        const stopSettings = subscribePersonalSettings(() => {
            const sync = useServerConfigStore.getState();
            if (!applying && loaded && sync.user) {
                const dirty = snapshot() !== baseline;
                useServerConfigStore.setState({ dirty });
                if (["ready", "saving"].includes(sync.phase) && dirty) queueSave();
            }
        });
        const stopManaged = useConfigStore.subscribe?.((next, prev) => { if (next.config !== prev.config) restoreManagedChannel(); });
        unsubscribe = () => { stopSettings(); stopManaged?.(); };
        window.addEventListener?.("focus", checkServerConfigurationVersions);
        window.addEventListener?.("online", checkServerConfigurationVersions);
        interval = setInterval(() => { void checkServerConfigurationVersions(); }, 30000);
        try {
            const params = new URLSearchParams(window.location.hash.slice(1));
            const code = params.get("server-config");
            const ssoError = params.get("server-config-sso");
            if (ssoError) {
                params.delete("server-config-sso");
                window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${params.size ? `#${params}` : ""}`);
                useServerConfigStore.setState({ ...emptyState, phase: "signed-out", message: ssoError === "unavailable" ? "企业登录服务暂时不可用，请稍后再试。" : "企业账号登录失败或该账号未开通，请联系管理员。" });
                return;
            }
            if (code) {
                params.delete("server-config");
                window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${params.size ? `#${params}` : ""}`);
            }
            if (!code && localStorage.getItem(SIGNED_OUT_KEY) === "true") {
                useServerConfigStore.setState({ ...emptyState, phase: "signed-out", message: "已退出，请登录后恢复配置。" });
                return;
            }
            const result = code && /^[A-Za-z0-9_-]{43}$/.test(code)
                ? await apiSettingsRequest<{ user: SettingsUser }>("/bootstrap", "POST", { code })
                : await apiSettingsRequest<{ user: SettingsUser }>("/session");
            localStorage.removeItem(SIGNED_OUT_KEY);
            await adoptUser(result.user, requestEpoch);
            await readAndApply(requestEpoch);
            await applyManagedChannel(result.user, requestEpoch);
        } catch (error) { failure(error, requestEpoch); }
    })();
    return initialized;
}

/** Used by HMR and tests; no credentials or pending callbacks survive engine disposal. */
export function disposeServerConfiguration() {
    epoch++; cancelPending(); if (interval) clearInterval(interval); unsubscribe?.();
    window.removeEventListener?.("focus", checkServerConfigurationVersions);
    window.removeEventListener?.("online", checkServerConfigurationVersions);
    initialized = undefined; loaded = false; polling = false; managedChannelFile = null;
}

