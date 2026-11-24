/** Trust only the access-token claim issued from a completed DingTalk exchange. */
export function createWorkEmailCheck({ casdoor, departments, baseUrl, token, portalAudience, boundAudiences = [], fetchImpl = fetch }) {
    const url = `${baseUrl.replace(/\/+$/, '')}/api/internal/employee-email-confirmation`;
    return async (claims, identity, { existing = false } = {}) => {
        const proof = claims.qyos_dingtalk_login;
        const allowed = existing ? boundAudiences : [portalAudience];
        if (!identity.casdoorId || identity.forbidden || claims.sub !== identity.casdoorId ||
            !allowed.includes(claims.azp) || ![claims.aud].flat().includes(claims.azp) ||
            ((!existing || proof !== undefined) && (!proof || typeof proof.provider !== 'string' || !proof.provider ||
                typeof proof.subject !== 'string' || !proof.subject))) return false;
        try {
            const { loginStatus } = await departments.freshLoginStatus();
            if (loginStatus?.state !== 'active' || loginStatus.type !== 'dingtalk' || (proof && loginStatus.name !== proof.provider)) return false;
            const user = await casdoor.userById(identity.casdoorId);
            if (user?.id !== identity.casdoorId || user.owner !== casdoor.organization || user.email !== identity.email ||
                typeof user.dingtalk !== 'string' || !user.dingtalk || (proof && user.dingtalk !== proof.subject) || user.isForbidden || user.isDisabled || user.isDeleted) return false;
            const response = await fetchImpl(url, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000),
                headers: { 'x-internal-token': token, 'content-type': 'application/json' },
                body: JSON.stringify({ organization: user.owner, employeeId: user.id, email: user.email, dingtalk: user.dingtalk }),
            });
            return response.ok && (await response.json())?.confirmed === true;
        } catch { return false; }
    };
}
