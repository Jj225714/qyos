import { describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ blobs: [] as Blob[] }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("file-saver", () => ({ saveAs: (blob: Blob) => saved.blobs.push(blob) }));
import { createModelChannel, defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { MANAGED_CHANNEL_ID } from "@/lib/managed-channel";
import { exportAppConfig } from "./config-file";

describe("configuration export", () => {
    it("leaves out the enterprise-managed channel and its key", async () => {
        const mine = createModelChannel({ id: "mine", name: "我的渠道", baseUrl: "https://llm.example/v1", apiKey: "sk-manual", models: [{ name: "img", capability: "image" }] });
        const managed = createModelChannel({ id: MANAGED_CHANNEL_ID, name: "企业模型网关", baseUrl: "https://llm.example/v1", apiKey: "sk-managed", models: [{ name: "gpt-image-2", capability: "image" }] });
        useConfigStore.setState({ config: { ...defaultConfig, channels: [mine, managed], models: ["mine::img", `${MANAGED_CHANNEL_ID}::gpt-image-2`] } });
        exportAppConfig();
        const text = await saved.blobs.at(-1)!.text();
        expect(text).not.toContain("sk-managed");
        expect(JSON.parse(text).config.channels.map((channel: { id: string }) => channel.id)).toEqual(["mine"]);
        expect(useConfigStore.getState().config.channels).toHaveLength(2);
    });
});
