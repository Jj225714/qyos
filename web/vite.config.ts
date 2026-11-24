/// <reference types="vitest/config" />
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import { createProviderHandler } from "../provider-relay/server.mjs";

import { parseChangelog } from "./src/lib/release";
import { BM_MODEL_GATEWAY_PREFIX, BM_MODEL_GATEWAY_TARGET, bmModelGatewayRequestStatus, isBmModelGatewayRedirect } from "./src/lib/bm-model-gateway";
import { SUB2API_MODEL_GATEWAY_PREFIX, SUB2API_MODEL_GATEWAY_TARGET, sub2apiModelGatewayRequestStatus } from "./src/lib/sub2api-model-gateway";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

export function bmModelGatewayGuard(prefix = BM_MODEL_GATEWAY_PREFIX, check = bmModelGatewayRequestStatus): Plugin {
    return {
        name: `model-gateway-guard:${prefix}`,
        apply: "serve",
        configureServer(server) {
            // Before Vite's middleware: inspect the original, undecoded request target.
            server.middlewares.use((req, res, next) => {
                if (!req.url?.startsWith(prefix)) return next();
                const status = check({
                    url: req.url,
                    method: req.method,
                    authorization: req.headers.authorization,
                    host: req.headers.host,
                    origin: req.headers.origin,
                    referer: req.headers.referer,
                    fetchSite: typeof req.headers["sec-fetch-site"] === "string" ? req.headers["sec-fetch-site"] : undefined,
                    remoteAddress: req.socket.remoteAddress,
                });
                if (status) {
                    res.writeHead(status, { "Cache-Control": "no-store" }).end();
                    return;
                }
                next();
            });
        },
    };
}

export function bmModelGatewayProxy(prefix = BM_MODEL_GATEWAY_PREFIX, target = BM_MODEL_GATEWAY_TARGET): ProxyOptions {
    return {
        target,
        changeOrigin: true,
        secure: true,
        followRedirects: false,
        ws: false,
        rewrite: (path) => path.slice(prefix.length),
        configure(proxy) {
            proxy.on("proxyReq", (proxyReq) => {
                for (const header of ["origin", "referer", "cookie"]) proxyReq.removeHeader(header);
            });
            proxy.on("proxyRes", (upstream, _req, res) => {
                delete upstream.headers.location;
                delete upstream.headers["set-cookie"];
                if (isBmModelGatewayRedirect(upstream.statusCode)) {
                    res.writeHead(502, { "Cache-Control": "no-store" }).end();
                    upstream.resume();
                }
            });
            // Vite registers its error logger after configure; keep its diagnostics generic.
            proxy.on("error", (error, _req, res) => {
                error.message = "BM model gateway upstream failure";
                error.stack = error.message;
                if ("writeHead" in res && !res.headersSent) res.writeHead(502, { "Cache-Control": "no-store" }).end();
            });
        },
    };
}

