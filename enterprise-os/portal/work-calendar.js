// 工作日历（员工端）。portal-core 在已登录且服务端开启时调用 setSession；私有内容只在内存中，不写入任何存储，不记录日志。
(function (root) {
    'use strict';

    const CONTEXT_HEADER = 'X-QYOS-Work-Context';
    const DEFAULT_BASE = '/portal/work';
    const MAX_RANGE_DAYS = 62, TITLE_MAX = 100, NOTES_MAX = 1000, NAME_MAX = 100, REPORT_MAX = 10000;
    const DAY_MS = 86400000, SHANGHAI_OFFSET_MS = 8 * 3600000;
    const STALE = Object.freeze({ stale: true });
    const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const PRIORITIES = { high: '高', normal: '普通', low: '低' };
    const MAX_SUBTASKS = 8, SUBTASK_TITLE_MAX = 80;
    const priorityOf = (item) => item && (item.priority === 'high' || item.priority === 'low') ? item.priority : 'normal';
    const subtasksOf = (item) => item && Array.isArray(item.subtasks) ? item.subtasks : [];
    const subtaskEntries = (items) => items.map((step) => step.id ? { id: step.id, title: step.title } : { title: step.title });
    const STATUS_TEXT = { open: '未完成', overdue: '逾期', completed: '已完成', canceled: '已取消' };
    const NOTICE_TEXT = { due_changed: '管理员调整了截止时间。', reopened: '管理员重新打开了此任务。', details_changed: '管理员更新了任务内容。', canceled: '管理员已取消此任务，无需处理。' };
    const NOTICE_TAG = { due_changed: '改期', reopened: '重开', details_changed: '已更新' };
    const REPORT_STATUS = { submitted: '已提交', late: '迟交', missing: '未提交', pending: '待提交', not_required: '无需提交', unknown: '未知' };
    const CODE_TEXT = {
        prefill_too_large: '完成事项较多，无法完整预填。请在保留的草稿中手动整理日报。',
        list_not_empty: '清单中还有任务，不能删除。',
        quota_exceeded: '数量已达上限，请先清理。',
        invalid_title: '标题需要 1–100 个字。',
        invalid_notes: '备注最多 1000 个字。',
        invalid_priority: '请选择有效的优先级。',
        invalid_subtasks: '请检查子任务内容和数量。',
        invalid_name: '清单名称需要 1–100 个字。',
        invalid_date: '日期无效。',
        invalid_time: '时间无效。',
        list_not_found: '所选清单已不存在，请重新加载。',
        invalid_transition: '任务状态已变化，请重新加载。',
        version_conflict: '内容已在其他页面被修改，请重新加载后再操作。',
        network: '网络连接失败，请稍后再试。',
        unavailable: '服务暂时不可用，请稍后再试。',
    };

    // ---- 日期：只用 YYYY-MM-DD 字符串做 UTC 运算，与浏览器时区无关 ----
    function toMs(day) {
        if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
        const ms = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
        return new Date(ms).toISOString().slice(0, 10) === day ? ms : NaN;
    }
    const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
    const isDay = (day) => !isNaN(toMs(day));
    const addDays = (day, n) => fromMs(toMs(day) + n * DAY_MS);
    const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS);
    const weekdayOf = (day) => new Date(toMs(day)).getUTCDay();
    const weekStart = (day) => addDays(day, -((weekdayOf(day) + 6) % 7)); // 周一开始
    function addMonths(day, n) {
        const y = +day.slice(0, 4), m = +day.slice(5, 7) - 1 + n;
        const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        return fromMs(Date.UTC(y, m, Math.min(+day.slice(8, 10), lastDay)));
    }
    function viewRange(view, anchor) {
        if (view === 'day') return { from: anchor, to: anchor };
        if (view === 'month') {
            const first = anchor.slice(0, 8) + '01', last = addDays(addMonths(first, 1), -1);
            return { from: weekStart(first), to: addDays(weekStart(last), 6) };
        }
        const start = weekStart(anchor);
        return { from: start, to: addDays(start, 6) };
    }
    const shiftAnchor = (view, anchor, step) => (view === 'month' ? addMonths(anchor, step) : addDays(anchor, step * (view === 'week' ? 7 : 1)));
    function rangeQuery(range) {
        const span = diffDays(range.from, range.to);
        if (!isDay(range.from) || !isDay(range.to) || !(span >= 0 && span < MAX_RANGE_DAYS)) throw new Error('invalid_range');
        return '?from=' + range.from + '&to=' + range.to + '&unscheduled=true';
    }
    const shanghaiToday = (nowMs) => fromMs(nowMs + SHANGHAI_OFFSET_MS); // 仅用于首次请求前的估计，随后以服务端 today 为准
    function formatShanghai(iso) {
        const ms = Date.parse(iso);
        if (typeof iso !== 'string' || isNaN(ms)) return '—';
        const s = new Date(ms + SHANGHAI_OFFSET_MS).toISOString();
        return s.slice(0, 10) + ' ' + s.slice(11, 16);
    }
    const shortDay = (day) => (+day.slice(5, 7)) + '月' + (+day.slice(8, 10)) + '日';
    const dayLabel = (day) => shortDay(day) + ' ' + WEEKDAYS[weekdayOf(day)];
    function viewTitle(view, anchor) {
        if (view === 'month') return anchor.slice(0, 4) + '年' + (+anchor.slice(5, 7)) + '月';
        if (view === 'day') return anchor.slice(0, 4) + '年' + dayLabel(anchor);
        const r = viewRange('week', anchor);
        return shortDay(r.from) + ' – ' + shortDay(r.to);
    }

    // ---- 任务与日报的纯函数 ----
    function itemStatus(item) {
        if (item.state === 'canceled') return 'canceled';
        if (item.state === 'completed') return 'completed';
        return item.overdue === true ? 'overdue' : 'open';
    }
    function matchesFilter(item, f) {
        const personal = item.kind === 'personal', st = itemStatus(item);
        if (f.mode === 'assigned' && personal) return false;
        if (f.mode === 'unscheduled' && (!personal || item.dueDate)) return false;
        if (f.mode === 'list' && (!personal || item.listId !== f.listId)) return false;
        if (f.status === 'open') return st === 'open' || st === 'overdue';
        return !f.status || f.status === 'all' || st === f.status;
    }
    const compareItems = (a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')
        || (a.dueTime || '99:99').localeCompare(b.dueTime || '99:99') || a.title.localeCompare(b.title, 'zh-CN');
    function groupByDay(items) {
        const groups = {};
        items.forEach((it) => { if (it.dueDate) (groups[it.dueDate] = groups[it.dueDate] || []).push(it); });
        Object.keys(groups).forEach((k) => groups[k].sort(compareItems));
        return groups;
    }
    function reportStatusLabel(r) {
        if (r.submitted) return r.submitted.late ? '已提交 · 迟交' : '已提交';
        const s = r.status === 'missing' && r.startDateKnown === false ? 'unknown' : r.status;
        return REPORT_STATUS[s] || '未知';
    }
    function reportTone(r) {
        if (r.submitted) return r.submitted.late ? 'warn' : 'ok';
        if (r.status === 'missing' && r.startDateKnown !== false) return 'danger';
        return r.status === 'pending' ? 'warn' : 'muted';
    }
    const draftText = (r) => (r && r.draft && typeof r.draft.text === 'string' ? r.draft.text : '');
    const reportDirty = (r, text) => !!r && !r.submitted && text !== draftText(r);
    const canSubmit = (r, text, today) => !!r && !r.submitted && !!r.draft && isDay(today) && r.date <= today
        && !reportDirty(r, text) && draftText(r).trim() !== '';
    const charCount = (s) => Array.from(s).length;
    const validName = (s) => charCount(s) >= 1 && charCount(s) <= NAME_MAX;
    function validateTask(f) {
        if (charCount(f.title) < 1 || charCount(f.title) > TITLE_MAX) return CODE_TEXT.invalid_title;
        if (charCount(f.notes) > NOTES_MAX) return CODE_TEXT.invalid_notes;
        if (f.subtasks && (f.subtasks.length > MAX_SUBTASKS || f.subtasks.some((step) => !step.title || charCount(step.title) > SUBTASK_TITLE_MAX)))
            return '最多添加 8 条子任务，每条需要 1–80 个字；不需要的子任务可以移除。';
        if (f.dueDate !== null && !isDay(f.dueDate)) return CODE_TEXT.invalid_date;
        if (f.dueTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(f.dueTime)) return CODE_TEXT.invalid_time;
        return '';
    }
    function createBody(f) {
        const b = { title: f.title };
        if (f.notes) b.notes = f.notes;
        if (f.listId) b.listId = f.listId;
        if (f.dueDate) { b.dueDate = f.dueDate; if (f.dueTime) b.dueTime = f.dueTime; }
        if (f.priority && f.priority !== 'normal') b.priority = f.priority;
        if (f.subtasks && f.subtasks.length) b.subtasks = subtaskEntries(f.subtasks);
        return b;
    }
    /** 只发送变化的字段；日期与时间总是成对发送（核心不接受单独的 dueTime）。 */
    function taskPatch(item, f) {
        const b = {};
        if (f.title !== item.title) b.title = f.title;
        if (f.notes !== (item.notes || '')) b.notes = f.notes;
        if (f.listId !== (item.listId || null)) b.listId = f.listId;
        if (f.dueDate !== (item.dueDate || null) || f.dueTime !== (item.dueTime || null)) { b.dueDate = f.dueDate; b.dueTime = f.dueDate ? f.dueTime : null; }
        if (f.priority && f.priority !== priorityOf(item)) b.priority = f.priority;
        if (f.subtasks) {
            const next = subtaskEntries(f.subtasks);
            if (JSON.stringify(next) !== JSON.stringify(subtaskEntries(subtasksOf(item)))) b.subtasks = next;
        }
        if (!Object.keys(b).length) return null;
        b.expectedVersion = item.version;
        return b;
    }
    const validItem = (x) => !!x && typeof x.id === 'string' && typeof x.title === 'string' && typeof x.version === 'number' && (!x.dueDate || isDay(x.dueDate));
    const validList = (l) => !!l && typeof l.id === 'string' && typeof l.name === 'string' && typeof l.version === 'number';
    const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN');
    const failure = (kind, status, code) => ({ kind, status, code: code || null });
    function messageFor(e) {
        if (e && e.code && CODE_TEXT[e.code]) return CODE_TEXT[e.code];
        if (e && e.kind === 'conflict') return '内容已变化，请重新加载后再操作。';
        if (e && (e.status === 400 || e.status === 422)) return '填写的内容无效，请检查后再试。';
        if (e && e.status === 413) return '内容过长。';
        if (e && e.status === 429) return '操作太频繁，请稍后再试。';
        return CODE_TEXT.unavailable;
    }

    // ---- 会话请求：上下文头、同源、no-store、回显校验、代次守卫、可中止 ----
    function createSession(fetchFn, base, AbortCtl) {
        let context = null, gen = 0, pending = [];
        const abortAll = () => { const list = pending; pending = []; list.forEach((c) => { try { c.abort(); } catch (e) { /* 忽略 */ } }); };
        return {
            context: () => context,
            pending: () => pending.length,
            setContext(next) { next = next || null; if (next === context) return false; context = next; gen++; abortAll(); return true; },
            invalidate() { gen++; abortAll(); },
            request(method, path, body) {
                if (!context) return Promise.reject(STALE);
                const mine = gen, ctx = context, ctl = AbortCtl ? new AbortCtl() : null;
                const live = () => mine === gen && ctx === context;
                const headers = { accept: 'application/json' };
                headers[CONTEXT_HEADER] = ctx;
                const init = { method, credentials: 'same-origin', cache: 'no-store', headers };
                if (ctl) { init.signal = ctl.signal; pending.push(ctl); }
                if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
                const settle = () => { if (ctl) pending = pending.filter((c) => c !== ctl); };
                let p;
                try { p = Promise.resolve(fetchFn(base + path, init)); } catch (e) { p = Promise.reject(e); }
                return p.then((res) => {
                    if (!live()) throw STALE;
                    const status = res && typeof res.status === 'number' ? res.status : 0;
                    if (status === 401 || status === 403 || status === 404) throw failure('auth', status);
                    if (status === 0 || status >= 500) throw failure('error', status, 'unavailable');
                    const echoed = res.headers && typeof res.headers.get === 'function' ? res.headers.get(CONTEXT_HEADER) : null;
                    if (echoed !== ctx) throw failure('auth', status, 'context_mismatch');
                    return Promise.resolve().then(() => res.json()).catch(() => null).then((data) => {
                        if (!live()) throw STALE;
                        if (status >= 200 && status < 300 && data && typeof data === 'object') return data;
                        const code = data && (typeof data.error === 'string' ? data.error : typeof data.code === 'string' ? data.code : null);
                        throw failure(status === 409 ? 'conflict' : 'error', status, code);
                    });
                }, () => { if (!live()) throw STALE; throw failure('error', 0, 'network'); })
                    .then((v) => { settle(); return v; }, (e) => { settle(); throw live() ? e : STALE; });
            },
        };
    }

    // ---- 界面 ----
    function create(options) {
        const doc = options.document, rootEl = options.root, layout = options.layout || null, win = doc.defaultView || null;
        const now = typeof options.now === 'function' ? options.now : Date.now;
        const session = createSession(options.fetch, options.apiBase || DEFAULT_BASE, options.AbortController || root.AbortController);
        const todoBox = doc.getElementById('work-todo');
        let S = blank(), dialog = null, destroyed = false, calBox = null, reportBox = null, rp = {};

        function blank() {
            return { today: null, anchor: shanghaiToday(now()), view: 'week', mode: 'all', listId: null, status: 'all', lists: [], items: [],
                loaded: null, truncated: false, loading: false, notice: '', conflict: false, locked: false, busy: false, loadSeq: 0,
                todoSeq: 0, todo: null, todoLoading: false, todoNotice: '', todoExpanded: new Set(),
                reportSeq: 0, reportDay: null, report: null, reportText: '', reportNotice: '', reportTone: 'error', reportConflict: false, reportBusy: false };
        }
        function h(tag, props, kids) {
            const n = doc.createElement(tag);
            (kids || []).forEach((c) => { if (c !== null && c !== undefined && c !== false) n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
            Object.keys(props || {}).forEach((k) => {
                const v = props[k];
                if (v === null || v === undefined || v === false) return;
                if (k === 'text') n.textContent = v;
                else if (k === 'class') n.className = v;
                else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
                else if (k === 'value' || k === 'checked' || k === 'disabled') n[k] = v;
                else n.setAttribute(k, v === true ? '' : String(v));
            });
            return n;
        }
        const opt = (value, label) => h('option', { value }, [label]);
        const enc = encodeURIComponent;
        const visibleItems = () => S.items.filter((it) => matchesFilter(it, S));
        const findItem = (it) => {
            const matches = (x) => x.id === it.id && x.kind === it.kind;
            const cal = S.items.find(matches), todo = S.todo && S.todo.pending.concat(S.todo.completed).find(matches);
            return todo && (!cal || todo.version > cal.version) ? todo : cal;
        };
        const listName = (id) => (!id ? '无' : (S.lists.find((l) => l.id === id) || { name: '已删除的清单' }).name);

        function keepFocus(fn) {
            const a = doc.activeElement;
            const scope = a && todoBox && todoBox.contains(a) ? todoBox : rootEl;
            const key = a && a !== doc.body && scope.contains(a) && a.getAttribute ? a.getAttribute('data-key') : null;
            fn();
            const n = key && scope.querySelector('[data-key="' + key + '"]');
            if (n && n !== doc.activeElement) n.focus();
        }
        function alertBox(msg, isError, action) {
            return h('div', { class: 'wc-alert' + (isError ? ' is-error' : ''), role: isError ? 'alert' : 'status' }, [h('span', { text: msg }),
                action ? h('button', { type: 'button', class: 'wc-btn', 'data-key': 'alert-action', onclick: action[1] }, [action[0]]) : null]);
        }

        // -- 会话生命周期 --
        function clearAll() { closeDialog(); S = blank(); rp = {}; calBox = reportBox = null; rootEl.textContent = ''; if (todoBox) todoBox.textContent = ''; }
        function setSession(wc) {
            if (destroyed) return;
            const next = wc && wc.enabled === true && typeof wc.context === 'string' && wc.context ? wc.context : null;
            if (next === session.context()) {
                if (next && S.todo && S.todo.today !== shanghaiToday(now()) && !S.todoLoading) loadTodo();
                return;
            }
            session.setContext(next);
            clearAll();
            rootEl.hidden = !next;
            if (todoBox) todoBox.hidden = !next;
            if (layout) layout.classList.toggle('wc-active', !!next);
            if (next) { buildShell(); loadRange(true); loadTodo(); }
        }
        function lockOut() { session.invalidate(); clearAll(); S.locked = true; buildShell(); }
        function onUnload(e) { if (reportDirty(S.report, S.reportText)) { e.preventDefault(); e.returnValue = ''; } }
        if (win) win.addEventListener('beforeunload', onUnload);
        function destroy() {
            if (destroyed) return;
            session.setContext(null); clearAll(); rootEl.hidden = true;
            if (todoBox) todoBox.hidden = true;
            if (layout) layout.classList.remove('wc-active');
            if (win) win.removeEventListener('beforeunload', onUnload);
            destroyed = true;
        }
        function buildShell() {
            rootEl.textContent = '';
            rootEl.appendChild(h('div', { class: 'wc-head' }, [h('h2', { text: '我的工作日历' }), S.locked ? null : h('span', { class: 'wc-muted', text: '个人任务仅自己可见' })]));
            if (S.locked) {
                calBox = reportBox = null;
                rootEl.appendChild(alertBox('工作日历暂时无法使用，私有内容已隐藏。', true, ['重新加载', () => { S.locked = false; buildShell(); loadRange(true); loadTodo(); }]));
                renderTodo();
                return;
            }
            calBox = h('div'); reportBox = h('section', { class: 'wc-section', 'aria-label': '日报' });
            rootEl.appendChild(calBox); rootEl.appendChild(reportBox);
            renderCal(); renderReport(); renderTodo();
        }

        // -- 写操作：忙碌禁用、无自动重试、冲突提供显式重新加载 --
        function mutate(o) {
            const st = S, key = o.area === 'report' ? 'reportBusy' : 'busy', hd = o.handle || null;
            if (st[key] || st.locked) return;
            st[key] = true;
            if (hd) { hd.setBusy(true); hd.setError(''); }
            if (o.area === 'report') updateReportControls();
            session.request(o.method, o.path, o.body).then((data) => {
                if (S !== st) return;
                st[key] = false;
                if (hd) hd.setBusy(false);
                o.ok(data);
                if (o.area === 'report') updateReportControls();
                else loadTodo();
            }).catch((e) => {
                if (S !== st || e === STALE) return;
                st[key] = false;
                if (hd) hd.setBusy(false);
                if (e && e.kind === 'auth') return lockOut();
                if (e && e.code === 'prefill_too_large') {
                    closeDialog();
                    Object.assign(st, { reportNotice: messageFor(e), reportTone: 'error', reportConflict: false });
                    renderReport();
                    return;
                }
                const msg = messageFor(e), conflict = !!e && e.kind === 'conflict';
                if (o.area === 'report' && (conflict || !hd || dialog !== hd)) {
                    if (conflict) closeDialog();
                    Object.assign(st, { reportNotice: msg, reportTone: 'error', reportConflict: conflict });
                    renderReport();
                } else if (hd && dialog === hd) { hd.setError(msg, conflict); if (hd.refresh) hd.refresh(); }
                else { st.notice = msg; st.todoNotice = msg; st.conflict = conflict; renderCal(); renderTodo(); }
            });
        }
        function upsert(next, kind) {
            if (!validItem(next)) throw failure('error', 0, 'unavailable');
            const item = Object.assign({}, next, { kind });
            const keep = !item.dueDate || (S.loaded && item.dueDate >= S.loaded.from && item.dueDate <= S.loaded.to);
            S.items = S.items.filter((x) => !(x.id === item.id && x.kind === kind));
            if (keep) S.items.push(item);
            if (S.todo) {
                for (const key of ['pending', 'completed']) {
                    S.todo[key] = S.todo[key].map((entry) => entry.id === item.id && entry.kind === kind ? item : entry);
                }
            }
        }

        // -- 日历数据 --
        function loadRange(initial) {
            if (S.locked || !calBox) return;
            const st = S, range = viewRange(st.view, st.anchor), mine = ++st.loadSeq;
            let query;
            try { query = rangeQuery(range); } catch (e) { return; }
            st.loading = true; renderCal();
            session.request('GET', '/bootstrap' + query).then((data) => {
                if (S !== st || mine !== st.loadSeq) return;
                if (!data || !isDay(data.today) || !Array.isArray(data.tasks) || !Array.isArray(data.assigned) || !Array.isArray(data.lists)) throw failure('error', 0, 'unavailable');
                st.today = data.today;
                st.lists = data.lists.filter(validList).sort(byName);
                st.items = data.tasks.filter(validItem).map((t) => Object.assign({}, t, { kind: 'personal' }))
                    .concat(data.assigned.filter(validItem).map((t) => Object.assign({}, t, { kind: 'assigned' })));
                st.loaded = range; st.truncated = data.truncated === true; st.loading = false;
                if (st.mode === 'list' && !st.lists.some((l) => l.id === st.listId)) { st.mode = 'all'; st.listId = null; }
                if (initial) {
                    st.anchor = st.today;
                    if (!st.reportDay) loadReport(st.today);
                    const want = viewRange(st.view, st.anchor);
                    if (want.from !== range.from || want.to !== range.to) return loadRange(false);
                }
                renderCal();
            }).catch((e) => {
                if (S !== st || mine !== st.loadSeq || e === STALE) return;
                if (e && e.kind === 'auth') return lockOut();
                Object.assign(st, { loading: false, notice: messageFor(e), conflict: false });
                renderCal();
            });
        }
        function navigate(view, anchor) {
            S.view = view; S.anchor = anchor;
            if (!S.conflict) S.notice = '';
            loadRange(false);
        }
        function reloadAll() { closeDialog(); S.notice = ''; S.conflict = false; loadRange(false); loadTodo(); }

        function loadTodo() {
            if (!todoBox || S.locked) return;
            const st = S, seq = ++st.todoSeq;
            st.todoLoading = true; st.todoNotice = ''; renderTodo();
            session.request('GET', '/todo-summary').then((data) => {
                if (S !== st || seq !== st.todoSeq) return;
                if (!data || !isDay(data.today) || !Array.isArray(data.pending) || !Array.isArray(data.completed)) throw failure('error', 0, 'unavailable');
                const visible = (it) => validItem(it) && (it.kind === 'personal' || it.kind === 'assigned');
                st.todo = { today: data.today, pending: data.pending.filter(visible), completed: data.completed.filter(visible), truncated: data.truncated === true };
                st.todoLoading = false; renderTodo();
            }).catch((e) => {
                if (S !== st || seq !== st.todoSeq || e === STALE) return;
                // Bootstrap owns auth recovery so that a missing summary route does not disable the calendar.
                if (e && e.kind === 'auth') { st.todo = null; }
                st.todoLoading = false; st.todoNotice = '暂时无法加载待办，请刷新重试。'; renderTodo();
            });
        }
        function renderTodo() {
            if (!todoBox) return;
            keepFocus(() => {
                todoBox.textContent = '';
                todoBox.appendChild(h('div', { class: 'wc-head' }, [h('h2', { text: '待办清单' }),
                    S.locked ? null : iconBtn('todo-refresh', '↻', '刷新待办', loadTodo)]));
                const section = (title, items, empty) => h('section', { class: 'wc-section', 'aria-label': title }, [
                    h('div', { class: 'wc-section-head' }, [h('h3', { text: title }), h('span', { class: 'wc-count', text: items.length + (S.todo.truncated ? '+' : '') })]),
                    items.length ? h('div', { class: 'wc-rows' }, items.map(todoRow)) : h('p', { class: 'wc-muted wc-empty', text: empty })]);
                if (S.todoNotice) todoBox.appendChild(alertBox(S.todoNotice, true, null));
                if (S.todo && !S.locked) {
                    todoBox.appendChild(section('今日待办', S.todo.pending, '今天没有待办任务'));
                    todoBox.appendChild(section('本周已完成', S.todo.completed, '本周还没有完成的任务'));
                    if (S.todo.truncated) todoBox.appendChild(h('p', { class: 'wc-muted', text: '任务较多，仅显示部分结果。' }));
                } else if (!S.todoNotice) todoBox.appendChild(h('p', { class: 'wc-muted', text: S.locked ? '私有内容已隐藏。' : '正在加载待办…' }));
            });
        }

        // -- 日历渲染 --
        function iconBtn(key, symbol, label, fn) {
            return h('button', { type: 'button', class: 'wc-btn wc-icon', title: label, 'aria-label': label, 'data-key': key, onclick: fn }, [h('span', { 'aria-hidden': 'true', text: symbol })]);
        }
        function toolbar() {
            const step = { week: ['上一周', '下一周'], month: ['上个月', '下个月'], day: ['前一天', '后一天'] }[S.view];
            const seg = h('div', { class: 'wc-seg', role: 'group', 'aria-label': '视图' }, [['week', '周'], ['month', '月'], ['day', '日']].map((v) =>
                h('button', { type: 'button', 'aria-pressed': String(S.view === v[0]), 'data-key': 'view-' + v[0], onclick: () => navigate(v[0], S.anchor) }, [v[1]])));
            return h('div', { class: 'wc-toolbar' }, [
                h('div', { class: 'wc-nav' }, [
                    iconBtn('prev', '‹', step[0], () => navigate(S.view, shiftAnchor(S.view, S.anchor, -1))),
                    h('button', { type: 'button', class: 'wc-btn', 'data-key': 'today', disabled: !S.today, onclick: () => navigate(S.view, S.today) }, ['今天']),
                    iconBtn('next', '›', step[1], () => navigate(S.view, shiftAnchor(S.view, S.anchor, 1))),
                    h('h3', { class: 'wc-title', text: viewTitle(S.view, S.anchor) })]),
                h('div', { class: 'wc-actions' }, [seg,
                    iconBtn('refresh', '↻', '刷新', () => { S.notice = ''; S.conflict = false; loadRange(false); }),
                    iconBtn('new', '+', '新建任务', () => openTaskForm(null)),
                    h('button', { type: 'button', class: 'wc-btn', 'data-key': 'ai-task', onclick: openAiTask }, ['AI 新建任务'])]),
                h('span', { class: 'wc-sr', role: 'status', text: S.loading ? '正在加载' : '' })]);
        }
        function filters() {
            const lists = S.lists.map((l) => opt('list:' + l.id, l.name));
            const mode = h('select', { 'aria-label': '任务范围', 'data-key': 'mode', value: S.mode === 'list' ? 'list:' + S.listId : S.mode, onchange: (e) => {
                const v = e.target.value;
                S.mode = v.indexOf('list:') === 0 ? 'list' : v; S.listId = S.mode === 'list' ? v.slice(5) : null; renderCal();
            } }, [opt('all', '全部任务'), opt('unscheduled', '仅未排期'), opt('assigned', '管理员指派')].concat(lists.length ? [h('optgroup', { label: '我的清单' }, lists)] : []));
            const status = h('select', { 'aria-label': '任务状态', 'data-key': 'status', value: S.status, onchange: (e) => { S.status = e.target.value; renderCal(); } },
                [['all', '全部状态'], ['open', '未完成'], ['overdue', '逾期'], ['completed', '已完成'], ['canceled', '已取消']].map((o) => opt(o[0], o[1])));
            return h('div', { class: 'wc-filters' }, [mode, status, h('button', { type: 'button', class: 'wc-btn', 'data-key': 'lists', onclick: () => openLists() }, ['管理清单'])]);
        }
        function itemRow(it, hd, fromTodo) {
            const st = itemStatus(it), key = it.kind + '-' + it.id + (hd ? '-d' : '') + (fromTodo ? '-todo' : ''), tags = [];
            if (it.kind === 'assigned') tags.push(h('span', { class: 'wc-tag is-admin', text: '管理员' }));
            if (it.kind === 'assigned' && st !== 'canceled' && NOTICE_TAG[it.notice]) tags.push(h('span', { class: 'wc-tag is-warn', text: NOTICE_TAG[it.notice] }));
            if (st === 'overdue') tags.push(h('span', { class: 'wc-tag is-danger', text: '逾期' }));
            if (st === 'canceled') tags.push(h('span', { class: 'wc-tag', text: '已取消' }));
            return h('div', { class: 'wc-item is-' + st }, [
                h('input', { type: 'checkbox', checked: it.state === 'completed', disabled: st === 'canceled' || (fromTodo && S.todoLoading), 'data-key': 'cb-' + key,
                    'aria-label': (it.state === 'completed' ? '撤销完成：' : '标记完成：') + it.title, onchange: (e) => onCheck(it, e.target, hd) }),
                h('button', { type: 'button', class: 'wc-item-title', title: it.title, 'data-key': 'it-' + key, onclick: () => openDetails(findItem(it) || it) },
                    [it.dueTime ? h('span', { class: 'wc-time', text: it.dueTime }) : null, h('span', { class: 'wc-name', text: it.title })]),
                priorityBadge(it),
            ].concat(tags));
        }
        function priorityBadge(it) {
            const priority = priorityOf(it);
            return h('span', { class: 'wc-priority is-' + priority, title: '优先级：' + PRIORITIES[priority], text: PRIORITIES[priority] });
        }
        function subtaskProgress(it) {
            const items = subtasksOf(it);
            return items.filter((step) => step.completed === true).length + '/' + items.length + ' 已完成';
        }
        function subtaskList(it, hd, fromTodo = false) {
            return h('ul', { class: 'wc-subtask-list' }, subtasksOf(it).map((step) => h('li', {}, [h('label', {}, [
                h('input', { type: 'checkbox', checked: step.completed === true,
                    disabled: it.state === 'canceled' || (fromTodo && S.todoLoading),
                    'data-key': 'step-' + it.kind + '-' + it.id + '-' + step.id + (fromTodo ? '-todo' : '-detail'),
                    onchange: (e) => toggleSubtask(it, step.id, e.target, hd) }),
                h('span', { text: step.title })])])));
        }
        function todoRow(it) {
            const row = itemRow(it, null, true);
            if (!subtasksOf(it).length) return row;
            const key = it.kind + '-' + it.id;
            const expanded = S.todoExpanded.has(key);
            return h('div', { class: 'wc-todo-entry' }, [row,
                h('button', { type: 'button', class: 'wc-subtask-disclose', 'aria-expanded': String(expanded),
                    'data-key': 'steps-' + key, onclick: () => {
                        if (expanded) S.todoExpanded.delete(key); else S.todoExpanded.add(key);
                        renderTodo();
                    } }, [(expanded ? '▾' : '▸') + ' 子任务 · ' + subtaskProgress(it)]),
                expanded ? subtaskList(it, null, true) : null]);
        }
        function grid() {
            const range = viewRange(S.view, S.anchor), groups = groupByDay(visibleItems()), limit = S.view === 'day' ? Infinity : 2;
            const box = h('div', { class: 'wc-grid wc-' + S.view, 'aria-busy': String(S.loading) });
            if (S.view === 'month') '一二三四五六日'.split('').forEach((w) => box.appendChild(h('div', { class: 'wc-wd', 'aria-hidden': 'true', text: '周' + w })));
            for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
                const d = day, items = groups[d] || [];
                const out = S.view === 'month' && d.slice(0, 7) !== S.anchor.slice(0, 7);
                const label = S.view === 'month' ? String(+d.slice(8)) : S.view === 'week' ? WEEKDAYS[weekdayOf(d)] + ' ' + (+d.slice(8)) : dayLabel(d);
                const cell = h('div', { class: 'wc-cell' + (d === S.today ? ' is-today' : '') + (out ? ' is-out' : '') }, [S.view === 'day'
                    ? h('span', { class: 'wc-date', text: label })
                    : h('button', { type: 'button', class: 'wc-date', 'data-key': 'date-' + d, title: dayLabel(d), 'aria-label': dayLabel(d) + '，' + items.length + ' 项', onclick: () => navigate('day', d) }, [label])]);
                items.slice(0, limit).forEach((it) => cell.appendChild(itemRow(it, null)));
                if (items.length > limit) cell.appendChild(h('button', { type: 'button', class: 'wc-more', 'data-key': 'more-' + d, onclick: () => openDayList(d) }, ['+' + (items.length - limit) + ' 项']));
                if (!items.length && S.view === 'day') cell.appendChild(h('p', { class: 'wc-muted', text: '当天没有任务' }));
                box.appendChild(cell);
            }
            return box;
        }
        function renderCal() {
            if (!calBox) return;
            keepFocus(() => {
                calBox.textContent = '';
                calBox.appendChild(toolbar());
                calBox.appendChild(filters());
                if (S.notice) calBox.appendChild(alertBox(S.notice, true, S.conflict ? ['重新加载', reloadAll] : null));
                if (S.truncated) calBox.appendChild(alertBox('任务较多，当前范围只显示了部分任务。', false, null));
                calBox.appendChild(grid());
                if (S.mode === 'assigned') return;
                const undated = visibleItems().filter((it) => !it.dueDate).sort(compareItems);
                calBox.appendChild(h('section', { class: 'wc-section', 'aria-label': '未排期' }, [
                    h('div', { class: 'wc-section-head' }, [h('h3', { text: '未排期' }), h('span', { class: 'wc-muted', text: undated.length + ' 项' })]),
                    undated.length ? h('div', { class: 'wc-rows' }, undated.map((it) => itemRow(it, null))) : h('p', { class: 'wc-muted', text: '没有未排期的任务' })]));
            });
            if (dialog && dialog.refresh) dialog.refresh();
        }

        // -- 完成 / 撤销（指派任务只允许这两种操作）--
        function onCheck(it, cb, hd) {
            const cur = findItem(it);
            if (!cur || S.busy || itemStatus(cur) === 'canceled') { cb.checked = !cb.checked; return; }
            cb.disabled = true;
            toggle(cur, cb.checked, hd);
        }
        function toggle(it, done, hd) {
            const path = (it.kind === 'assigned' ? '/assignments/' : '/tasks/') + enc(it.id) + (done ? '/complete' : '/undo');
            mutate({ handle: hd, method: 'POST', path, body: { expectedVersion: it.version }, ok: (next) => {
                upsert(next, it.kind);
                if (hd && (!hd.refresh || hd.details)) closeDialog();
                renderCal();
            } });
        }
        function toggleSubtask(it, subtaskId, cb, hd) {
            const cur = findItem(it) || it;
            const step = subtasksOf(cur).find((entry) => entry.id === subtaskId);
            if (!step || S.busy || cur.state === 'canceled') { cb.checked = step ? step.completed === true : !cb.checked; return; }
            const completed = cb.checked;
            cb.checked = step.completed === true;
            if (!hd) cb.disabled = true;
            const path = (cur.kind === 'assigned' ? '/assignments/' : '/tasks/') + enc(cur.id) + '/subtasks/' + enc(subtaskId);
            mutate({ handle: hd, method: 'POST', path, body: { expectedVersion: cur.version, completed }, ok: (next) => {
                upsert(next, cur.kind);
                renderCal();
            } });
        }

        // -- 对话框（原生 <dialog>，模态，Esc 关闭；忙碌时不可关闭）--
        function openDialog(title, body, actions) {
            closeDialog();
            const opener = doc.activeElement, openerKey = opener && opener.getAttribute ? opener.getAttribute('data-key') : null;
            const err = h('p', { class: 'wc-error', role: 'alert', hidden: true });
            const reload = h('button', { type: 'button', class: 'wc-btn', hidden: true, onclick: reloadAll }, ['重新加载']);
            const bodyBox = h('div', { class: 'wc-dlg-body' }, body);
            let primary = null;
            const buttons = actions.map((a) => {
                if (a.primary) primary = a;
                return h('button', { type: a.primary ? 'submit' : 'button', class: 'wc-btn' + (a.primary ? ' is-primary' : '') + (a.danger ? ' is-danger' : ''),
                    onclick: a.primary ? null : () => (a.onClick ? a.onClick(hd) : closeDialog()) }, [a.label]);
            });
            const form = h('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); if (primary && !hd.busy) primary.onClick(hd); } },
                [h('h3', { id: 'wc-dialog-title', text: title }), bodyBox, err, h('div', { class: 'wc-dlg-actions' }, [reload].concat(buttons))]);
            const node = h('dialog', { class: 'wc-dialog', 'aria-labelledby': 'wc-dialog-title' }, [form]);
            const hd = { node, body: bodyBox, busy: false, refresh: null, opener, openerKey,
                setBusy(b) {
                    if (hd.busy === b) return;
                    hd.busy = b; node.setAttribute('aria-busy', String(b));
                    Array.from(node.querySelectorAll('button, input, select, textarea')).forEach((c) => {
                        if (b) { c.setAttribute('data-was-disabled', c.disabled ? '1' : ''); c.disabled = true; }
                        else { c.disabled = c.getAttribute('data-was-disabled') === '1'; c.removeAttribute('data-was-disabled'); }
                    });
                },
                setError(msg, conflict) { err.textContent = msg || ''; err.hidden = !msg; reload.hidden = !conflict; } };
            node.addEventListener('cancel', (e) => { e.preventDefault(); if (!hd.busy) closeDialog(); });
            node.addEventListener('close', () => { if (dialog === hd) closeDialog(); });
            dialog = hd;
            rootEl.appendChild(node);
            if (typeof node.showModal === 'function') node.showModal(); else node.setAttribute('open', '');
            return hd;
        }
        function closeDialog() {
            const hd = dialog;
            if (!hd) return;
            dialog = null;
            if (hd.node.open && typeof hd.node.close === 'function') hd.node.close();
            if (hd.node.parentNode) hd.node.parentNode.removeChild(hd.node);
            const scope = todoBox && (todoBox.contains(hd.opener) || (hd.openerKey && hd.openerKey.endsWith('-todo'))) ? todoBox : rootEl;
            const target = hd.opener && scope.contains(hd.opener) ? hd.opener : hd.openerKey && scope.querySelector('[data-key="' + hd.openerKey + '"]');
            if (target && typeof target.focus === 'function') target.focus();
        }
        function confirmDialog(title, message, label, onConfirm, danger, extra) {
            return openDialog(title, [h('p', { class: 'wc-msg', text: message })].concat(extra || []), [{ label, primary: true, danger, onClick: onConfirm }, { label: '取消' }]);
        }
        function openDayList(day) {
            const hd = openDialog(dayLabel(day), [], [{ label: '关闭' }]);
            hd.refresh = () => {
                const items = visibleItems().filter((it) => it.dueDate === day).sort(compareItems);
                hd.body.textContent = '';
                hd.body.appendChild(items.length ? h('div', { class: 'wc-rows' }, items.map((it) => itemRow(it, hd))) : h('p', { class: 'wc-muted', text: '当天没有任务' }));
            };
            hd.refresh();
        }
        function openDetails(it) {
            const st = itemStatus(it), rows = [], body = [];
            const pair = (k, v) => rows.push(h('dt', { text: k }), h('dd', { text: v }));
            pair('类型', it.kind === 'assigned' ? '管理员指派' : '个人任务');
            if (it.kind === 'personal') pair('清单', listName(it.listId));
            pair('截止', it.dueDate ? dayLabel(it.dueDate) + ' ' + (it.dueTime || '全天') : '未排期');
            rows.push(h('dt', { text: '优先级' }), h('dd', {}, [priorityBadge(it)]));
            pair('状态', STATUS_TEXT[st]);
            if (it.state === 'completed' && it.completedAt) pair('完成于', formatShanghai(it.completedAt));
            const flag = it.kind === 'assigned' ? NOTICE_TEXT[st === 'canceled' ? 'canceled' : it.notice] : null;
            if (flag) body.push(h('p', { class: 'wc-alert', text: flag }));
            body.push(h('dl', { class: 'wc-kv' }, rows));
            if (it.notes) body.push(h('p', { class: 'wc-notes', text: it.notes }));
            const actions = [];
            if (st !== 'canceled') actions.push({ label: it.state === 'completed' ? '撤销完成' : '标记完成', primary: true, onClick: (hd) => toggle(findItem(it) || it, it.state !== 'completed', hd) });
            if (it.kind === 'personal') actions.push({ label: '编辑', onClick: () => openTaskForm(findItem(it) || it) }, { label: '删除', danger: true, onClick: () => confirmDelete(findItem(it) || it) });
            actions.push({ label: '关闭' });
            const steps = h('section', { class: 'wc-detail-steps', 'aria-label': '子任务' });
            const hd = openDialog(it.title, body.concat(steps), actions);
            hd.details = true;
            if (subtasksOf(it).length) {
                hd.refresh = () => {
                    const cur = findItem(it) || it;
                    const focused = steps.contains(doc.activeElement) && doc.activeElement.getAttribute('data-key');
                    steps.replaceChildren(h('h4', { text: '子任务 · ' + subtaskProgress(cur) }), subtaskList(cur, hd));
                    const target = focused && Array.from(steps.querySelectorAll('input')).find((input) => input.getAttribute('data-key') === focused);
                    if (target) target.focus();
                };
                hd.refresh();
            }
        }
        function openAiTask() {
            if (S.locked || S.busy) return;
            const text = h('textarea', { rows: 4, maxlength: 1000, placeholder: '例如：明天做抖音新品上架，准备新品图片和价格', 'aria-label': '任务描述' });
            const status = h('p', { class: 'wc-muted', role: 'status' });
            const st = S;
            openDialog('AI 新建任务', [h('p', { class: 'wc-muted', text: '用一句话描述要做的事。AI 只整理草稿，保存后才会加入你的私人清单。' }),
                h('label', { class: 'wc-fld' }, [h('span', { text: '任务描述' }), text]), status], [
                { label: '生成草稿', primary: true, onClick: async (hd) => {
                    const input = text.value.trim();
                    if (!input) { hd.setError('请输入任务描述。'); text.focus(); return; }
                    hd.setError(''); hd.setBusy(true); status.textContent = '正在整理草稿…';
                    try {
                        const draft = await session.request('POST', '/task-draft', { text: input });
                        if (S !== st || dialog !== hd) return;
                        if (typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > TITLE_MAX ||
                            typeof draft.notes !== 'string' || draft.notes.length > NOTES_MAX ||
                            (draft.dueDate !== null && !isDay(draft.dueDate)) || typeof draft.assigneeQuery !== 'string') {
                            throw failure('error', 0, 'unavailable');
                        }
                        openTaskForm(null, draft);
                    } catch (e) {
                        if (S !== st || dialog !== hd || e === STALE) return;
                        if (e && e.kind === 'auth') { lockOut(); return; }
                        hd.setError(e && e.status === 429 ? 'AI 正忙，请稍后再试，或手动填写。' : '暂时无法生成草稿，请重试或手动填写。');
                    } finally {
                        if (S === st && dialog === hd) { status.textContent = ''; hd.setBusy(false); }
                    }
                } },
                { label: '手动填写', onClick: () => openTaskForm(null, { title: '', notes: text.value.trim(), dueDate: null, assigneeQuery: '' }) }, { label: '取消' }]);
        }
        function openTaskForm(it, draft = null) {
            const field = (label, control) => h('label', { class: 'wc-fld' }, [h('span', { text: label }), control]);
            const title = h('input', { type: 'text', maxlength: TITLE_MAX, required: true, autocomplete: 'off', value: it ? it.title : draft ? draft.title : '' });
            const notes = h('textarea', { maxlength: NOTES_MAX, rows: 3, value: it ? it.notes || '' : draft ? draft.notes : '' });
            const list = h('select', { value: it ? it.listId || '' : (S.mode === 'list' ? S.listId : '') }, [opt('', '无清单')].concat(S.lists.map((l) => opt(l.id, l.name))));
            const date = h('input', { type: 'date', value: it ? it.dueDate || '' : draft ? draft.dueDate || '' : (S.mode === 'unscheduled' ? '' : S.anchor) });
            const time = h('input', { type: 'time', value: it ? it.dueTime || '' : '' });
            const priority = h('select', { value: priorityOf(it || draft), 'aria-label': '优先级' }, Object.entries(PRIORITIES).map(([value, label]) => opt(value, label)));
            const steps = [], stepRows = h('div', { class: 'wc-step-rows' });
            const add = h('button', { type: 'button', class: 'wc-btn', onclick: () => addStep().focus() }, ['添加子任务']);
            function addStep(step = {}) {
                const input = h('input', { type: 'text', maxlength: SUBTASK_TITLE_MAX, value: step.title || '', 'aria-label': '子任务内容' });
                const entry = { id: step.id, input };
                const row = h('div', { class: 'wc-step-entry' }, [input,
                    h('button', { type: 'button', class: 'wc-btn', 'aria-label': '移除子任务', onclick: () => {
                        const at = steps.indexOf(entry);
                        steps.splice(at, 1); row.remove(); add.disabled = false;
                        (steps[at] ? steps[at].input : add).focus();
                    } }, ['移除'])]);
                steps.push(entry); stepRows.appendChild(row); add.disabled = steps.length >= MAX_SUBTASKS;
                return input;
            }
            subtasksOf(it || draft).slice(0, MAX_SUBTASKS).forEach(addStep);
            const sync = () => { time.disabled = !date.value; if (!date.value) time.value = ''; };
            date.addEventListener('input', sync); date.addEventListener('change', sync); sync();
            const mentioned = draft && draft.assigneeQuery.trim();
            const accept = mentioned ? h('input', { type: 'checkbox' }) : null;
            openDialog(it ? '编辑任务' : draft && draft.title ? '确认 AI 任务草稿' : '新建任务', [
                draft ? h('p', { class: 'wc-muted', text: draft.title ? '请核对日期、内容、优先级和子任务。确认保存后才会创建任务。' : '原任务描述已保留在备注中。' }) : null,
                mentioned ? h('p', { class: 'wc-muted', text: '描述中提到了「' + mentioned + '」。员工端只能为自己新建任务。' }) : null,
                accept ? h('label', {}, [accept, ' 保存为我自己的任务']) : null,
                field('标题', title), field('备注', notes), h('div', { class: 'wc-fld-row' }, [field('清单', list), field('优先级', priority)]),
                h('div', { class: 'wc-fld-row' }, [field('截止日期（可选）', date), field('时间（可选）', time)]),
                h('fieldset', { class: 'wc-step-editor' }, [h('legend', { text: '子任务' }), stepRows, add])], [
                { label: '保存', primary: true, onClick: (hd) => {
                    if (accept && !accept.checked) { hd.setError('请先确认保存为你自己的任务。'); accept.focus(); return; }
                    saveTask(it, hd, { title: title.value.trim(), notes: notes.value.trim(), listId: list.value || null,
                        priority: priority.value, subtasks: steps.map((step) => ({ id: step.id, title: step.input.value.trim() })),
                        dueDate: date.value || null, dueTime: date.value && time.value ? time.value : null });
                } },
                { label: '取消' }]);
        }
        function saveTask(it, hd, form) {
            const problem = validateTask(form);
            if (problem) return hd.setError(problem);
            const done = (next) => { upsert(next, 'personal'); closeDialog(); renderCal(); };
            if (!it) return mutate({ handle: hd, method: 'POST', path: '/tasks', body: createBody(form), ok: done });
            const body = taskPatch(it, form);
            if (!body) return closeDialog();
            mutate({ handle: hd, method: 'PATCH', path: '/tasks/' + enc(it.id), body, ok: done });
        }
        function confirmDelete(it) {
            confirmDialog('删除任务', '删除「' + it.title + '」后无法恢复。', '删除', (hd) => mutate({ handle: hd, method: 'DELETE', path: '/tasks/' + enc(it.id),
                body: { expectedVersion: it.version }, ok: () => { S.items = S.items.filter((x) => !(x.kind === 'personal' && x.id === it.id)); closeDialog(); renderCal(); } }), true);
        }
        function openLists() {
            const fresh = h('input', { type: 'text', maxlength: NAME_MAX, autocomplete: 'off' });
            const rows = S.lists.map((l) => {
                const input = h('input', { type: 'text', maxlength: NAME_MAX, autocomplete: 'off', value: l.name, 'aria-label': '清单名称：' + l.name });
                return h('li', { class: 'wc-list-row' }, [input,
                    h('button', { type: 'button', class: 'wc-btn', onclick: () => act('PATCH', l, { name: input.value.trim(), expectedVersion: l.version }) }, ['重命名']),
                    h('button', { type: 'button', class: 'wc-btn is-danger', onclick: () => act('DELETE', l, { expectedVersion: l.version }) }, ['删除'])]);
            });
            const hd = openDialog('管理清单', [rows.length ? h('ul', { class: 'wc-lists' }, rows) : h('p', { class: 'wc-muted', text: '还没有清单' }),
                h('label', { class: 'wc-fld' }, [h('span', { text: '新建清单' }), fresh])],
            [{ label: '新建', primary: true, onClick: () => act('POST', null, { name: fresh.value.trim() }) }, { label: '关闭' }]);
            function act(method, list, body) {
                if ('name' in body && !validName(body.name)) return hd.setError(CODE_TEXT.invalid_name);
                if (method === 'PATCH' && body.name === list.name) return;
                mutate({ handle: hd, method, path: '/lists' + (list ? '/' + enc(list.id) : ''), body, ok: (res) => {
                    if (method === 'DELETE') {
                        S.lists = S.lists.filter((x) => x.id !== list.id);
                        if (S.listId === list.id) { S.mode = 'all'; S.listId = null; }
                    } else if (validList(res)) S.lists = S.lists.filter((x) => x.id !== res.id).concat([res]).sort(byName);
                    else throw failure('error', 0, 'unavailable');
                    renderCal(); openLists();
                } });
            }
        }

        // -- 日报：读取、预填（不保存）、保存草稿、确认后提交；从不自动保存或提交 --
        function loadReport(day) {
            if (!reportBox || !isDay(day)) return;
            const st = S, mine = ++st.reportSeq;
            Object.assign(st, { reportDay: day, report: null, reportText: '', reportNotice: '', reportConflict: false });
            renderReport();
            session.request('GET', '/reports/' + day).then((r) => {
                if (S !== st || mine !== st.reportSeq) return;
                if (!r || r.date !== day || typeof r.status !== 'string' || (r.submitted && typeof r.submitted.text !== 'string')) throw failure('error', 0, 'unavailable');
                st.report = r; st.reportText = draftText(r);
                renderReport();
            }).catch((e) => {
                if (S !== st || mine !== st.reportSeq || e === STALE) return;
                if (e && e.kind === 'auth') return lockOut();
                Object.assign(st, { reportNotice: messageFor(e), reportTone: 'error', reportConflict: false });
                renderReport();
            });
        }
        function changeReportDay(day, input) {
            if (!isDay(day) || (S.today && day > S.today) || day === S.reportDay) { input.value = S.reportDay || ''; return; }
            if (!reportDirty(S.report, S.reportText)) return loadReport(day);
            input.value = S.reportDay;
            confirmDialog('放弃未保存的修改？', '当前日报有未保存的修改，切换日期会丢失这些修改。', '放弃并切换', () => { closeDialog(); loadReport(day); }, true);
        }
        function renderReport() {
            if (!reportBox) return;
            keepFocus(() => {
                reportBox.textContent = '';
                rp = {};
                const r = S.report, day = S.reportDay;
                rp.date = h('input', { type: 'date', value: day || '', max: S.today || null, 'aria-label': '日报日期', 'data-key': 'rp-date', disabled: !day || S.reportBusy,
                    onchange: (e) => changeReportDay(e.target.value, e.target) });
                reportBox.appendChild(h('div', { class: 'wc-section-head' }, [h('h3', { text: '日报' }), rp.date,
                    r ? h('span', { class: 'wc-status is-' + reportTone(r), text: reportStatusLabel(r) }) : null]));
                if (S.reportNotice) {
                    const action = S.reportConflict ? ['放弃修改并重新加载', () => loadReport(S.reportDay)] : (!r && day ? ['重试', () => loadReport(day)] : null);
                    reportBox.appendChild(alertBox(S.reportNotice, S.reportTone === 'error', action));
                }
                if (!r) { if (!S.reportNotice && day) reportBox.appendChild(h('p', { class: 'wc-muted', text: '正在加载…' })); return; }
                if (r.submitted) {
                    reportBox.appendChild(h('p', { class: 'wc-muted', text: '提交于 ' + formatShanghai(r.submitted.submittedAt) + (r.submitted.late ? '（迟交）' : '') }));
                    reportBox.appendChild(h('div', { class: 'wc-rp-final', text: r.submitted.text }));
                    return;
                }
                if (S.today && day > S.today) { reportBox.appendChild(h('p', { class: 'wc-muted', text: '不能填写未来日期的日报。' })); return; }
                reportBox.appendChild(h('p', { class: 'wc-privacy', text: '提交后，日报内容对管理员可见且不能修改。提交前请删除不想公开的内容。' }));
                rp.ta = h('textarea', { class: 'wc-rp-text', rows: 8, maxlength: REPORT_MAX, 'aria-label': '日报内容', 'data-key': 'rp-text', value: S.reportText,
                    oninput: (e) => { S.reportText = e.target.value; updateReportControls(); } });
                rp.state = h('span', { class: 'wc-muted', role: 'status' });
                rp.counter = h('span', { class: 'wc-muted wc-count' });
                rp.prefill = h('button', { type: 'button', class: 'wc-btn', 'data-key': 'rp-prefill', onclick: prefill }, ['从完成事项预填']);
                rp.save = h('button', { type: 'button', class: 'wc-btn', 'data-key': 'rp-save', onclick: saveReport }, ['保存草稿']);
                rp.submit = h('button', { type: 'button', class: 'wc-btn is-primary', 'data-key': 'rp-submit', onclick: confirmSubmit }, ['提交日报']);
                reportBox.appendChild(rp.ta);
                reportBox.appendChild(h('div', { class: 'wc-rp-bar' }, [rp.state, rp.counter, rp.prefill, rp.save, rp.submit]));
                updateReportControls();
            });
        }
        function updateReportControls() {
            if (reportBox) reportBox.setAttribute('aria-busy', String(S.reportBusy));
            if (rp.date) rp.date.disabled = S.reportBusy || !S.reportDay;
            if (!rp.ta || !S.report) return;
            const dirty = reportDirty(S.report, S.reportText);
            rp.state.textContent = dirty ? '有未保存的修改，保存后才能提交' : (S.report.draft ? '草稿已保存，仅自己可见' : '');
            rp.counter.textContent = charCount(S.reportText) + ' / ' + REPORT_MAX;
            rp.ta.readOnly = S.reportBusy;
            rp.prefill.disabled = S.reportBusy;
            rp.save.disabled = S.reportBusy || !dirty;
            rp.submit.disabled = S.reportBusy || !canSubmit(S.report, S.reportText, S.today);
        }
        function prefill() {
            const st = S, day = st.reportDay, mine = st.reportSeq;
            if (!st.report || st.report.submitted || st.reportBusy) return;
            const run = (hd) => mutate({ area: 'report', handle: hd, method: 'POST', path: '/reports/' + day + '/prefill', body: {}, ok: (res) => {
                if (hd) closeDialog();
                if (mine !== st.reportSeq) return;
                const text = res && typeof res.text === 'string' ? res.text : '';
                if (text.trim()) Object.assign(st, { reportText: text, reportNotice: '' });
                else Object.assign(st, { reportNotice: '当天没有已完成的事项。', reportTone: 'info', reportConflict: false });
                renderReport();
            } });
            if (st.reportText.trim()) confirmDialog('替换日报内容', '将用当天完成的事项替换编辑框中的内容，当前文字会被覆盖。', '替换', run, true);
            else run(null);
        }
        function saveReport() {
            const st = S, r = st.report, day = st.reportDay, mine = st.reportSeq, text = st.reportText;
            if (!r || r.submitted || !reportDirty(r, text)) return;
            if (charCount(text) > REPORT_MAX) { Object.assign(st, { reportNotice: '日报最多 10000 个字。', reportTone: 'error', reportConflict: false }); return renderReport(); }
            mutate({ area: 'report', method: 'PATCH', path: '/reports/' + day, body: { text, expectedVersion: r.draft ? r.draft.version : 0 }, ok: (res) => {
                if (mine !== st.reportSeq) return;
                const draft = res && res.draft && typeof res.draft.version === 'number' ? res.draft
                    : res && typeof res.version === 'number' ? { text: typeof res.text === 'string' ? res.text : text, version: res.version } : null;
                if (!draft) throw failure('error', 0, 'unavailable');
                if (typeof res.status === 'string' && res.date === day) Object.assign(r, res); else r.draft = draft;
                Object.assign(st, { reportText: draftText(r), reportNotice: '', reportConflict: false });
                renderReport();
            } });
        }
        function confirmSubmit() {
            const st = S, r = st.report, day = st.reportDay, mine = st.reportSeq;
            if (!canSubmit(r, st.reportText, st.today)) return;
            const extra = [h('div', { class: 'wc-preview', text: r.draft.text })];
            if (day < st.today) extra.push(h('p', { class: 'wc-privacy', text: '该日期已过，提交后将记为迟交。' }));
            confirmDialog('提交 ' + dayLabel(day) + ' 的日报', '提交后，以下内容对管理员可见且不能修改。请确认已删除不想公开的内容。', '确认提交', (hd) => mutate({
                area: 'report', handle: hd, method: 'POST', path: '/reports/' + day + '/submit', body: { expectedVersion: r.draft.version, confirm: true }, ok: (res) => {
                    closeDialog();
                    if (mine !== st.reportSeq) return;
                    const snap = res && res.submitted ? res.submitted : res;
                    if (!snap || typeof snap.text !== 'string') throw failure('error', 0, 'unavailable');
                    Object.assign(r, { submitted: snap, draft: null, status: snap.late ? 'late' : 'submitted' });
                    Object.assign(st, { reportText: '', reportNotice: '', reportConflict: false });
                    renderReport();
                } }), false, extra);
        }

        return { setSession, destroy };
    }

    const api = { create, createSession, STALE, CONTEXT_HEADER, isDay, addDays, diffDays, weekStart, addMonths, viewRange, shiftAnchor, rangeQuery,
        shanghaiToday, formatShanghai, itemStatus, matchesFilter, groupByDay, reportStatusLabel, reportDirty, canSubmit, taskPatch, createBody, validateTask };
    root.QYOS_WORK_CALENDAR = api;
    if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
