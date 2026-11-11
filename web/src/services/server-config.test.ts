import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PersonalSettings, TeamSettings } from "@/types/settings-sync";

const fixtures = vi.hoisted(() => ({
    personal: { config: { apiKey: "legacy-secret", proxyUrl: "http://localhost:9999" }, webdav: { url: "https://dav.test", username: "old", password: "legacy-dav", directory: "test" } } as PersonalSettings,
    team: { policyPack: { id: "legacy-policy" }, brands: [] } as unknown as TeamSettings,
    listener: (() => {}) as () => void,
    hydrate: vi.fn(async () => {}),
    backups: new Map<string, string>(),
    storeBackup: vi.fn(async (key: string, value: string) => { fixtures.backups.set(key, value); }),
    // Minimal live config store: the managed channel is added, restored and removed through it.
    aiStore: (() => {
        type Channel = { id: string; baseUrl: string; apiKey: string; [key: string]: unknown };
        type State = { config: { channels: Channel[]; [key: string]: unknown } };
        let state: State = { config: { channels: [] } };
        const listeners = new Set<(next: State, prev: State) => void>();
        return {
            getState: () => state,
            setState: (patch: Partial<State>) => { const prev = state; state = { ...state, ...patch }; listeners.forEach((listener) => listener(state, prev)); },
            subscribe: (listener: (next: State, prev: State) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
            reset: () => { state = { config: { channels: [] } }; listeners.clear(); },
        };
    })(),
}));
vi.mock("@/lib/localforage-storage", () => ({ localForageStorage: { getItem: async (key: string) => fixtures.backups.get(key) ?? null, setItem: (key: string, value: string) => fixtures.storeBackup(key, value), removeItem: async (key: string) => { fixtures.backups.delete(key); } } }));
vi.mock("@/stores/use-config-store", () => ({ normalizePersonalConfig: (value: unknown) => value, useConfigStore: fixtures.aiStore }));
// Real merge semantics are covered in channel-config-file.test.ts; here only the fixed id matters.
vi.mock("./channel-config-file", () => ({
    applyManagedChannelFile: (config: { channels: { id: string }[] }, file: { channel?: { apiKey?: unknown } }) => {
        if (typeof file?.channel?.apiKey !== "string") throw new Error("invalid");
        return { ...config, channels: [...config.channels.filter((c) => c.id !== "managed-enterprise"), { ...file.channel, id: "managed-enterprise" }] };
    },
}));
vi.mock("./settings-data", () => ({
    waitForSettingsHydration: () => fixtures.hydrate(),
    captureLocalPersonalSettings: () => fixtures.personal,
    captureLocalTeamSettings: () => fixtures.team,
    applyPersonalSettings: vi.fn(async (value, isCurrent = () => true) => { if (isCurrent()) { fixtures.personal = structuredClone(value); fixtures.listener(); } }),
    applyTeamSettings: vi.fn(async (value, _revision, isCurrent = () => true) => { if (isCurrent()) fixtures.team = structuredClone(value); }),
    clearPersonalSettings: vi.fn(async (isCurrent = () => true) => { if (isCurrent()) { fixtures.personal = { config: { apiKey: "" } }; fixtures.listener(); } }),
    clearTeamSettings: vi.fn(() => { fixtures.team = { policyPack: { id: "default" }, brands: [] } as unknown as TeamSettings; }),
    subscribePersonalSettings: (listener: () => void) => { fixtures.listener = listener; return () => { fixtures.listener = () => {}; }; },
}));

const user = { id: 1, email: "owner@example.test" };
const other = { id: 2, email: "other@example.test" };
const remotePersonal = { config: { apiKey: "server-secret", quality: "auto" }, webdav: { url: "https://dav.test", username: "owner", password: "server-dav", directory: "test" } } satisfies PersonalSettings;
const remoteTeam = { policyPack: { id: "team-policy" }, brands: [] } as unknown as TeamSettings;
const section = <T>(value: T | null, revision = 3) => ({ revision, value, savedAt: "2026-09-30T00:00:00Z" });
const envelope = (personal: PersonalSettings | null = remotePersonal, revision = 3, account = user) => ({ schemaVersion: 2, user: account, permissions: { manageTeam: true }, personal: section(personal, revision), team: section(remoteTeam, 2), draft: section(remoteTeam, 1) });
const reply = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
let service: typeof import("./server-config");
let target: EventTarget;
beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    fixtures.personal = { config: { apiKey: "legacy-secret" }, webdav: { url: "https://dav.test", username: "old", password: "legacy-dav", directory: "test" } };
    fixtures.team = { policyPack: { id: "legacy-policy" }, brands: [] } as unknown as TeamSettings;
    fixtures.hydrate.mockReset().mockResolvedValue(undefined);
    fixtures.backups.clear();
    fixtures.storeBackup.mockReset().mockImplementation(async (key, value) => { fixtures.backups.set(key, value); });
    fixtures.listener = () => {};
    fixtures.aiStore.reset();
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    target = new EventTarget();
    vi.stubGlobal("window", { localStorage, __RUNTIME_CONFIG__: { serverConfigEnabled: true }, location: { hash: "", pathname: "/config", search: "" }, history: { replaceState: vi.fn() }, addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target) });
    service = await import("./server-config");
});
afterEach(() => { service?.disposeServerConfiguration(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function standardFetch() {
    const mock = vi.fn(async (url: string, options?: RequestInit) => {
        if (url.endsWith("/session") || url.endsWith("/login") || url.endsWith("/bootstrap")) return reply({ user });
        if (url.endsWith("/logout")) return reply(null, 204);
        if (url.endsWith("/versions")) return reply({ user, personal: 3, team: 2, permissions: { manageTeam: true } });
        if (options?.method === "PUT") { const body = JSON.parse(options.body as string); return reply(section(body.value, body.revision + 1)); }
        return reply(envelope());
    });
    vi.stubGlobal("fetch", mock);
    return mock;
}
const edit = (key = "new-secret") => { fixtures.personal = { ...fixtures.personal, config: { ...fixtures.personal.config, apiKey: key } }; fixtures.listener(); };

it("restores complete settings and captures legacy migration before first application without writing defaults", async () => {
    const fetch = standardFetch();
    await service.initializeServerConfiguration();
    expect(fixtures.personal).toEqual(remotePersonal);
    expect(fixtures.team).toEqual(remoteTeam);
    expect(service.useServerConfigStore.getState().migrationCandidate?.personal.config.apiKey).toBe("legacy-secret");
    expect(service.useServerConfigStore.getState().migrationCandidate?.team.policyPack.id).toBe("legacy-policy");
    expect(fetch.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
    expect(() => service.assertSettingsReady()).not.toThrow();
});

it("waits for persisted stores before reading and blocks generation during hydration", async () => {
    const gate = deferred<void>(); fixtures.hydrate.mockReturnValueOnce(gate.promise);
    const fetch = standardFetch();
    const initialize = service.initializeServerConfiguration();
    expect(fetch).not.toHaveBeenCalled();
    expect(() => service.assertSettingsReady()).toThrow();
    gate.resolve(); await initialize;
    expect(service.useServerConfigStore.getState().phase).toBe("ready");
});

it("automatically saves first edits at revision zero but never uploads blank initial state", async () => {
    const fetch = standardFetch();
    fetch.mockImplementation(async (url, options) => options?.method === "PUT" ? reply(section(JSON.parse(options.body as string).value, 1)) : reply(url.endsWith("/session") ? { user } : envelope(null, 0)));
    await service.initializeServerConfiguration();
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetch.mock.calls.filter(([, o]) => o?.method === "PUT")).toHaveLength(0);
    edit(); await vi.advanceTimersByTimeAsync(1100);
    const write = fetch.mock.calls.find(([, o]) => o?.method === "PUT")!;
    expect(JSON.parse(write[1]!.body as string).revision).toBe(0);
    expect(write[1]!.headers).toMatchObject({ "X-Config-User": "1" });
    expect(service.useServerConfigStore.getState().revision).toBe(1);
});

it("debounces edits and retains dirty credentials on save conflict", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    fetch.mockImplementation(async () => reply({}, 409));
    edit("one"); edit("two"); await vi.advanceTimersByTimeAsync(1100);
    expect(fetch.mock.calls.filter(([, o]) => o?.method === "PUT")).toHaveLength(1);
    expect(service.useServerConfigStore.getState().phase).toBe("conflict");
    expect(fixtures.personal.config.apiKey).toBe("two");
    edit("three"); await vi.advanceTimersByTimeAsync(1100);
    expect(fetch.mock.calls.filter(([, o]) => o?.method === "PUT")).toHaveLength(1);
});

it("keeps edits made during a save and schedules the next revision", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    const gate = deferred<Response>();
    fetch.mockImplementationOnce(() => gate.promise);
    edit("first"); const save = service.saveServerConfiguration();
    edit("second"); gate.resolve(reply(section({ config: { apiKey: "first" } }, 4))); await save;
    await vi.advanceTimersByTimeAsync(1100);
    const puts = fetch.mock.calls.filter(([, o]) => o?.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(JSON.parse(puts[1][1]!.body as string)).toMatchObject({ revision: 4, value: { config: { apiKey: "second" } } });
});

it("clears all personal domains on logout and ignores an in-flight save response", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    const gate = deferred<Response>(); fetch.mockImplementationOnce(() => gate.promise);
    edit(); const saving = service.saveServerConfiguration();
    await service.logoutServerConfiguration();
    gate.resolve(reply(section(remotePersonal, 4))); await saving;
    expect(fixtures.personal).toEqual({ config: { apiKey: "" } });
    expect(service.useServerConfigStore.getState()).toMatchObject({ user: null, phase: "signed-out", migrationCandidate: null });
    expect(() => service.assertSettingsReady()).toThrow();
});

it("does not apply old account reads or expose old migration candidate after account switching", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    const oldRead = deferred<Response>(); fetch.mockImplementationOnce(() => oldRead.promise);
    const reload = service.reloadServerConfiguration();
    fetch.mockImplementation(async (url) => reply(url.endsWith("/login") ? { user: other } : envelope(null, 0, other)));
    await service.loginServerConfiguration(other.email, "password");
    oldRead.resolve(reply(envelope())); await reload;
    expect(service.useServerConfigStore.getState()).toMatchObject({ user: other, phase: "ready", revision: 0, migrationCandidate: null });
    expect(fixtures.personal.config.apiKey).toBe("");
});

