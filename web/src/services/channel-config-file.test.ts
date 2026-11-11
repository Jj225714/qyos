import { describe, expect, it, vi } from "vitest";
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import { configForBrowserStorage, createModelChannel, defaultConfig, normalizePersonalConfig, type AiConfig } from "@/stores/use-config-store";
import { MANAGED_CHANNEL_ID, withoutManagedChannel } from "@/lib/managed-channel";
import { applyManagedChannelFile, mergeChannelConfigFile } from "./channel-config-file";

const input = { app: "infinite-canvas-channel", version: 1, channel: { name: "Sub2API", baseUrl: "https://llm.zhitouzhuan.com/v1", apiKey: "test-only", models: [{ name: "image-model", capability: "image" }, { name: "text-model", capability: "text" }] } };
describe("personal channel import", () => {
    it("preserves existing channels and preferences, binding the imported models", () => {
        const config = { ...defaultConfig, proxyUrl: "http://localhost:23210", quality: "low" };
        const result = mergeChannelConfigFile(config, input);
        expect(result.channels.slice(0, -1)).toEqual(config.channels);
        expect(result.proxyUrl).toBe(config.proxyUrl);
        expect(result.quality).toBe("low");
        const channel = result.channels.at(-1)!;
        expect(result.imageModel).toBe(`${channel.id}::image-model`);
        expect(result.textModel).toBe(`${channel.id}::text-model`);
        expect(config.channels).toHaveLength(defaultConfig.channels.length);
        expect(mergeChannelConfigFile(result, input)).toEqual(result);
    });
    it.each(["http://llm.zhitouzhuan.com/v1", "https://user:password@llm.zhitouzhuan.com/v1", "https://llm.zhitouzhuan.com/v1?key=unsafe"])("rejects unsafe address %s", (baseUrl) => {
        expect(() => mergeChannelConfigFile(defaultConfig, { ...input, channel: { ...input.channel, baseUrl } })).toThrow();
    });
    it("rejects malformed input without changing the configuration", () => {
        for (const bad of [null, {}, { ...input, channel: { ...input.channel, models: [null] } }, { ...input, channel: { ...input.channel, apiKey: "" } }]) expect(() => mergeChannelConfigFile(defaultConfig, bad)).toThrow();
    });
});

describe("enterprise-managed channel", () => {
    const managed = (apiKey = "sk-own", models = [{ name: "gpt-image-2", capability: "image" }, { name: "gpt-5", capability: "text" }]) => ({ app: "infinite-canvas-channel", version: 1, channel: { name: "企业模型网关", baseUrl: "https://llm.zhitouzhuan.com/v1", apiKey, models } });
    const manual = createModelChannel({ id: "mine", name: "我的渠道", baseUrl: "https://llm.zhitouzhuan.com/v1", apiKey: "sk-manual", models: [{ name: "my-image", capability: "image" }] });

    it("uses its own fixed id and never replaces a hand-entered channel at the same address", () => {
        const config = { ...defaultConfig, channels: [manual], imageModel: "mine::my-image", model: "mine::my-image", textModel: "" };
        const result = applyManagedChannelFile(config, managed());
        expect(result.channels.map((channel) => channel.id)).toEqual(["mine", MANAGED_CHANNEL_ID]);
        expect(result.channels[0]).toEqual(manual);
        expect(result.channels[1]).toMatchObject({ id: MANAGED_CHANNEL_ID, apiKey: "sk-own", baseUrl: "https://llm.zhitouzhuan.com/v1" });
        // A working image default is kept; the missing text default is filled on first add.
        expect(result.imageModel).toBe("mine::my-image");
        expect(result.model).toBe("mine::my-image");
        expect(result.textModel).toBe(`${MANAGED_CHANNEL_ID}::gpt-5`);
        // A user channel file import also leaves the managed channel alone.
        const imported = mergeChannelConfigFile(result, input);
        expect(imported.channels.find((channel) => channel.id === MANAGED_CHANNEL_ID)?.apiKey).toBe("sk-own");
        expect(imported.channels.find((channel) => channel.id === "mine")?.apiKey).toBe("test-only");
    });

    it("sets defaults only on first add when none is configured, and refreshes keep the user's choices", () => {
        const empty = { ...defaultConfig, channels: [], model: "", imageModel: "", textModel: "" };
        const first = applyManagedChannelFile(empty, managed());
        expect(first.imageModel).toBe(`${MANAGED_CHANNEL_ID}::gpt-image-2`);
        expect(first.model).toBe(`${MANAGED_CHANNEL_ID}::gpt-image-2`);
        expect(first.textModel).toBe(`${MANAGED_CHANNEL_ID}::gpt-5`);
        const chosen = { ...first, imageModel: "", model: "", textModel: "" };
        const refreshed = applyManagedChannelFile(chosen, managed("sk-rotated"));
        expect(refreshed.channels.find((channel) => channel.id === MANAGED_CHANNEL_ID)?.apiKey).toBe("sk-rotated");
        expect(refreshed).toMatchObject({ imageModel: "", model: "", textModel: "" });
        expect(applyManagedChannelFile(refreshed, managed("sk-rotated"))).toBe(refreshed);
        // Restoring after settings were re-applied does not pick defaults either.
        const restored = applyManagedChannelFile({ ...empty }, managed(), { setDefaults: false });
        expect(restored).toMatchObject({ imageModel: "", textModel: "" });
        // The default config's keyless OpenAI channel does not count as a configured default.
        expect(applyManagedChannelFile(defaultConfig, managed()).imageModel).toBe(`${MANAGED_CHANNEL_ID}::gpt-image-2`);
    });

    it("is never written to browser storage, while the chosen default survives a reload", () => {
        const config = applyManagedChannelFile({ ...defaultConfig, channels: [manual] }, managed());
        const stored = { config: configForBrowserStorage(config) as AiConfig };
        expect(JSON.stringify(stored)).not.toContain("sk-own");
        expect(stored.config.channels.map((channel) => channel.id)).toEqual(["mine"]);
        expect(stored.config.models.some((value) => value.startsWith(`${MANAGED_CHANNEL_ID}::`))).toBe(false);
        const reloaded = normalizePersonalConfig(stored.config);
        expect(reloaded.textModel).toBe(`${MANAGED_CHANNEL_ID}::gpt-5`);
        expect(withoutManagedChannel(config).channels).toEqual([manual]);
    });
});