function localWorkspaceMigration(): Plugin {
    const directory = "F:/AIVIBI/sanheai/backups/workspace-transfer-private";
    const loopback = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
    return {
        name: "local-workspace-migration",
        apply: "serve",
        configureServer(server) {
            const bootstrapPath = resolve(directory, "bootstrap.json");
            server.watcher.add(bootstrapPath);
            const reload = (path: string) => {
                if (resolve(path) === bootstrapPath) server.ws.send({ type: "full-reload" });
            };
            server.watcher.on("add", reload);
            server.watcher.on("change", reload);
            server.middlewares.use("/__local-workspace-migration", async (req, res) => {
                res.setHeader("Cache-Control", "no-store");
                const address = req.socket.remoteAddress;
                try {
                    const host = new URL(`http://${req.headers.host}`);
                    const source = new URL(req.headers.origin || req.headers.referer || "");
                    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address || "") || !loopback(host.hostname) || !loopback(source.hostname) || source.host !== host.host) {
                        res.statusCode = 403;
                        res.end();
                        return;
                    }
                    let bootstrap;
                    try {
                        bootstrap = JSON.parse(readFileSync(resolve(directory, "bootstrap.json"), "utf8"));
                    } catch {
                        res.statusCode = 204;
                        res.end();
                        return;
                    }
                    if (bootstrap.authorized !== true || typeof bootstrap.id !== "string" || !Number.isFinite(Date.parse(bootstrap.expiresAt)) || Date.parse(bootstrap.expiresAt) <= Date.now()) {
                        res.statusCode = 204;
                        res.end();
                        return;
                    }
                    if (req.method === "GET") {
                        try {
                            const previous = JSON.parse(readFileSync(resolve(directory, "result.json"), "utf8"));
                            if (previous.id === bootstrap.id && previous.status === "uploaded") {
                                res.statusCode = 204;
                                res.end();
                                return;
                            }
                        } catch {
                            /* No completed migration yet. */
                        }
                        res.setHeader("Content-Type", "application/json");
                        res.end(JSON.stringify(bootstrap));
                        return;
                    }
                    if (req.method === "POST") {
                        let body = "";
                        for await (const chunk of req) {
                            body += chunk.toString();
                            if (body.length > 32768) {
                                res.statusCode = 413;
                                res.end();
                                return;
                            }
                        }
                        const result = JSON.parse(body);
                        if (result.id !== bootstrap.id || !["uploaded", "error"].includes(result.status)) {
                            res.statusCode = 400;
                            res.end();
                            return;
                        }
                        const safe = {
                            id: bootstrap.id,
                            status: result.status,
                            at: new Date().toISOString(),
                            bytes: Number(result.bytes) || 0,
                            localKeys: Number(result.localKeys) || 0,
                            counts: Object.fromEntries(["jobs", "canvases", "rulePacks", "assets", "whiteRecords"].map((key) => [key, Number.isSafeInteger(result.counts?.[key]) && result.counts[key] >= 0 ? result.counts[key] : 0])),
                            stores: Array.isArray(result.stores)
                                ? result.stores
                                      .filter((s: { name: unknown; records: unknown }) => typeof s.name === "string" && /^[\w-]+$/.test(s.name) && Number.isSafeInteger(s.records))
                                      .map((s: { name: string; records: number }) => ({ name: s.name, records: s.records }))
                                : [],
                            ...(result.status === "error" ? { error: "migration_failed" } : {}),
                        };
                        writeFileSync(resolve(directory, "result.json"), JSON.stringify({ ...safe, sha256: typeof result.sha256 === "string" && /^[a-f0-9]{64}$/.test(result.sha256) ? result.sha256 : undefined }, null, 2));
                        res.statusCode = 204;
                        res.end();
                        return;
                    }
                    res.statusCode = 405;
                    res.end();
                } catch {
                    res.statusCode = 400;
                    res.end();
                }
            });
        },
    };
}

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [
        react(),
        bmModelGatewayGuard(),
        bmModelGatewayGuard(SUB2API_MODEL_GATEWAY_PREFIX, sub2apiModelGatewayRequestStatus),
        {
            name: "personal-provider-relay",
            configureServer(server) {
                server.middlewares.use(createProviderHandler());
            },
            configurePreviewServer(server) {
                server.middlewares.use(createProviderHandler());
            },
        },
        localPluginsManifest(),
        localWorkspaceMigration(),
    ],
    server: { proxy: { [BM_MODEL_GATEWAY_PREFIX]: bmModelGatewayProxy(), [SUB2API_MODEL_GATEWAY_PREFIX]: bmModelGatewayProxy(SUB2API_MODEL_GATEWAY_PREFIX, SUB2API_MODEL_GATEWAY_TARGET) } },
    preview: { proxy: {} },
    // These two files use node:test, not Vitest; they run with `npm run test:node`.
    test: { exclude: ["**/node_modules/**", "**/dist/**", "tests/settings-category-model-boundary.test.mjs", "tests/settings-category-model-preservation.test.mjs"] },
    build: { rollupOptions: { input: { main: resolve(webDir, "index.html"), "workspace-transfer": resolve(webDir, "workspace-transfer.html"), "channel-setup": resolve(webDir, "channel-setup.html") } } },
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});
