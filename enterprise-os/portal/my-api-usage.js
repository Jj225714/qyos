(async function () {
    'use strict';
    const state = document.getElementById('usage-state');
    const details = document.getElementById('usage-details');
    const days = document.getElementById('usage-days');
    const totals = document.getElementById('usage-totals');
    const fields = ['requests', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'];
    const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' });
    async function refresh() {
        days.disabled = true;
        totals.hidden = true;
        state.textContent = '正在查询用量…';
        try {
            const res = await fetch(`/auth/api-usage?days=${days.value}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
            if (res.status === 401) { location.replace('/'); return; }
            if (!res.ok) throw Error();
            const data = await res.json();
            if (data.status === 'unlinked') { state.textContent = '尚未关联 API 网关账号，请联系管理员。'; return; }
            if (data.status === 'unconfigured') { state.textContent = '尚无纳入统计的个人 API Key，请联系管理员。'; return; }
            if (data.status !== 'ok' || fields.some(key => !Number.isSafeInteger(data[key]) || data[key] < 0)) throw Error();
            for (const key of fields) document.getElementById(`usage-${key}`).textContent = data[key].toLocaleString('zh-CN');
            state.textContent = `${data.requests ? '统计截至' : '本期暂无直接调用。统计截至'} ${date.format(new Date(data.as_of))}（北京时间）`;
            totals.hidden = false;
        } catch { state.textContent = '暂时无法查询用量，请稍后重试。'; }
        finally { days.disabled = false; }
    }
    try {
        const response = await fetch('/auth/me', {
            method: 'GET', credentials: 'same-origin', cache: 'no-store',
            headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000),
        });
        if (response.status === 401) { location.replace('/'); return; }
        if (!response.ok) throw new Error('session unavailable');
        const identity = await response.json();
        if (identity?.signedIn !== true) { location.replace('/'); return; }
        if (!Array.isArray(identity.apps) || !identity.apps.includes('api')) {
            state.textContent = '当前账号未启用个人 API 用量。';
            return;
        }
        details.hidden = false;
        days.addEventListener('change', refresh);
        await refresh();
    } catch {
        state.textContent = '无法确认登录状态，请返回员工工作台重试。';
    }
})();
