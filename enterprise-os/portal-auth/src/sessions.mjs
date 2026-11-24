import { createHash, randomBytes } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');

/**
 * Homepage sessions, in memory (a restart signs everybody out of the portal only; Casdoor's own session lets
 * them back in silently). Keyed by SHA-256 of the cookie value; records never hold tokens.
 */
export function createSessions({ maxSessions = 20000, now = () => Date.now() } = {}) {
    const sessions = new Map();

    function prune() {
        for (const [key, record] of sessions) if (record.expiresAt <= now()) sessions.delete(key);
        while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
    }

    return {
        /** A fresh, unpredictable session for this identity; returns the cookie value. */
        create(identity, lifetimeMs) {
            prune();
            const id = randomBytes(32).toString('base64url');
            const at = now();
            sessions.set(hash(id), { ...identity, createdAt: at, expiresAt: at + lifetimeMs, checkedAt: at, lastOkAt: at, pending: null });
            return id;
        },
        get(id) {
            if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
            const record = sessions.get(hash(id));
            if (!record) return null;
            if (record.expiresAt <= now()) { sessions.delete(hash(id)); return null; }
            return record;
        },
        delete(id) { if (typeof id === 'string') sessions.delete(hash(id)); },
        size: () => sessions.size,
    };
}
