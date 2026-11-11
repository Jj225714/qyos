import i18n, { changeAppLocale } from "@/i18n";
import { defaultConfig, defaultWebdavSyncConfig, normalizePersonalConfig, useConfigStore } from "@/stores/use-config-store";
import { withoutManagedChannel } from "@/lib/managed-channel";
import { useCommerceStore } from "@/stores/use-commerce-store";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { DEFAULT_PROMPT_SOURCES } from "@/services/api/prompt-source-presets";
import { createBuiltInPolicyPack, defaultModelRoles } from "@/lib/commerce/defaults";
import { getImageBlob } from "@/services/image-storage";
import type { StoredImageRef } from "@/types/commerce";
import type { PersonalSettings, SettingsAsset, TeamModelConfig, TeamSettings } from "@/types/settings-sync";

export const TEAM_POLICY_PREFIX = "server-aoweisi-team-";
const clone = <T>(value: T): T => structuredClone(value);

export async function waitForSettingsHydration() {
    const persistence = useCommerceStore.persist;
    if (!persistence || persistence.hasHydrated()) return;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            unsubscribe();
            reject(new Error("本地配置尚未读取完成，请刷新后重试"));
        }, 15000);
        const unsubscribe = persistence.onFinishHydration(() => {
            clearTimeout(timer);
            unsubscribe();
            resolve();
        });
        if (persistence.hasHydrated()) {
            clearTimeout(timer);
            unsubscribe();
            resolve();
        }
    });
}

export function captureLocalPersonalSettings(): PersonalSettings {
    const state = useConfigStore.getState();
    // Keep provider credentials and model bindings in the encrypted server vault
    // so the same account can restore an identical setup in every browser. The
    // local proxy remains machine-specific and is intentionally excluded. The enterprise-managed
    // channel is per session (fetched at sign-in) and its key never enters the vault or backups.
    const { managedPrincipalId: _principal, proxyEnabled: _proxyEnabled, proxyUrl: _proxyUrl, ...config } = withoutManagedChannel(state.config);
    const { lastSyncedAt: _last, ...webdav } = state.webdav;
    const prompts = usePromptSourceStore.getState();
    return clone({
        config,
        webdav,
        promptSources: { sources: prompts.sources, schedule: { intervalMinutes: prompts.schedule.intervalMinutes } },
        appearance: { theme: useThemeStore.getState().theme, locale: i18n.resolvedLanguage === "en-US" ? "en-US" : "zh-CN" },
    });
}

export async function applyPersonalSettings(value: PersonalSettings, isCurrent: () => boolean = () => true) {
    await waitForSettingsHydration();
    if (!isCurrent()) return;
    const local = useConfigStore.getState().config;
    // Build from defaults, never from another account's channels, model bindings or secrets.
    useConfigStore.setState({ config: normalizePersonalConfig({ ...clone(defaultConfig), ...clone(value.config), proxyEnabled: local.proxyEnabled, proxyUrl: local.proxyUrl }), webdav: { ...clone(defaultWebdavSyncConfig), ...clone(value.webdav || {}) } });
    if (!isCurrent()) return;
    // `modelRoles` is retained on the type for legacy account records. New captures
    // omit it because roles are owned by the team model configuration.
    useCommerceStore.setState({ modelRoles: { ...defaultModelRoles, ...(value.modelRoles ? clone(value.modelRoles) : {}) } });
    usePromptSourceStore.setState({ sources: clone(value.promptSources?.sources || DEFAULT_PROMPT_SOURCES), schedule: { intervalMinutes: value.promptSources?.schedule.intervalMinutes ?? 30, lastFetchedAt: "" } });
    useThemeStore.getState().setTheme(value.appearance?.theme || "dark");
    if (isCurrent()) await changeAppLocale(value.appearance?.locale || "zh-CN");
}

export async function clearPersonalSettings(isCurrent: () => boolean = () => true) {
    await applyPersonalSettings({ config: clone(defaultConfig) }, isCurrent);
}

