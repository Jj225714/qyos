import { CONFIG_STORE_KEY, buildApiUrl, useConfigStore } from "@/stores/use-config-store";
import { mergeChannelConfigFile } from "@/services/channel-config-file";
import { installLocalProxyAuth } from "@/lib/local-proxy-auth";

installLocalProxyAuth();

const status = document.getElementById("status")!;
const token = new URLSearchParams(location.hash.slice(1)).get("setup");
history.replaceState(null, "", location.pathname);

async function configure() {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("请通过本次提供的私密配置链接打开此页面。");
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const response = await fetch("/api/channel-setup/claim", { method: "POST", headers, credentials: "omit", cache: "no-store", redirect: "error" });
    if (!response.ok) throw new Error(response.status === 410 ? "此配置链接已完成或已过期。" : "暂时无法领取个人配置，请重新打开私密配置链接。");
    const input = await response.json();
    const current = useConfigStore.getState().config;
    const config = mergeChannelConfigFile(current, input);
    const channel = config.channels.find((c) => c.baseUrl === "https://llm.zhitouzhuan.com/v1");
    if (!channel || !config.imageModel.endsWith("::gpt-image-2") || !config.textModel.endsWith("::gpt-5.5")) throw new Error("渠道配置不完整，已保留原配置。");
    status.textContent = "正在验证模型连接…";
    const modelsResponse = await fetch(buildApiUrl(channel.baseUrl, "/models"), { headers: { Authorization: `Bearer ${channel.apiKey}` }, credentials: "omit", redirect: "error" });
    if (!modelsResponse.ok) throw new Error("模型连接验证失败，已保留原配置。");
    const models = (await modelsResponse.json()).data;
    if (!Array.isArray(models) || !["gpt-image-2", "gpt-5.5"].every((id) => models.some((model) => model.id === id))) throw new Error("所需图片或文本模型暂不可用，已保留原配置。");
    const previous = localStorage.getItem(CONFIG_STORE_KEY);
    if (previous && !localStorage.getItem(`${CONFIG_STORE_KEY}:before-sub2api`)) localStorage.setItem(`${CONFIG_STORE_KEY}:before-sub2api`, previous);
    useConfigStore.setState({ config });
    const saved = JSON.parse(localStorage.getItem(CONFIG_STORE_KEY) || "null")?.state?.config;
    if (saved?.imageModel !== config.imageModel || saved?.textModel !== config.textModel || !saved?.channels?.some((c: { id: string; apiKey: string }) => c.id === channel.id && c.apiKey === channel.apiKey)) throw new Error("浏览器未能保存渠道配置，请检查存储权限。");
    const keyHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(channel.apiKey))), (b) => b.toString(16).padStart(2, "0")).join("");
    const receipt = await fetch("/api/channel-setup/complete", { method: "POST", headers, credentials: "omit", redirect: "error", body: JSON.stringify({ saved: true, imageModel: "gpt-image-2", textModel: "gpt-5.5", keyHash }) });
    if (!receipt.ok) throw new Error("渠道已保存，但完成回执未送达。可以返回工作区使用。");
    status.textContent = "配置完成，正在返回生图工作区…";
    location.replace("/canvas");
}
configure().catch((error) => { status.textContent = error instanceof Error ? error.message : "配置未完成，请重新打开私密配置链接。"; });
