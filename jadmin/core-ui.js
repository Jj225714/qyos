// Shared state stays in this page's memory. Only onboarding display preferences may use storage.
var token = '', loadedBaseURL = '', $ = id => document.getElementById(id);
var JadminSessionEmail = '';
async function api(url, options = {}) {
  const requestGeneration = JadminState.generation();
  const request = { ...options, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(options.headers || {}) } };
  let response, data;
  try { response = await fetch(url, request); data = await response.json(); }
  catch (error) { if (requestGeneration !== JadminState.generation()) { const cancelled = Error('读取已被新会话取代'); cancelled.code = 'superseded_read'; throw cancelled; } throw error; }
  if (requestGeneration !== JadminState.generation()) { const error = Error('读取已被新会话取代'); error.code = 'superseded_read'; throw error; }
  if (!response.ok) {
    const error = Error(data.error || '请求未完成'); error.code = data.code; error.status = response.status; error.data = data; throw error;
  }
  if (request.method && request.method !== 'GET' && url !== '/api/login') {
    const affected = url.includes('/config-vault') ? ['vault', 'audit']
      : /\/sub2api\/users/.test(url) ? ['sub2api', 'accounts', 'vault', 'audit']
      : url.includes('/login-config') || url.endsWith('/login-im') ? ['login', 'audit']
      : url.includes('/sso/') ? ['links', 'audit'] : url.includes('/departments') || url.includes('/assignments') ? ['departments', 'directory', 'audit']
        : url.includes('/users') ? ['users', 'accounts', 'audit'] : url.includes('/config') ? ['providers', 'model', 'configDetails', 'audit'] : ['audit'];
    JadminState.invalidate(...affected);
  }
  return data;
}
var load = async function () {};
var JadminState = (function () {
  let entries = new Map(), pending = new Map(), versions = new Map(), epoch = 0;
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(); } catch (_) {} } };
  function get(key) { return entries.get(key) || { value: undefined, at: 0, error: null, status: 'unloaded' }; }
  async function read(key, loader, { force = false, timeout = 0 } = {}) {
    const current = get(key);
    if (pending.has(key)) return pending.get(key);
    if (!force && !current.stale && current.status === 'ok' && current.at > 0 && Date.now() - current.at <= 300000) return current.value;
    const generation = epoch, version = versions.get(key) || 0, entry = { ...current, status: 'loading', error: null, revision: version };
    const stillCurrent = () => epoch === generation && (versions.get(key) || 0) === version;
    const latestValue = () => {
      if (epoch !== generation) { const error = Error('读取已被新会话取代'); error.code = 'superseded_read'; throw error; }
      if (pending.has(key)) return pending.get(key);
      const latest = get(key);
      if (latest.revision === (versions.get(key) || 0)) { if (latest.status === 'ok' && !latest.stale) return latest.value; if (latest.status === 'error') throw latest.error; }
      return read(key, loader, { timeout });
    };
    entries.set(key, entry); emit();
    let timer;
    const task = (async () => {
      try {
        const operation = Promise.resolve().then(loader);
        const value = timeout ? await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => { const e = Error('读取超时，请重试'); e.code = 'client_timeout'; reject(e); }, timeout); })]) : await operation;
        if (!stillCurrent()) return await latestValue();
        entries.set(key, { value, at: Date.now(), error: null, status: 'ok', revision: version });
        return value;
      } catch (error) {
        if (!stillCurrent()) return await latestValue();
        entries.set(key, { ...entry, status: 'error', error });
        throw error;
      } finally { clearTimeout(timer); if (stillCurrent() && pending.get(key) === task) { pending.delete(key); emit(); } }
    })();
    pending.set(key, task); return task;
  }
  return { read, get, generation() { return epoch; }, invalidate(...keys) { for (const key of keys) { const e = get(key); versions.set(key, (versions.get(key) || 0) + 1); pending.delete(key); entries.set(key, { ...e, stale: true }); } emit(); }, reset() { epoch++; entries = new Map(); pending = new Map(); versions = new Map(); emit(); }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
})();
var JadminDOM = {
  el(tag, text, attrs = {}) { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = text; Object.assign(node, attrs); return node; },
  time(at) { return at ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '未读取'; },
  empty(node, message) { node.replaceChildren(JadminDOM.el('p', message, { className: 'empty-state' })); },
  error(node, error, retry) {
    const box = JadminDOM.el('div', null, { className: 'error-banner', role: 'alert' });
    box.append(JadminDOM.el('p', '读取未完成，请检查连接后重试。'));
    if (retry) box.append(JadminDOM.el('button', '重试', { type: 'button', onclick: retry }));
    const detail = JadminDOM.el('details'); detail.append(JadminDOM.el('summary', '技术详情'), JadminDOM.el('pre', error.message || String(error))); box.append(detail); node.replaceChildren(box);
  },
  table(table, names) { const row = document.createElement('tr'); names.forEach(n => row.append(JadminDOM.el('th', n))); const head = document.createElement('thead'), body = document.createElement('tbody'); head.append(row); table.replaceChildren(head, body); return body; },
};
var JadminShell = (function () {
  const loaders = new Map();
  let persistentNotice = { message: '', bad: false, scope: 'general' };
  function closeDialog(dialog, value, resolve, previous) { for (const input of dialog.querySelectorAll('input,textarea')) input.value = ''; dialog.close(); dialog.replaceChildren(); dialog.remove(); if (previous && previous.focus) previous.focus(); resolve(value); }
  function present({ title, message = '', reason = false, danger = false, confirmText = '确认', fields = null, password = null }) {
    return new Promise(resolve => {
      const previous = document.activeElement, dialog = JadminDOM.el('dialog', null, { className: 'admin-dialog' }), form = JadminDOM.el('form');
      const heading = JadminDOM.el('h2', title), description = JadminDOM.el('p', message), controls = [], status = JadminDOM.el('p', '', { role: 'status', className: 'muted' });
      heading.id = 'dialog-title'; dialog.setAttribute('aria-labelledby', heading.id); form.append(heading, description);
      if (reason) fields = [{ name: 'reason', label: '操作原因', type: 'textarea', required: true }];
      for (const field of fields || []) {
        const label = JadminDOM.el('label', field.label, { className: 'field' });
        const input = JadminDOM.el(field.type === 'textarea' ? 'textarea' : 'input', null, { type: field.type || 'text', name: field.name, required: !!field.required, value: field.value || '', autocomplete: field.type === 'password' ? 'new-password' : 'off' });
        label.append(input); form.append(label); controls.push([field, input]);
        if (field.type === 'password') { const toggle = JadminDOM.el('button', '显示', { type: 'button', className: 'button-secondary', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; toggle.textContent = input.type === 'password' ? '显示' : '隐藏'; } }); label.append(toggle); }
      }
      if (password !== null) {
        const secret = JadminDOM.el('input', null, { type: 'text', value: password, readOnly: true, autocomplete: 'off', ariaLabel: '本次临时密码' });
        const copy = JadminDOM.el('button', '复制', { type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(secret.value); status.textContent = '已复制'; } catch (_) { secret.select(); status.textContent = '请选中密码后手动复制'; }
        } }); form.append(secret, copy, JadminDOM.el('p', '关闭后无法再次查看。', { className: 'muted' }));
      }
      const footer = JadminDOM.el('div', null, { className: 'dialog-actions' });
      const cancel = JadminDOM.el('button', password === null ? '取消' : '关闭', { type: 'button', className: 'button-secondary', onclick: () => closeDialog(dialog, false, resolve, previous) }); footer.append(cancel);
      if (password === null) footer.append(JadminDOM.el('button', confirmText, { type: 'submit', className: danger ? 'danger' : '' }));
      form.append(status, footer); dialog.append(form); document.body.append(dialog);
      dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(dialog, false, resolve, previous); });
      form.onsubmit = event => {
        event.preventDefault(); const values = {};
        for (const [field, input] of controls) { const value = input.value; if (field.required && !value.trim()) { status.textContent = '请填写' + field.label; input.focus(); return; } values[field.name] = value; }
        closeDialog(dialog, reason ? values.reason.trim() : fields ? values : true, resolve, previous);
      };
      dialog.showModal(); const initial = controls[0] && controls[0][1]; if (initial) initial.focus(); else cancel.focus();
    });
  }
  return { loaders, register(route, loader) { const name = route.replace(/^#?\//, ''); if (!loaders.has(name)) loaders.set(name, []); loaders.get(name).push(loader); },
    page(route) { return $('page-' + route.replace(/^#?\//, '')); },
    mount(route, node) { const page = this.page(route); if (page) page.append(node); return node; },
    isOwner() { const e = JadminState.get('links'); return e.status === 'ok' && e.value.owner === true; },
    actor() { return JadminSessionEmail; },
    dialog(options) { return present(options); }, formDialog(options) { return present(options); }, showPassword(password) { return present({ title: '请保存本次临时密码', password: String(password || '') }); },
    notice(message, bad = false, scope = 'general') { if (scope !== 'page-error') persistentNotice = { message, bad, scope }; const target = $('global-notice'); if (target) { target.textContent = message || ''; target.className = bad ? 'error-banner' : 'notice'; target.hidden = !message; target.dataset.noticeScope = scope; } },
    clearPageError() { if ($('global-notice').dataset.noticeScope === 'page-error') this.notice(persistentNotice.message, persistentNotice.bad, persistentNotice.scope); },
    navigate(route) { location.hash = '#/' + route.replace(/^#?\//, ''); },
    async run(route, options = {}) { const result = await Promise.allSettled((loaders.get(route) || []).map(fn => fn(options))); const errors = result.filter(x => x.status === 'rejected'); if (errors.length) throw errors[0].reason; },
  };
})();
window.JadminState = JadminState; window.JadminShell = JadminShell; window.JadminDOM = JadminDOM;

// Role-separated account views use exactly the existing USER/ADMIN endpoints.
(function () {
  const { el, table } = JadminDOM;
  const userCard = el('section', null, { className: 'card', id: 'platformUsersCard' }), adminCard = el('section', null, { className: 'card', id: 'adminUsersCard' });
  const userTable = el('table'), adminTable = el('table'), ownerIdentity = el('p', '', { className: 'muted' });
  const userNotice = el('div'), adminNotice = el('div');
  const createUser = el('button', '新建 Jchat 账号', { type: 'button', onclick: () => create('USER') });
  const createAdmin = el('button', '添加管理员', { type: 'button', onclick: () => create('ADMIN') });
  userCard.append(el('h2', 'Jchat 账号'), el('p', '仅显示普通平台账号；管理员账号在「管理员与权限」中管理。', { className: 'muted' }), createUser, userNotice, userTable);
  adminCard.append(el('h2', 'Jadmin 管理员'), ownerIdentity, el('p', '注意：任何管理员都可创建、停用或重置其他管理员。界面隐藏仅为方便；权限由服务器检查。已有账号暂不支持更改角色或删除；不能在此转移所有权。', { className: 'muted' }), createAdmin, adminNotice, adminTable);
  JadminShell.mount('accounts', userCard); JadminShell.mount('admins', adminCard);
  async function create(role) {
    const values = await JadminShell.formDialog({ title: role === 'ADMIN' ? '添加 Jadmin 管理员' : '新建 Jchat 账号', message: role === 'ADMIN' ? '注意：任何管理员都可执行此操作。新账号同时写入 Jchat；已有账号暂不支持升为管理员。' : '初始密码留空时由服务器自动生成。', fields: [{ name: 'email', label: '邮箱', type: 'email', required: true }, { name: 'password', label: '初始密码（留空自动生成）', type: 'password' }], confirmText: '创建账号' });
    if (!values) return;
    try { const result = await api('/api/users', { method: 'POST', body: JSON.stringify({ email: values.email.trim(), password: values.password, role }) }); await JadminShell.showPassword(result.temporaryPassword); await refreshUsers(); }
    catch (error) { if (error.code === 'superseded_read') return; JadminShell.notice(error.message + '；创建失败后请刷新核对账号记录。', true); }
  }
  function renderUsers(data) {
    ownerIdentity.textContent = '所有者 · 由服务器配置决定' + (JadminShell.isOwner() ? '：' + JadminSessionEmail : '（邮箱未通过当前接口提供）');
    for (const [role, target] of [['USER', userTable], ['ADMIN', adminTable]]) {
      const body = table(target, ['邮箱', '角色', '状态', '操作']);
      const rows = (data.users || []).filter(x => String(x.role).toUpperCase() === role);
      rows.forEach(user => {
        const row = el('tr'), actions = el('td'); [user.email, role === 'ADMIN' ? '管理员' : '平台账号', user.enabled ? '启用' : '停用'].forEach(v => row.append(el('td', v)));
        const change = el('button', user.enabled ? '停用' : '启用', { type: 'button', className: 'button-secondary', onclick: async () => {
          const confirmed = await JadminShell.dialog({ title: (user.enabled ? '停用' : '启用') + '账号', message: user.email + (role === 'ADMIN' ? '。注意：任何管理员都可执行此操作。' : ''), danger: !!user.enabled });
          if (!confirmed) return;
          try { await api('/api/users/' + (user.enabled ? 'disable' : 'enable'), { method: 'POST', body: JSON.stringify({ id: user.id }) }); await refreshUsers(); } catch (error) { if (error.code === 'superseded_read') return; JadminShell.notice(error.message, true); }
        } });
        const reset = el('button', '重置密码', { type: 'button', className: 'button-secondary', onclick: async () => {
          if (!await JadminShell.dialog({ title: '重置密码', message: '重置 ' + user.email + ' 的密码？' + (role === 'ADMIN' ? '注意：任何管理员都可执行此操作。' : ''), danger: true })) return;
          try { const result = await api('/api/users/reset-password', { method: 'POST', body: JSON.stringify({ id: user.id }) }); await JadminShell.showPassword(result.temporaryPassword); await refreshUsers(); } catch (error) { if (error.code === 'superseded_read') return; JadminShell.notice(error.message, true); }
        } }); actions.append(change, reset); row.append(actions); body.append(row);
      });
      if (!rows.length) { const row = el('tr'); row.append(el('td', role === 'ADMIN' ? '还没有其他管理员，可使用上方按钮添加。' : '还没有 Jchat 普通账号。', { colSpan: 4 })); body.append(row); }
    }
  }
  async function refreshUsers({ force = false } = {}) {
    try { renderUsers(await JadminState.read('users', () => api('/api/users'), { force })); userNotice.replaceChildren(); adminNotice.replaceChildren(); }
    catch (error) { if (error.code === 'superseded_read') return; JadminDOM.error(userNotice, error, () => refreshUsers({ force: true })); JadminDOM.error(adminNotice, error, () => refreshUsers({ force: true })); throw error; }
  }
  JadminShell.register('accounts', refreshUsers); JadminShell.register('admins', refreshUsers);
})();

// Human-readable audit, with the complete backend detail available in disclosure.
(function () {
  const { el, table } = JadminDOM, card = el('section', null, { className: 'card' }), body = el('div');
  card.append(el('h2', '操作记录'), el('p', '仅显示系统已记录的操作；登录操作的详细原因请到企业登录页查看。', { className: 'muted' }), body); JadminShell.mount('audit', card);
  const labels = { create_user: '创建账号', disable_user: '停用账号', enable_user: '启用账号', reset_password: '重置密码', save_config: '保存模型配置', login_config: '登录配置操作', login_config_core: '登录配置操作', department_save: '保存部门', department_delete: '删除部门', department_assign: '分配部门', view_credentials: '查看凭据摘要', sso_login: '企业登录', sso_link: '关联企业账号', sso_unlink: '解除企业关联', vault_admin_grant: '授予保险库权限', vault_admin_revoke: '撤销保险库权限', sub2api_create_user: '创建 JAPI 账号' };
  function render(target, rows, limit) {
    if (!rows.length) return JadminDOM.empty(target, '暂无操作记录。');
    const list = el('table'), tbody = table(list, ['时间', '操作', '详情']);
    rows.slice(0, limit || rows.length).forEach(item => { const row = el('tr'), details = el('details'), cell = el('td'); details.append(el('summary', '查看详情'), el('pre', item.detail || '无附加详情')); row.append(el('td', new Date(item.at * 1000).toLocaleString('zh-CN')), el('td', labels[item.action] || '系统操作')); cell.append(details); row.append(cell); tbody.append(row); }); target.replaceChildren(list);
  }
  JadminShell.renderAudit = render;
  JadminShell.register('audit', async ({ force = false } = {}) => { try { const result = await JadminState.read('audit', () => api('/api/audit'), { force }); render(body, result.audit || []); } catch (error) { if (error.code === 'superseded_read') return; JadminDOM.error(body, error, () => load()); throw error; } });
})();

$('loginform').onsubmit = async event => {
  event.preventDefault(); $('loginbtn').disabled = true; $('msg').textContent = '';
  try { const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: $('email').value, password: $('password').value }) }); token = result.token; JadminSessionEmail = $('email').value; $('password').value = ''; JadminState.reset(); $('loginbox').hidden = true; $('app').hidden = false; await load(); }
  catch (error) { if (error.code === 'superseded_read') return; $('msg').textContent = error.status === 401 ? '邮箱或密码不正确' : '登录未完成，请重试。'; $('msg').className = 'bad'; if (!token) { $('loginbox').hidden = false; $('app').hidden = true; } }
  finally { $('loginbtn').disabled = false; }
};
$('refresh').onclick = () => load();
const loginPasswordToggle = JadminDOM.el('button', '显示密码', { type: 'button', className: 'button-secondary', onclick: () => { const input = $('password'); input.type = input.type === 'password' ? 'text' : 'password'; loginPasswordToggle.textContent = input.type === 'password' ? '显示密码' : '隐藏密码'; } });
$('password').after(loginPasswordToggle);
