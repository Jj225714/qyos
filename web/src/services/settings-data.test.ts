import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalSettings, TeamSettings } from "@/types/settings-sync";

const state = vi.hoisted(() => ({ config: {} as any, commerce: {} as any, prompts: {} as any, theme: {} as any, getBlob: vi.fn() }));
function unused() {}
vi.mock("@/i18n", () => ({ default: { resolvedLanguage: "zh-CN", t: (key: string) => key, on: () => {}, off: () => {} }, changeAppLocale: vi.fn() }));
vi.mock("@/stores/use-config-store", () => ({
    defaultConfig: { apiKey: "", channels: [], proxyEnabled: false, proxyUrl: "" },
    defaultWebdavSyncConfig: { url: "", username: "", password: "", directory: "infinite-canvas", lastSyncedAt: "" },
    normalizePersonalConfig: (value: unknown) => value,
    useConfigStore: { getState: () => state.config, setState: (patch: unknown) => Object.assign(state.config, patch), subscribe: () => unused },
}));
vi.mock("@/stores/use-commerce-store", () => ({
    useCommerceStore: { getState: () => state.commerce, persist: { hasHydrated: () => true }, setState: (patch: any) => Object.assign(state.commerce, typeof patch === "function" ? patch(state.commerce) : patch), subscribe: () => unused },
}));
vi.mock("@/stores/use-prompt-source-store", () => ({ usePromptSourceStore: { getState: () => state.prompts, setState: (patch: unknown) => Object.assign(state.prompts, patch), subscribe: () => unused } }));
vi.mock("@/stores/use-theme-store", () => ({ useThemeStore: { getState: () => state.theme, subscribe: () => unused } }));
vi.mock("@/services/image-storage", () => ({ getImageBlob: state.getBlob }));
import { createBuiltInPolicyPack, createDefaultBrand } from "@/lib/commerce/defaults";
import { applyPersonalSettings, applyTeamSettings, captureLocalPersonalSettings, captureLocalTeamSettings, clearPersonalSettings, clearTeamSettings, prepareTeamSettingsForServer } from "./settings-data";

beforeEach(() => {
    vi.clearAllMocks();
    state.config = {
        config: { apiKey: "old-key", channels: [{ id: "old", apiKey: "old-secret" }], proxyEnabled: true, proxyUrl: "http://localhost:9999" },
        webdav: { url: "https://dav.example", username: "me", password: "dav-key", directory: "backup", lastSyncedAt: "yesterday" },
    };
    state.commerce = { modelRoles: { removalApiKey: "remove-secret" }, policyPacks: [createBuiltInPolicyPack()], brands: [createDefaultBrand()], jobs: [{ id: "private-task" }], teamBrandIds: [] };
    state.prompts = { sources: [], schedule: { intervalMinutes: 60, lastFetchedAt: "runtime" } };
    state.theme = {
        theme: "dark",
        setTheme: (theme: string) => {
            state.theme.theme = theme;
        },
    };
});

