// 门户页面逻辑（与浏览器环境解耦，便于测试）。portal.js 只负责把真实的 document / fetch / 定时器交给它。
(function (root) {
    'use strict';

    var ICONS = {
        chat: '<path d="M5 6.5A3.5 3.5 0 0 1 8.5 3h11A3.5 3.5 0 0 1 23 6.5v7a3.5 3.5 0 0 1-3.5 3.5H12l-5 4v-4.2A3.5 3.5 0 0 1 5 13.5z"/><path d="M10 8.5h8M10 12h5" class="line"/>',
        image: '<rect x="3.5" y="4" width="21" height="18" rx="3.5"/><circle cx="10" cy="10" r="2.2" class="line"/><path d="M5 19.5l5.5-5.5 4 4 3-3 5 4.5" class="line"/>',
        media: '<rect x="4" y="4" width="20" height="19" rx="3.5"/><path d="M8 17l4-4 3 2 5-6m-4 0h4v4" class="line"/>',
        book: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H22v18H7.5A2.5 2.5 0 0 0 5 23.5z"/><path d="M5 23.5A2.5 2.5 0 0 1 7.5 21H22v2.5" class="line"/>',
        grid: '<rect x="4" y="4" width="8.5" height="8.5" rx="2"/><rect x="15.5" y="4" width="8.5" height="8.5" rx="2"/><rect x="4" y="15.5" width="8.5" height="8.5" rx="2"/><rect x="15.5" y="15.5" width="8.5" height="8.5" rx="2"/>',
        mail: '<rect x="3.5" y="5.5" width="21" height="17" rx="3.5"/><path d="M4.5 8.5l9.5 7 9.5-7" class="line"/>',
    };

    // 固定文案；登录错误码来自 portal-auth 的固定列表，未知的码只显示通用提示，不回显参数内容。
    var ERRORS = {
        method: '登录方式无效，请重新选择。',
        provider: '企业登录平台无效，请重新选择。',
        provider_changed: '企业登录方式已变更，请重新选择。',
        NO_DEPARTMENT: '你还没有分配部门，暂时不能使用。请联系管理员在 Jadmin「部门目录」中设置。',
        ADMIN_ACCOUNT: '这个邮箱对应的是 API 管理员账号，不能通过企业登录进入，请联系 IT。',
        IDENTITY_MISMATCH: '这个邮箱的 API 账号属于另一个企业账号，请联系 IT 核对。',
        BINDING_REQUIRED: '你的 API 账号需要管理员先完成关联，请联系 IT。',
        USER_DISABLED: '你的账号已停用，请联系管理员。',
        KEY_DISABLED: '你的 API Key 已停用或额度用尽，请联系管理员。',
        FORBIDDEN: '你的企业账号已被禁用，请联系管理员。',
        EMAIL_UNVERIFIED: '企业账号的邮箱尚未验证，请联系 IT。',
        NO_EMAIL: '企业账号没有邮箱，请联系 IT 补充。',
        state: '登录已过期，或在别的窗口重新发起过，请再登录一次。',
        failed: '登录没有成功，请再试一次。',
        unavailable: '登录服务暂时不可用，请稍后再试。',
    };
    var GENERIC_ERROR = '登录没有成功，请再试一次；仍有问题请联系 IT。';
    var POLL_MS = 60000;

    /** 只放行 https:// 完整地址和本站绝对路径，避免配置写错时出现 javascript: 之类的链接。 */
    function safeUrl(value) {
        if (typeof value !== 'string') return null;
        var url = value.trim();
        if (/^\/(?!\/)/.test(url)) return url;
        try {
            var parsed = new URL(url);
            return parsed.protocol === 'https:' ? parsed.href : null;
        } catch (error) {
            return null;
        }
    }

    function errorMessage(code) {
        return Object.prototype.hasOwnProperty.call(ERRORS, code) ? ERRORS[code] : GENERIC_ERROR;
    }

    /** 已配置、地址合法、且服务端允许的应用，按配置顺序。enabledIds 为 null 时不过滤（未启用登录的回退模式）。 */
    function visibleApps(config, enabledIds) {
        var list = Array.isArray(config.apps) ? config.apps : [];
        return list.filter(function (app) {
            if (!app || !app.name || !safeUrl(app.url)) return false;
            if (enabledIds === null) return true;
            return typeof app.id === 'string' && enabledIds.indexOf(app.id) !== -1;
        });
    }

    /** 只在服务端明确开启工作日历并给出不透明上下文时返回会话；不使用邮箱等身份字段。 */
    function workCalendarOf(body) {
        var wc = body && body.workCalendar;
        if (!wc || wc.enabled !== true || typeof wc.context !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(wc.context)) return null;
        return { enabled: true, context: wc.context };
    }

    /** 企业邮箱入口只接受服务端给出的 32 位不透明上下文（base64url）；其他任何形状都视为没有。 */
    function enterpriseMailOf(body) {
        var em = body && body.enterpriseMail;
        var context = em && typeof em === 'object' ? em.context : null;
        return typeof context === 'string' && /^[A-Za-z0-9_-]{32}$/.test(context) ? context : null;
    }

    function createPortal(env) {
        var doc = env.document;
        var config = env.config || {};
        var state = { phase: 'checking', user: null, apps: [], notice: '', retryLogout: false, workCalendar: null, enterpriseMail: null };
        var timer = null;
        var optionsLatest = 0;
        var busyLinks = [];
        var providerBusyLinks = [];
        var loginEnabled = !(config.login && config.login.enabled === false);
        var workModule = env.workCalendar || root.QYOS_WORK_CALENDAR;
        var workRoot = doc.getElementById('work-calendar');
        var work = workModule && typeof workModule.create === 'function' && workRoot
            ? workModule.create({ document: doc, fetch: function (url, init) { return env.fetch(url, init); }, root: workRoot, layout: workRoot.parentNode }) : null;
        // 企业邮箱：独立模块；脚本缺失（旧页面）时为 null，门户其余部分不受影响。
        var mailModule = env.enterpriseMail || root.QYOS_ENTERPRISE_MAIL;
        var mail = mailModule && typeof mailModule.create === 'function' ? mailModule.create({
            fetch: function (url, init) { return env.fetch(url, init); },
            onStaleContext: function () { refresh(); },
            setTimeout: typeof env.setTimeout === 'function' ? function (fn, ms) { return env.setTimeout(fn, ms); } : undefined,
            clearTimeout: typeof env.clearTimeout === 'function' ? function (id) { env.clearTimeout(id); } : undefined,
            now: typeof env.now === 'function' ? env.now : undefined,
        }) : null;
        var rendering = false;
        // 模块只在状态真正变化时回调；render 过程中的变化由 render 自己画出，避免重入。
        if (mail) mail.subscribe(function () { if (!rendering && state.phase === 'signed-in') renderApps(state.apps); });

        function el(id) { return doc.getElementById(id); }
        function show(id, visible) { var node = el(id); if (node) node.hidden = !visible; }
        function text(id, value) {
            var node = el(id);
            if (!node) return;
            if (typeof value === 'string' && value.trim()) { node.textContent = value.trim(); node.hidden = false; }
            else { node.textContent = ''; node.hidden = true; }
        }

        function guardLink(link, providerLink) {
            var busy = false;
            var originalClass = link.className;
            var reset = function () { busy = false; link.setAttribute('aria-disabled', 'false'); link.className = originalClass; };
            (providerLink ? providerBusyLinks : busyLinks).push(reset);
            link.addEventListener('click', function (event) {
                if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || (event.button && event.button !== 0)) return;
                if (busy) { event.preventDefault(); return; }
                busy = true;
                link.setAttribute('aria-disabled', 'true');
                link.className = originalClass + ' is-busy';
            });
        }

        function renderOptions(body, loading) {
            var list = el('providers');
            if (!list) return;
            var types = ['lark', 'wecom', 'dingtalk'];
            var names = ['飞书', '企业微信', '钉钉'];
            var mode = body && body.v === 1 && ['active', 'detached', 'unknown'].indexOf(body.mode) !== -1 ? body.mode : 'unknown';
            var providers = body && Array.isArray(body.providers) ? body.providers : [];
            var active = providers.filter(function (p) { return p && types.indexOf(p.type) !== -1 && p.state === 'active'; });
            if (mode === 'active' && (active.length !== 1 || providers.length !== 3 || types.some(function (type) { return providers.filter(function (p) { return p && p.type === type; }).length !== 1; }))) mode = 'unknown';
            // Only the public active contract creates a provider-specific navigation link.
            providerBusyLinks = [];
            list.textContent = '';
            types.forEach(function (type, index) {
                var providerState = mode === 'detached' ? 'inactive' : mode === 'active' ? (active[0].type === type ? 'active' : 'inactive') : 'unknown';
                var row = doc.createElement('li');
                row.className = 'provider provider-' + type + ' provider-' + providerState;
                row.setAttribute('data-provider', type);
                var symbol = doc.createElement('span');
                symbol.className = 'provider-symbol';
                symbol.setAttribute('aria-hidden', 'true');
                symbol.textContent = names[index].slice(0, 1);
                var name = doc.createElement(providerState === 'active' ? 'a' : 'span');
                name.className = 'provider-name';
                name.textContent = names[index];
                if (providerState === 'active') { name.href = '/auth/login?provider=' + type; guardLink(name, true); }
                else name.setAttribute('aria-disabled', 'true');
                var badge = doc.createElement('span');
                badge.className = 'provider-state';
                badge.textContent = { active: '已接入登录', inactive: '未启用', unknown: '待确认' }[providerState];
                row.appendChild(symbol); row.appendChild(name); row.appendChild(badge); list.appendChild(row);
            });
            text('options-status', loading ? '正在读取登录方式…' : mode === 'detached' ? '企业 IM 登录已停用' : mode === 'active' ? '企业平台状态已更新' : '登录方式暂时无法确认');
        }

        function refreshOptions() {
            var mine = ++optionsLatest;
            renderOptions(null, true);
            return Promise.resolve().then(function () {
                return env.fetch('/auth/options', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
            }).then(function (response) {
                if (!response || response.status !== 200) throw new Error('options unavailable');
                return response.json();
            }).then(function (body) {
                if (mine === optionsLatest && state.phase === 'signed-out') renderOptions(body, false);
            }).catch(function () {
                if (mine === optionsLatest && state.phase === 'signed-out') renderOptions(null, false);
            });
        }

        function setupTabs() {
            var modes = ['email', 'enterprise'];
            function select(mode, focus) {
                modes.forEach(function (value) {
                    var tab = el('tab-' + value);
                    tab.setAttribute('aria-selected', String(value === mode));
                    tab.setAttribute('tabindex', value === mode ? '0' : '-1');
                    show('panel-' + value, value === mode);
                    if (focus && value === mode) tab.focus();
                });
            }
            modes.forEach(function (mode, index) {
                var tab = el('tab-' + mode);
                if (!tab) return;
                tab.addEventListener('click', function () { select(mode, false); });
                tab.addEventListener('keydown', function (event) {
                    var next = { ArrowLeft: modes[1 - index], ArrowRight: modes[1 - index], Home: 'email', End: 'enterprise', Enter: mode, ' ': mode }[event.key];
                    if (next) { event.preventDefault(); select(next, true); }
                });
            });
            select('enterprise', false);
        }

        function motion() {
            var backdrop = el('backdrop');
            if (backdrop) backdrop.className = 'backdrop' + (doc.hidden || doc.visibilityState === 'hidden' ? ' motion-paused' : '');
        }

        function appCard(app, preview) {
            var li = doc.createElement('li');
            var link = doc.createElement(preview ? 'button' : 'a');
            link.className = preview ? 'app app-preview' : 'app';
            if (preview) {
                link.type = 'button';
                link.setAttribute('aria-haspopup', 'dialog');
                link.addEventListener('click', function () { if (!preview.open && state.phase === 'signed-in') preview.showModal(); });
            } else link.href = safeUrl(app.url);
            var icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('viewBox', '0 0 28 28');
            icon.setAttribute('aria-hidden', 'true');
            icon.setAttribute('class', 'app-icon');
            icon.innerHTML = ICONS[app.icon] || ICONS.grid; // 固定图标，不来自配置内容
            var body = doc.createElement('span');
            body.className = 'app-body';
            var name = doc.createElement('span');
            name.className = 'app-name';
            name.textContent = app.name;
            body.appendChild(name);
            if (app.description) {
                var desc = doc.createElement('span');
                desc.className = 'app-desc';
                desc.textContent = app.description;
                body.appendChild(desc);
            }
            var arrow = doc.createElement('span');
            arrow.className = 'app-arrow';
            arrow.setAttribute('aria-hidden', 'true');
            arrow.textContent = '→';
            link.appendChild(icon);
            link.appendChild(body);
            link.appendChild(arrow);
            li.appendChild(link);
            return li;
        }

        /**
         * 企业邮箱卡片：外观沿用 appCard；它是外部共享邮箱，新标签页打开且可重复点击，所以不用 guardLink。
         * 服务端字段只经 textContent 或校验后的 https href 输出。
         */
        function mailCard(snap) {
            var url = snap && snap.visible === true && typeof snap.webmailUrl === 'string' && /^https:\/\//i.test(snap.webmailUrl) ? safeUrl(snap.webmailUrl) : null;
            if (!url) return null;
            var li = doc.createElement('li');
            var link = doc.createElement('a');
            link.className = 'app app-mail';
            link.href = url;
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener noreferrer');
            var icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('viewBox', '0 0 28 28');
            icon.setAttribute('aria-hidden', 'true');
            icon.setAttribute('class', 'app-icon');
            icon.innerHTML = ICONS.mail; // 固定图标，不来自服务端
            var body = doc.createElement('span');
            body.className = 'app-body';
            var name = doc.createElement('span');
            name.className = 'app-name';
            name.textContent = '企业邮箱';
            var desc = doc.createElement('span');
            desc.className = 'app-desc';
            desc.textContent = String(snap.mailbox || '');
            body.appendChild(name);
            body.appendChild(desc);
            if (snap.unsynced === true) {
                var note = doc.createElement('span');
                note.className = 'app-mail-state';
                note.textContent = '暂未同步';
                body.appendChild(note);
            }
            link.appendChild(icon);
            link.appendChild(body);
            var unread = snap.unread;
            if (typeof unread === 'number' && Number.isSafeInteger(unread) && unread > 0) {
                var badge = doc.createElement('span');
                badge.className = 'app-badge';
                badge.setAttribute('aria-hidden', 'true');
                badge.textContent = unread > 99 ? '99+' : String(unread);
                var count = doc.createElement('span');
                count.className = 'app-sr';
                count.textContent = '，' + unread + ' 封未读邮件';
                link.appendChild(badge);
                link.appendChild(count);
            }
            var external = doc.createElement('span');
            external.className = 'app-sr';
            external.textContent = '（在新标签页打开）';
            var arrow = doc.createElement('span');
            arrow.className = 'app-arrow';
            arrow.setAttribute('aria-hidden', 'true');
            arrow.textContent = '→';
            link.appendChild(external);
            link.appendChild(arrow);
            li.appendChild(link);
            return li;
        }

        function renderApps(apps) {
            var list = el('apps');
            var signedIn = state.phase === 'signed-in';
            var preview = signedIn ? el('media-preview') : null;
            var previewCard = preview && appCard({ name: 'JMedia', icon: 'media', description: 'AI 媒体热点 · 内容分发（筹备中）' }, preview);
            // 企业邮箱紧跟 JMedia、位于 API 管理之前；没有 JMedia 时同样位于 API 之前。
            var mailNode = signedIn && mail ? mailCard(mail.getSnapshot()) : null;
            var extras = [previewCard, mailNode].filter(Boolean);
            var inserted = false;
            list.textContent = '';
            apps.forEach(function (app) {
                if (extras.length && !inserted && app.id === 'api') { extras.forEach(function (node) { list.appendChild(node); }); inserted = true; }
                list.appendChild(appCard(app));
            });
            if (!inserted) extras.forEach(function (node) { list.appendChild(node); });
            if (!apps.length && !extras.length) {
                var empty = doc.createElement('li');
                empty.className = 'noscript';
                empty.textContent = '暂时没有可以进入的应用，请联系管理员。';
                list.appendChild(empty);
            }
        }

        function render() {
            // 先同步企业邮箱会话：非登录状态或上下文变化时立即清空，随后 renderApps 读到的就是最新快照。
            if (mail) {
                rendering = true;
                try { mail.setSession(state.phase === 'signed-in' ? state.enterpriseMail : null); } finally { rendering = false; }
            }
            show('checking', state.phase === 'checking');
            show('login', state.phase === 'signed-out');
            show('unavailable', state.phase === 'unavailable');
            show('signed-in', state.phase === 'signed-in' || state.phase === 'legacy');
            show('logout', state.phase === 'signed-in');
            show('logout-note', state.phase === 'signed-in');
            var mediaPreview = el('media-preview');
            if (state.phase !== 'signed-in' && mediaPreview && mediaPreview.open) mediaPreview.close();
            // 部分退出后提供可用的重试（同源 POST 表单）；重新登录后不再显示。
            show('logout-retry', state.phase === 'signed-out' && state.retryLogout === true);
            text('login-error', state.phase === 'signed-out' ? state.notice : '');
            text('legacy-note', state.phase === 'legacy' ? '未启用企业登录：各应用会分别要求登录。' : '');
            if (state.phase === 'signed-in') {
                var who = state.user.name || state.user.email || '';
                text('greeting', '你好，' + who + (state.user.department ? '（' + state.user.department + '）' : ''));
                renderApps(state.apps);
            } else if (state.phase === 'legacy') {
                text('greeting', '');
                renderApps(state.apps);
            } else {
                text('greeting', '');
                el('apps').textContent = '';
            }
            // 工作日历只在已登录且服务端开启时出现；其他任何状态都立即清空。
            if (work) work.setSession(state.phase === 'signed-in' && state.workCalendar ? state.workCalendar : null);
        }

        function set(next) {
            if (next.phase && next.phase !== 'signed-out') optionsLatest++;
            for (var key in next) if (Object.prototype.hasOwnProperty.call(next, key)) state[key] = next[key];
            render();
        }

        var latest = 0;
        var mailFence = 0; // 点“退出”时记下当时最新的 /auth/me 序号；更早发起的应答不能再带回邮箱上下文。

        /**
         * 查询 /auth/me：200 显示入口，401 显示登录页，其他情况显示“暂时不可用”且不显示入口。
         * 轮询、焦点、切回页面和重试可能同时发起查询；只采用最后一次发起的查询结果，
         * 较早的应答（无论成功与否）都不能覆盖较新的状态。
         */
        function refresh() {
            var mine = ++latest;
            var current = function () { return mine === latest; };
            return Promise.resolve()
                .then(function () { return env.fetch('/auth/me', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }); })
                .then(function (response) {
                    if (!current()) return;
                    if (response.status === 401) { set({ phase: 'signed-out', user: null, apps: [], workCalendar: null, enterpriseMail: null, notice: state.phase === 'signed-in' ? '登录已结束，请重新登录。' : state.notice }); return refreshOptions(); }
                    if (response.status !== 200) throw new Error('status ' + response.status);
                    return response.json().then(function (body) {
                        if (!current()) return;
                        if (!body || body.signedIn !== true || !body.user) throw new Error('bad body');
                        var ids = Array.isArray(body.apps) ? body.apps.filter(function (id) { return typeof id === 'string'; }) : [];
                        set({ phase: 'signed-in', retryLogout: false, user: { name: String(body.user.name || ''), email: String(body.user.email || ''), department: body.user.department ? String(body.user.department) : '' }, apps: visibleApps(config, ids), notice: '', workCalendar: workCalendarOf(body), enterpriseMail: mine > mailFence ? enterpriseMailOf(body) : null });
                    });
                })
                .catch(function () { if (current()) set({ phase: 'unavailable', user: null, apps: [], workCalendar: null, enterpriseMail: null }); });
        }

        function readParams() {
            var params = new URLSearchParams(env.location.search || '');
            var notice = '';
            if (params.has('login_error')) notice = errorMessage(params.get('login_error'));
            else if (params.get('signed_out') === '1') notice = '已退出企业登录。已打开的应用页面会在各自会话到期后失效；在公用电脑上请在各应用内也点退出。';
            else if (params.get('signed_out') === 'partial') { notice = '已退出门户，但企业登录服务暂时无法退出。请稍后点下面的“再次退出企业登录”，或关闭浏览器。'; state.retryLogout = true; }
            if (params.has('login_error') || params.has('signed_out')) env.history.replaceState(null, '', env.location.pathname);
            return notice;
        }

        function start() {
            var title = typeof config.title === 'string' && config.title.trim() ? config.title.trim() : '企业OS';
            doc.title = title;
            text('title', title);
            text('subtitle', config.subtitle);
            text('login-hint', '使用企业账号，连接你的工作空间。');
            var button = el('login-button');
            if (button) { button.href = '/auth/login?method=enterprise'; guardLink(button); }
            var email = el('login-email');
            if (email) { email.href = '/auth/login?method=email'; guardLink(email); }
            setupTabs();
            renderOptions(null, true);
            motion();
            env.addEventListener('pageshow', function () { busyLinks.concat(providerBusyLinks).forEach(function (reset) { reset(); }); });
            var retry = el('retry');
            if (retry) retry.addEventListener('click', function () { set({ phase: 'checking' }); refresh(); });
            var logout = el('logout');
            // 点击“退出”时立即清空工作日历，不等待页面跳转。
            if (logout) logout.addEventListener('submit', function () { state.workCalendar = null; if (work) work.setSession(null); });
            if (logout) logout.addEventListener('submit', function () { mailFence = latest; state.enterpriseMail = null; if (mail) mail.setSession(null); });
            renderAdmin();
            text('help', config.help);
            if (!loginEnabled) { set({ phase: 'legacy', apps: visibleApps(config, null), workCalendar: null }); return Promise.resolve(); }
            state.notice = readParams();
            render();
            timer = env.setInterval(refresh, POLL_MS);
            env.addEventListener('focus', refresh);
            env.addEventListener('focus', function () { if (mail) mail.wake(); });
            doc.addEventListener('visibilitychange', function () { motion(); if (doc.visibilityState === 'visible') { refresh(); if (mail) mail.wake(); } });
            return refresh();
        }

        function renderAdmin() {
            var adminLinks = el('admin-links');
            if (!adminLinks) return;
            (Array.isArray(config.admin) ? config.admin : []).forEach(function (item) {
                var url = item && safeUrl(item.url);
                if (!url || !item.name) return;
                var a = doc.createElement('a');
                a.href = url;
                a.textContent = item.name;
                adminLinks.appendChild(a);
            });
            show('admin', adminLinks.children.length > 0);
        }

        return { start: start, refresh: refresh, state: state, stop: function () { if (timer) env.clearInterval(timer); if (work) work.destroy(); if (mail) mail.dispose(); } };
    }

    root.QYOS_PORTAL_CORE = { createPortal: createPortal, safeUrl: safeUrl, errorMessage: errorMessage, visibleApps: visibleApps, workCalendarOf: workCalendarOf, enterpriseMailOf: enterpriseMailOf, POLL_MS: POLL_MS };
})(typeof window !== 'undefined' ? window : this);
