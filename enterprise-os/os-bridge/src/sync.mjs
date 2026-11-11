import { identityFromCasdoorUser } from './casdoor.mjs';

// Casdoor writes the record's response as `{status:"ok", msg:"..."}` (not JSON); the status comes first
// and is set by Casdoor itself, so an anchored match cannot be steered by the message text.
const responseStatus = value => (typeof value === 'string' ? /^\{\s*"?status"?\s*:\s*"([^"]*)"/.exec(value)?.[1] : value?.status) || '';

const parseJson = value => {
    if (typeof value !== 'string') return value && typeof value === 'object' ? value : null;
    try { return JSON.parse(value); } catch { return null; }
};

/**
 * Keeps JAPI accounts in line with Casdoor.
 *
 * Casdoor webhook bodies are NOT trusted: the record's `object` is the raw HTTP request body (also for
 * failed requests), and `extendedUser` is the ACTING user, not the one acted upon. A webhook only says
 * "someone may have changed"; os-bridge then reads the person from Casdoor itself.
 * A periodic full reconcile also catches events that never arrived (Casdoor delivers each one at most 3 times).
 */
export function createCasdoorSync({ casdoor, provisioner, log = () => {}, maxDisableRatio = 0.2, minDisableGuard = 5, now = () => Date.now() }) {
    let running = null;
    let lastRun = null;

    async function reconcileAll() {
        running ??= (async () => {
            const started = now();
            const people = await casdoor.users();
            if (people.length === 0) throw new Error('Casdoor returned no users; refusing to reconcile');
            const byId = new Map(people.map(person => [String(person.id), person]));
            const accounts = await provisioner.managedAccounts();
            const plan = accounts.map(({ user, casdoorId }) => {
                const person = byId.get(casdoorId);
                const gone = !person || person.isForbidden === true || person.isDeleted === true;
                return { user, person, gone };
            });
            const toDisable = plan.filter(item => item.gone && item.user.status === 'active');
            // A misconfigured organization (or a partial Casdoor answer) must not switch everyone off.
            if (toDisable.length > minDisableGuard && toDisable.length > accounts.length * maxDisableRatio) {
                throw new Error(`reconcile would disable ${toDisable.length} of ${accounts.length} accounts; refusing (check casdoor.organization)`);
            }
            let disabled = 0; let reactivated = 0;
            for (const item of plan) {
                try {
                    if (item.gone) { if ((await provisioner.disableAccount(item.user)).changed) disabled++; }
                    else if ((await provisioner.reactivateAccount(item.user)).changed) reactivated++;
                } catch (error) { log({ event: 'reconcile_account_failed', japiUserId: item.user.id, message: error.message }); }
            }
            lastRun = { at: now(), ms: now() - started, accounts: accounts.length, disabled, reactivated };
            log({ event: 'reconcile_done', ...lastRun });
            return lastRun;
        })().finally(() => { running = null; });
        return running;
    }

    /** One person, read fresh from Casdoor; `provision` pre-creates the account on login. */
    async function syncPerson(name, { provision = false } = {}) {
        const person = await casdoor.userByName(name);
        if (!person) return { result: 'not found in Casdoor (reconcile scheduled)', reconcile: true };
        const identity = identityFromCasdoorUser(person);
        const applied = await provisioner.applyCasdoorState(identity);
        if (!provision || identity.forbidden) return { result: applied };
        try {
            const entry = await provisioner.ensure(identity);
            return { result: { japiUserId: entry.user.id, department: entry.department.name } };
        } catch (error) {
            if (error.status === 403) return { result: `not provisioned: ${error.code}` };
            throw error;
        }
    }

    /**
     * Handles one webhook record. Only successful operations of our organization count; the person is taken
     * from the record's session user (login) or from the target named in the request (admin operations),
     * and always re-read from Casdoor.
     */
    async function handleRecord(record) {
        const action = String(record?.action || '');
        if (responseStatus(record?.response) !== 'ok') return { action, result: 'ignored: operation did not succeed' };
        if (record?.organization && record.organization !== casdoor.organization && !['add-user', 'update-user', 'delete-user'].includes(action)) {
            return { action, result: 'ignored: other organization' };
        }
        let name = null; let provision = false;
        if (['login', 'signup', 'new-user'].includes(action)) {
            if (record.organization !== casdoor.organization) return { action, result: 'ignored: other organization' };
            name = typeof record.user === 'string' ? record.user : null;
            provision = true;
        } else if (['add-user', 'update-user', 'delete-user'].includes(action)) {
            const target = parseJson(record.object);
            if (target?.owner !== casdoor.organization) return { action, result: 'ignored: other organization' };
            name = typeof target?.name === 'string' ? target.name : null;
        } else {
            return { action, result: 'ignored' };
        }
        if (!name) return { action, result: 'ignored: no user' };
        const outcome = await syncPerson(name, { provision });
        // A deleted person cannot be read back: the full reconcile finds their account by its binding.
        if (outcome.reconcile || action === 'delete-user') reconcileSoon();
        return { action, result: outcome.result };
    }

    let timer = null;
    function reconcileSoon(delayMs = 2000) {
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            reconcileAll().catch(error => log({ event: 'reconcile_failed', message: error.message }));
        }, delayMs);
        timer.unref?.();
    }

    function start(intervalMs) {
        if (!intervalMs) return () => {};
        const run = () => reconcileAll().catch(error => log({ event: 'reconcile_failed', message: error.message }));
        const first = setTimeout(run, 10000); first.unref?.();
        const every = setInterval(run, intervalMs); every.unref?.();
        return () => { clearTimeout(first); clearInterval(every); if (timer) clearTimeout(timer); };
    }

    return { handleRecord, reconcileAll, reconcileSoon, start, status: () => lastRun };
}
