const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,255}$/;
export const DISABLED_MARK = '[os-bridge-disabled]';

const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

/**
 * Department of one employee, same rule as Jadmin: a manual assignment by email wins; otherwise the
 * first department (in Jadmin's order) that lists one of the employee's Casdoor groups; otherwise none.
 * The directory comes from Jadmin (`load`) and is refreshed every `refreshMs`; on a failed refresh
 * the last good copy stays in use. Without `load`, the static `departments`/`assignments` apply.
 */
export function createDepartments({ load = null, departments = [], assignments = {}, loginProvider = null, defaultJapiGroupId = null, defaultRagflowKey = null, ragflowKeys = {}, refreshMs = 60000, now = () => Date.now(), log = () => {} }) {
    let snapshot = { departments, assignments, loginProvider };
    let loadedAt = load ? -Infinity : Infinity;
    let pending = null;

    async function fresh() {
        if (!load || now() - loadedAt < refreshMs) return snapshot;
        pending ??= load().then(value => {
            if (!Array.isArray(value?.departments) || typeof value?.assignments !== 'object') throw new Error('invalid department feed');
            snapshot = { departments: value.departments, assignments: value.assignments || {}, loginProvider: value.loginProvider || null };
            loadedAt = now();
        }).catch(error => {
            // Keep serving the last good directory; retry on the next request after a short pause.
            loadedAt = now() - refreshMs + 5000;
            log({ event: 'departments_refresh_failed', message: error.message });
        }).finally(() => { pending = null; });
        await pending;
        return snapshot;
    }

    return {
        async resolve(identity) {
            const { departments: list, assignments: manual } = await fresh();
            const email = String(identity.email || '').toLowerCase();
            const code = Object.hasOwn(manual, email) ? manual[email] : list.find(dept => (dept.groups || []).some(group => identity.groups.includes(group)))?.code;
            const match = list.find(dept => dept.code === code);
            return {
                name: match?.code || null,
                japiGroupId: match ? (match.japiGroupId ?? defaultJapiGroupId) : defaultJapiGroupId,
                ragflowKey: (match && ragflowKeys[match.code]) || defaultRagflowKey,
            };
        },
        /** JAPI groups that belong to departments (os-bridge may remove these from an account, never others). */
        async departmentGroupIds() {
            const { departments: list } = await fresh();
            return new Set([defaultJapiGroupId, ...list.map(dept => dept.japiGroupId)].filter(id => Number.isInteger(id) && id > 0));
        },
        /** The IM login chosen in Jadmin ({type, name}) or null. */
        loginProvider: async () => (await fresh()).loginProvider || null,
    };
}

