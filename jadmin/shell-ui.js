// Runs last: feature scripts register loaders; this script owns the final load alias.
(function () {
  const { el } = JadminDOM;
  const pages = {
    mail: ['企业邮箱', '配置', ''],
    overview: ['概览', '工作台', '查看设置进度、服务摘要与最近操作。'], setup: ['开始设置', '首次设置', '根据实际状态逐步完成工作台配置。'],
    people: ['员工与部门', '日常管理', '管理部门目录，核对员工资料与部门分配。'], accounts: ['平台账号', '日常管理', '管理 Jchat、JAPI 账号，查看各平台用量。'],
    teamwork: ['团队日程', '日常管理', '安排员工任务，查看团队日程与日报提交状态。日报仅可只读查看。'],
    models: ['模型与接口', '配置', '管理统一接口和默认模型；业务调用需要另行验收。'], login: ['企业登录', '配置', '配置企业登录方式。后台邮箱密码登录始终可用。'],
    admins: ['管理员与权限', '权限与安全', '管理后台账号、企业账号关联与保险库权限。'], credentials: ['凭据摘要', '权限与安全', '核对已配置的账号与掩码密钥。'],
    audit: ['操作记录', '权限与安全', '查看系统记录的管理操作。'], status: ['服务与资源', '运行状态', '查看服务探测、资源与 JAPI 用量；业务状态需另行验收。'],
  };
  const keysByPage = { overview: ['modules', 'metrics', 'audit', 'departments', 'login'], setup: ['providers', 'model', 'login'], people: ['departments', 'directory'], accounts: ['users', 'accounts'], teamwork: ['teamwork'], admins: ['users', 'links', 'vault', 'sub2api'], models: ['providers', 'model'], login: ['login'], credentials: ['credentials'], audit: ['audit'], status: ['modules', 'health', 'metrics', 'sub2api'] };
  let booted = false, bootPromise = null, activeRoute = '', visit = 0, setupVisit = -1, setupPromise = null, displaySequence = 0, bootstrapGeneration = 0;
  keysByPage.mail = ['enterpriseMail'];
  function parseFragment(hash) { if (/^#(?:sso-token|sso-error|login-test-done)=/.test(hash || '')) return { special: true, route: null }; const route = /^#\/([a-z]+)(?:[?&].*)?$/.exec(hash || ''); return { special: false, route: route && pages[route[1]] ? route[1] : null }; }
  function landing({ explicit, owner, providers, login, ssoNotice = '', sso = false }) {
    if (explicit && pages[explicit]) return explicit;
    if (ssoNotice) return 'admins';
    if (!owner) return 'overview';
    if (!providers || !login) return 'overview';
    const op = login.operation || {};
    if (['interrupted', 'compensation_failed'].includes(op.status) || ['draining', 'cleanup_incomplete'].includes(op.phase)) return 'login';
    const provider = (providers.providers || [])[0];
    return provider && provider.keyConfigured === false ? 'setup' : 'overview';
  }
  JadminShell.parseFragment = parseFragment; JadminShell.landing = landing;
  const originalRun = JadminShell.run;
  JadminShell.run = async function (route, options = {}) { visit++; return originalRun.call(JadminShell, route, options); };
  JadminShell.loadSetupNotice = async function () {
    if (!JadminShell.isOwner()) { if (typeof setupCard !== 'undefined') setupCard.hidden = true; return; }
    if (typeof setupCard === 'undefined' || typeof refreshSetup !== 'function') return;
    setupCard.hidden = false;
    if (setupVisit === visit) return setupPromise;
    setupVisit = visit; setupPromise = refreshSetup(); return setupPromise;
  };
  if (typeof setupCard !== 'undefined') { setupCard.hidden = true; JadminShell.mount('status', setupCard); }
  JadminShell.register('status', () => JadminShell.loadSetupNotice());
  function closeDrawer() { $('app').classList.remove('drawer-open'); $('menu-toggle').setAttribute('aria-expanded', 'false'); }
  $('menu-toggle').onclick = () => { const open = $('app').classList.toggle('drawer-open'); $('menu-toggle').setAttribute('aria-expanded', String(open)); if (open) $('sidebar').querySelector('a').focus(); };
  $('drawer-scrim').onclick = closeDrawer;
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDrawer(); });
  for (const link of $('sidebar').querySelectorAll('a[data-route]')) link.addEventListener('click', closeDrawer);
  function labelTables(root) {
    for (const table of root.querySelectorAll('table')) { const names = [...table.querySelectorAll('thead th')].map(n => n.textContent); for (const row of table.querySelectorAll('tbody tr')) [...row.children].forEach((cell, index) => { if (names[index]) cell.setAttribute('data-label', names[index]); }); }
  }
  JadminShell.labelTables = labelTables;
  // Both account groups keep their existing loaders; tabs only control presentation.
  const accountPanels = [$('platformUsersCard'), $('jm-accounts')].filter(Boolean);
  if (accountPanels.length === 2) {
    const tabs = el('div', null, { className: 'tab-list', role: 'tablist', ariaLabel: '账号分类' });
    const buttons = accountPanels.map((panel, index) => { const button = el('button', index ? '全平台账号与用量' : 'Jchat 账号', { type: 'button', className: 'button-secondary', role: 'tab', id: 'account-tab-' + index }); button.setAttribute('aria-controls', panel.id); panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id); button.onclick = () => select(index); button.onkeydown = event => { if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index; select(next); buttons[next].focus(); } }; tabs.append(button); return button; });
    function select(index) { accountPanels.forEach((panel, i) => { panel.hidden = i !== index; buttons[i].setAttribute('aria-selected', String(i === index)); buttons[i].tabIndex = i === index ? 0 : -1; }); }
    $('page-accounts').prepend(tabs); select(0);
  }
  function freshness(route) {
    const values = (keysByPage[route] || []).map(k => JadminState.get(k)), loaded = values.filter(e => e.at);
    const at = loaded.length ? Math.min(...loaded.map(e => e.at)) : 0;
    const stale = values.some(e => e.stale || e.status === 'error' || (e.at && Date.now() - e.at > 300000));
    $('page-freshness').textContent = at ? '数据时间 ' + JadminDOM.time(at) + (stale ? ' · 可能已过期' : '') : '尚未读取此页数据';
  }
  async function show(route, { force = false } = {}) {
    const sequence = ++displaySequence, generation = bootstrapGeneration; activeRoute = route; closeDrawer();
    JadminShell.clearPageError();
    for (const name of Object.keys(pages)) $('page-' + name).hidden = name !== route;
    for (const link of $('sidebar').querySelectorAll('a[data-route]')) { if (link.dataset.route === route) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }
    $('page-title').textContent = pages[route][0]; $('page-group').textContent = pages[route][1]; $('page-description').textContent = pages[route][2];
    document.title = pages[route][0] + ' · Jadmin'; $('refresh').disabled = true; $('page-freshness').textContent = '正在读取…';
    try {
      if (route === 'overview' && force) await JadminState.read('login', () => api('/api/admin/login-config'), { force: true, timeout: 8000 });
      await JadminShell.run(route, { force });
    } catch (error) { if (error.code !== 'superseded_read' && sequence === displaySequence && generation === bootstrapGeneration) JadminShell.notice('部分数据读取未完成。可点击刷新重试；未取得的状态保持未知。', true, 'page-error'); }
    finally { if (sequence === displaySequence && generation === bootstrapGeneration) { $('refresh').disabled = false; freshness(route); labelTables($('page-' + route)); } }
  }
  async function bootstrap(generation, initialToken) {
    const current = () => generation === bootstrapGeneration && initialToken === token;
    $('bootstrap-status').hidden = false;
    try {
      try { await JadminState.read('links', () => api('/api/admin/sso/links'), { force: true }); }
      catch (error) { if (!current() || error.code === 'superseded_read') return; token = ''; JadminState.reset(); $('app').hidden = true; $('loginbox').hidden = false; $('bootstrap-status').hidden = true; $('msg').textContent = '无法确认管理权限，请重新登录。'; throw error; }
      if (!current()) return;
      await JadminState.read('providers', () => api('/api/admin/providers'), { force: true }).catch(() => {});
      if (!current()) return;
      await JadminState.read('login', () => api('/api/admin/login-config'), { force: true, timeout: 8000 }).catch(() => {});
      if (!current()) return;
      // Feature discovery hooks (team calendar) run once per authenticated bootstrap and own their nav visibility.
      for (const discover of JadminShell.discoverHooks || []) { try { await discover(); } catch (_) {} if (!current()) return; }
      booted = true; $('app').hidden = false; $('loginbox').hidden = true;
      if (!JadminSessionEmail && token) { try { const payload = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'); JadminSessionEmail = atob(payload + '='.repeat((4 - payload.length % 4) % 4)).split('|')[0]; } catch (_) {} }
      $('session-email').textContent = JadminSessionEmail; $('role-badge').textContent = JadminShell.isOwner() ? '所有者' : '管理员';
      for (const link of $('sidebar').querySelectorAll('[data-route="credentials"]')) link.hidden = !JadminShell.isOwner();
      const pending = window.JadminPendingSso, notice = pending && typeof pending === 'object' ? pending.notice || '' : '';
      const providers = JadminState.get('providers'), login = JadminState.get('login');
      const route = landing({ explicit: parseFragment(location.hash).route, owner: JadminShell.isOwner(), providers: providers.status === 'ok' ? providers.value : null, login: login.status === 'ok' ? login.value : null, ssoNotice: notice, sso: !!pending });
      window.JadminPendingSso = null;
      if (providers.status !== 'ok' || login.status !== 'ok') JadminShell.notice('部分设置状态未知，请到相关页面点击刷新重试。', true, 'bootstrap');
      if (notice) JadminShell.notice(notice, false, 'sso');
      history.replaceState(null, '', location.pathname + location.search + '#/' + route);
      await show(route);
    } finally { if (current()) $('bootstrap-status').hidden = true; }
  }
  JadminShell.currentRoute = () => activeRoute;
  JadminShell.load = async function () {
    if (window.JadminLoginTestPopup || !token) return;
    if (!booted) { if (!bootPromise) { const generation = ++bootstrapGeneration; let attempt; attempt = bootstrap(generation, token).finally(() => { if (bootPromise === attempt) bootPromise = null; }); bootPromise = attempt; } return bootPromise; }
    return show(activeRoute || 'overview', { force: true });
  };
  load = JadminShell.load;
  window.addEventListener('hashchange', () => { const route = parseFragment(location.hash).route; if (booted && route) show(route); });
  $('logout').onclick = () => { token = ''; JadminSessionEmail = ''; booted = false; bootPromise = null; bootstrapGeneration++; displaySequence++; JadminState.reset(); $('app').hidden = true; $('loginbox').hidden = false; $('bootstrap-status').hidden = true; $('password').value = ''; $('apiKey').value = ''; $('apiKey').type = 'password'; $('msg').textContent = ''; JadminShell.notice(''); history.replaceState(null, '', location.pathname + location.search); closeDrawer(); $('email').focus(); };
  if (window.JadminLoginTestPopup) return;
  if (window.JadminPendingSso && token) load().catch(() => {});

  // Overview loads only local/probe data. Login state is the bootstrap cache, unless explicitly refreshed.
  const attentionCard = el('section', null, { className: 'card' }), attention = el('div'), auditCard = el('section', null, { className: 'card' }), audit = el('div');
  attentionCard.append(el('h2', '需要处理'), attention); auditCard.append(el('h2', '最近操作'), audit, el('a', '查看全部操作记录', { href: '#/audit' })); JadminShell.mount('overview', attentionCard); JadminShell.mount('overview', auditCard);
  JadminShell.register('overview', async ({ force = false } = {}) => {
    const results = await Promise.allSettled([JadminState.read('audit', () => api('/api/audit'), { force }), JadminState.read('departments', () => api('/api/admin/departments'), { force })]);
    if (results.some(result => result.status === 'rejected' && result.reason.code === 'superseded_read')) return;
    const warnings = [], login = JadminState.get('login'), providers = JadminState.get('providers');
    if (login.status !== 'ok') warnings.push('企业登录状态未知，请刷新检查。');
    else { const value = login.value, operation = value.operation || {}; if (['interrupted', 'compensation_failed'].includes(operation.status)) warnings.push('企业登录操作未完成，请到企业登录页核对。'); if (['draining', 'cleanup_incomplete'].includes(operation.phase)) warnings.push('企业登录仍在等待切换完成或清理旧配置。'); if (value.signup && value.signup.paused) warnings.push('新员工首次注册已暂停。'); if (value.connection && !value.connection.ok) warnings.push('身份服务尚未连接。'); }
    if (providers.status !== 'ok') warnings.push('模型接口配置状态未知。'); else if ((providers.value.providers || [])[0]?.keyConfigured === false) warnings.push('模型接口尚未配置 Key。');
    attention.replaceChildren(...(warnings.length ? warnings.map(text => el('p', text)) : [el('p', '暂无待处理事项。', { className: 'muted' })]));
    if (results[0].status === 'fulfilled') JadminShell.renderAudit(audit, results[0].value.audit || [], 5); else JadminDOM.error(audit, results[0].reason, () => load());
    const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
  });
})();