it("does not inherit persisted settings when server session belongs to another account", async () => {
    localStorage.setItem("infinite-canvas:settings-owner", "999");
    standardFetch(); await service.initializeServerConfiguration();
    expect(service.useServerConfigStore.getState().migrationCandidate).toBeNull();
    expect(fixtures.personal.config.apiKey).toBe("server-secret");
});

it("retains current data on read failure and never falls back to legacy /config", async () => {
    const fetch = standardFetch();
    fetch.mockImplementation(async (url) => reply(url.endsWith("/session") ? { user } : {}, url.endsWith("/session") ? 200 : 500));
    await service.initializeServerConfiguration();
    expect(fixtures.personal.config.apiKey).toBe("legacy-secret");
    expect(service.useServerConfigStore.getState().phase).toBe("error");
    edit(); await vi.advanceTimersByTimeAsync(1100);
    expect(fetch.mock.calls.every(([url]) => !url.endsWith("/config"))).toBe(true);
    expect(fetch.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(false);
});

it("focus and thirty-second polling fetch clean remote updates", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    fetch.mockImplementation(async (url) => reply(url.endsWith("/versions") ? { user, personal: 4, team: 2, permissions: { manageTeam: true } } : envelope({ config: { apiKey: "updated-remote" } }, 4)));
    target.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(1);
    expect(fixtures.personal.config.apiKey).toBe("updated-remote");
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/versions"))).toHaveLength(2);
});