export function subscribePersonalSettings(listener: () => void) {
    const subscriptions = [
        useConfigStore.subscribe((next, prev) => {
            if (next.config !== prev.config || next.webdav !== prev.webdav) listener();
        }),
        useCommerceStore.subscribe((next, prev) => {
            if (next.modelRoles !== prev.modelRoles) listener();
        }),
        usePromptSourceStore.subscribe((next, prev) => {
            if (next.sources !== prev.sources || next.schedule.intervalMinutes !== prev.schedule.intervalMinutes) listener();
        }),
        useThemeStore.subscribe((next, prev) => {
            if (next.theme !== prev.theme) listener();
        }),
    ];
    i18n.on("languageChanged", listener);
    return () => {
        subscriptions.forEach((unsubscribe) => unsubscribe());
        i18n.off("languageChanged", listener);
    };
}

export function captureLocalTeamSettings(): TeamSettings {
    const state = useCommerceStore.getState();
    // Team publishing never carries an employee's managed channel or key.
    const config = withoutManagedChannel(useConfigStore.getState().config);
    const active = state.policyPacks.find((pack) => pack.id === state.teamPolicyPackId) || state.policyPacks.filter((pack) => pack.status === "published").sort((a, b) => b.version - a.version)[0] || createBuiltInPolicyPack();
    const brands = state.teamPolicyPackId ? state.brands.filter((brand) => state.teamBrandIds.includes(brand.id)) : state.brands.filter((brand) => !brand.id.startsWith("server-brand-") && !brand.id.startsWith("team-brand-"));
    const modelConfig: TeamModelConfig = {
        channels: config.channels,
        defaults: { model: config.model, imageModel: config.imageModel, videoModel: config.videoModel, textModel: config.textModel, audioModel: config.audioModel },
        roles: state.modelRoles,
    };
    return clone({ policyPack: active, brands, modelConfig });
}

export async function applyTeamSettings(value: TeamSettings, revision: number, isCurrent: () => boolean = () => true) {
    await waitForSettingsHydration();
    if (!isCurrent()) return;
    const pack = clone(value.policyPack);
    if (!pack.id.startsWith(TEAM_POLICY_PREFIX) || pack.status !== "published") throw new Error("团队规则发布版本无效");
    const brands = clone(value.brands);
    if (value.modelConfig) {
        const teamConfig = value.modelConfig;
        const localConfig = useConfigStore.getState().config;
        const defaultChannel = teamConfig.channels.find((channel) => teamConfig.defaults.model?.startsWith(`${channel.id}::`));
        useConfigStore.setState({ config: normalizePersonalConfig({ ...localConfig, baseUrl: defaultChannel?.baseUrl || "", apiKey: defaultChannel?.apiKey || "", apiFormat: defaultChannel?.apiFormat || "openai", channels: clone(teamConfig.channels), ...clone(teamConfig.defaults), models: teamConfig.channels.flatMap((channel) => (channel.models || []).map((model) => `${channel.id}::${model.name}`)), model: teamConfig.defaults.model }) });
        if (!isCurrent()) return;
        const roles = clone(teamConfig.roles);
        useCommerceStore.setState({ modelRoles: {
            ...defaultModelRoles,
            ...roles,
            sceneModel: roles.sceneModel || teamConfig.defaults.imageModel,
            repairModel: roles.repairModel || teamConfig.defaults.imageModel,
            copyModel: roles.copyModel || teamConfig.defaults.textModel,
            translationModel: roles.translationModel || teamConfig.defaults.textModel,
            complianceModel: roles.complianceModel || teamConfig.defaults.textModel,
        } });
    }
    useCommerceStore.setState((state) => ({
        teamPolicyPackId: pack.id,
        teamRevision: revision,
        teamBrandIds: brands.map((brand) => brand.id),
        policyPacks: [pack, ...state.policyPacks.filter((previous) => previous.id !== pack.id).map((previous) => (previous.id.startsWith(TEAM_POLICY_PREFIX) && previous.status === "published" ? { ...previous, status: "retired" as const } : previous))],
        brands: [...brands, ...state.brands.filter((previous) => !brands.some((brand) => brand.id === previous.id))],
    }));
}