/** Reads the department directory that Jadmin publishes for os-bridge. */
export function jadminDepartmentLoader({ baseUrl, token, fetchImpl = fetch }) {
    const url = `${baseUrl.replace(/\/+$/, '')}/api/internal/departments`;
    return async () => {
        const response = await fetchImpl(url, { headers: { 'x-internal-token': token, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`Jadmin departments HTTP ${response.status}`);
        return response.json();
    };
}

export const BINDING_PREFIX = 'os-bridge casdoor:';
const BINDING = /(?:^|\s)os-bridge casdoor:(\S+)/;
/** The Casdoor user ID a JAPI account is bound to (written into its notes), or null. */
export const bindingOf = user => BINDING.exec(String(user?.notes || ''))?.[1] || null;

/**
 * Keeps one JAPI user + one dedicated API key per employee.
 * The JAPI account is found by email but BOUND to the Casdoor user ID (`os-bridge casdoor:<id>` in its notes):
 * a token carrying the same email but another Casdoor ID never gets that account or its key.
 * Administrator accounts are never bound automatically, and only verified emails are trusted.
 * JAPI stays the source of truth; this cache only avoids an admin round trip per request.
 */
export function createProvisioner({ japi, departments, keyName = 'enterprise-os', requireDepartment = true, requireEmailVerified = 'auto', newUser = {}, cacheMs = 300000, now = () => Date.now(), log = () => {} }) {
    const byEmail = new Map();
    const inflight = new Map();

    const ownKey = keys => keys.find(key => key.name === keyName);

    /**
     * true / false, or "auto": verified emails are required unless the IM chosen in Jadmin is WeCom.
     * Casdoor marks Lark and DingTalk emails as verified; WeCom never vouches for an email (the employee is
     * matched by WeCom userid instead), so its emails come from the admin-maintained WeCom directory.
     */
    async function mustVerifyEmail() {
        if (requireEmailVerified !== 'auto') return requireEmailVerified !== false;
        return (await departments.loginProvider?.())?.type !== 'wecom';
    }

    async function keyFor(user, groupId) {
        const existing = ownKey(await japi.listKeys(user.id));
        if (existing) {
            // Never replace a key an administrator disabled or that ran out of quota / expired.
            if (existing.status !== 'active') throw failure(403, 'KEY_DISABLED', `os-bridge key is ${existing.status}: contact an administrator`);
            if (groupId && existing.id && existing.group_id !== groupId) {
                await japi.updateKeyGroup(existing.id, groupId);
                log({ event: 'key_group_changed', japiUserId: user.id, from: existing.group_id ?? null, to: groupId });
            }
            return { key: existing.key, previousGroupId: existing.group_id ?? null };
        }
        let created;
        try { created = await japi.createKey(user.id, { name: keyName, groupId }); }
        catch (error) {
            if (error.status === 404 && !error.json) throw failure(503, 'JAPI_PATCH_MISSING', 'JAPI lacks POST /admin/users/:id/api-keys (apply japi-patch/0001)');
            throw error;
        }
        log({ event: 'key_created', japiUserId: user.id });
        return { key: created.key, previousGroupId: null };
    }

    /** Refuses an account bound to another Casdoor user; binds an existing, unbound account on first use. */
    async function bind(user, identity) {
        const bound = bindingOf(user);
        if (bound === identity.casdoorId) return user;
        if (bound) {
            log({ event: 'identity_mismatch', japiUserId: user.id });
            throw failure(403, 'IDENTITY_MISMATCH', 'JAPI account belongs to another Casdoor user');
        }
        if (user.role === 'admin') {
            log({ event: 'admin_bind_refused', japiUserId: user.id });
            throw failure(403, 'ADMIN_ACCOUNT', 'JAPI administrator accounts are never bound automatically; add "os-bridge casdoor:<id>" to its notes by hand');
        }
        const notes = `${user.notes || ''} ${BINDING_PREFIX}${identity.casdoorId}`.trim();
        await japi.updateUser(user.id, { notes });
        log({ event: 'user_bound', japiUserId: user.id });
        return { ...user, notes };
    }

    /**
     * The department's JAPI group joins the account's allowed groups; the groups of OTHER departments that
     * os-bridge added before are removed (a department change must not accumulate models and quota).
     * Groups an administrator added that belong to no department stay.
     */
    async function syncGroups(user, groupId) {
        if (!groupId) return;
        const current = Array.isArray(user.allowed_groups) ? user.allowed_groups : [];
        const departmental = await departments.departmentGroupIds();
        const next = [...current.filter(id => id === groupId || !departmental.has(id)), ...(current.includes(groupId) ? [] : [groupId])];
        if (next.length === current.length && next.every(id => current.includes(id))) return;
        await japi.updateUser(user.id, { allowed_groups: next });
        log({ event: 'user_groups_synced', japiUserId: user.id, groupId, removed: current.filter(id => !next.includes(id)) });
    }

    async function load(identity, dept) {
        let user = await japi.findUserByEmail(identity.email);
        if (!user) {
            user = await japi.createUser({ email: identity.email, username: identity.name.slice(0, 100), notes: `${BINDING_PREFIX}${identity.casdoorId}`, groupIds: dept.japiGroupId ? [dept.japiGroupId] : [], ...newUser });
            // A scoped admin key without users.read gets only {id} back from write routes.
            if (!user?.status || !user?.email) user = (await japi.getUser(user.id)) || user;
            log({ event: 'user_created', japiUserId: user.id, department: dept.name });
        } else {
            user = await bind(user, identity);
        }
        // A disabled account stays disabled: only os-bridge's own Casdoor sync may lift a bridge-made block.
        if (user.status !== 'active') throw failure(403, 'USER_DISABLED', 'JAPI account disabled');
        await syncGroups(user, dept.japiGroupId);
        const { key } = await keyFor(user, dept.japiGroupId);
        return { user: { id: user.id, email: String(user.email).toLowerCase(), status: user.status }, casdoorId: identity.casdoorId, key, department: dept, at: now() };
    }

    async function ensure(identity) {
        if (!EMAIL.test(identity.email || '')) throw failure(403, 'NO_EMAIL', 'Casdoor account has no email');
        if (!identity.casdoorId) throw failure(403, 'NO_CASDOOR_ID', 'Casdoor account has no ID');
        if (identity.forbidden) throw failure(403, 'FORBIDDEN', 'Casdoor account forbidden');
        if (!identity.emailVerified && await mustVerifyEmail()) throw failure(403, 'EMAIL_UNVERIFIED', 'Casdoor account email is not verified');
        const dept = await departments.resolve(identity);
        if (requireDepartment && !dept.name) throw failure(403, 'NO_DEPARTMENT', 'No department assigned in Jadmin');
        const cached = byEmail.get(identity.email);
        // The cache holds only while the Casdoor user and the department's JAPI group are unchanged.
        if (cached && now() - cached.at < cacheMs && cached.casdoorId === identity.casdoorId && cached.department.japiGroupId === dept.japiGroupId) return { ...cached, department: dept };
        let pending = inflight.get(identity.email);
        if (!pending) {
            pending = load(identity, dept).finally(() => inflight.delete(identity.email));
            inflight.set(identity.email, pending);
        }
        const entry = await pending;
        byEmail.set(identity.email, entry);
        return entry;
    }

    /**
     * The existing os-bridge key of an os-bridge-managed account (Jimage vault). Never creates a key:
     * keys are made by ensure(), which knows the employee's department; accounts os-bridge did not
     * provision or bind (JAPI administrators, for example) are refused.
     */
    async function keyForUserId(id) {
        const user = await japi.getUser(id);
        if (!user) throw failure(404, 'NO_USER', 'No such JAPI account');
        if (user.status !== 'active') throw failure(403, 'USER_DISABLED', 'JAPI account disabled');
        if (!bindingOf(user)) throw failure(403, 'NOT_MANAGED', 'JAPI account is not managed by os-bridge');
        const key = ownKey(await japi.listKeys(user.id));
        if (!key) throw failure(404, 'NO_KEY', 'No os-bridge key yet: the employee must sign in once');
        if (key.status !== 'active') throw failure(403, 'KEY_DISABLED', `os-bridge key is ${key.status}`);
        log({ event: 'key_read', japiUserId: user.id });
        return key.key;
    }

    /** Sets the os-bridge key's status; tolerated when JAPI lacks the route (the account status still applies). */
    async function setOwnKeyStatus(user, status) {
        try {
            const key = ownKey(await japi.listKeys(user.id));
            if (key && key.status !== status && (status === 'disabled' ? key.status === 'active' : key.status === 'disabled')) {
                await japi.setKeyStatus(key.id, status);
                log({ event: status === 'disabled' ? 'key_disabled' : 'key_enabled', japiUserId: user.id });
            }
        } catch (error) {
            log({ event: 'key_status_failed', japiUserId: user.id, status, message: error.message });
        }
    }

    /** Disables the JAPI account (and its os-bridge key) bound to this Casdoor user. Unbound accounts are never touched. */
    async function disableAccount(user) {
        for (const [email, entry] of byEmail) if (entry.user.id === user.id) byEmail.delete(email);
        if (user.status === 'active') {
            await japi.updateUser(user.id, { status: 'disabled', notes: `${user.notes || ''} ${DISABLED_MARK}`.trim() });
            log({ event: 'user_disabled', japiUserId: user.id });
        }
        await setOwnKeyStatus(user, 'disabled');
        return { changed: user.status === 'active', japiUserId: user.id };
    }

    /** Re-enables an account only when os-bridge itself disabled it (never an administrator's block). */
    async function reactivateAccount(user) {
        if (user.status === 'active' || !String(user.notes || '').includes(DISABLED_MARK)) return { changed: false };
        await japi.updateUser(user.id, { status: 'active', notes: String(user.notes).replace(DISABLED_MARK, '').replace(/\s{2,}/g, ' ').trim() });
        await setOwnKeyStatus(user, 'active');
        log({ event: 'user_reactivated', japiUserId: user.id });
        return { changed: true, japiUserId: user.id };
    }

    /** Applies the current Casdoor state of one employee (looked up by os-bridge, never taken from a webhook body). */
    async function applyCasdoorState(identity) {
        if (!identity.casdoorId || !EMAIL.test(identity.email || '')) return { changed: false };
        const user = await japi.findUserByEmail(identity.email);
        if (!user || bindingOf(user) !== identity.casdoorId) return { changed: false };
        return identity.forbidden ? disableAccount(user) : reactivateAccount(user);
    }

    /** All JAPI accounts bound by os-bridge: [{user, casdoorId}]. */
    async function managedAccounts() {
        const users = await japi.searchUsers(BINDING_PREFIX.trim());
        return users.map(user => ({ user, casdoorId: bindingOf(user) })).filter(item => item.casdoorId);
    }

    async function status(id) {
        const user = await japi.getUser(id);
        if (!user) throw failure(404, 'NO_USER', 'No such JAPI account');
        return { id: user.id, email: String(user.email).toLowerCase(), status: user.status, casdoorId: bindingOf(user) };
    }

    return { ensure, status, keyForUserId, applyCasdoorState, disableAccount, reactivateAccount, managedAccounts, forget: email => byEmail.delete(email) };
}