it("polling reports conflicting remote values without overwriting unsaved local changes", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    edit("unsaved");
    fetch.mockImplementation(async (url) => reply(url.endsWith("/versions") ? { user, personal: 4, team: 2, permissions: { manageTeam: true } } : envelope({ config: { apiKey: "remote-change" } }, 4)));
    await service.checkServerConfigurationVersions();
    expect(fixtures.personal.config.apiKey).toBe("unsaved");
    expect(service.useServerConfigStore.getState().serverPersonal?.config.apiKey).toBe("remote-change");
    expect(service.useServerConfigStore.getState().phase).toBe("conflict");
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetch.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(false);
});

it("online reconnect retries failed saves with preserved edits", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    fetch.mockImplementationOnce(async () => { throw new TypeError("offline"); });
    edit(); await service.saveServerConfiguration();
    expect(service.useServerConfigStore.getState().phase).toBe("error");
    target.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(1100);
    expect(service.useServerConfigStore.getState().phase).toBe("ready");
    expect(service.useServerConfigStore.getState().revision).toBe(4);
});

it("invalidates pending callbacks when session expires", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    edit(); fetch.mockImplementation(async () => reply({}, 401));
    await service.checkServerConfigurationVersions(); await vi.advanceTimersByTimeAsync(1100);
    expect(service.useServerConfigStore.getState().phase).toBe("signed-out");
    expect(fetch.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(false);
    expect(() => service.assertSettingsReady()).toThrow();
});

