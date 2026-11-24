// QYOS-WORK-01 团队日程 (Jadmin). Loads before shell-ui.js. Team data lives only in this closure's memory.
// Talks to /jadmin/team-work only; it never reads employee private tasks, lists, drafts or their counts.
(function (root) {
  'use strict';
  const BASE = '/jadmin/team-work', DAY_MS = 86400000, MAX_PER_CELL = 2;
  const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
  const TASK_STATUS = { open: '进行中', overdue: '已逾期', completed: '已完成', canceled: '已取消', unknown: '状态未知' };
  const PRIORITIES = [['high', '高'], ['normal', '普通'], ['low', '低']];
  const MAX_SUBTASKS = 8, MAX_SUBTASK_TITLE = 80;
  const REPORT_STATUS = { submitted: '已提交', missing: '未提交', pending: '待提交', not_required: '无需提交', unknown: '状态未知' };
  const TASK_FILTERS = [['', '全部任务状态'], ['open', '进行中'], ['overdue', '已逾期'], ['completed', '已完成'], ['canceled', '已取消']];
  const REPORT_FILTERS = [['', '全部日报状态'], ['submitted', '已提交'], ['late', '迟交'], ['missing', '未提交'], ['pending', '待提交'], ['not_required', '无需提交'], ['unknown', '状态未知']];
  const ACTIONS = { create: '创建并发布', edit: '修改内容', reschedule: '调整截止时间', reassign: '改派负责人', cancel: '取消任务', reopen: '重新打开', complete: '员工标记完成', undo: '员工撤销完成', subtask: '员工更新子任务进度' };
  const FIELDS = { title: '标题', notes: '备注', dueAt: '截止', state: '状态', completedAt: '完成时间', assigneeName: '负责人', priority: '优先级', subtasks: '子任务' };
  const ERRORS = {
    network: '网络连接中断，结果未知。请重新读取核对后再操作。', invalid_response: '服务器返回的数据无法识别。',
    version_conflict: '该任务已被其他人修改（版本冲突）。请重新读取后再操作。', invalid_transition: '任务状态已变化，当前操作不再适用。请重新读取。',
    assignee_inactive: '该员工已停用，不能指派任务。', employee_not_found: '该员工不在当前名录中。', not_found: '记录不存在或已不可见。',
    invalid_title: '标题不能为空，且不超过 100 字。', invalid_notes: '备注不超过 1000 字。', invalid_date: '日期无效。',
    invalid_priority: '请选择有效的优先级。', invalid_subtasks: '请检查子任务的标题和数量。',
    invalid_time: '时间无效，请使用“时:分”。', invalid_range: '日期范围无效（最多 62 天）。', invalid_request: '请求内容无效。',
    directory_unavailable: '员工名录暂时无法读取，请稍后重试。', directory_ambiguous: '员工名录数据冲突，请联系系统管理员。',
    authorization_unavailable: '暂时无法确认管理权限，请稍后重试。', admin_required: '需要管理员权限。',
  };
  const own = (object, key) => (Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);

  // ---- pure helpers (exported for tests) -------------------------------------------------------
  function parseDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const ms = Date.UTC(+value.slice(0, 4), +value.slice(5, 7) - 1, +value.slice(8, 10));
    return new Date(ms).toISOString().slice(0, 10) === value ? ms : NaN;
  }
  const isDay = value => !Number.isNaN(parseDay(value));
  const fromMs = ms => new Date(ms).toISOString().slice(0, 10);
  const addDays = (day, n) => fromMs(parseDay(day) + n * DAY_MS);
  const weekday = day => (new Date(parseDay(day)).getUTCDay() + 6) % 7; // 0 = Monday
  const weekStart = day => addDays(day, -weekday(day));
  const monthStart = day => day.slice(0, 8) + '01';
  function monthEnd(day) { const d = new Date(parseDay(day)); return fromMs(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)); }
  function rangeFor(view, anchor) {
    if (view === 'day') return { from: anchor, to: anchor };
    if (view === 'month') return { from: monthStart(anchor), to: monthEnd(anchor) };
    const from = weekStart(anchor); return { from, to: addDays(from, 6) };
  }
  function shift(view, anchor, dir) {
    if (view === 'day') return addDays(anchor, dir);
    if (view !== 'month') return addDays(anchor, 7 * dir);
    const d = new Date(parseDay(anchor)), y = d.getUTCFullYear(), m = d.getUTCMonth() + dir;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return fromMs(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
  }
  function daysIn(from, to) { const out = []; for (let d = from; d <= to && out.length < 62; d = addDays(d, 1)) out.push(d); return out; }
  const shanghaiToday = nowMs => fromMs(nowMs + 8 * 3600000);
  function shanghaiStamp(iso) {
    const ms = Date.parse(iso); if (typeof iso !== 'string' || Number.isNaN(ms)) return '—';
    const text = new Date(ms + 8 * 3600000).toISOString(); return text.slice(0, 10) + ' ' + text.slice(11, 16);
  }
  const dayLabel = day => day.slice(5).replace('-', '/') + ' 周' + WEEKDAYS[weekday(day)];
  function taskStatus(a) {
    if (!a) return 'unknown';
    if (a.state === 'open') return a.overdue === true ? 'overdue' : 'open';
    return a.state === 'completed' || a.state === 'canceled' ? a.state : 'unknown';
  }
  function reportInfo(day, known) {
    if (!day || typeof day !== 'object') return null;
    const submitted = day.status === 'submitted' || day.status === 'late';
    let key = submitted ? 'submitted' : own(REPORT_STATUS, day.status) ? day.status : 'unknown';
    if (!known && (key === 'missing' || key === 'pending')) key = 'unknown'; // no verified start date: never "missing"
    return { key, label: REPORT_STATUS[key], late: submitted && (day.status === 'late' || day.late === true), readable: submitted,
      hint: key === 'unknown' && !known ? '未配置起始日期，无法判断是否应提交' : '' };
  }
  const byName = (a, b) => String(a.displayName).localeCompare(String(b.displayName), 'zh-CN') || String(a.employeeId).localeCompare(String(b.employeeId));
  function groupRows(employees, assignments, filter) {
    const map = new Map(), assigned = new Set();
    for (const e of employees) if (e && typeof e.employeeId === 'string') map.set(e.employeeId, { employeeId: e.employeeId, displayName: String(e.displayName || e.employeeId), department: e.department ? String(e.department) : '', active: e.active === true, inRoster: true });
    for (const a of assignments) {
      const p = a && a.assignee; if (!p || typeof p.employeeId !== 'string') continue; assigned.add(p.employeeId);
      if (!map.has(p.employeeId)) map.set(p.employeeId, { employeeId: p.employeeId, displayName: String(p.displayName || p.employeeId), department: p.department ? String(p.department) : '', active: false, inRoster: false });
    }
    const groups = new Map();
    [...map.values()].filter(r => (r.active || assigned.has(r.employeeId)) && (!filter.employeeId || r.employeeId === filter.employeeId) && (!filter.department || r.department === filter.department))
      .sort(byName).forEach(r => { if (!groups.has(r.department)) groups.set(r.department, []); groups.get(r.department).push(r); });
    return [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'zh-CN')))
      .map(([department, rows]) => ({ department, label: department || '未分配部门', rows }));
  }
  const byTime = (x, y) => String(x.dueTime || '').localeCompare(String(y.dueTime || '')) || String(x.id).localeCompare(String(y.id));
  function indexAssignments(list) {
    const map = new Map();
    for (const a of list) { if (!a || !a.assignee || !isDay(a.dueDate)) continue; const key = a.assignee.employeeId + '|' + a.dueDate; if (!map.has(key)) map.set(key, []); map.get(key).push(a); }
    for (const items of map.values()) items.sort(byTime);
    return map;
  }
  function indexReports(list) {
    const out = new Map();
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || typeof e.employeeId !== 'string') continue;
      const days = new Map(); for (const d of Array.isArray(e.days) ? e.days : []) if (d && isDay(d.date)) days.set(d.date, d);
      out.set(e.employeeId, { known: e.startDateKnown === true, days });
    }
    return out;
  }
  function query(params) {
    const q = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
    const text = q.toString(); return text ? '?' + text : '';
  }
  function matchingAssignees(employees, query) {
    const key = value => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
    const needle = key(query);
    return needle ? employees.filter(e => e.active === true && (key(e.displayName) === needle || key(e.email) === needle)) : [];
  }
  const priorityOf = value => PRIORITIES.find(([key]) => key === value) || PRIORITIES[1];
  const subtasksOf = value => Array.isArray(value) ? value.filter(x => x && typeof x.title === 'string' && x.title.trim()).slice(0, MAX_SUBTASKS) : [];
  const editableSubtasks = value => subtasksOf(value).map(x => ({ ...(x.id ? { id: x.id } : {}), title: x.title }));
  function diffAssignment(a, v) {
    const body = { expectedVersion: a.version };
    if (v.title !== String(a.title || '').trim()) body.title = v.title;
    if (v.notes !== String(a.notes || '').trim()) body.notes = v.notes;
    if (v.dueDate !== a.dueDate || v.dueTime !== a.dueTime) { body.dueDate = v.dueDate; body.dueTime = v.dueTime; }
    if (a.assignee && v.employeeId !== a.assignee.employeeId) body.employeeId = v.employeeId;
    if (v.priority !== undefined && priorityOf(v.priority)[0] !== priorityOf(a.priority)[0]) body.priority = v.priority;
    if (v.subtasks !== undefined) {
      const next = editableSubtasks(v.subtasks);
      if (JSON.stringify(next) !== JSON.stringify(editableSubtasks(a.subtasks))) body.subtasks = next;
    }
    return Object.keys(body).length > 1 ? body : null;
  }
  function errorText(e) {
    const code = e && typeof e.code === 'string' ? own(ERRORS, e.code) : undefined;
    if (code) return code;
    if (e && e.status === 409) return ERRORS.version_conflict;
    if (e && e.status === 404) return ERRORS.not_found;
    return '操作未完成' + (e && e.status ? '（HTTP ' + e.status + '）' : '') + '。';
  }
  function fieldText(key, value) {
    if (value === null || value === undefined || value === '') return '—';
    if (key === 'dueAt' || key === 'completedAt') return shanghaiStamp(value);
    if (key === 'state') return own(TASK_STATUS, value) || '状态未知';
    if (key === 'priority') return priorityOf(value)[1];
    const text = key === 'subtasks' ? subtasksOf(value).map(x => x.title + (x.completed ? '（已完成）' : '')).join('、') || '—' : String(value);
    return text.length > 60 ? text.slice(0, 60) + '…' : text;
  }
  function describeHistory(entry, nameOf) {
    const actor = entry.actorKind === 'admin' ? '管理员 ' + String(entry.actor || '') : entry.actorKind === 'employee' ? (nameOf(entry.actor) || '员工') : '系统';
    const head = shanghaiStamp(entry.at) + ' · ' + actor + ' · ' + (own(ACTIONS, entry.action) || '其他变更'), changes = [];
    if (entry.action !== 'create') {
      const before = entry.old || {}, after = entry.new || {};
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) if (own(FIELDS, key)) changes.push(FIELDS[key] + '：' + fieldText(key, before[key]) + ' → ' + fieldText(key, after[key]));
    }
    return { head, changes };
  }
  const H = { parseDay, isDay, addDays, weekday, weekStart, monthEnd, rangeFor, shift, daysIn, shanghaiToday, shanghaiStamp, dayLabel, taskStatus, reportInfo, groupRows, indexAssignments, indexReports, query, matchingAssignees, diffAssignment, errorText, describeHistory };
  if (typeof module === 'object' && module && module.exports) module.exports = H;
  if (typeof document === 'undefined' || !root.JadminShell || !root.JadminState || !root.JadminDOM) return;

  // ---- UI ------------------------------------------------------------------------------------
  const Shell = root.JadminShell, State = root.JadminState, DOM = root.JadminDOM, el = DOM.el;
  const page = Shell.page('teamwork'), nav = document.querySelector('#sidebar a[data-route="teamwork"]');
  if (!page) return;
  const style = document.createElement('style');
  style.textContent = `
.tw,.tw *,.tw-dialog,.tw-dialog *{letter-spacing:0}
.tw{max-width:100%;min-width:0;font-size:14px}
.tw-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;background:#fff;border:1px solid var(--line);border-bottom:0}
.tw-bar:first-child{border-radius:8px 8px 0 0}
.tw button{min-height:34px;padding:5px 11px;font-size:13px;margin:0}
.tw select,.tw input{min-height:34px;padding:4px 8px;font-size:13px}
.tw-seg{display:inline-flex;border:1px solid #c9d6dd;border-radius:8px;overflow:hidden}
.tw .tw-seg button{border:0;border-radius:0;background:#fff;color:var(--ink)}
.tw .tw-seg button+button{border-left:1px solid #c9d6dd}
.tw .tw-seg button:hover{background:#edf4f5}
.tw .tw-seg button[aria-pressed=true]{background:var(--accent);color:#fff}
.tw .tw-icon{min-width:34px;padding:4px 8px;font-size:17px;line-height:1}
.tw-range{font-weight:600;white-space:nowrap}
.tw-grow{flex:1 1 auto}
.tw-filter{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.tw-msgs{background:#fff;border:1px solid var(--line);border-bottom:0;padding:0 12px}
.tw-msgs:empty{display:none}
.tw-msg{margin:8px 0;padding:6px 10px;border-radius:6px;font-size:13px}
.tw-msg-warn{background:#fff1d9;color:#7a4d08}
.tw-msg-info{background:#edf1f5;color:#40525f}
.tw-legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 12px;background:#fafcfd;border:1px solid var(--line);border-bottom:0;font-size:12px;color:var(--muted)}
.tw-body{background:#fff;border:1px solid var(--line);border-radius:0 0 8px 8px;padding:12px;min-height:160px;min-width:0}
.tw-body .empty-state{margin:0}
.tw-scroll{overflow-x:auto;max-width:100%}
.tw-week,.tw-month{table-layout:fixed;margin:0;font-size:13px}
.tw-week{min-width:980px}
.tw-week th,.tw-week td,.tw-month th,.tw-month td{padding:6px;border:1px solid #e6edf1;vertical-align:top}
.tw-week thead th:first-child{width:150px}
.tw-week .tw-dept th{background:#f3f6f8;color:var(--muted);font-size:12px;padding:5px 8px}
.tw .tw-today{background:#f1f8f7}
.tw .tw-dayhead{display:block;width:100%;min-height:0;padding:0;border:0;background:none;color:var(--ink);font-weight:600;font-size:12px;text-align:left}
.tw .tw-dayhead:hover{background:none;color:var(--accent);text-decoration:underline}
.tw-name{background:#fff;font-weight:400}
.tw-emp{display:block;font-weight:600;overflow-wrap:anywhere}
.tw-sub{display:block;font-size:11px;color:var(--muted)}
.tw .tw-item{display:block;width:100%;min-height:0;margin:2px 0;padding:3px 6px;border:0;border-left:3px solid var(--accent);border-radius:4px;background:#eef6f5;color:var(--ink);font-size:12px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tw .tw-item:hover{background:#dfeeec}
.tw .tw-item.s-overdue{border-left-color:var(--danger);background:#fbe8ea;color:#7c1f27}
.tw .tw-item.s-completed{border-left-color:#8fa3ae;background:#f3f6f8;color:var(--muted)}
.tw .tw-item.s-canceled,.tw .tw-item.s-unknown{border-left-color:#c3ced5;background:#fff;color:#8a99a4}
.tw .tw-item.s-canceled{text-decoration:line-through}
.tw .tw-more{min-height:0;padding:0 4px;border:0;background:none;color:var(--accent);font-size:12px;font-weight:600}
.tw .tw-more:hover{background:none;text-decoration:underline}
.tw-repwrap{display:inline-flex;flex-wrap:wrap;gap:4px;margin:0 4px 3px 0}
.tw-rep,.tw .tw-rep{display:inline-flex;align-items:center;min-height:0;margin:0;padding:1px 6px;border:1px solid transparent;border-radius:4px;font-size:11px;line-height:18px;white-space:nowrap}
.tw-rep.r-submitted{background:#e6f4ee;color:#17694b;border-color:#bfe0d2}
.tw button.tw-rep:hover{background:#d3ebe0}
.tw-rep.r-missing{background:#fbe8ea;color:#a82732}
.tw-rep.r-pending{background:#fff;color:#895709;border-color:#e8c37d}
.tw-rep.r-not_required{background:#f6f8f9;color:#8a99a4}
.tw-rep.r-unknown{background:#fff;color:#5c6e7c;border:1px dashed #b7c4cc}
.tw-late{display:inline-flex;padding:1px 5px;border-radius:4px;background:#fff1d9;color:#895709;font-size:11px;line-height:18px}
.tw-chip{display:inline-flex;padding:1px 7px;border-radius:4px;font-size:12px;background:#eef6f5;color:#0e5d56}
.tw-chip.s-overdue{background:#fbe8ea;color:#a82732}
.tw-chip.s-completed{background:#f3f6f8;color:#5c6e7c}
.tw-chip.s-canceled,.tw-chip.s-unknown{background:#fff;color:#8a99a4;border:1px solid #dce5eb}
.tw-priority{display:inline-block;margin-inline-end:4px;padding:0 5px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap}
.tw-priority.p-high{background:#fee2e2;color:#991b1b}
.tw-priority.p-normal{background:#dbeafe;color:#1e40af}
.tw-priority.p-low{background:#e5e7eb;color:#374151}
.tw-month td{height:92px}
.tw-month .tw-out{background:#fafbfc}
.tw-count{display:block;font-size:11px;line-height:16px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tw-count.c-bad{color:#a82732}.tw-count.c-warn{color:#895709}.tw-count.c-ok{color:#17694b}
.tw-group{margin:14px 0 4px;padding-bottom:4px;border-bottom:1px solid var(--line);font-size:13px;color:var(--muted)}
.tw-group:first-child{margin-top:0}
.tw-dayrow{display:grid;grid-template-columns:minmax(120px,180px) minmax(90px,160px) minmax(0,1fr) auto;gap:10px;align-items:start;padding:8px 0;border-bottom:1px solid #eef2f4}
.tw-daytasks{min-width:0}
.tw-agenda-day{padding:8px 0;border-bottom:1px solid #eef2f4}
.tw-agenda-day h3{margin:0 0 4px;font-size:14px}
.tw-agenda-reps{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px;font-size:12px}
.tw-none{margin:2px 0;font-size:12px}
.tw-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.tw-dialog dl{display:grid;grid-template-columns:84px minmax(0,1fr);gap:6px 12px;margin:0 0 12px;font-size:14px}
.tw-dialog dt{color:var(--muted)}
.tw-dialog dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
.tw-dialog h3{font-size:15px;margin:16px 0 6px}
.tw-dialog .tw-pair{display:flex;gap:12px;flex-wrap:wrap}
.tw-dialog .tw-pair .field{flex:1 1 160px}
.tw-subtasks{min-width:0;margin:8px 0;padding:8px 10px;border:1px solid var(--line);border-radius:6px}
.tw-subtasks legend{padding:0 4px;font-size:14px;font-weight:600}
.tw-subtask-row{display:flex;align-items:center;gap:6px;margin:6px 0}
.tw-subtask-row input{flex:1;min-width:0;width:100%;margin:0}
.tw-subtask-row button{flex:none;margin:0}
.tw-subtask-list{margin:4px 0;padding-inline-start:20px}
.tw-history{list-style:none;margin:0;padding:0;max-height:220px;overflow:auto;border-top:1px solid var(--line);font-size:13px}
.tw-history li{padding:6px 0;border-bottom:1px solid #eef2f4}
.tw-history small{display:block;color:var(--muted);overflow-wrap:anywhere}
.tw-report-text{white-space:pre-wrap;overflow-wrap:anywhere;max-height:50vh;overflow:auto;padding:12px;border:1px solid var(--line);border-radius:6px;background:#fafcfd}
@media(max-width:640px){.tw-bar{padding:8px}.tw-filter{flex:1 1 45%;min-width:0}.tw-filter select{flex:1;width:100%}.tw-range{order:9;flex-basis:100%}.tw-dayrow{grid-template-columns:minmax(0,1fr) auto}.tw-daytasks{grid-column:1/-1}.tw-month th,.tw-month td{padding:3px}.tw-month td{height:70px}.tw-count.c-muted{display:none}.tw-body{padding:10px}}
`;
  document.head.append(style);

  function btn(text, onclick, className = 'button-secondary', label = '') {
    const node = el('button', text, { type: 'button', className, onclick });
    if (label) node.setAttribute('aria-label', label);
    return node;
  }
  function field(label, control) { const node = el('label', null, { className: 'field' }); control.setAttribute('aria-label', label); node.append(label, control); return node; }
  function actionsRow(...buttons) { const node = el('div', null, { className: 'dialog-actions' }); node.append(...buttons); return node; }
  function details(pairs) {
    const dl = el('dl');
    for (const [k, v] of pairs) { if (v === null || v === undefined || v === '') continue; const dd = el('dd'); dd.append(v instanceof Node ? v : String(v)); dl.append(el('dt', k), dd); }
    return dl;
  }
  function fillSelect(select, options, value) {
    select.replaceChildren(...options.map(([v, t]) => el('option', t, { value: v })));
    select.value = options.some(([v]) => v === value) ? value : '';
    return select.value;
  }
  function filterSelect(label, options, key) {
    const wrap = el('label', null, { className: 'tw-filter' }), select = el('select');
    wrap.append(label, select); fillSelect(select, options, '');
    select.onchange = () => { S.filter[key] = select.value; load(); };
    return { wrap, select };
  }

  // Session-bound state: bound to one JadminState generation and the token captured at request time.
  const fresh = () => ({ enabled: null, today: '', anchor: '', anchorAuto: true, view: '', focus: '', data: null, filter: { employeeId: '', department: '', status: '', reportStatus: '' } });
  let S = fresh(), boundGen = -1, loadSeq = 0, discoverSeq = 0, dialogSeq = 0;
  const dialogs = new Set();
  const capture = () => (typeof token === 'string' && token ? { gen: State.generation(), tok: token } : null);
  const alive = ctx => !!ctx && ctx.gen === State.generation() && ctx.tok === token;
  const authLost = e => e.status === 401 || e.status === 403;
  function superseded() { const e = Error('读取已被新会话取代'); e.code = 'superseded_read'; return e; }
  function fail(status, code) { const e = Error(errorText({ status, code })); e.status = status; e.code = code || ''; return e; }

  async function call(ctx, method, path, body, timeoutMs = 0) {
    if (!alive(ctx)) throw superseded();
    const headers = { Accept: 'application/json', Authorization: 'Bearer ' + ctx.tok }, init = { method, headers, cache: 'no-store' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const controller = timeoutMs ? new AbortController() : null, timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : 0;
    if (controller) init.signal = controller.signal;
    let response, data = null;
    try { response = await fetch(BASE + path, init); try { data = await response.json(); } catch (_) { data = null; } }
    catch (_) { if (!alive(ctx)) throw superseded(); throw fail(0, 'network'); }
    finally { clearTimeout(timer); }
    if (!alive(ctx)) throw superseded();
    if (!response.ok) throw fail(response.status, data && typeof data === 'object' ? String(data.code || data.error || '') : '');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail(response.status, 'invalid_response');
    return data;
  }

  // ---- layout -------------------------------------------------------------------------------
  const rootNode = el('div', null, { className: 'tw' }), viewBtns = {};
  const seg = el('div', null, { className: 'tw-seg', role: 'group' }); seg.setAttribute('aria-label', '视图');
  for (const [key, text] of [['day', '日'], ['week', '周'], ['month', '月'], ['agenda', '列表']]) {
    const b = btn(text, () => { S.view = key; load(); }, ''); b.setAttribute('aria-pressed', 'false'); viewBtns[key] = b; seg.append(b);
  }
  const prev = btn('‹', () => move(-1), 'button-secondary tw-icon', '上一周'), next = btn('›', () => move(1), 'button-secondary tw-icon', '下一周');
  const todayBtn = btn('今天', () => { S.anchor = S.today || shanghaiToday(Date.now()); S.anchorAuto = !S.today; load(); });
  const dateInput = el('input', null, { type: 'date' }), monthInput = el('input', null, { type: 'month' });
  dateInput.setAttribute('aria-label', '选择日期'); monthInput.setAttribute('aria-label', '选择月份');
  dateInput.onchange = () => { if (isDay(dateInput.value)) { S.anchor = dateInput.value; S.anchorAuto = false; load(); } };
  monthInput.onchange = () => { if (isDay(monthInput.value + '-01')) { S.anchor = monthInput.value + '-01'; S.anchorAuto = false; load(); } };
  const rangeText = el('span', '', { className: 'tw-range' }); rangeText.setAttribute('aria-live', 'polite');
  const createBtn = btn('新建任务', () => openCreate(), '');
  const aiBtn = btn('AI 新建任务', openAiTask);
  const empSel = filterSelect('员工', [['', '全部员工']], 'employeeId'), deptSel = filterSelect('部门', [['', '全部部门']], 'department');
  const statusSel = filterSelect('任务', TASK_FILTERS, 'status'), reportSel = filterSelect('日报', REPORT_FILTERS, 'reportStatus');
  const bar1 = el('div', null, { className: 'tw-bar' }), bar2 = el('div', null, { className: 'tw-bar' }), legend = el('div', null, { className: 'tw-legend' });
  bar1.append(seg, prev, todayBtn, next, dateInput, monthInput, rangeText, el('span', null, { className: 'tw-grow' }), createBtn, aiBtn);
  bar2.append(empSel.wrap, deptSel.wrap, statusSel.wrap, reportSel.wrap);
  legend.append('任务：', ...['open', 'overdue', 'completed', 'canceled'].map(k => el('span', TASK_STATUS[k], { className: 'tw-chip s-' + k })), ' 日报：',
    ...['submitted', 'missing', 'pending', 'not_required', 'unknown'].map(k => el('span', REPORT_STATUS[k], { className: 'tw-rep r-' + k })), el('span', '迟交', { className: 'tw-late' }));
  const msgs = el('div', null, { className: 'tw-msgs' }), content = el('div', null, { className: 'tw-body' });
  const bars = [bar1, bar2, legend];
  rootNode.append(bar1, bar2, msgs, legend, content); Shell.mount('teamwork', rootNode);

  function resetSession() {
    loadSeq++; discoverSeq++;
    for (const handle of [...dialogs]) handle.close();
    S = fresh(); content.replaceChildren(); msgs.replaceChildren(); rangeText.textContent = '';
    fillSelect(empSel.select, [['', '全部员工']], ''); fillSelect(deptSel.select, [['', '全部部门']], ''); statusSel.select.value = ''; reportSel.select.value = '';
    bars.forEach(b => { b.hidden = false; }); createBtn.disabled = aiBtn.disabled = true;
    if (nav) nav.hidden = true;
  }
  function bind(gen) { if (boundGen !== gen) { resetSession(); boundGen = gen; } }
  function lockOut(kind) {
    const gen = State.generation(); resetSession(); boundGen = gen; S.enabled = false;
    bars.forEach(b => { b.hidden = true; });
    DOM.empty(content, kind === 'off' ? '团队日程功能未启用。' : '无法确认管理权限或登录已失效，团队日程内容已清空。请重新登录后再查看。');
    State.invalidate('teamwork');
  }
  // Logout and login both call JadminState.reset(); a new generation wipes everything and closes dialogs.
  State.subscribe(() => { if (boundGen !== -1 && State.generation() !== boundGen) { boundGen = -1; resetSession(); } });

  const rangeView = () => (S.view === 'agenda' ? 'week' : S.view);
  function move(dir) { S.anchor = shift(rangeView(), S.anchor || S.today || shanghaiToday(Date.now()), dir); S.anchorAuto = false; load(); }
  function goDay(day, employeeId = '') { S.view = 'day'; S.anchor = day; S.anchorAuto = false; S.focus = employeeId; load(); }
  function syncToolbar(range) {
    for (const [key, b] of Object.entries(viewBtns)) b.setAttribute('aria-pressed', String(key === S.view));
    const [back, fwd] = { day: ['前一天', '后一天'], month: ['上个月', '下个月'] }[S.view] || ['上一周', '下一周'];
    prev.setAttribute('aria-label', back); prev.title = back; next.setAttribute('aria-label', fwd); next.title = fwd;
    dateInput.value = S.anchor; monthInput.value = S.anchor.slice(0, 7);
    rangeText.textContent = range.from === range.to ? range.from + ' 周' + WEEKDAYS[weekday(range.from)] : range.from + ' 至 ' + range.to;
    createBtn.disabled = aiBtn.disabled = !S.data;
  }
  function refreshFilters(employees) {
    const active = employees.filter(e => e.active === true).sort(byName), before = S.filter.employeeId + '|' + S.filter.department;
    S.filter.employeeId = fillSelect(empSel.select, [['', '全部员工'], ...active.map(e => [e.employeeId, String(e.displayName || e.employeeId)])], S.filter.employeeId);
    const depts = [...new Set(employees.map(e => e.department).filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    S.filter.department = fillSelect(deptSel.select, [['', '全部部门'], ...depts.map(d => [d, d])], S.filter.department);
    return before !== S.filter.employeeId + '|' + S.filter.department;
  }

  // ---- discovery + loading ----------------------------------------------------------------
  async function discover() {
    const ctx = capture(); if (!ctx) return;
    bind(ctx.gen);
    const seq = ++discoverSeq, guess = shanghaiToday(Date.now());
    try {
      const data = await call(ctx, 'GET', '/bootstrap' + query({ from: guess, to: guess }), undefined, 8000);
      if (seq !== discoverSeq || !alive(ctx)) return;
      S.enabled = true; if (isDay(data.today)) S.today = data.today;
      if (nav) nav.hidden = false;
    } catch (error) {
      if (seq !== discoverSeq || !alive(ctx)) return;
      S.enabled = error.status === 404 ? false : null;
      if (nav) nav.hidden = true;
    }
  }
  (Shell.discoverHooks = Shell.discoverHooks || []).push(discover);

  async function load({ rethrow = false } = {}) {
    const ctx = capture(); if (!ctx) return;
    bind(ctx.gen);
    const seq = ++loadSeq;
    if (!S.view) S.view = root.matchMedia && root.matchMedia('(max-width: 640px)').matches ? 'agenda' : 'week';
    if (!S.anchor) { S.anchor = S.today || shanghaiToday(Date.now()); S.anchorAuto = !S.today; }
    const range = rangeFor(rangeView(), S.anchor), f = S.filter, span = { from: range.from, to: range.to };
    S.data = null; bars.forEach(b => { b.hidden = false; }); syncToolbar(range); msgs.replaceChildren(); DOM.empty(content, '正在读取团队日程…');
    try {
      const [boot, asg, rep] = await Promise.all([
        call(ctx, 'GET', '/bootstrap' + query(span)),
        call(ctx, 'GET', '/assignments' + query({ ...span, employeeId: f.employeeId, department: f.department, status: f.status })),
        call(ctx, 'GET', '/reports' + query({ ...span, employeeId: f.employeeId, department: f.department, reportStatus: f.reportStatus })),
      ]);
      if (seq !== loadSeq || !alive(ctx)) return;
      if (!Array.isArray(boot.employees) || !Array.isArray(asg.assignments) || !Array.isArray(rep.employees)) throw fail(200, 'invalid_response');
      if (isDay(boot.today)) S.today = boot.today;
      if (S.anchorAuto) { S.anchorAuto = false; if (S.today && S.today !== S.anchor) { S.anchor = S.today; return load({ rethrow }); } }
      S.enabled = true; if (nav) nav.hidden = false;
      const employees = boot.employees.filter(e => e && typeof e.employeeId === 'string');
      if (refreshFilters(employees)) return load({ rethrow });
      const assignments = asg.assignments.filter(a => a && typeof a.id === 'string' && a.assignee);
      S.data = { range, days: daysIn(range.from, range.to), employees, assignments, truncated: asg.truncated === true,
        reports: indexReports(rep.employees), mapping: rep.startDateMappingRequired === true || boot.startDateMappingRequired === true,
        byKey: indexAssignments(assignments), groups: groupRows(employees, assignments, S.filter) };
      render();
      await State.read('teamwork', () => true, { force: true }).catch(() => {}); // freshness marker only, no data
    } catch (error) {
      if (seq !== loadSeq || error.code === 'superseded_read' || !alive(ctx)) return;
      if (error.status === 404) { lockOut('off'); return; }
      if (authLost(error)) { lockOut('auth'); if (rethrow) throw error; return; }
      S.data = null; createBtn.disabled = aiBtn.disabled = true; msgs.replaceChildren(); State.invalidate('teamwork');
      DOM.error(content, error, () => load());
      if (rethrow) throw error;
    }
  }
  Shell.register('teamwork', () => load({ rethrow: true }));

  // ---- rendering ----------------------------------------------------------------------------
  function render() {
    const d = S.data; if (!d) return;
    syncToolbar(d.range);
    const notes = [];
    if (d.truncated) notes.push(['warn', '任务数量超出单次读取上限，仅显示部分任务。请缩小日期范围或增加筛选条件。']);
    if (d.mapping) notes.push(['info', '尚未配置员工起始日期：无法判断是否应提交的日期显示为“状态未知”，不计为未提交。']);
    if (S.filter.reportStatus) notes.push(['info', '日报状态筛选只影响日报标记；员工与任务仍按其他条件显示。']);
    msgs.replaceChildren(...notes.map(([kind, text]) => el('p', text, { className: 'tw-msg tw-msg-' + kind })));
    if (!d.groups.length) { DOM.empty(content, '没有符合筛选条件的员工。'); return; }
    content.replaceChildren({ day: renderDay, month: renderMonth, agenda: renderAgenda }[S.view] ? { day: renderDay, month: renderMonth, agenda: renderAgenda }[S.view](d) : renderWeek(d));
    if (S.focus) { const target = [...content.querySelectorAll('[data-employee]')].find(n => n.dataset.employee === S.focus); S.focus = ''; if (target) target.scrollIntoView({ block: 'center' }); }
  }
  const reportFor = (id, day) => { const e = S.data.reports.get(id); return e ? reportInfo(e.days.get(day), e.known) : null; };
  const dayButton = (day, text) => btn(text || dayLabel(day) + (day === S.today ? ' · 今天' : ''), () => goDay(day), 'tw-dayhead', '查看 ' + day + ' 日视图');
  function priorityBadge(value) {
    const [key, label] = priorityOf(value);
    return el('span', label, { className: 'tw-priority p-' + key, title: '优先级：' + label });
  }
  function itemButton(a, withName) {
    const st = taskStatus(a), who = a.assignee.displayName || '';
    const text = (a.dueTime ? a.dueTime + ' ' : '') + (withName && who ? who + '：' : '') + a.title;
    const priority = priorityOf(a.priority)[1];
    const node = btn('', () => openDetail(a), 'tw-item s-' + st, a.title + '，' + who + '，' + a.dueDate + ' ' + (a.dueTime || '') + '，' + TASK_STATUS[st] + '，优先级：' + priority);
    node.append(priorityBadge(a.priority), text);
    node.title = text + ' · ' + priority + '优先级'; return node;
  }
  function reportMarker(r, day, info, withName) {
    const wrap = el('span', null, { className: 'tw-repwrap' }), text = (withName ? r.displayName + ' ' : '') + info.label;
    const label = r.displayName + ' ' + day + ' 日报：' + info.label + (info.late ? '，迟交' : '');
    const node = info.readable ? btn(text, () => openReport(r, day), 'tw-rep r-' + info.key, label + '，点击只读查看') : el('span', text, { className: 'tw-rep r-' + info.key, title: info.hint || label });
    wrap.append(node); if (info.late) wrap.append(el('span', '迟交', { className: 'tw-late' }));
    return wrap;
  }
  function nameCell(tag, r) {
    const cell = el(tag, null, { className: 'tw-name' }); if (tag === 'th') cell.scope = 'row';
    cell.append(el('span', r.displayName, { className: 'tw-emp' }));
    const rep = S.data.reports.get(r.employeeId), sub = [];
    if (!r.inRoster) sub.push('不在当前名录'); else if (!r.active) sub.push('已停用');
    if (rep && !rep.known) sub.push('起始日期未配置');
    if (sub.length) cell.append(el('span', sub.join(' · '), { className: 'tw-sub' }));
    return cell;
  }
  function renderWeek(d) {
    const table = el('table', null, { className: 'tw-week' }), head = el('tr'), thead = el('thead'), tbody = el('tbody');
    table.append(el('caption', '周视图 ' + d.range.from + ' 至 ' + d.range.to, { className: 'tw-sr' }));
    head.append(el('th', '员工', { scope: 'col' }));
    for (const day of d.days) { const th = el('th', null, { scope: 'col', className: day === S.today ? 'tw-today' : '' }); th.append(dayButton(day)); head.append(th); }
    thead.append(head);
    for (const g of d.groups) {
      const tr = el('tr', null, { className: 'tw-dept' }); tr.append(el('th', g.label + '（' + g.rows.length + ' 人）', { colSpan: 8 })); tbody.append(tr);
      for (const r of g.rows) {
        const row = el('tr'); row.dataset.employee = r.employeeId; row.append(nameCell('th', r));
        for (const day of d.days) {
          const td = el('td', null, { className: day === S.today ? 'tw-today' : '' }), info = reportFor(r.employeeId, day), items = d.byKey.get(r.employeeId + '|' + day) || [];
          if (info) td.append(reportMarker(r, day, info, false));
          items.slice(0, MAX_PER_CELL).forEach(a => td.append(itemButton(a, false)));
          if (items.length > MAX_PER_CELL) td.append(btn('+' + (items.length - MAX_PER_CELL), () => goDay(day, r.employeeId), 'tw-more', '查看 ' + r.displayName + ' ' + day + ' 的全部 ' + items.length + ' 项任务'));
          row.append(td);
        }
        tbody.append(row);
      }
    }
    table.append(thead, tbody);
    const wrap = el('div', null, { className: 'tw-scroll', tabIndex: 0 }); wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', '周视图，可横向滚动');
    wrap.append(table); return wrap;
  }
  function renderDay(d) {
    const day = d.days[0], box = el('div');
    for (const g of d.groups) {
      box.append(el('h3', g.label + '（' + g.rows.length + ' 人）', { className: 'tw-group' }));
      for (const r of g.rows) {
        const row = el('div', null, { className: 'tw-dayrow' }), rep = el('div'), tasks = el('div', null, { className: 'tw-daytasks' }), act = el('div');
        row.dataset.employee = r.employeeId;
        const info = reportFor(r.employeeId, day);
        rep.append(info ? reportMarker(r, day, info, false) : el('span', '—', { className: 'muted', title: '无日报状态' }));
        const items = d.byKey.get(r.employeeId + '|' + day) || [];
        if (items.length) items.forEach(a => tasks.append(itemButton(a, false))); else tasks.append(el('span', '无任务', { className: 'muted tw-none' }));
        if (r.active && r.inRoster) act.append(btn('+ 任务', () => openCreate({ employeeId: r.employeeId, date: day }), 'button-secondary', '为 ' + r.displayName + ' 新建任务'));
        row.append(nameCell('div', r), rep, tasks, act); box.append(row);
      }
    }
    return box;
  }
  function renderMonth(d) {
    const visible = new Set(d.groups.flatMap(g => g.rows.map(r => r.employeeId))), stats = new Map();
    for (const day of d.days) stats.set(day, { open: 0, overdue: 0, completed: 0, canceled: 0, submitted: 0, late: 0, missing: 0, pending: 0, unknown: 0 });
    for (const a of d.assignments) { const s = stats.get(a.dueDate), k = taskStatus(a); if (s && visible.has(a.assignee.employeeId) && k in s) s[k]++; }
    for (const [id, e] of d.reports) {
      if (!visible.has(id)) continue;
      for (const [day, raw] of e.days) { const s = stats.get(day), info = reportInfo(raw, e.known); if (!s || !info) continue; if (info.key in s) s[info.key]++; if (info.late) s.late++; }
    }
    const lines = [['open', '进行中', ''], ['overdue', '逾期', 'c-bad'], ['completed', '完成', 'c-muted'], ['canceled', '取消', 'c-muted'],
      ['submitted', '已交', 'c-ok'], ['late', '迟交', 'c-warn'], ['missing', '未交', 'c-bad'], ['pending', '待交', 'c-warn'], ['unknown', '未知', 'c-muted']];
    const table = el('table', null, { className: 'tw-month' }), head = el('tr'), thead = el('thead'), tbody = el('tbody');
    table.append(el('caption', d.range.from.slice(0, 7) + ' 月视图', { className: 'tw-sr' }));
    WEEKDAYS.forEach(w => head.append(el('th', '周' + w, { scope: 'col' }))); thead.append(head);
    for (let week = weekStart(d.range.from); week <= d.range.to; week = addDays(week, 7)) {
      const tr = el('tr');
      for (let i = 0; i < 7; i++) {
        const day = addDays(week, i), s = stats.get(day), td = el('td');
        if (!s) { td.className = 'tw-out'; td.append(el('span', String(+day.slice(8)), { className: 'tw-count' })); tr.append(td); continue; }
        if (day === S.today) td.className = 'tw-today';
        td.append(btn(String(+day.slice(8)) + (day === S.today ? ' 今天' : ''), () => goDay(day), 'tw-dayhead', '查看 ' + day + ' 日视图'));
        for (const [key, text, cls] of lines) if (s[key]) td.append(el('span', text + ' ' + s[key], { className: 'tw-count ' + cls }));
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody); return table;
  }
  function renderAgenda(d) {
    const box = el('div'), rows = d.groups.flatMap(g => g.rows), visible = new Set(rows.map(r => r.employeeId));
    for (const day of d.days) {
      const sec = el('section', null, { className: 'tw-agenda-day' + (day === S.today ? ' tw-today' : '') }), head = el('h3');
      head.append(dayButton(day)); sec.append(head);
      const items = d.assignments.filter(a => a.dueDate === day && visible.has(a.assignee.employeeId)).sort(byTime);
      if (items.length) items.forEach(a => sec.append(itemButton(a, true))); else sec.append(el('p', '无任务', { className: 'muted tw-none' }));
      const reps = el('div', null, { className: 'tw-agenda-reps' }), counts = {};
      for (const r of rows) {
        const info = reportFor(r.employeeId, day); if (!info) continue;
        if (info.readable) reps.append(reportMarker(r, day, info, true)); else counts[info.key] = (counts[info.key] || 0) + 1;
      }
      const summary = ['missing', 'pending', 'unknown'].filter(k => counts[k]).map(k => REPORT_STATUS[k] + ' ' + counts[k]).join(' · ');
      if (summary) reps.append(el('span', summary, { className: 'muted' }));
      if (reps.childNodes.length) { reps.prepend(el('span', '日报：', { className: 'muted' })); sec.append(reps); }
      box.append(sec);
    }
    return box;
  }

  // ---- dialogs ------------------------------------------------------------------------------
  function openDialog(title, build, onClose) {
    const previous = document.activeElement, dialog = el('dialog', null, { className: 'admin-dialog tw-dialog' });
    const heading = el('h2', title, { id: 'tw-dialog-' + (++dialogSeq) });
    dialog.setAttribute('aria-labelledby', heading.id); dialog.append(heading);
    const handle = { dialog, closed: false, close() {
      if (handle.closed) return; handle.closed = true; dialogs.delete(handle);
      if (dialog.open) dialog.close(); dialog.remove();
      if (onClose) onClose();
      if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
    } };
    dialog.addEventListener('cancel', event => { event.preventDefault(); handle.close(); }); // Escape
    dialogs.add(handle); build(handle); document.body.append(dialog); dialog.showModal();
    const first = dialog.querySelector('input,select,textarea,button:not([disabled])'); if (first) first.focus();
    return handle;
  }
  function confirmBox(title, message, confirmText, danger) {
    return new Promise(resolve => {
      let answer = false;
      openDialog(title, h => {
        h.dialog.append(el('p', message), actionsRow(btn('返回', () => h.close()), btn(confirmText, () => { answer = true; h.close(); }, danger ? 'danger' : '')));
      }, () => resolve(answer));
    });
  }
  async function mutate(ctx, h, method, path, body, status, controls) {
    if (!alive(ctx)) { h.close(); return; }
    if (controls.some(c => c.disabled)) return;
    controls.forEach(c => { c.disabled = true; }); status.className = 'muted'; status.textContent = '正在保存…';
    try { await call(ctx, method, path, body); }
    catch (error) {
      if (error.code === 'superseded_read' || !alive(ctx)) { h.close(); return; }
      if (authLost(error)) { lockOut('auth'); return; }
      if (h.closed) return;
      status.className = 'bad'; status.textContent = errorText(error);
      // Conflicts, missing rows and unknown network outcomes require an explicit reload; never retried silently.
      if (error.status === 409 || error.status === 404 || !error.status) status.append(' ', btn('重新读取', () => { h.close(); load(); }));
      else controls.forEach(c => { c.disabled = false; });
      return;
    }
    State.invalidate('audit'); h.close(); load();
  }
  const activeEmployees = () => (S.data ? S.data.employees.filter(e => e.active === true).sort(byName) : []);
  const nameOf = id => { const e = S.data && S.data.employees.find(x => x.employeeId === id); return e ? String(e.displayName || '') : ''; };
  function subtaskEditor(values) {
    const container = el('fieldset', null, { className: 'tw-subtasks' }), rows = el('div');
    const add = btn('添加子任务', () => appendRow({}, true));
    function update() {
      add.disabled = rows.children.length >= MAX_SUBTASKS;
      Array.from(rows.children).forEach((row, i) => {
        row.firstElementChild.setAttribute('aria-label', '子任务 ' + (i + 1));
        row.lastElementChild.setAttribute('aria-label', '删除子任务 ' + (i + 1));
      });
    }
    function appendRow(value, focus = false) {
      if (rows.children.length >= MAX_SUBTASKS) return;
      const row = el('div', null, { className: 'tw-subtask-row' });
      const input = el('input', null, { type: 'text', maxLength: MAX_SUBTASK_TITLE, value: value.title || '', placeholder: '填写要完成的步骤', autocomplete: 'off' });
      if (value.id) row.dataset.id = value.id;
      row.append(input, btn('删除', () => {
        const next = row.nextElementSibling || row.previousElementSibling;
        row.remove(); update();
        (next ? next.firstElementChild : add).focus();
      }));
      rows.append(row); update(); if (focus) input.focus();
    }
    container.append(el('legend', '子任务（可选）'), rows, add);
    subtasksOf(values).forEach(x => appendRow(x));
    return { container, read: () => Array.from(rows.children, row => ({ ...(row.dataset.id ? { id: row.dataset.id } : {}), title: row.firstElementChild.value.trim() })).filter(x => x.title) };
  }
  function assignmentForm(h, values, current) {
    const node = el('form'), note = el('p', '', { className: 'muted' }), status = el('p', '', { role: 'status', className: 'muted' });
    const select = el('select', null, { required: true }), active = activeEmployees();
    select.append(el('option', '请选择员工', { value: '' }));
    for (const e of active) select.append(el('option', String(e.displayName || e.employeeId) + (e.department ? ' · ' + e.department : '') + (e.email ? ' · ' + e.email : ''), { value: e.employeeId }));
    if (current && !active.some(e => e.employeeId === current.employeeId)) select.append(el('option', (current.displayName || current.employeeId) + '（当前负责人，不可再指派）', { value: current.employeeId }));
    select.value = values.employeeId || '';
    const title = el('input', null, { type: 'text', required: true, maxLength: 100, value: values.title, autocomplete: 'off' });
    const notes = el('textarea', null, { maxLength: 1000, value: values.notes });
    const priority = el('select'); fillSelect(priority, PRIORITIES, priorityOf(values.priority)[0]);
    const subtasks = subtaskEditor(values.subtasks);
    const date = el('input', null, { type: 'date', required: true, value: values.dueDate }), time = el('input', null, { type: 'time', required: true, step: 60, value: values.dueTime });
    const submit = el('button', '保存', { type: 'submit' }), pair = el('div', null, { className: 'tw-pair' });
    pair.append(field('截止日期', date), field('截止时间', time));
    node.append(note, field('负责人', select), field('标题', title), field('备注（可选）', notes), pair, field('优先级', priority), subtasks.container, status, actionsRow(btn('取消', () => h.close()), submit));
    function read() {
      const out = { employeeId: select.value, title: title.value.trim(), notes: notes.value.trim(), dueDate: date.value, dueTime: time.value.slice(0, 5), priority: priority.value, subtasks: subtasks.read() };
      const problem = !out.employeeId ? [select, '请选择负责人'] : !out.title ? [title, '请填写标题'] : !isDay(out.dueDate) ? [date, '请选择有效日期']
        : !/^([01]\d|2[0-3]):[0-5]\d$/.test(out.dueTime) ? [time, '请选择截止时间'] : null;
      if (problem) { status.className = 'bad'; status.textContent = problem[1]; problem[0].focus(); return null; }
      return out;
    }
    return { node, note, status, submit, read };
  }
  function openAiTask() {
    const ctx = capture(); if (!ctx || !S.data) return;
    openDialog('AI 新建任务', h => {
      const form = el('form'), text = el('textarea', null, { rows: 4, maxLength: 1000, placeholder: '例如：明天安排贾季做抖音新品上架的工作' });
      const status = el('p', '', { role: 'status', className: 'muted' }), generate = el('button', '生成草稿', { type: 'submit' });
      const manual = btn('手动填写', () => { const notes = text.value.trim(); h.close(); openCreate({ notes }); });
      form.append(el('p', '用一句话描述负责人、日期和要做的事。AI 先整理草稿，核对后再发布。', { className: 'muted' }),
        field('任务描述', text), status, actionsRow(btn('取消', () => h.close()), manual, generate));
      form.onsubmit = async event => {
        event.preventDefault(); if (generate.disabled) return;
        const input = text.value.trim();
        if (!input) { status.className = 'bad'; status.textContent = '请输入任务描述。'; text.focus(); return; }
        status.className = 'muted'; status.textContent = '正在整理草稿…';
        text.disabled = manual.disabled = generate.disabled = true;
        try {
          const draft = await call(ctx, 'POST', '/task-draft', { text: input }, 20000);
          if (h.closed || !alive(ctx)) return;
          if (typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 100 ||
              typeof draft.notes !== 'string' || draft.notes.length > 1000 ||
              (draft.dueDate !== null && !isDay(draft.dueDate)) || typeof draft.assigneeQuery !== 'string') throw fail(200, 'invalid_response');
          h.close(); openCreate({ draft });
        } catch (error) {
          if (h.closed || !alive(ctx)) return;
          if (authLost(error)) { lockOut('auth'); return; }
          status.className = 'bad'; status.textContent = error.status === 429 ? 'AI 正忙，请稍后再试，或手动填写。' : '暂时无法生成草稿，请重试或手动填写。';
        } finally { if (!h.closed) { text.disabled = manual.disabled = generate.disabled = false; } }
      };
      h.dialog.append(form);
    });
  }
  function openCreate(preset = {}) {
    const ctx = capture(); if (!ctx || !S.data) return;
    const draft = preset.draft;
    const query = draft ? draft.assigneeQuery.trim() : '';
    const matches = matchingAssignees(activeEmployees(), query);
    const employeeId = draft ? (matches.length === 1 ? matches[0].employeeId : '') : preset.employeeId || S.filter.employeeId;
    openDialog(draft ? '确认 AI 任务草稿' : '新建任务', h => {
      const form = assignmentForm(h, { employeeId, title: draft ? draft.title : '', notes: draft ? draft.notes : preset.notes || '',
        priority: draft && draft.priority, subtasks: draft && draft.subtasks,
        dueDate: draft ? draft.dueDate || '' : preset.date || (S.view === 'day' ? S.anchor : S.today || S.anchor), dueTime: '18:00' }, null);
      const who = !query ? '未识别负责人，请手动选择。' : matches.length === 1 ? '已找到「' + query + '」，请核对负责人。' :
        matches.length > 1 ? '找到多位「' + query + '」，请按部门或邮箱选择正确的员工。' : '未找到「' + query + '」，请手动选择负责人。';
      form.note.textContent = draft ? who + (draft.dueDate ? '' : ' 未识别截止日期，请填写。') + ' 请核对内容和截止时间（默认 18:00）。优先级和子任务可在发布前调整。' :
        '每个任务指派给一名在职员工。保存后立即发布，员工可在自己的日程中看到。';
      form.submit.textContent = '保存并发布';
      form.node.onsubmit = event => { event.preventDefault(); const v = form.read(); if (v) mutate(ctx, h, 'POST', '/assignments', v, form.status, [form.submit]); };
      h.dialog.append(form.node);
    });
  }
  function openEdit(a, ctx) {
    if (!alive(ctx)) return;
    openDialog('编辑任务', h => {
      const form = assignmentForm(h, { employeeId: a.assignee.employeeId, title: a.title, notes: a.notes || '', dueDate: a.dueDate, dueTime: a.dueTime || '18:00', priority: a.priority, subtasks: a.subtasks }, a.assignee);
      form.note.textContent = '仅进行中的任务可修改、改期或改派。保存后员工会看到更新提示。';
      form.submit.textContent = '保存修改';
      form.node.onsubmit = async event => {
        event.preventDefault();
        const v = form.read(); if (!v) return;
        const body = diffAssignment(a, v);
        if (!body) { form.status.className = 'muted'; form.status.textContent = '没有需要保存的修改。'; return; }
        if (body.employeeId && !await confirmBox('确认改派', '将「' + a.title + '」从 ' + a.assignee.displayName + ' 改派给 ' + (nameOf(body.employeeId) || '所选员工') + '？原负责人将不再看到此任务，子任务的完成进度也会重置。', '确认改派', false)) return;
        if (!h.closed) mutate(ctx, h, 'PATCH', '/assignments/' + encodeURIComponent(a.id), body, form.status, [form.submit]);
      };
      h.dialog.append(form.node);
    });
  }
  function openDetail(a) {
    const ctx = capture(); if (!ctx) return;
    const st = taskStatus(a), person = a.assignee, path = '/assignments/' + encodeURIComponent(a.id);
    openDialog('任务详情', h => {
      const state = el('span'); state.append(el('span', TASK_STATUS[st], { className: 'tw-chip s-' + st }));
      if (a.completedLate === true) state.append(' ', el('span', '逾期完成', { className: 'tw-late' }));
      h.dialog.append(details([['任务', a.title], ['负责人', person.displayName + (person.department ? ' · ' + person.department : '')], ['截止', a.dueDate + ' ' + (a.dueTime || '')],
        ['状态', state], ['优先级', priorityBadge(a.priority)], ['备注', a.notes || '—'], ['发布人', a.createdBy], ['完成时间', a.completedAt ? shanghaiStamp(a.completedAt) : ''], ['取消时间', a.canceledAt ? shanghaiStamp(a.canceledAt) : '']]));
      const subtasks = subtasksOf(a.subtasks);
      if (subtasks.length) {
        const list = el('ul', null, { className: 'tw-subtask-list' });
        for (const subtask of subtasks) list.append(el('li', subtask.title + (subtask.completed ? ' · 已完成' : ' · 未完成')));
        h.dialog.append(el('h3', '子任务（' + subtasks.filter(x => x.completed).length + '/' + subtasks.length + ' 已完成）'), list);
      }
      const note = el('p', '', { role: 'status', className: 'muted' }), buttons = [];
      if (a.state === 'open') buttons.push(btn('编辑 / 改期 / 改派', () => { h.close(); openEdit(a, ctx); }, ''));
      if (a.state === 'completed') buttons.push(btn('重新打开', () => mutate(ctx, h, 'POST', path + '/reopen', { expectedVersion: a.version }, note, buttons), ''));
      if (a.state === 'open' || a.state === 'completed') buttons.push(btn('取消任务', async () => {
        if (!await confirmBox('取消任务', '确认取消「' + a.title + '」？员工会看到任务已取消。取消后不能恢复，只能重新新建。', '确认取消', true)) return;
        if (!h.closed) mutate(ctx, h, 'POST', path + '/cancel', { expectedVersion: a.version }, note, buttons);
      }, 'danger'));
      if (a.state === 'canceled') note.textContent = '任务已取消，仅可查看。';
      const list = el('ul', null, { className: 'tw-history' }); list.append(el('li', '正在读取变更记录…', { className: 'muted' }));
      h.dialog.append(note, actionsRow(...buttons, btn('关闭', () => h.close())), el('h3', '变更记录'), list);
      loadHistory(ctx, h, path, list);
    });
  }
  async function loadHistory(ctx, h, path, list) {
    try {
      const data = await call(ctx, 'GET', path + '/history');
      if (h.closed) return;
      if (!Array.isArray(data.history)) throw fail(200, 'invalid_response');
      list.replaceChildren(...data.history.map(entry => {
        const { head, changes } = describeHistory(entry, nameOf), li = el('li', head);
        changes.forEach(text => li.append(el('small', text))); return li;
      }));
      if (!data.history.length) list.append(el('li', '暂无记录', { className: 'muted' }));
    } catch (error) {
      if (error.code === 'superseded_read' || !alive(ctx)) { h.close(); return; }
      if (authLost(error)) { lockOut('auth'); return; }
      if (!h.closed) list.replaceChildren(el('li', '变更记录读取未完成：' + errorText(error), { className: 'bad' }));
    }
  }
  function openReport(r, day) {
    const ctx = capture(); if (!ctx) return;
    openDialog(r.displayName + ' · ' + day + ' 日报', h => {
      const status = el('p', '正在读取…', { role: 'status', className: 'muted' }), body = el('div');
      h.dialog.append(el('p', '只读查看已提交的日报，每次查看都会记入审计记录。', { className: 'muted' }), status, body, actionsRow(btn('关闭', () => h.close())));
      (async () => {
        try {
          const data = await call(ctx, 'GET', '/reports/' + encodeURIComponent(r.employeeId) + '/' + encodeURIComponent(day));
          if (h.closed) return;
          const s = data.submitted && typeof data.submitted === 'object' ? data.submitted : data;
          if (typeof s.text !== 'string') throw fail(200, 'invalid_response');
          const when = el('span', s.submittedAt ? shanghaiStamp(s.submittedAt) : '—');
          if (s.late === true) when.append(' ', el('span', '迟交', { className: 'tw-late' }));
          status.textContent = '';
          body.append(details([['员工', s.displayName || r.displayName], ['部门', s.department || r.department || '未分配部门'], ['日期', isDay(s.date) ? s.date : day], ['提交时间', when]]),
            el('div', s.text, { className: 'tw-report-text', tabIndex: 0 }));
        } catch (error) {
          if (error.code === 'superseded_read' || !alive(ctx)) { h.close(); return; }
          if (authLost(error)) { lockOut('auth'); return; }
          if (h.closed) return;
          status.className = 'bad'; status.textContent = error.status === 404 ? '该日报不存在或尚未提交。' : errorText(error);
        }
      })();
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
