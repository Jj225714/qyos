/**
 * Enterprise SSO accounts receive a model-gateway channel carrying their own JAPI key from the config vault.
 * It lives in memory only, under this fixed id, separate from channels the user entered by hand: it is
 * fetched again on every sign-in / session restore and must never be persisted, synced or exported.
 */
export const MANAGED_CHANNEL_ID = "managed-enterprise";
const MODEL_PREFIX = `${MANAGED_CHANNEL_ID}::`;

type ChannelList = { channels?: { id?: string }[]; models?: string[] };

export function isManagedChannel(channel: { id?: string } | null | undefined) {
    return channel?.id === MANAGED_CHANNEL_ID;
}

/** A `channelId::model` value that points at the managed channel. */
export function isManagedModelValue(value: unknown): value is string {
    return typeof value === "string" && value.startsWith(MODEL_PREFIX);
}

/**
 * The configuration without the managed channel (and its entries in the derived `models` list).
 * Default-model choices such as `imageModel` are kept: they hold no secret and are restored with the channel.
 */
export function withoutManagedChannel<T extends ChannelList>(config: T): T {
    if (!config || typeof config !== "object") return config;
    const hasChannel = Array.isArray(config.channels) && config.channels.some(isManagedChannel);
    const hasModel = Array.isArray(config.models) && config.models.some(isManagedModelValue);
    if (!hasChannel && !hasModel) return config;
    return {
        ...config,
        ...(hasChannel ? { channels: config.channels!.filter((channel) => !isManagedChannel(channel)) } : {}),
        ...(hasModel ? { models: config.models!.filter((model) => !isManagedModelValue(model)) } : {}),
    };
}
