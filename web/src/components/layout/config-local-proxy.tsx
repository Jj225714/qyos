import { App, Button, Form, Input, Switch } from "antd";
import { Copy, Network, Wifi } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import { getLocalProxyToken, setLocalProxyToken } from "@/lib/local-proxy-auth";
import { testLocalProxy } from "@/services/api/local-proxy";
import { DEFAULT_LOCAL_PROXY_URL, normalizeLocalProxyUrl, useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";

export function ConfigLocalProxy() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const [testing, setTesting] = useState(false);
    const [token, setToken] = useState(getLocalProxyToken);
    const config = useConfigStore((state) => state.config);
    const webdav = useConfigStore((state) => state.webdav);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const command = localProxyCommand(config, webdav);

    const testProxy = async () => {
        setTesting(true);
        try {
            message.success(t("config.proxy.available", { proxy: await testLocalProxy(config.proxyUrl, token) }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.proxy.unreachable"));
        } finally {
            setTesting(false);
        }
    };

    return (
        <Form layout="vertical" requiredMark={false}>
            <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <Network className="size-4" />
                            {t("config.proxy.title")}
                        </div>
                        <div className="mt-1 text-xs text-stone-500">{t("config.proxy.description")}</div>
                    </div>
                    <Switch checked={config.proxyEnabled} onChange={(checked) => updateConfig("proxyEnabled", checked)} />
                </div>
                {config.proxyEnabled ? (
                    <>
                        <div className="mt-3 rounded-md bg-stone-100 px-3 py-2 dark:bg-stone-900">
                            <div className="mb-1 text-xs text-stone-500">{t("config.proxy.startHint")}</div>
                            <div className="flex items-center justify-between gap-3">
                                <code className="min-w-0 break-all text-xs">{command}</code>
                                <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => copyText(command)} />
                            </div>
                            <div className="mt-1 text-xs text-stone-500">{t("config.proxy.targetHint")}</div>
                        </div>
                        <Form.Item label={t("config.proxy.address")} extra={t("config.proxy.addressDescription")} className="mt-3 mb-0">
                            <Input
                                value={config.proxyUrl}
                                placeholder={DEFAULT_LOCAL_PROXY_URL}
                                onChange={(event) => updateConfig("proxyUrl", event.target.value)}
                                onBlur={(event) => updateConfig("proxyUrl", normalizeLocalProxyUrl(event.target.value) || DEFAULT_LOCAL_PROXY_URL)}
                            />
                        </Form.Item>
                        <Form.Item label={t("config.proxy.token")} extra={t("config.proxy.tokenDescription")} className="mt-3 mb-0">
                            <Input.Password
                                value={token}
                                autoComplete="off"
                                placeholder="cp_…"
                                onChange={(event) => {
                                    setToken(event.target.value);
                                    setLocalProxyToken(event.target.value);
                                }}
                            />
                        </Form.Item>
                        <Button className="mt-3" icon={<Wifi className="size-4" />} loading={testing} onClick={() => void testProxy()}>
                            {t("config.proxy.test")}
                        </Button>
                        <div className="mt-3 text-xs text-stone-500">{t("config.proxy.channelHint")}</div>
                    </>
                ) : null}
            </section>
        </Form>
    );
}

/** Origins the proxy should allow: every configured channel and the WebDAV server (scheme://host[:port]). */
export function proxyTargets(config: Pick<AiConfig, "channels" | "baseUrl">, webdav?: Pick<WebdavSyncConfig, "url">) {
    const origins = new Set<string>();
    for (const raw of [config.baseUrl, ...(config.channels || []).map((channel) => channel.baseUrl), webdav?.url]) {
        try {
            const url = new URL(String(raw || "").trim());
            if (url.protocol === "http:" || url.protocol === "https:") origins.add(url.origin);
        } catch {
            /* not configured */
        }
    }
    return [...origins];
}

export function localProxyCommand(config: Pick<AiConfig, "channels" | "baseUrl" | "proxyUrl">, webdav?: Pick<WebdavSyncConfig, "url">) {
    const parts = ["node canvas-proxy/index.js", `--allow-origin ${typeof location === "undefined" ? "<站点地址>" : location.origin}`];
    for (const target of proxyTargets(config, webdav)) parts.push(`--allow-target ${target}`);
    try {
        const port = new URL(normalizeLocalProxyUrl(config.proxyUrl) || DEFAULT_LOCAL_PROXY_URL).port;
        if (port && port !== new URL(DEFAULT_LOCAL_PROXY_URL).port) parts.push(`--port ${port}`);
    } catch {
        /* keep defaults */
    }
    return parts.join(" ");
}