it("keeps the bootstrap token compatible but migration needs explicit confirmation", async () => {
    window.location.hash = "#server-config=" + "a".repeat(43);
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    expect(window.history.replaceState).toHaveBeenCalledWith(null, "", "/config");
    expect(fetch.mock.calls[0][0]).toBe("/api/config-vault/bootstrap");
    expect(fetch.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(false);
    const candidate = service.useServerConfigStore.getState().migrationCandidate!;
    await service.saveServerConfiguration(candidate.personal);
    expect(fixtures.personal.config.apiKey).toBe("legacy-secret");
});

it("saves and publishes team drafts separately from personal settings", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    const draft = await service.loadTeamDraft();
    expect(draft.revision).toBe(1);
    const saved = await service.saveTeamDraft(remoteTeam, 1);
    fetch.mockImplementationOnce(async () => reply(section(remoteTeam, 5)));
    await service.publishTeamDraft(saved.revision);
    expect(service.useServerConfigStore.getState()).toMatchObject({ revision: 3, teamRevision: 5 });
    expect(fetch.mock.calls.at(-1)?.[1]?.headers).toMatchObject({ "X-Config-User": "1" });
});

it("reapplies published team models after explicit legacy personal restoration", async () => {
    standardFetch(); await service.initializeServerConfiguration();
    const team: TeamSettings = { ...remoteTeam, modelConfig: { channels: [], defaults: { model: "", imageModel: "", textModel: "", videoModel: "", audioModel: "" }, roles: { sceneModel: "", repairModel: "", copyModel: "", translationModel: "", complianceModel: "", removalApiUrl: "", removalApiKey: "" } } };
    service.useServerConfigStore.setState({ serverTeam: team, teamRevision: 7 });
    const { applyPersonalSettings, applyTeamSettings } = await import("./settings-data");
    vi.mocked(applyTeamSettings).mockClear();
    await service.saveServerConfiguration({ config: { apiKey: "legacy", textModel: "old::text" } });
    expect(applyTeamSettings).toHaveBeenCalledWith(team, 7, expect.any(Function));
    expect(vi.mocked(applyTeamSettings).mock.invocationCallOrder.at(-1)).toBeGreaterThan(vi.mocked(applyPersonalSettings).mock.invocationCallOrder.at(-1)!);
});

it("anonymous writes are rejected locally and disabled servers do not gate generation", async () => {
    const fetch = standardFetch();
    await expect(service.apiSettingsRequest("/settings/personal", "PUT", {})).rejects.toThrow("请先登录");
    expect(fetch).not.toHaveBeenCalled();
    window.__RUNTIME_CONFIG__!.serverConfigEnabled = false;
    expect(() => service.assertSettingsReady()).not.toThrow();
});

it("keeps the durable legacy migration candidate across subsequent application restarts", async () => {
    standardFetch(); await service.initializeServerConfiguration();
    const saved = JSON.parse(fixtures.backups.get("settings-migration-candidate:1")!);
    expect(saved.personal.config.apiKey).toBe("legacy-secret");
    service.disposeServerConfiguration();
    service.useServerConfigStore.setState({ migrationCandidate: null });
    await service.initializeServerConfiguration();
    expect(service.useServerConfigStore.getState().migrationCandidate?.personal.config.apiKey).toBe("legacy-secret");
    expect(fixtures.personal.config.apiKey).toBe("server-secret");
});

