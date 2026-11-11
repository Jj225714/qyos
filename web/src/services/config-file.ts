import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { useConfigStore, normalizePersonalConfig, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";
import { mergeChannelConfigFile } from "./channel-config-file";
import { withoutManagedChannel } from "@/lib/managed-channel";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

export function exportAppConfig() {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    // The enterprise-managed channel carries a per-session key and is never exported.
    const data: AppConfigFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config: withoutManagedChannel(config), webdav, promptSources: { sources, schedule } };
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

export async function importAppConfig(file: File) {
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    if ((data as { app: string })?.app === "infinite-canvas-channel") {
        useConfigStore.setState({ config: mergeChannelConfigFile(useConfigStore.getState().config, data) });
        return;
    }
    if (data.app !== "infinite-canvas" || data.version !== 1 || !data.config || !data.webdav || !data.promptSources) throw new Error(i18n.t("config.invalidFile"));
    useConfigStore.setState({ config: normalizePersonalConfig(data.config), webdav: data.webdav });
    usePromptSourceStore.setState(data.promptSources);
}
