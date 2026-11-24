import { getLocalProxyToken, verifyLocalProxy } from "@/lib/local-proxy-auth";
import { normalizeLocalProxyUrl } from "@/stores/use-config-store";

/** Handshake with the configured proxy and token; refuses old proxies without token/origin protection. */
export async function testLocalProxy(proxyUrl: string, token = getLocalProxyToken()) {
    const { proxy, version } = await verifyLocalProxy(normalizeLocalProxyUrl(proxyUrl), token);
    return `${proxy} v${version}`;
}