it("backup failures stop cloud application before replacing any legacy settings", async () => {
    const fetch = standardFetch(); fixtures.storeBackup.mockRejectedValueOnce(new Error("quota"));
    await service.initializeServerConfiguration();
    expect(fixtures.personal.config.apiKey).toBe("legacy-secret");
    expect(service.useServerConfigStore.getState().message).toContain("备份失败");
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/settings"))).toBe(false);
});

it("explicit conflict resolution rebases only the confirmed values and uses a fresh compare-and-swap", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    edit("keep-mine");
    fetch.mockImplementationOnce(async () => reply({}, 409));
    await service.saveServerConfiguration();
    expect(service.useServerConfigStore.getState().phase).toBe("conflict");
    fetch.mockImplementationOnce(async () => reply(envelope({ config: { apiKey: "other-device" } }, 6)));
    await service.resolvePersonalConflict(fixtures.personal);
    const body = JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string);
    expect(body).toMatchObject({ revision: 6, value: { config: { apiKey: "keep-mine" } } });
    expect(service.useServerConfigStore.getState()).toMatchObject({ phase: "ready", revision: 7, dirty: false });
});

it("preserves edits made while a settings reload is in flight", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    const gate = deferred<Response>(); fetch.mockImplementationOnce(() => gate.promise);
    const reading = service.reloadServerConfiguration();
    edit("edited-during-read"); gate.resolve(reply(envelope({ config: { apiKey: "new-remote" } }, 4))); await reading;
    expect(fixtures.personal.config.apiKey).toBe("edited-during-read");
    expect(service.useServerConfigStore.getState()).toMatchObject({ phase: "conflict", dirty: true });
});

it("operation guards reject stale model requests even after another account is ready", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    const guard = service.captureSettingsSessionGuard();
    expect(guard).not.toThrow();
    fetch.mockImplementation(async (url) => reply(url.endsWith("/login") ? { user: other } : envelope({ config: { apiKey: "other-key" } }, 5, other)));
    await service.loginServerConfiguration(other.email, "password");
    expect(() => service.assertSettingsReady()).not.toThrow();
    expect(guard).toThrow("会话已变化");
});

it("does not silently sign back in after a failed server logout and browser reload", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    fetch.mockImplementationOnce(async () => { throw new TypeError("offline"); });
    await service.logoutServerConfiguration();
    const calls = fetch.mock.calls.length;
    service.disposeServerConfiguration(); await service.initializeServerConfiguration();
    expect(fetch.mock.calls.length).toBe(calls);
    expect(service.useServerConfigStore.getState().phase).toBe("signed-out");
    expect(fixtures.personal.config.apiKey).toBe("");
    await service.loginServerConfiguration(user.email, "password");
    expect(service.useServerConfigStore.getState().phase).toBe("ready");
});

it("retries the initial settings read after connectivity returns without requiring another login", async () => {
    const fetch = standardFetch();
    fetch.mockImplementationOnce(async () => reply({ user })).mockImplementationOnce(async () => reply({}, 500));
    await service.initializeServerConfiguration();
    expect(service.useServerConfigStore.getState().phase).toBe("error");
    target.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(1);
    expect(service.useServerConfigStore.getState().phase).toBe("ready");
    expect(fixtures.personal.config.apiKey).toBe("server-secret");
});

it("rejects old configuration arguments even if the new account is already fully ready", async () => {
    standardFetch(); await service.initializeServerConfiguration();
    expect(() => service.captureSettingsSessionGuard({ apiKey: "legacy-secret" })).toThrow("凭据已变化");
    expect(() => service.captureSettingsSessionGuard({ apiKey: "server-secret" })).not.toThrow();
    const channels = [{ id: "model", name: "Model", apiKey: "channel-secret", baseUrl: "https://model.test", apiFormat: "openai" as const, models: [] }];
    fixtures.personal.config.channels = channels;
    expect(() => service.captureSettingsSessionGuard({ channels, apiKey: "channel-secret", model: "alternate" })).not.toThrow();
    expect(() => service.captureSettingsSessionGuard({ channels: [{ ...channels[0], baseUrl: "https://stale.test" }] })).toThrow("渠道已随账号");
    const guard = service.captureSettingsSessionGuard({ channels });
    fixtures.personal.config.channels = [{ ...channels[0], apiKey: "replacement-key" }];
    expect(guard).toThrow("渠道已随账号");
});

