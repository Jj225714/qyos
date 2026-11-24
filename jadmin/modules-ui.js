(() => {
  const state = JadminState, shell = JadminShell;
  const labels = {healthy: '正常', degraded: '探测异常', unconfigured: '未连接', reachable: '端口可达（业务未验证）'};
  const capabilities = {modules: '模块状态', audit: '操作记录', metrics: '资源采样', users: '账号',
    'endpoint-config': '接口配置', models: '模型列表', health: '服务探测'};
  function el(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = String(text);
    if (className) result.className = className;
    return result;
  }
  function button(text, action, danger = false) {
    const result = el('button', text, danger ? 'danger' : '');
    result.type = 'button'; result.onclick = action; return result;
  }
  function card(route, title, id) {
    const section = el('section', undefined, 'card'); section.id = id;
    section.append(el('h2', title)); shell.mount(route, section); return section;
  }
  function notice(target, text, bad = false) { target.textContent = text; target.className = bad ? 'bad' : 'muted'; }
  function dataTime(key) {
    const entry = state.get(key);
    if (!entry?.at) return '数据尚未读取';
    return '数据时间 ' + new Date(entry.at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) +
      (entry.stale || entry.status !== 'ok' || Date.now() - entry.at > 300000 ? ' · 可能已过期' : '');
  }
  function fail(target, message, error, retry) {
    target.replaceChildren(el('p', message, 'bad'));
    const details = el('details'); details.append(el('summary', '技术详情'), el('p', error.message, 'muted'));
    target.append(details, button('重试', retry));
  }
  function table(title, items, columns, empty = '暂无记录') {
    const wrap = el('div', undefined, 'table-wrap'); wrap.style.overflow = 'auto';
    if (title) wrap.append(el('h3', title));
    if (!items?.length) { wrap.append(el('p', empty, 'muted')); return wrap; }
    const grid = el('table'), head = el('thead'), row = el('tr'), body = el('tbody');
    columns.forEach(([, label]) => row.append(el('th', label))); head.append(row);
    items.forEach(item => {
      const tr = el('tr');
      columns.forEach(([key, label]) => {
        const value = typeof key === 'function' ? key(item) : item[key];
        const td = el('td', value === null || value === undefined || value === '' ? '未返回' :
          typeof value === 'object' ? JSON.stringify(value) : value);
        td.dataset.label = label; td.style.overflowWrap = 'anywhere'; tr.append(td);
      }); body.append(tr);
    });
    grid.append(head, body); wrap.append(grid); return wrap;
  }
  function pairs(title, values) { return table(title, Object.entries(values).map(([name, value]) => ({name, value})), [['name', '项目'], ['value', '值']]); }
  const superseded = error => error?.code === 'superseded_read';
  function actionError(error) { if (!superseded(error)) shell.notice('操作未完成：' + error.message, true); }
  function retry(loader) { return async () => { try { await loader({force: true}); } catch (error) { actionError(error); } }; }
  async function read(key, url, force, target) {
    notice(target, '正在读取…');
    try {
      const value = await state.read(key, () => api(url), {force}); notice(target, dataTime(key)); return value;
    } catch (error) { if (!superseded(error)) notice(target, '读取失败；' + dataTime(key), true); throw error; }
  }
  async function all(loaders) {
    const results = await Promise.allSettled(loaders.map(loader => loader()));
    const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
  }

  const overview = card('overview', '服务摘要', 'jm-overview'), overviewBody = el('div'), overviewNotice = el('p', '', 'muted');
  const statusLink = el('a', '查看服务与资源'); statusLink.href = '#/status';
  overview.append(overviewBody, overviewNotice, statusLink);
  function renderOverview() {
    overviewBody.replaceChildren();
    const modules = state.get('modules'), metrics = state.get('metrics');
    if (modules?.status === 'ok') {
      const items = Object.values(modules.value.modules || {});
      overviewBody.append(el('p', items.length ? items.map(item => item.name + ' ' + (labels[item.status] || '未知')).join(' · ') : '没有返回模块数据'));
    } else overviewBody.append(el('p', '服务状态未知，请刷新重试', 'bad'));
    if (metrics?.status === 'ok') {
      const current = metrics.value.current || {};
      overviewBody.append(el('p', ['cpu', 'memory', 'disk'].map((key, index) => ['CPU（负载估算）', '内存', '磁盘'][index] +
        ' ' + (Number.isFinite(current[key]) ? current[key] + '%' : '未知')).join(' · ')));
    } else overviewBody.append(el('p', '资源数据未知', 'muted'));
    notice(overviewNotice, dataTime('modules') + '；' + dataTime('metrics'));
  }
  async function loadOverview({force = false} = {}) {
    notice(overviewNotice, '正在读取…');
    try { await all([() => state.read('modules', () => api('/api/admin/modules'), {force}),
      () => state.read('metrics', () => api('/api/metrics'), {force})]); renderOverview(); }
    catch (error) { if (superseded(error)) return; renderOverview(); throw error; }
  }

  const moduleCard = card('status', '服务与能力', 'jm-modules'), moduleBody = el('div', undefined, 'module-grid'), moduleNotice = el('p', '', 'muted');
  moduleCard.append(moduleBody, moduleNotice);
  async function loadModules({force = false} = {}) {
    try {
      const result = await read('modules', '/api/admin/modules', force, moduleNotice);
      moduleBody.replaceChildren(...Object.values(result.modules || {}).map(item => {
        const section = el('div', undefined, 'module-item');
        section.append(el('h3', item.name), el('strong', labels[item.status] || '状态未知', item.status === 'healthy' ? 'ok' : item.status === 'degraded' ? 'bad' : 'muted'),
          el('p', item.endpoint, 'muted'), el('p', (item.capabilities || []).map(value => capabilities[value] || value).join('、'), 'muted'));
        return section;
      }));
      if (!moduleBody.children.length) moduleBody.append(el('p', '没有返回模块数据', 'muted'));
      moduleBody.append(el('p', '这些是本机服务或端口探测，不能代替对话、生图或知识库的业务验收。', 'muted'));
    } catch (error) { if (superseded(error)) return; fail(moduleBody, '暂时无法读取模块状态', error, retry(loadModules)); throw error; }
  }
  const resources = card('status', '资源与容器', 'jm-resources'), resourceBody = el('div'), resourceNotice = el('p', '', 'muted');
  resources.append(resourceBody, resourceNotice);
  async function loadMetrics({force = false} = {}) {
    try {
      const result = await read('metrics', '/api/metrics', force, resourceNotice), current = result.current || {};
      resourceBody.replaceChildren();
      [['cpu', 'CPU（负载估算）'], ['memory', '内存'], ['disk', '磁盘']].forEach(([key, label]) => {
        const line = el('p', label + '：' + (Number.isFinite(current[key]) ? current[key] + '%' : '未知'));
        if (Number.isFinite(current[key])) {
          const meter = el('meter'); meter.min = 0; meter.max = 100; meter.value = current[key];
          meter.setAttribute('aria-label', label + '使用率'); line.append(' ', meter);
        } resourceBody.append(line);
      });
      resourceBody.append(table('容器', current.containers || [], [['name', '名称'], ['status', '状态'], ['image', '镜像']],
        '未返回容器信息；可能没有读取权限，不能据此判断没有容器。'),
      el('p', '历史采样：' + (Array.isArray(result.history) ? result.history.length : '未知') + '；手动刷新，不自动轮询。', 'muted'));
    } catch (error) { if (superseded(error)) return; fail(resourceBody, '暂时无法读取资源数据', error, retry(loadMetrics)); throw error; }
  }
  const healthBody = el('div'); moduleCard.append(healthBody);
  async function loadHealth({force = false} = {}) {
    try {
      const health = await state.read('health', () => api('/api/health'), {force});
      const names = {librechat: 'Jchat', sub2api: 'JAPI', image: 'Jimage', configVault: '配置保险库', providerRelay: '模型转发服务', admin: 'Jadmin', nginx: '入口服务'};
      healthBody.replaceChildren(pairs('补充探测', Object.fromEntries(Object.entries(health).map(([name, value]) =>
        [names[name] || name, value === true ? '探测通过' : value === false ? '探测未通过' : '未知']))));
    } catch (error) { if (superseded(error)) return; fail(healthBody, '补充服务探测读取失败', error, retry(loadHealth)); throw error; }
  }

  const japiCard = card('status', 'JAPI 账户与用量', 'jm-japi'), japiBody = el('div'), japiNotice = el('p', '', 'muted');
  japiCard.append(el('p', '管理员可查看此处的 JAPI 掩码 Key；完整 Key 和用户密码不会显示。', 'muted'),
    button('刷新 JAPI', retry(loadSub2Api)), japiBody, japiNotice);
  function part(value, target, title) {
    if (value?.error) { target.append(el('p', title + '：' + value.error, 'bad')); return null; }
    if (!value?.data) { target.append(el('p', title + '未返回数据', 'muted')); return null; }
    return value.data;
  }
  async function loadSub2Api({force = false} = {}) {
    try {
      const result = await read('sub2api', '/api/admin/sub2api', force, japiNotice); japiBody.replaceChildren();
      const account = part(result.account, japiBody, '账户信息');
      if (account) japiBody.append(pairs('账户信息', {ID: account.id, 邮箱: account.email, 用户名: account.username, 角色: account.role, 状态: account.status,
        最近活跃: account.last_active_at, 创建时间: account.created_at}), pairs('余额与额度', {余额: account.balance, 冻结余额: account.frozen_balance,
        并发额度: account.concurrency, 允许分组: account.allowed_groups, 累计充值: account.total_recharged, 'RPM 限制': account.rpm_limit}),
      pairs('通知设置', {余额通知: account.balance_notify_enabled === true ? '已开启' : account.balance_notify_enabled === false ? '已关闭' : '未返回',
        通知阈值: account.balance_notify_threshold, 附加邮箱: account.balance_notify_extra_emails}));
      const keys = part(result.keys, japiBody, 'API Key');
      if (keys) japiBody.append(table('API Key 配置状态', keys.items || [], [['name', '名称'], ['keyMasked', 'Key'], ['status', '状态'], ['group_id', '分组'], ['last_used_at', '最近使用']]));
      const usage = part(result.usage, japiBody, '最近用量');
      if (usage) japiBody.append(pairs('最近用量', {记录总数: usage.total, 当前页: usage.page, 每页数量: usage.page_size, 页数: usage.pages}),
        table('最近调用记录', usage.items || [], [['model', '模型'], ['service_tier', '服务等级'], ['reasoning_effort', '推理等级'], ['created_at', '时间'], ['total_tokens', 'Token']]));
    } catch (error) { if (superseded(error)) return; fail(japiBody, '暂时无法读取 JAPI 数据', error, retry(loadSub2Api)); throw error; }
  }

  const accountsCard = card('accounts', '全平台账号与用量', 'jm-accounts'), accountsBody = el('div'), accountsNotice = el('p', '', 'muted');
  accountsCard.append(el('p', '各平台账号分别管理；JAPI 账号暂不支持在这里停用或编辑。', 'muted'),
    button('新建 JAPI 账号', createJapiUser), button('刷新账号数据', retry(loadAccounts)), accountsBody, accountsNotice);
  async function loadAccounts({force = false} = {}) {
    try {
      const result = await read('accounts', '/api/admin/accounts', force, accountsNotice), rows = result.accounts || [];
      accountsBody.replaceChildren(table('', rows, [['platform', '平台'], [row => (row.email || row.username || '未返回') + (row.id ? '（' + row.id + '）' : ''), '账号'],
        ['role', '角色'], ['status', '状态'], [row => row.lastLoginAt || '暂无记录', '最近登录 / 活跃'],
        [row => Object.entries(row.usage || {}).map(([key, value]) => key + '：' + (value ?? '未返回')).join('，') || '未返回', '用量']],
      '暂未返回平台账号；可使用上方入口新建账号。'));
      notice(accountsNotice, '共 ' + rows.length + ' 条平台账号记录；' + dataTime('accounts'));
    } catch (error) { if (superseded(error)) return; fail(accountsBody, '暂时无法读取平台账号', error, retry(loadAccounts)); throw error; }
  }
  async function createJapiUser() {
    const values = await shell.formDialog({title: '新建 JAPI 账号', message: '此操作单独创建 JAPI 账号；邮箱和初始密码必填。', confirmText: '创建账号', fields: [
      {name: 'email', label: '邮箱', type: 'email', required: true}, {name: 'username', label: '用户名'}, {name: 'password', label: '初始密码', type: 'password', required: true}]});
    if (!values) return;
    try {
      const email = values.email.trim(), password = values.password;
      if (!email || !password) throw Error('邮箱和初始密码必填');
      const result = await api('/api/admin/sub2api/users', {method: 'POST', body: JSON.stringify({email, username: (values.username || '').trim(), password})});
      if (result.error) throw Error(result.error);
      state.invalidate('accounts', 'sub2api', 'vault', 'credentials', 'audit');
      shell.notice('JAPI 账号创建成功'); values.password = '';
      try { await loadAccounts(); }
      catch (_) { shell.notice('JAPI 账号已创建，但列表刷新未完成；请刷新核对，不要重复创建。', true); }
    } catch (error) { actionError(error); } finally { values.password = ''; }
  }

  const vaultCard = card('admins', '配置保险库管理员', 'jm-vault'), vaultBody = el('div'), vaultNotice = el('p', '', 'muted'), pickerNotice = el('p', '', 'muted');
  const picker = el('select'), pickerLabel = el('label', '选择现有 JAPI 用户 '), grant = button('授权', () => vaultAction('grant', picker.value));
  picker.id = 'jm-vault-user'; pickerLabel.htmlFor = picker.id; picker.setAttribute('aria-label', '选择现有 JAPI 用户');
  picker.disabled = grant.disabled = true; pickerLabel.append(picker);
  vaultCard.append(el('p', '任何管理员均可授权或撤销保险库管理员；后台权限由服务器检查。', 'muted'),
    button('刷新保险库管理员', retry(loadAdmins)), pickerLabel, grant, pickerNotice, vaultBody, vaultNotice);
  async function loadVault({force = false} = {}) {
    try {
      const result = await read('vault', '/api/admin/config-vault', force, vaultNotice);
      if (result.error) throw Error(result.error);
      const list = result.administrators || [], wrap = table('', list, [['id', '用户 ID'], ['email', '邮箱'], ['username', '用户名'], ['role', '角色'],
        ['status', '账号状态'], ['last_active_at', '最近活跃'], ['permission', '保险库权限']], '尚未返回保险库管理员记录。');
      const grid = wrap.querySelector('table');
      if (grid) {
        grid.querySelector('thead tr').append(el('th', '操作'));
        [...grid.querySelectorAll('tbody tr')].forEach((row, index) => {
          const td = el('td'); td.dataset.label = '操作'; td.append(button('撤销', () => vaultAction('revoke', String(list[index].id)), true)); row.append(td);
        });
      }
      vaultBody.replaceChildren(wrap);
      vaultBody.append(el('p', '列表为空仅表示接口没有返回管理员记录，不证明底层身份服务已完成业务验收。', 'muted'));
    } catch (error) { if (superseded(error)) return; fail(vaultBody, '暂时无法读取保险库管理员', error, retry(loadVault)); throw error; }
  }
  async function loadPicker({force = false} = {}) {
    const placeholder = el('option', '请选择 JAPI 用户'); placeholder.value = '';
    picker.replaceChildren(placeholder); picker.disabled = grant.disabled = true;
    try {
      const result = await read('sub2api', '/api/admin/sub2api', force, pickerNotice);
      if (result.users?.error) throw Error(result.users.error);
      const items = result.users?.data?.items; if (!Array.isArray(items)) throw Error('JAPI 用户列表未返回');
      items.forEach(user => {
        if (!/^\d+$/.test(String(user.id))) return;
        const option = el('option', (user.email || user.username || '未返回姓名') + '（' + user.id + '）'); option.value = String(user.id); picker.append(option);
      });
      picker.disabled = grant.disabled = picker.children.length <= 1;
      if (picker.disabled) notice(pickerNotice, '未返回可选用户，请先在平台账号页创建 JAPI 账号。');
    } catch (error) { if (superseded(error)) return; notice(pickerNotice, '无法读取可选 JAPI 用户，请刷新重试。', true); throw error; }
  }
  async function loadAdmins(options = {}) { await all([() => loadVault(options), () => loadPicker(options)]); }
  async function vaultAction(action, id) {
    try {
      if (!/^\d+$/.test(id)) throw Error('请先选择 JAPI 用户');
      if (action === 'revoke' && !await shell.dialog({title: '撤销保险库管理员', message: '确认撤销用户 ' + id + ' 的配置保险库管理员权限？此操作不删除平台账号。', danger: true, confirmText: '撤销权限'})) return;
      const result = await api('/api/admin/config-vault/' + action, {method: 'POST', body: JSON.stringify({userId: id})});
      if (result.error) throw Error(result.error);
      state.invalidate('vault', 'accounts', 'audit');
      const actionName = action === 'grant' ? '授权' : '撤销';
      shell.notice(actionName + '操作已提交，请核对刷新后的管理员列表。');
      try { await loadVault(); }
      catch (_) { shell.notice(actionName + '操作已提交，但列表刷新未完成；请刷新核对。', true); }
    } catch (error) { actionError(error); }
  }

  const credentialCard = card('credentials', '凭据摘要', 'jm-credentials'), credentialBody = el('div'), credentialNotice = el('p', '', 'muted');
  let credentialsShown = false;
  const show = button('显示凭据摘要', () => showCredentials().catch(actionError));
  const hide = button('隐藏凭据', () => { credentialsShown = false; credentialBody.replaceChildren(); notice(credentialNotice, '凭据已隐藏'); });
  credentialCard.append(el('p', '仅所有者可查看本页摘要。密钥只显示掩码，管理员密码不经网页显示；用户密码使用哈希存储，无法还原。', 'muted'),
    el('p', '其他管理员仍可在服务与资源页查看 JAPI 掩码 Key。界面隐藏仅为方便；权限由服务器检查。', 'muted'), show, hide, credentialBody, credentialNotice);
  async function showCredentials({force = false} = {}) {
    if (!shell.isOwner()) {
      credentialsShown = false; credentialBody.replaceChildren(); show.disabled = hide.disabled = true;
      notice(credentialNotice, '仅所有者可查看凭据摘要。', true); return;
    }
    credentialsShown = true;
    try {
      const result = await read('credentials', '/api/admin/credentials', force, credentialNotice);
      if (!shell.isOwner() || !credentialsShown) return;
      const rows = [{platform: 'Jadmin', name: result.adminLogin?.email, type: '登录密码', value: result.adminLogin?.passwordConfigured ? '已设置（不显示）' : '未设置'},
        {platform: 'Jchat', name: '模型接口', type: 'API Key', value: result.librechatApiKey || '未配置'},
        ...(result.keys?.data?.items || []).map(key => ({platform: 'JAPI', name: key.name || key.id, type: 'API Key', value: key.keyMasked ? '已配置' : '未配置'})),
        {platform: 'Jchat / JAPI', name: '用户账号', type: '登录密码', value: '哈希存储，无法还原；需设置新密码'}];
      credentialBody.replaceChildren(table('', rows, [['platform', '平台'], ['name', '账号 / 名称'], ['type', '凭据类型'], ['value', '值（掩码）']]));
      if (result.keys?.error) credentialBody.append(el('p', result.keys.error, 'bad'));
      notice(credentialNotice, '只显示掩码；服务器记录读取审计。' + dataTime('credentials')); state.invalidate('audit');
    } catch (error) {
      if (superseded(error)) return;
      if (credentialsShown) fail(credentialBody, '暂时无法读取凭据摘要', error, retry(showCredentials)); throw error;
    }
  }
  async function loadCredentials({force = false} = {}) {
    show.disabled = hide.disabled = !shell.isOwner();
    if (!shell.isOwner()) { credentialsShown = false; credentialBody.replaceChildren(); notice(credentialNotice, '仅所有者可查看凭据摘要。'); return; }
    if (credentialsShown) await showCredentials({force}); else notice(credentialNotice, '点击显示以读取掩码摘要。');
  }
  if (state.subscribe) state.subscribe(() => {
    if (!shell.isOwner()) {
      credentialsShown = false; credentialBody.replaceChildren(); show.disabled = hide.disabled = true;
      notice(credentialNotice, '仅所有者可查看凭据摘要。');
    }
  });
  shell.register('overview', loadOverview);
  shell.register('status', options => all([() => loadModules(options), () => loadMetrics(options), () => loadHealth(options), () => loadSub2Api(options)]));
  shell.register('accounts', loadAccounts); shell.register('admins', loadAdmins); shell.register('credentials', loadCredentials);
})();
