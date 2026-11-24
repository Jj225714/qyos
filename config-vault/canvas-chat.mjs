export const CANVAS_CHAT_BODY_LIMIT = 128 * 1024;
const RESPONSE_LIMIT = 96 * 1024;
const WINDOW = 60000;
const PER_USER = 10;
const GLOBAL = 60;
const PARALLEL = 4;
const fail = status => Object.assign(new Error('Canvas chat unavailable'), { status });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shape = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, max, allowEmpty = false) => typeof value === 'string' && value.length <= max &&
    (allowEmpty || value.trim().length > 0) && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);

function validate(input) {
    if (!shape(input, ['message', 'canvas', 'history']) || !text(input.message, 2000) ||
        !shape(input.canvas, ['nodes']) || !Array.isArray(input.canvas.nodes) || input.canvas.nodes.length > 24 ||
        !Array.isArray(input.history) || input.history.length > 8) throw fail(400);
    const ids = new Set();
    for (const node of input.canvas.nodes) {
        if (!shape(node, ['id', 'title', 'text']) || !text(node.id, 120) || !text(node.title, 120, true) || ids.has(node.id) ||
            (Object.hasOwn(node, 'text') && !text(node.text, 500, true))) throw fail(400);
        ids.add(node.id);
    }
    for (const turn of input.history) {
        if (!shape(turn, ['role', 'content']) || !['user', 'assistant'].includes(turn.role) || !text(turn.content, 2000)) throw fail(400);
    }
    return ids;
}

async function boundedJson(response) {
    if (!response.body) throw fail(502);
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > RESPONSE_LIMIT) throw fail(502);
        chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

function cleanResponse(value, ids) {
    if (!shape(value, ['reply', 'actions']) || !text(value.reply, 6000) || !Array.isArray(value.actions) || value.actions.length > 6) throw fail(502);
    const renamed = new Set();
    const actions = value.actions.map(action => {
        if (shape(action, ['kind', 'text']) && action.kind === 'add-note' && text(action.text, 1000)) {
            return { kind: 'add-note', text: action.text.trim() };
        }
        if (shape(action, ['kind', 'id', 'title']) && action.kind === 'rename-node' && ids.has(action.id) &&
            !renamed.has(action.id) && text(action.title, 120)) {
            renamed.add(action.id);
            return { kind: 'rename-node', id: action.id, title: action.title.trim() };
        }
        throw fail(502);
    });
    return { reply: value.reply.trim(), actions };
}

export function createCanvasChat(send, clock = Date.now) {
    const active = new Set();
    const limits = new Map();
    let global = [];
    return async (id, input) => {
        const ids = validate(input);
        const now = clock();
        const cutoff = now - WINDOW;
        global = global.filter(time => time > cutoff);
        if (global.length >= GLOBAL || active.size >= PARALLEL || active.has(id)) throw fail(429);
        for (const [user, times] of limits) if (times.at(-1) <= cutoff) limits.delete(user);
        const times = (limits.get(id) || []).filter(time => time > cutoff);
        if (times.length >= PER_USER) throw fail(429);
        limits.set(id, [...times, now]);
        global.push(now);
        active.add(id);
        try {
            const response = await send(input);
            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                throw fail([429, 503, 504].includes(response.status) ? response.status : 502);
            }
            return cleanResponse(await boundedJson(response), ids);
        } catch (error) {
            if (error.name === 'TimeoutError' || error.name === 'AbortError') throw fail(504);
            throw fail([429, 503, 504].includes(error.status) ? error.status : 502);
        } finally {
            active.delete(id);
        }
    };
}