it("allows slow configuration asset uploads while retaining short timeouts for ordinary requests", async () => {
    standardFetch(); await service.initializeServerConfiguration();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
        await service.apiSettingsRequest("/assets", "POST", { scope: "team", data: "test" });
        expect(timeout).toHaveBeenLastCalledWith(120000);
        await service.apiSettingsRequest("/settings");
        expect(timeout).toHaveBeenLastCalledWith(20000);
        await service.apiSettingsRequest("/settings/personal", "PUT", { revision: 3, value: remotePersonal });
        expect(timeout).toHaveBeenLastCalledWith(20000);
    } finally { timeout.mockRestore(); }
});

it("shows bounded server validation text only for 422 without serializing untrusted error bodies", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    fetch.mockImplementationOnce(async () => reply({ error: "厨房地垫：缺少场景示例图" }, 422));
    await expect(service.apiSettingsRequest("/settings/team/publish", "POST", { revision: 1 })).rejects.toThrow("厨房地垫：缺少场景示例图");
    for (const [status, error] of [[422, { secret: "private" }], [422, "a".repeat(1001)], [500, "private raw error"]] as const) {
        fetch.mockImplementationOnce(async () => reply({ error }, status));
        await expect(service.apiSettingsRequest("/settings/team/publish", "POST", { revision: 1 })).rejects.toThrow(status === 422 ? "配置或附件不完整" : "服务器配置读取或保存失败");
    }
});

it("refreshes team rules without canceling the pending save or replacing dirty personal values", async () => {
    const fetch = standardFetch(); await service.initializeServerConfiguration();
    edit("pending-personal-key");
    const updated = envelope(); updated.team = section(remoteTeam, 8); updated.draft = section(remoteTeam, 5);
    fetch.mockImplementationOnce(async () => reply(updated));
    await service.reloadTeamConfiguration();
    expect(fixtures.personal.config.apiKey).toBe("pending-personal-key");
    expect(service.useServerConfigStore.getState()).toMatchObject({ revision: 3, teamRevision: 8, phase: "ready", dirty: true });
    await vi.advanceTimersByTimeAsync(1100);
    const puts = fetch.mock.calls.filter(([, o]) => o?.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0][1]!.body as string)).toMatchObject({ revision: 3, value: { config: { apiKey: "pending-personal-key" } } });
    expect(service.useServerConfigStore.getState()).toMatchObject({ revision: 4, teamRevision: 8, dirty: false });
});

const managedUser = { ...user, managed: true };
const managedFile = (apiKey = "sk-own") => ({ app: "infinite-canvas-channel", version: 1, channel: { name: "企业模型网关", baseUrl: "https://llm.example/v1", apiKey, models: [] } });
const channelIds = () => fixtures.aiStore.getState().config.channels.map((channel) => channel.id);
function managedFetch(apiKey = "sk-own") {
    const mock = vi.fn(async (url: string, options?: RequestInit) => {
        if (url.endsWith("/session")) return reply({ user: managedUser });
        if (url.endsWith("/managed-channel")) return reply(managedFile(apiKey));
        if (url.endsWith("/logout")) return reply(null, 204);
        if (url.endsWith("/versions")) return reply({ user: managedUser, personal: 3, team: 2, permissions: { manageTeam: true } });
        if (options?.method === "PUT") return reply({ revision: 4, savedAt: "2026-09-30T00:00:01Z", value: JSON.parse(options.body as string).value });
        return reply(envelope(remotePersonal, 3, managedUser));
    });
    vi.stubGlobal("fetch", mock);
    return mock;
}

