export type HydrationStatus = "loading" | "ready" | "error";

/** Thrown by store actions that would persist before the saved data was read successfully. */
export class StoreNotReadyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "StoreNotReadyError";
    }
}

/**
 * Write gate for a persisted store: closed until the saved data was read successfully, so a failed or slow
 * read can never write default (empty) state over it. `generation` changes on every close so a delayed write
 * scheduled before can tell it is stale.
 */
export function createPersistGate() {
    let open = false;
    let generation = 0;
    return {
        isOpen: () => open,
        generation: () => generation,
        open: () => {
            open = true;
        },
        close: () => {
            open = false;
            generation += 1;
        },
    };
}

export function hydrationErrorMessage(error: unknown, label: string) {
    const reason = error instanceof Error && error.message ? `（${error.message.slice(0, 120)}）` : "";
    return `${label}读取失败${reason}，已暂停保存，原有数据未被修改。请重试读取；若仍失败，请刷新页面或检查浏览器存储。`;
}