describe("portable settings data", () => {
    it("never puts the enterprise-managed channel or its key into personal sync, team publishing or backups", () => {
        state.config.config = { ...state.config.config, channels: [{ id: "old", apiKey: "old-secret" }, { id: "managed-enterprise", apiKey: "sk-managed" }], models: ["old::a", "managed-enterprise::gpt-image-2"], imageModel: "managed-enterprise::gpt-image-2" };
        const personal = captureLocalPersonalSettings();
        const team = captureLocalTeamSettings();
        for (const payload of [personal, team]) expect(JSON.stringify(payload)).not.toContain("sk-managed");
        expect(personal.config.channels).toEqual([{ id: "old", apiKey: "old-secret" }]);
        expect(personal.config.models).toEqual(["old::a"]);
        // The default choice itself is not secret and follows the account.
        expect(personal.config.imageModel).toBe("managed-enterprise::gpt-image-2");
        expect(team.modelConfig?.channels).toEqual([{ id: "old", apiKey: "old-secret" }]);
        // The live configuration is untouched.
        expect(state.config.config.channels).toHaveLength(2);
    });
    it("includes provider credentials and model bindings while omitting machine proxy and runtime timestamps", () => {
        const snapshot = captureLocalPersonalSettings();
        expect(snapshot.config.apiKey).toBe("old-key");
        expect(snapshot.config.channels).toEqual([{ id: "old", apiKey: "old-secret" }]);
        expect(snapshot.config).not.toHaveProperty("proxyUrl");
        expect(snapshot.modelRoles).toBeUndefined();
        expect(snapshot.webdav?.password).toBe("dav-key");
        expect(snapshot.webdav).not.toHaveProperty("lastSyncedAt");
        expect(snapshot.promptSources?.schedule).toEqual({ intervalMinutes: 60 });
        expect(captureLocalTeamSettings()).not.toHaveProperty("jobs");
    });
    it("account restore replaces old secrets rather than filling missing fields from the prior account", async () => {
        await applyPersonalSettings({ config: { channels: [], apiKey: "new-key" } });
        expect(state.config.config.apiKey).toBe("new-key");
        expect(state.config.config.channels).toEqual([]);
        expect(state.config.webdav.password).toBe("");
        expect(state.commerce.modelRoles.removalApiKey).toBe("");
        expect(state.config.config.proxyUrl).toBe("http://localhost:9999");
        await clearPersonalSettings();
        expect(state.config.config.apiKey).toBe("");
        expect(state.commerce.jobs).toEqual([{ id: "private-task" }]);
    });
    it("ignores application of a no-longer-current account", async () => {
        const before = JSON.stringify(state.config);
        await applyPersonalSettings({ config: {} }, () => false);
        expect(JSON.stringify(state.config)).toBe(before);
    });
    it("does not erase restored legacy channels when no team document exists", async () => {
        await applyPersonalSettings({ config: { channels: [{ id: "legacy", apiKey: "test-secret" }] as any, textModel: "legacy::text" } });
        clearTeamSettings();
        expect(state.config.config.textModel).toBe("legacy::text");
        expect(state.config.config.channels[0].apiKey).toBe("test-secret");
    });
    it("adds immutable team versions without removing historical task and brand references", async () => {
        const old = captureLocalTeamSettings();
        const team = structuredClone(old);
        team.policyPack.id = "server-aoweisi-team-v9-123456abcdef";
        team.brands[0].id = "team-brand-original-v9";
        await applyTeamSettings(team, 9);
        expect(state.commerce.teamPolicyPackId).toBe(team.policyPack.id);
        expect(state.commerce.policyPacks.some((pack: any) => pack.id === old.policyPack.id)).toBe(true);
        expect(state.commerce.brands.some((brand: any) => brand.id === old.brands[0].id)).toBe(true);
        expect(state.commerce.jobs[0].id).toBe("private-task");
    });
    it("captures and applies team channels, defaults, and workflow roles", async () => {
        state.config.config = { ...state.config.config, channels: [{ id: "team", name: "Team", baseUrl: "https://models.example", apiKey: "team-secret", apiFormat: "openai", models: [{ name: "text", capability: "text" }] }], model: "team::text", imageModel: "team::text", videoModel: "team::text", textModel: "team::text", audioModel: "team::text" };
        state.commerce.modelRoles = { sceneModel: "team::text", repairModel: "", copyModel: "team::text", translationModel: "", complianceModel: "", removalApiUrl: "", removalApiKey: "" };
        const team = captureLocalTeamSettings();
        team.policyPack.id = "server-aoweisi-team-v1-test";
        expect(team.modelConfig?.channels[0].apiKey).toBe("team-secret");
        expect(team.modelConfig?.roles.sceneModel).toBe("team::text");
        team.modelConfig!.channels[0].models[0].supportsImageInput = true;
        await applyPersonalSettings({ config: { channels: [], textModel: "obsolete::text" } });
        await applyTeamSettings(team, 4);
        expect(state.config.config.channels[0].id).toBe("team");
        expect(state.config.config.textModel).toBe("team::text");
        expect(state.config.config.channels[0].apiKey).toBe("team-secret");
        expect(state.config.config.channels[0].models[0].supportsImageInput).toBe(true);
        expect(state.commerce.modelRoles.sceneModel).toBe("team::text");
        expect(state.commerce.modelRoles.repairModel).toBe("team::text");
    });
    it("uploads local attachments once, removes local keys, and never traverses product photos", async () => {
        const team = captureLocalTeamSettings();
        team.policyPack.references = [{ id: "ref", name: "rule", url: "blob:old", storageKey: "image:one", source: "upload", sheet: "", anchor: "", kind: "example" }];
        team.brands[0].logo = { id: "logo", name: "logo", url: "blob:old", storageKey: "image:one", source: "upload" };
        state.getBlob.mockResolvedValue(new Blob(["image"], { type: "image/png" }));
        const upload = vi.fn().mockResolvedValue({ id: "asset", url: "/api/config-vault/assets/team/" + "a".repeat(64), contentHash: "a".repeat(64), name: "rule", mimeType: "image/png", bytes: 5 });
        const result = await prepareTeamSettingsForServer(team, upload);
        expect(upload).toHaveBeenCalledTimes(1);
        expect(result.policyPack.references[0]).not.toHaveProperty("storageKey");
        expect(result.brands[0].logo?.url).toContain("/assets/team/");
        expect(team.brands[0].logo?.storageKey).toBe("image:one");
    });
    it("fails a missing local file instead of publishing an unusable blob URL", async () => {
        const team: TeamSettings = captureLocalTeamSettings();
        team.brands[0].logo = { id: "logo", name: "商标", url: "blob:gone", storageKey: "image:gone", source: "upload" };
        state.getBlob.mockResolvedValue(null);
        const upload = vi.fn();
        await expect(prepareTeamSettingsForServer(team, upload)).rejects.toThrow("本机附件已丢失");
        expect(upload).not.toHaveBeenCalled();
    });
});
