import { create, type StateCreator } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { getItemStrict, localForageStorage } from "@/lib/localforage-storage";
import { createPersistGate, hydrationErrorMessage, StoreNotReadyError, type HydrationStatus } from "@/lib/store-hydration";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    /** True only after the saved projects were read successfully (same meaning as hydrationStatus === "ready"). */
    hydrated: boolean;
    hydrationStatus: HydrationStatus;
    hydrationError?: string;
    retryHydration: () => Promise<void>;
    projects: CanvasProject[];
    deletedProjects: CanvasDeletedProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[], deletedProjects?: CanvasDeletedProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
const NOT_READY = "画布数据尚未读取完成，请稍后重试；读取失败时请先点击“重试读取”";
type PersistedCanvasState = Pick<CanvasStore, "projects" | "deletedProjects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
const gate = createPersistGate();

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const value = await getItemStrict(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        // A record without a project list is damaged, not empty: refuse it rather than adopt defaults.
        if (!parsed || typeof parsed !== "object" || !parsed.state || !Array.isArray(parsed.state.projects)) throw new Error("画布数据格式无效");
        queuedPersistState = parsed.state as PersistedCanvasState;
        return parsed;
    },
    setItem: (name, value) => {
        // Nothing is written until the saved projects were read successfully.
        if (!gate.isOpen()) return;
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects && queuedPersistState.deletedProjects === nextState.deletedProjects) return;
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        const generation = gate.generation();
        saveTimer = setTimeout(() => {
            saveTimer = null;
            if (!gate.isOpen() || gate.generation() !== generation) return;
            void Promise.resolve(localForageStorage.setItem(name, JSON.stringify(value))).catch((error) => console.error("[canvas] 保存画布失败", error));
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

function ready() {
    return useCanvasStore.getState().hydrationStatus === "ready";
}

function requireReady() {
    if (!ready()) throw new StoreNotReadyError(NOT_READY);
}

// Effect-driven updates (project page) are already gated on hydration; refusing them must not crash rendering.
function skipUnlessReady(action: string) {
    if (ready()) return false;
    console.error(`[canvas] ${action} skipped: ${NOT_READY}`);
    return true;
}

export const useCanvasStore = create<CanvasStore>()(((rawSet, get, api) =>
    persist<CanvasStore>(
        (set) => ({
            hydrated: false,
            hydrationStatus: "loading",
            hydrationError: undefined,
            retryHydration: async () => {
                if (get().hydrationStatus !== "error") return;
                await useCanvasStore.persist.rehydrate();
            },
            projects: [],
            deletedProjects: [],
            createProject: (title = i18n.t("canvas.project.untitled")) => {
                requireReady();
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                requireReady();
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || i18n.t("canvas.project.imported"),
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) => {
                if (skipUnlessReady("rename")) return;
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                }));
            },
            deleteProjects: (ids) => {
                if (skipUnlessReady("delete")) return;
                set((state) => {
                    const now = new Date().toISOString();
                    const removing = new Set(ids);
                    const projects = state.projects.filter((project) => !removing.has(project.id));
                    const deletedProjects = [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))];
                    return { projects, deletedProjects };
                });
            },
            replaceProjects: (projects, deletedProjects = []) => {
                requireReady();
                set({ projects, deletedProjects });
            },
            updateProject: (id, patch) => {
                if (skipUnlessReady("update")) return;
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
                }));
            },
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                    deletedProjects: state.deletedProjects,
                }) as StorageValue<CanvasStore>["state"],
            // Status changes use the raw setter, so they never trigger a write.
            onRehydrateStorage: () => {
                gate.close();
                if (saveTimer) clearTimeout(saveTimer);
                saveTimer = null;
                rawSet({ hydrated: false, hydrationStatus: "loading", hydrationError: undefined });
                return (state, error) => {
                    if (error !== undefined || !state) {
                        rawSet({ hydrated: false, hydrationStatus: "error", hydrationError: hydrationErrorMessage(error, "画布") });
                        return;
                    }
                    gate.open();
                    rawSet({ hydrated: true, hydrationStatus: "ready", hydrationError: undefined });
                };
            },
        },
    )(rawSet, get, api)) as StateCreator<CanvasStore, [], [["zustand/persist", CanvasStore]]>,
);
