import { request } from 'node:http';
import { Readable } from 'node:stream';

export function sharedImageProvider(socketPath) {
    const send = (path, method, body, headers, signal) => new Promise((resolve, reject) => {
        const req = request({ socketPath, path, method, signal, agent: false, headers: {
            ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        } }, res => {
            const safe = Object.fromEntries(Object.entries(res.headers).filter(([,v]) => typeof v === 'string'));
            resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers: safe }));
        });
        req.on('error', reject);
        req.end(body);
    });
    return {
        async epoch() {
            try {
                const res = await send('/route', 'GET', null, {}, AbortSignal.timeout(3000));
                if (!res.ok) { await res.body?.cancel(); throw Error(); }
                const { epoch } = await res.json();
                if (typeof epoch !== 'string' || !/^[a-f0-9]{64}$/.test(epoch)) throw Error();
                return epoch;
            } catch { throw Object.assign(new Error('Image route unavailable'), { status: 503 }); }
        },
        generate(payload, id, epoch, timeout) {
            const path = payload.references?.length ? '/v1/images/edits' : '/v1/images/generations';
            return send(path, 'POST', JSON.stringify(payload), {
                'Content-Type': 'application/json', 'X-Client-Request-Id': id, 'X-Image-Route': epoch,
            }, AbortSignal.timeout(timeout));
        },
        chat(payload) {
            return send('/canvas-chat', 'POST', JSON.stringify(payload), {
                'Content-Type': 'application/json',
            }, AbortSignal.timeout(28000));
        },
        reversePrompt(payload) {
            return send('/reverse-prompt', 'POST', JSON.stringify(payload), {
                'Content-Type': 'application/json',
            }, AbortSignal.timeout(28000));
        },
    };
}