it("enterprise SSO accounts fetch their managed channel on every session restore, under its own id", async () => {
    const manual = { id: "mine", baseUrl: "https://llm.example/v1", apiKey: "sk-manual" };
    fixtures.aiStore.setState({ config: { channels: [manual] } });
    const mock = managedFetch();
    await service.initializeServerConfiguration();
    expect(mock.mock.calls.filter(([url]) => String(url).endsWith("/managed-channel"))).toHaveLength(1);
    expect(fixtures.aiStore.getState().config.channels).toEqual([manual, expect.objectContaining({ id: "managed-enterprise", apiKey: "sk-own" })]);
    expect(service.useServerConfigStore.getState().user).toEqual(managedUser);

    // A page reload starts without the channel (never persisted) and fetches it again.
    service.disposeServerConfiguration();
    vi.resetModules();
    service = await import("./server-config");
    fixtures.aiStore.setState({ config: { channels: [manual] } });
    const again = managedFetch("sk-rotated");
    await service.initializeServerConfiguration();
    expect(again.mock.calls.filter(([url]) => String(url).endsWith("/managed-channel"))).toHaveLength(1);
    expect(fixtures.aiStore.getState().config.channels.find((channel) => channel.id === "managed-enterprise")?.apiKey).toBe("sk-rotated");
});

it("settings applied from the server keep the session's managed channel", async () => {
    managedFetch();
    await service.initializeServerConfiguration();
    // Server / team settings replace the whole channel list; the managed channel is put back from memory.
    fixtures.aiStore.setState({ config: { channels: [{ id: "team", baseUrl: "https://team.test", apiKey: "team-key" }] } });
    expect(channelIds()).toEqual(["team", "managed-enterprise"]);
});

it("a 401 from the vault removes the managed channel", async () => {
    const mock = managedFetch();
    await service.initializeServerConfiguration();
    expect(channelIds()).toContain("managed-enterprise");
    mock.mockImplementation(async () => reply({ error: "Request failed" }, 401));
    await service.checkServerConfigurationVersions();
    expect(service.useServerConfigStore.getState()).toMatchObject({ phase: "signed-out", user: null });
    expect(channelIds()).not.toContain("managed-enterprise");
    // Nothing re-adds it afterwards.
    fixtures.aiStore.setState({ config: { channels: [] } });
    expect(channelIds()).toEqual([]);
});

it("a 401 on any vault request (for example a disabled employee) removes the managed channel", async () => {
    const mock = managedFetch();
    await service.initializeServerConfiguration();
    mock.mockImplementationOnce(async () => reply({ error: "Request failed" }, 401));
    await expect(service.apiSettingsRequest("/settings")).rejects.toThrow("登录已失效");
    expect(channelIds()).not.toContain("managed-enterprise");
});

it("signing out removes the managed channel", async () => {
    managedFetch();
    await service.initializeServerConfiguration();
    expect(channelIds()).toContain("managed-enterprise");
    await service.logoutServerConfiguration();
    expect(channelIds()).not.toContain("managed-enterprise");
    fixtures.aiStore.setState({ config: { channels: [] } });
    expect(channelIds()).toEqual([]);
});

it("operation guards accept requests that use the managed channel", async () => {
    managedFetch();
    await service.initializeServerConfiguration();
    const managed = fixtures.aiStore.getState().config.channels.find((channel) => channel.id === "managed-enterprise")!;
    fixtures.personal.config.channels = [];
    expect(() => service.captureSettingsSessionGuard({ apiKey: "sk-own" })).not.toThrow();
    expect(() => service.captureSettingsSessionGuard({ channels: [managed as never] })).not.toThrow();
});

it("password accounts never request a managed channel, and a failing channel does not block sign-in", async () => {
    const fetch = standardFetch();
    await service.initializeServerConfiguration();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/managed-channel"))).toBe(false);

    service.disposeServerConfiguration();
    vi.resetModules();
    service = await import("./server-config");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.endsWith("/session")) return reply({ user: managedUser });
        if (url.endsWith("/managed-channel")) return reply({ error: "Request failed" }, 503);
        return reply(envelope(remotePersonal, 3, managedUser));
    }));
    await service.initializeServerConfiguration();
    expect(service.useServerConfigStore.getState().user).toEqual(managedUser);
    expect(channelIds()).toEqual([]);
});

it("reports a failed enterprise sign-in returned in the URL hash", async () => {
    const fetch = standardFetch();
    (window as unknown as { location: { hash: string } }).location.hash = "#server-config-sso=failed";
    await service.initializeServerConfiguration();
    expect(fetch).not.toHaveBeenCalled();
    expect(service.useServerConfigStore.getState()).toMatchObject({ phase: "signed-out", user: null });
    expect(service.useServerConfigStore.getState().message).toContain("企业账号登录失败");
});
