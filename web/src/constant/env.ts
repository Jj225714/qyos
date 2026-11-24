export const APP_VERSION = __APP_VERSION__ || "dev";

export const DOCS_URL = import.meta.env.VITE_DOC_URL || "https://docs.canvas.best";

// Official plugin registry: shipped with this app as same-origin static files (web/public/official-plugins, generated
// by plugins/canvas/registry `npm run release-web`). Bundles run only if their SHA-256 matches
// official-plugin-lock.json compiled into this build. VITE_PLUGIN_REGISTRY_URL may point elsewhere (for example this
// repository's plugins-dist branch); the same lock still decides what may run.
export const PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL || `${import.meta.env.BASE_URL || "/"}official-plugins/official-plugins.json`;
