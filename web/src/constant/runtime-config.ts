// Runtime configuration access layer.
// Priority: window.__RUNTIME_CONFIG__ (injected by the container entrypoint) > build-time VITE_ variables > defaults.
// This supports both configuring the same image with docker run -e and injecting values during custom builds.
//
// Each analytics provider has its own variable; configured providers are enabled independently and all are disabled by default.
// Only GA4 and Baidu are supported. Both accept IDs only, and script URLs are assembled in code without arbitrary scripts or inline JavaScript.

type RuntimeConfig = {
    managedModelGatewayEnabled?: boolean;
    bmModelGatewayEnabled?: boolean;
    sub2apiModelGatewayEnabled?: boolean;
    gptImageJobsEnabled?: boolean;
    serverConfigEnabled?: boolean;
    enterpriseSsoEnabled?: boolean;
    enterpriseSsoLabel?: string;
    commercePolicyCatalogUrl?: string;
    commerceVisualPolicyCatalogUrl?: string;
    commerceCreativePolicyCatalogUrl?: string;
    ANALYTICS_GA4_ID?: string; // GA4 measurement ID (G-XXXX)
    ANALYTICS_BAIDU_ID?: string; // Baidu Analytics site ID
};

declare global {
    interface Window {
        __RUNTIME_CONFIG__?: RuntimeConfig;
    }
}

const runtime: RuntimeConfig = (typeof window !== "undefined" && window.__RUNTIME_CONFIG__) || {};

function read(key: keyof RuntimeConfig, buildTime: string | undefined, fallback = ""): string {
    const value = runtime[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof buildTime === "string" && buildTime.trim()) return buildTime.trim();
    return fallback;
}

export const ANALYTICS_GA4_ID = read("ANALYTICS_GA4_ID", import.meta.env.VITE_ANALYTICS_GA4_ID);
export const ANALYTICS_BAIDU_ID = read("ANALYTICS_BAIDU_ID", import.meta.env.VITE_ANALYTICS_BAIDU_ID);

export function getCommercePolicyCatalogUrl(): string | undefined {
    const value = typeof window !== "undefined" ? window.__RUNTIME_CONFIG__?.commerceCreativePolicyCatalogUrl || window.__RUNTIME_CONFIG__?.commerceVisualPolicyCatalogUrl || window.__RUNTIME_CONFIG__?.commercePolicyCatalogUrl : undefined;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getBmModelGatewayEnabled(): boolean {
    return import.meta.env.DEV === true || (typeof window !== "undefined" && window.__RUNTIME_CONFIG__?.bmModelGatewayEnabled === true);
}

export function getManagedModelGatewayEnabled(): boolean {
    // Retired: stale deployment config must never re-enable access-code gating.
    return false;
}

export function getSub2apiModelGatewayEnabled(): boolean {
    return import.meta.env.DEV === true || (typeof window !== "undefined" && window.__RUNTIME_CONFIG__?.sub2apiModelGatewayEnabled === true);
}

/** Enterprise sign-in (Casdoor via the config vault). Off unless the server's runtime config enables it. */
export function getEnterpriseSsoEnabled(): boolean {
    return typeof window !== "undefined" && window.__RUNTIME_CONFIG__?.enterpriseSsoEnabled === true;
}

export function getEnterpriseSsoLabel(): string {
    return read("enterpriseSsoLabel", undefined, "企业账号登录（飞书 / 企业微信 / 钉钉）");
}

export function getGptImageJobsEnabled(): boolean {
    return typeof window !== "undefined" && window.__RUNTIME_CONFIG__?.gptImageJobsEnabled === true;
}

export function getServerConfigEnabled(): boolean {
    return typeof window !== "undefined" && window.__RUNTIME_CONFIG__?.serverConfigEnabled === true;
}
