import type { AiConfig, ModelChannel, WebdavSyncConfig } from "@/stores/use-config-store";
import type { PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";
import type { BrandProfile, ModelRoleConfig, PolicyPack } from "./commerce";

export type TeamModelDefaults = Pick<AiConfig, "model" | "imageModel" | "videoModel" | "textModel" | "audioModel">;
export type TeamModelConfig = { channels: ModelChannel[]; defaults: TeamModelDefaults; roles: ModelRoleConfig };

export type PersonalSettings = {
    config: Partial<AiConfig>;
    modelRoles?: ModelRoleConfig;
    webdav?: Omit<WebdavSyncConfig, "lastSyncedAt">;
    promptSources?: { sources: PromptSource[]; schedule: Pick<PromptSourceSchedule, "intervalMinutes"> };
    appearance?: { theme: "light" | "dark"; locale: "zh-CN" | "en-US" };
};
export type TeamSettings = { policyPack: PolicyPack; brands: BrandProfile[]; modelConfig?: TeamModelConfig };
export type SettingsSection<T> = { revision: number; savedAt: string | null; value: T | null };
/** `managed`: signed in through enterprise SSO; the vault then supplies the employee's own model-gateway channel. */
export type SettingsUser = { id: number; email: string; managed?: boolean };
export type SettingsEnvelope = {
    schemaVersion: 2;
    user: SettingsUser;
    permissions: { manageTeam: boolean };
    personal: SettingsSection<PersonalSettings>;
    team: SettingsSection<TeamSettings>;
    draft?: SettingsSection<TeamSettings>;
};
export type SettingsVersions = { user: SettingsUser; personal: number; team: number; draft?: number; permissions: { manageTeam: boolean } };
export type SettingsAsset = { id: string; url: string; contentHash: string; name: string; mimeType: string; bytes: number };
