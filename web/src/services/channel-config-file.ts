import { createModelChannel, isAiConfigReady, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { MANAGED_CHANNEL_ID, isManagedChannel } from "@/lib/managed-channel";

/** Validates an `infinite-canvas-channel` v1 file and returns its channel fields. */
function parseChannelConfigFile(input: unknown) {
    const data = input as { app?: string; version?: number; channel?: Record<string, unknown> } | null;
    const c = data?.channel;
    if (data?.app !== "infinite-canvas-channel" || data.version !== 1 || !c || typeof c.baseUrl !== "string" || typeof c.apiKey !== "string" || !c.apiKey.trim() || !Array.isArray(c.models)) throw new Error("无效的渠道配置文件");
    const url = new URL(c.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("无效的渠道接口地址");
    const models = c.models as { name?: unknown; capability?: unknown }[];
    if (!models.every((model) => model && typeof model.name === "string" && ["image", "text"].includes(model.capability as string))) throw new Error("无效的渠道模型列表");
    return { name: typeof c.name === "string" ? c.name : "Sub2API", baseUrl: c.baseUrl.replace(/\/+$/, ""), apiKey: c.apiKey, models: models.map((model) => ({ name: model.name as string, capability: model.capability as "image" | "text" })) };
}

/** Import one personal channel without replacing the workspace's other settings. */
export function mergeChannelConfigFile(config: AiConfig, input: unknown): AiConfig {
    const parsed = parseChannelConfigFile(input);
    const existing = config.channels.find((channel) => !isManagedChannel(channel) && channel.baseUrl.replace(/\/+$/, "") === parsed.baseUrl);
    const channel = createModelChannel({ id: existing?.id, ...parsed, apiFormat: "openai", provider: "general" });
    const channels = existing ? config.channels.map((item) => (item.id === existing.id ? channel : item)) : [...config.channels, channel];
    const image = channel.models.find((model) => model.capability === "image");
    const text = channel.models.find((model) => model.capability === "text");
    return {
        ...config,
        channels,
        models: [...new Set([...config.models, ...channel.models.map((model) => `${channel.id}::${model.name}`)])],
        ...(image ? { model: `${channel.id}::${image.name}`, imageModel: `${channel.id}::${image.name}` } : {}),
        ...(text ? { textModel: `${channel.id}::${text.name}` } : {}),
    };
}

/**
 * Adds or refreshes the enterprise-managed channel under its fixed id. It never merges with or replaces a channel
 * the user entered, even at the same address. Default models are chosen only when the channel is added for the first
 * time (`setDefaults`) and the user has no working default of that kind yet; later refreshes keep the user's choices.
 */
export function applyManagedChannelFile(config: AiConfig, input: unknown, { setDefaults = true }: { setDefaults?: boolean } = {}): AiConfig {
    const parsed = parseChannelConfigFile(input);
    const channel: ModelChannel = createModelChannel({ id: MANAGED_CHANNEL_ID, ...parsed, apiFormat: "openai", provider: "general" });
    const existed = config.channels.some(isManagedChannel);
    const previous = config.channels.find(isManagedChannel);
    if (previous && JSON.stringify(previous) === JSON.stringify(channel)) return config;
    const channels = existed ? config.channels.map((item) => (isManagedChannel(item) ? channel : item)) : [...config.channels, channel];
    const next: AiConfig = { ...config, channels, models: [...new Set([...config.models.filter((value) => !value.startsWith(`${MANAGED_CHANNEL_ID}::`)), ...channel.models.map((model) => `${channel.id}::${model.name}`)])] };
    if (existed || !setDefaults) return next;
    // "Has a default": it already works, or it is a remembered choice inside the managed channel itself.
    const hasDefault = (value: string) => Boolean(value) && (isAiConfigReady(next, value) || channel.models.some((model) => value === `${channel.id}::${model.name}`));
    const image = channel.models.find((model) => model.capability === "image");
    const text = channel.models.find((model) => model.capability === "text");
    if (image && !hasDefault(next.imageModel)) {
        next.imageModel = `${channel.id}::${image.name}`;
        if (!hasDefault(next.model)) next.model = next.imageModel;
    }
    if (text && !hasDefault(next.textModel)) next.textModel = `${channel.id}::${text.name}`;
    return next;
}
