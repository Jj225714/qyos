// 企业邮箱入口的数据层：按部门授权读取共享销售邮箱的摘要（网页版链接 + 未读数），不渲染 HTML、不写任何存储。
// 与 DOM 解耦：门户通过 setSession / subscribe / getSnapshot 使用；fetch、定时器、时钟均可注入，便于测试。
// 说明：这里只是定时查询（约 120 秒一次）加上窗口重新获得焦点 / 切回页面时补查一次；
// 服务端回应之前客户端看不到任何变化，没有推送。
(function (root) {
    'use strict';

    var SUMMARY_URL = '/auth/mail/status';
    var CONTEXT_HEADER = 'x-qyos-mail-context';
    var MAILBOX = 'sales@example.invalid';
    var PROVIDERS = ['tencent', 'google', 'custom'];
    var STATUSES = ['ok', 'error', 'pending', 'link_only', 'unconfigured'];
    var REFRESH_MS = 120000;
    var TIMEOUT_MS = 15000;
    var WAKE_GAP_MS = 5000;
    var MAX_URL = 2048;
    var CONTEXT_RE = /^[A-Za-z0-9_-]{32}$/;

    function hasOwn(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
    function isCount(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
    function positive(value, fallback) { return typeof value === 'number' && isFinite(value) && value > 0 ? value : fallback; }

    /** 只接受 32 位 base64url 不透明上下文；其他任何值都视为“没有会话”。 */
    function contextOf(value) { return typeof value === 'string' && CONTEXT_RE.test(value) ? value : null; }

    /** 只放行完整的 https 地址（无内嵌账号、无首尾空白），返回规范化后的 href。 */
    function httpsUrl(value) {
        if (typeof value !== 'string' || !value || value.length > MAX_URL || value !== value.trim()) return null;
        var parsed;
        try { parsed = new URL(value); } catch (error) { return null; }
        if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
        return parsed.href;
    }

    /**
     * 校验服务端摘要。返回 null 表示数据不合法（一律按不可见处理），{ visible: false } 表示未授权/未开启。
     * 非 ok 状态下忽略 unread，避免把未确认的数字展示出来。
     */
    function parseSummary(body) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
        if (body.visible === false) return { visible: false };
        if (body.visible !== true) return null;
        if (!isCount(body.revision)) return null;
        if (typeof body.provider !== 'string' || PROVIDERS.indexOf(body.provider) === -1) return null;
        if (body.mailbox !== MAILBOX) return null;
        var url = httpsUrl(body.webmailUrl);
        if (!url) return null;
        if (typeof body.status !== 'string' || STATUSES.indexOf(body.status) === -1) return null;
        if (!hasOwn(body, 'unread') || (body.unread !== null && !isCount(body.unread))) return null;
        return {
            visible: true, revision: body.revision, provider: body.provider, mailbox: MAILBOX, webmailUrl: url,
            status: body.status, unread: body.status === 'ok' ? body.unread : null,
        };
    }

    function present(s) {
        return Object.freeze({
            visible: true, revision: s.revision, provider: s.provider, mailbox: s.mailbox, webmailUrl: s.webmailUrl,
            status: s.status, unread: s.unread,
            // “暂未同步”：error / pending / unconfigured，或 ok 但没有数字；link_only 只给链接、不显示任何提示。
            unsynced: s.status !== 'link_only' && s.unread === null,
        });
    }

    function same(a, b) {
        if (a === b) return true;
        if (!a || !b) return false;
        return a.revision === b.revision && a.provider === b.provider && a.mailbox === b.mailbox
            && a.webmailUrl === b.webmailUrl && a.status === b.status && a.unread === b.unread;
    }

    function create(options) {
        var opts = options || {};
        var fetchFn = typeof opts.fetch === 'function' ? opts.fetch : null;
        var setT = typeof opts.setTimeout === 'function' ? opts.setTimeout : function (fn, ms) { return setTimeout(fn, ms); };
        var clearT = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : function (id) { clearTimeout(id); };
        var now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
        var Abort = hasOwn(opts, 'AbortController') ? opts.AbortController : (typeof AbortController === 'function' ? AbortController : null);
        var refreshMs = positive(opts.refreshMs, REFRESH_MS);
        var timeoutMs = positive(opts.timeoutMs, TIMEOUT_MS);
        var wakeGapMs = positive(opts.wakeGapMs, WAKE_GAP_MS);

        var context = null;       // 当前已确认的会话上下文
        var snapshot = null;      // 冻结的展示快照；null = 不显示
        var lastRevision = -1;    // 本会话内已采用的最高版本号
        var inflight = null;      // 当前唯一的请求
        var timer = null;         // 下一次定时查询
        var lastStart = null;
        var disposed = false;
        var listeners = [];

        function notify() {
            var current = snapshot;
            listeners.slice().forEach(function (fn) {
                try { fn(current); } catch (error) { /* 订阅方出错不影响模块状态 */ }
            });
        }

        function replace(next) {
            if (same(snapshot, next)) return false;
            snapshot = next;
            return true;
        }

        function clearTimer() { if (timer !== null) { clearT(timer); timer = null; } }

        function abortInflight() {
            var req = inflight;
            if (!req) return;
            inflight = null;
            req.done = true;
            if (req.timeoutId !== null) { clearT(req.timeoutId); req.timeoutId = null; }
            if (req.controller) { try { req.controller.abort(); } catch (error) { /* ignore */ } }
        }

        function schedule() {
            clearTimer();
            if (disposed || !context || inflight) return;
            timer = setT(function () { timer = null; run(); }, refreshMs);
        }

        function finish(req, kind, body) {
            if (req.done || req !== inflight) return; // 已超时、已被取代或会话已变：结果作废
            req.done = true;
            inflight = null;
            if (req.timeoutId !== null) { clearT(req.timeoutId); req.timeoutId = null; }
            var changed = false;
            if (kind === 'body') {
                var parsed = parseSummary(body);
                if (!parsed || parsed.visible !== true) changed = replace(null);
                else if (parsed.revision >= lastRevision) {
                    lastRevision = parsed.revision;
                    changed = replace(present(parsed)); // 整体替换：旧数字不会带到新版本/新服务商
                }
                // 版本号低于已采用版本：忽略，较旧结果不能覆盖较新状态。
            } else if (kind === 'error') {
                // 同步失败：清掉数字；同一会话里已确认过的链接可以保留。
                changed = replace(snapshot ? present({
                    revision: snapshot.revision, provider: snapshot.provider, mailbox: snapshot.mailbox,
                    webmailUrl: snapshot.webmailUrl, status: 'error', unread: null,
                }) : null);
            } else {
                // 401/403/404 或数据不合法：全部清除，包括链接。
                changed = replace(null);
            }
            schedule();
            if (changed) notify();
        }

        function run() {
            if (disposed || !context || inflight || !fetchFn) return;
            clearTimer();
            var req = { done: false, controller: Abort ? new Abort() : null, timeoutId: null };
            inflight = req;
            lastStart = now();
            req.timeoutId = setT(function () {
                req.timeoutId = null;
                if (req.controller) { try { req.controller.abort(); } catch (error) { /* ignore */ } }
                finish(req, 'error');
            }, timeoutMs);
            var headers = { accept: 'application/json' };
            headers[CONTEXT_HEADER] = context;
            var init = { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: headers };
            if (req.controller) init.signal = req.controller.signal;
            var pending;
            try { pending = Promise.resolve(fetchFn(SUMMARY_URL, init)); } catch (error) { pending = Promise.reject(error); }
            pending.then(function (response) {
                if (req.done) return undefined;
                var status = response && response.status;
                if (status === 401 || status === 403 || status === 404 || status === 409) {
                    finish(req, 'denied');
                    if (status === 409 && typeof opts.onStaleContext === 'function') opts.onStaleContext();
                    return undefined;
                }
                if (status !== 200) { finish(req, 'error'); return undefined; }
                if (typeof response.json !== 'function') { finish(req, 'invalid'); return undefined; }
                return Promise.resolve().then(function () { return response.json(); }).then(
                    function (body) { finish(req, 'body', body); },
                    function () { finish(req, 'invalid'); });
            }).catch(function () { finish(req, 'error'); });
        }

        /** 设置会话；与当前相同时什么也不做。其他情况同步清空旧状态、取消旧请求与定时器。 */
        function setSession(value) {
            if (disposed) return;
            var next = contextOf(value);
            if (next === context) return;
            abortInflight();
            clearTimer();
            context = next;
            lastRevision = -1;
            lastStart = null;
            if (replace(null)) notify();
            if (next !== null && context === next) run();
        }

        /** 窗口获得焦点 / 页面重新可见时调用；有请求在途或刚查过时不重复查询。 */
        function wake() {
            if (disposed || !context || inflight) return;
            if (lastStart !== null && now() - lastStart < wakeGapMs) return;
            run();
        }

        function subscribe(fn) {
            if (typeof fn !== 'function' || disposed) return function () {};
            listeners.push(fn);
            return function () { listeners = listeners.filter(function (item) { return item !== fn; }); };
        }

        function dispose() {
            abortInflight();
            clearTimer();
            disposed = true;
            context = null;
            snapshot = null;
            listeners = [];
        }

        return {
            setSession: setSession,
            getSnapshot: function () { return snapshot; },
            subscribe: subscribe,
            wake: wake,
            refresh: function () { run(); },
            dispose: dispose,
        };
    }

    root.QYOS_ENTERPRISE_MAIL = {
        create: create, parseSummary: parseSummary, contextOf: contextOf,
        MAILBOX: MAILBOX, REFRESH_MS: REFRESH_MS, TIMEOUT_MS: TIMEOUT_MS,
    };
})(typeof window !== 'undefined' ? window : this);