export function clearTeamSettings() {
    // Account changes/logout clear personal data first. An absent team document
    // must not erase the personal channels just restored for a legacy account.
    useCommerceStore.setState((state) => ({
        modelRoles: { ...defaultModelRoles },
        teamPolicyPackId: undefined,
        teamRevision: undefined,
        teamBrandIds: [],
        policyPacks: state.policyPacks.map((pack) => (pack.id.startsWith(TEAM_POLICY_PREFIX) && pack.status === "published" ? { ...pack, status: "retired" as const } : pack)),
        brands: [...state.brands.filter((brand) => !brand.id.startsWith("server-brand-") && !brand.id.startsWith("team-brand-")), ...state.brands.filter((brand) => brand.id.startsWith("server-brand-") || brand.id.startsWith("team-brand-"))],
    }));
}

export type SettingsAssetUploader = (scope: "team" | "personal", name: string, blob: Blob) => Promise<SettingsAsset>;
function serverAssetUrl(value: string) {
    if (!value) return undefined;
    try {
        const origin = typeof window === "undefined" ? "https://local.test" : window.location.origin;
        const url = new URL(value, origin);
        return url.origin === origin && !url.search && !url.hash && /^\/api\/config-vault\/assets\/team\/[A-Za-z0-9._-]+$/.test(url.pathname) ? url.pathname : undefined;
    } catch {
        return undefined;
    }
}

async function attachmentBlob(ref: { name: string; url?: string; storageKey?: string }) {
    if (ref.storageKey) {
        const blob = await getImageBlob(ref.storageKey);
        if (!blob) throw new Error(`${ref.name}：本机附件已丢失，请重新上传`);
        return blob;
    }
    if (!ref.url) throw new Error(`${ref.name}：没有可上传的附件`);
    const response = await fetch(ref.url, { credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${ref.name}：附件读取失败，请检查来源后重试`);
    return response.blob();
}

/** Publish only portable configuration attachments. Jobs and SKU images never enter this traversal. */
export async function prepareTeamSettingsForServer(value: TeamSettings, upload: SettingsAssetUploader, isCurrent: () => boolean = () => true): Promise<TeamSettings> {
    const team = clone(value);
    const assert = () => {
        if (!isCurrent()) throw new Error("账号已变化，已停止配置迁移");
    };
    const reused = new Map<string, Promise<SettingsAsset>>();
    const prepare = async <T extends StoredImageRef>(ref: T): Promise<T> => {
        assert();
        const { storageKey: _local, ...portable } = ref;
        const serverUrl = !ref.storageKey && serverAssetUrl(ref.url);
        if (serverUrl) return { ...portable, url: serverUrl } as T;
        const identity = ref.storageKey || ref.url;
        let transfer = reused.get(identity);
        if (!transfer) {
            transfer = attachmentBlob(ref).then((blob) => {
                assert();
                return upload("team", ref.name, blob);
            });
            reused.set(identity, transfer);
        }
        const asset = await transfer;
        assert();
        return { ...portable, url: asset.url } as T;
    };
    for (let index = 0; index < team.policyPack.references.length; index++) team.policyPack.references[index] = await prepare(team.policyPack.references[index]);
    for (const brand of team.brands) {
        if (brand.logo) brand.logo = await prepare(brand.logo);
        if (brand.thaiFont) {
            const font = brand.thaiFont;
            const existing = serverAssetUrl(font.dataUrl);
            if (existing) font.dataUrl = existing;
            else {
                const blob = await attachmentBlob({ name: font.name, url: font.dataUrl });
                assert();
                font.dataUrl = (await upload("team", font.name, blob)).url;
            }
        }
        // Per-product photos must never be carried in reusable brand defaults.
        for (const selections of Object.values(brand.requirementDefaultsByCategory))
            for (const selection of selections) {
                delete selection.sourceImageIds;
                delete selection.primaryImageId;
                delete selection.primaryImageIds;
            }
    }
    assert();
    return team;
}

export function settingsAttachmentCount(team: TeamSettings) {
    return team.policyPack.references.length + team.brands.reduce((count, brand) => count + Number(Boolean(brand.logo)) + Number(Boolean(brand.thaiFont)), 0);
}
