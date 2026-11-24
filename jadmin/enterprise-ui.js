// 企业OS：企业账号登录、部门目录、员工资料检查。所有文字用 textContent 写入，不拼接 HTML。
(function () {
  const el = (tag, text, attrs) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = text; Object.assign(node, attrs || {}); return node; };
  const superseded = error => error?.code === 'superseded_read';

  // ---- 企业账号登录（Casdoor）
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.has('login-test-done')) {
    window.JadminLoginTestPopup = true;
    history.replaceState(null, '', location.pathname + location.search);
    $('loginbox').replaceChildren(el('h2', '测试已完成'), el('p', '请回到原窗口查看结果。'));
    if (window.opener) { try { window.opener.postMessage({ type: 'jadmin-login-test' }, location.origin); } catch (_) {} }
    return;
  }
  if (hash.get('sso-token') || hash.get('sso-error')) history.replaceState(null, '', location.pathname + location.search);
  // The public administrator screen has one email/password form. Existing SSO
  // callbacks and the authenticated provider configuration remain supported.
  if (hash.get('sso-error')) { $('msg').textContent = hash.get('sso-error'); $('msg').className = 'bad'; }

  // ---- 部门与员工
  const card = el('section', null, { className: 'card' });
  card.append(el('style', '.people-tabs{display:flex;gap:6px;border-bottom:1px solid #d9e0ea;margin:16px 0}.people-tabs button{border:0;border-radius:6px 6px 0 0;background:transparent;color:#667085;padding:10px 16px;margin:0}.people-tabs button[aria-selected=true]{color:#1d4ed8;background:#eff6ff;box-shadow:inset 0 -2px #2563eb}.directory-filters{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.directory-filters .filter-chip{font-size:13px;border-radius:999px;border:1px solid #d9e0ea;background:white;color:#344054;padding:5px 11px;margin:0}.directory-filters .filter-chip[aria-pressed=true]{border-color:#2563eb;background:#eff6ff;color:#1d4ed8}.directory-filters .filter-chip:disabled{opacity:.65;cursor:default}'));
  card.append(
    el('h2', '部门与员工'),
    el('p', '员工的部门按以下顺序确定：手动分配 → 第一个包含其 Casdoor 群组的部门 → 未分配。部门用于映射 JAPI 分组（额度与可用模型）。历史部门映射可能含 RAGFlow；实际团队知识库配置与可用性需另行核对。', { className: 'muted' }),
  );
  const peopleTabs = el('nav', null, { className: 'people-tabs' }); peopleTabs.setAttribute('role', 'tablist'); peopleTabs.setAttribute('aria-label', '员工与部门');
  const departmentPanel = el('div', null, { id: 'people-departments' }), directoryPanel = el('div', null, { id: 'people-directory', hidden: true });
  const departmentTab = el('button', '部门', { type: 'button', id: 'people-tab-departments' }), directoryTab = el('button', '员工资料检查', { type: 'button', id: 'people-tab-directory' });
  [[departmentTab, departmentPanel], [directoryTab, directoryPanel]].forEach(([tab, panel]) => {
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
  });
  departmentTab.setAttribute('aria-selected', 'true'); directoryTab.setAttribute('aria-selected', 'false'); directoryTab.tabIndex = -1;
  peopleTabs.append(departmentTab, directoryTab); card.append(peopleTabs, departmentPanel, directoryPanel);
  const deptTable = el('table'); departmentPanel.append(el('h3', '部门目录'), deptTable);
  const form = el('div');
  const fields = {
    code: el('input', null, { placeholder: '部门代码，如 sales' }),
    name: el('input', null, { placeholder: '部门名称' }),
    groups: el('input', null, { placeholder: 'Casdoor 群组，逗号分隔，如 jpmamoru/sales', size: 40 }),
    japiGroupId: el('input', null, { placeholder: 'JAPI 分组 ID', inputMode: 'numeric', size: 10 }),
    sort: el('input', null, { placeholder: '排序', inputMode: 'numeric', size: 6 }),
  };
  const save = el('button', '保存部门', { type: 'button' });
  const clear = el('button', '清空', { type: 'button' });
  form.append(...Object.values(fields), save, clear);
  const notice = el('p', '', { className: 'muted' });
  departmentPanel.append(form); card.append(notice);

  const dirButton = el('button', '检查员工资料（读取 Casdoor）', { type: 'button' });
  const dirSummary = el('p', '尚未检查员工资料；选择此页签或点击检查后读取员工目录。', { className: 'muted' });
  const dirTable = el('table');
  const directoryFilters = el('div', null, { className: 'directory-filters' }); directoryFilters.setAttribute('aria-label', '按资料问题筛选');
  directoryPanel.append(el('h3', '员工资料检查'), el('p', '核对员工的工作邮箱、联系方式、企业账号绑定与部门。', { className: 'muted' }), dirButton, dirSummary, directoryFilters, dirTable);
  const emailCapability = el('p', '', { className: 'muted', hidden: true });
  const emailForm = el('form', null, { className: 'employee-email-form', hidden: true });
  const emailPerson = el('p');
  const employeeEmail = el('input', null, { type: 'email', name: 'workEmail', id: 'employee-work-email', required: true, maxLength: 254, autocomplete: 'off' });
  const emailLabel = el('label', '工作邮箱', { className: 'field', htmlFor: 'employee-work-email' }); emailLabel.append(employeeEmail);
  const emailSave = el('button', '保存邮箱', { type: 'submit' }), emailCancel = el('button', '取消', { type: 'button', className: 'button-secondary' });
  const emailFeedback = el('p', '', { role: 'status', ariaLive: 'polite' });
  const emailTitle = el('h3', '补工作邮箱');
  emailForm.append(emailTitle, emailPerson, emailLabel, el('p', '保存后自动确认工作邮箱，用于该员工的钉钉登录。', { className: 'muted' }), emailSave, emailCancel);
  directoryPanel.insertBefore(emailCapability, dirTable); directoryPanel.insertBefore(emailForm, dirTable); directoryPanel.insertBefore(emailFeedback, dirTable);
  card.append(el('style', '.employee-email-form{border-top:1px solid #d9e0ea;border-bottom:1px solid #d9e0ea;padding:16px 0;margin:16px 0}.employee-email-form .field{max-width:480px}.employee-email-form input{box-sizing:border-box;width:100%;min-width:0}.employee-email-action{display:block;margin-top:6px}.employee-email-form p{overflow-wrap:anywhere}'));
  JadminShell.mount('people', card);

  let departments = [];
  const say = (text, bad) => { notice.textContent = text; notice.className = bad ? 'bad' : 'muted'; };
  const fill = d => { fields.code.value = d.code; fields.name.value = d.name; fields.groups.value = d.groups.join(', '); fields.japiGroupId.value = d.japiGroupId || ''; fields.sort.value = d.sort || 0; fields.code.readOnly = true; };
  clear.onclick = () => { Object.values(fields).forEach(f => { f.value = ''; }); fields.code.readOnly = false; };

  function header(table, names) { const tr = el('tr'); names.forEach(n => tr.append(el('th', n))); const thead = el('thead'); thead.append(tr); table.replaceChildren(thead, el('tbody')); return table.querySelector('tbody'); }

  function renderDepartments(data) {
    departments = data.departments || [];
    const counts = {}; (data.assignments || []).forEach(a => { counts[a.code] = (counts[a.code] || 0) + 1; });
    const body = header(deptTable, ['代码', '名称', 'Casdoor 群组', 'JAPI 分组', '手动分配人数', '操作']);
    departments.forEach(d => {
      const tr = el('tr');
      const edit = el('button', '编辑', { type: 'button', onclick: () => fill(d) });
      const del = el('button', '删除', { type: 'button', className: 'danger', onclick: async () => {
        if (!(await confirmed('删除部门', '删除部门「' + d.name + '」？', true))) return;
        try { renderDepartments(await api('/api/admin/departments/delete', { method: 'POST', body: JSON.stringify({ code: d.code }) })); JadminState.invalidate('departments', 'directory'); say('已删除'); } catch (e) { if (superseded(e)) return false; say(e.message, true); }
      } });
      const ops = el('td'); ops.append(edit, ' ', del);
      [d.code, d.name, d.groups.join('、') || '—', d.japiGroupId || '默认', counts[d.code] || 0].forEach(v => tr.append(el('td', String(v))));
      tr.append(ops); body.append(tr);
    });
    if (!departments.length) { const tr = el('tr'); tr.append(el('td', '还没有部门。先在 Casdoor 建群组，再在这里建部门并填入群组。', { colSpan: 6, className: 'muted' })); body.append(tr); }
    JadminShell.labelTables?.(card);
  }

  save.onclick = async () => {
    try {
      const data = await api('/api/admin/departments', { method: 'POST', body: JSON.stringify({ code: fields.code.value.trim(), name: fields.name.value.trim(), groups: fields.groups.value, japiGroupId: fields.japiGroupId.value.trim(), sort: fields.sort.value.trim() || 0 }) });
      JadminState.invalidate('departments', 'directory'); renderDepartments(data); clear.onclick(); say('已保存，os-bridge 一分钟内生效');
    } catch (e) { if (superseded(e)) return false; say(e.message, true); }
  };

  let directoryData = null, directoryFilter = 'all', directoryUnknown = '未检查';
  let emailTarget = null, emailExisting = null, emailBusy = false, emailNeedsRefresh = false, emailOperation = 0;
  function closeEmailForm() {
    emailOperation++; emailTarget = null; emailExisting = null; emailBusy = false;
    employeeEmail.value = ''; emailForm.hidden = true;
    employeeEmail.disabled = false; employeeEmail.readOnly = false; emailSave.disabled = false; emailCancel.disabled = false;
  }
  function startEmailForm(user) {
    if (emailBusy || emailNeedsRefresh || !directoryData?.emailCompletion?.available || !user.id ||
        !(user.email ? user.canConfirmWorkEmail === true : user.canCompleteEmail === true)) return;
    closeEmailForm(); emailTarget = user.id;
    emailExisting = user.email || null;
    employeeEmail.value = emailExisting || ''; employeeEmail.readOnly = !!emailExisting;
    emailTitle.textContent = emailExisting ? '确认工作邮箱' : '补工作邮箱';
    emailSave.textContent = emailExisting ? '确认工作邮箱' : '保存邮箱';
    emailPerson.textContent = user.displayName || user.name || '';
    emailFeedback.textContent = ''; emailForm.hidden = false;
    employeeEmail.focus?.();
  }
  emailCancel.onclick = () => { if (!emailBusy) { closeEmailForm(); emailFeedback.textContent = ''; } };
  emailForm.onsubmit = async event => {
    event.preventDefault();
    if (emailBusy || !emailTarget || !directoryData?.emailCompletion?.available) return;
    const existing = emailExisting;
    const email = existing || employeeEmail.value.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || (emailForm.reportValidity && !emailForm.reportValidity())) { emailFeedback.textContent = '请输入有效的工作邮箱。'; return; }
    const target = emailTarget, operation = ++emailOperation, generation = JadminState.generation?.();
    const current = () => operation === emailOperation && generation === JadminState.generation?.();
    emailBusy = true; employeeEmail.disabled = true; emailSave.disabled = true; emailCancel.disabled = true;
    emailFeedback.textContent = '正在保存…'; renderDirectoryRows();
    try {
      const result = await api('/api/admin/directory/email', { method: 'POST', body: JSON.stringify({ employeeId: target, email, ...(existing ? {confirmExisting: true} : {}) }) });
      if (!current()) return;
      if (result?.employeeId !== target || result.email !== email || (existing ? result.workEmailConfirmed !== true :
          result.updated !== true || result.emailVerified !== false || !['confirmed','pending','not_applicable'].includes(result.workEmailConfirmation))) throw Object.assign(Error('unconfirmed'), { code: 'write_outcome_unknown' });
      const message = existing || result.workEmailConfirmation === 'confirmed' ? '管理员已确认工作邮箱。' :
        result.workEmailConfirmation === 'not_applicable' ? '邮箱已保存；员工尚未绑定钉钉。' : '邮箱已保存，确认未完成。请在员工列表中选择“确认工作邮箱”。';
      closeEmailForm(); const settled = emailOperation;
      JadminState.invalidate('directory', 'departments', 'audit');
      emailFeedback.textContent = message;
      try { await refreshDirectory({ force: true }); }
      catch (error) { if (!superseded(error) && generation === JadminState.generation?.() && settled === emailOperation) emailFeedback.textContent = message + ' 员工列表暂时无法刷新，请稍后重新检查。'; }
    } catch (error) {
      if (!current() || superseded(error)) return;
      const messages = {
        dingtalk_required: '请先让员工绑定钉钉账号，再确认工作邮箱。',
        email_invalid: '请输入有效的工作邮箱。', email_conflict: '此邮箱已被其他账号使用，请核对。',
        email_not_empty: '该员工已有邮箱，请刷新员工列表。', employee_changed: '员工资料已变化，请刷新后重试。',
        employee_inactive: '该员工已停用，无法补填。', employee_not_found: '员工记录不存在，请刷新员工列表。',
        atomic_writer_unconfigured: '邮箱补填服务尚未启用，请联系系统管理员。',
        write_outcome_unknown: '保存结果尚未确认，请先重新检查员工邮箱，不要重复提交。',
        administrator_required: '当前账号没有管理员权限。', unauthorized: '登录已失效，请重新登录。',
        admin_required: '当前账号没有管理员权限。', writer_unavailable: '邮箱补填服务暂时不可用，请稍后重试。',
        writer_capability_missing: '邮箱补填服务尚未就绪，请联系系统管理员。',
        writer_configuration_invalid: '邮箱补填服务尚未就绪，请联系系统管理员。',
        organization_unconfigured: '员工组织尚未配置，请联系系统管理员。', directory_unavailable: '暂时无法核对员工资料，请稍后重试。'
      };
      const code = error.code || (error.status === 401 ? 'unauthorized' : error.status === 403 ? 'administrator_required' : 'write_outcome_unknown');
      emailFeedback.textContent = messages[code] || messages.write_outcome_unknown;
      if (!messages[code] || code === 'write_outcome_unknown') { closeEmailForm(); emailNeedsRefresh = true; JadminState.invalidate('directory', 'audit'); }
    } finally {
      if (current()) { emailBusy = false; employeeEmail.disabled = false; emailSave.disabled = false; emailCancel.disabled = false; }
      if (generation === JadminState.generation?.()) renderDirectoryRows();
    }
  };
  const issueFilters = [['all', '全部'], ['ready', '资料完整'], ['missingEmail', '缺邮箱'], ['missingPhone', '缺手机号'], ['duplicateEmail', '邮箱重复'], ['duplicatePhone', '手机号重复'], ['noIm', '未绑定 IM'], ['unassigned', '未分配部门']];
  function renderDirectoryFilters() {
    directoryFilters.replaceChildren(...issueFilters.map(([key, label]) => {
      const count = directoryData && (key === 'all' ? directoryData.total : key === 'ready' ? directoryData.ready : (directoryData.counts || {})[key]);
      const chip = el('button', label + ' · ' + (Number.isFinite(count) ? count : directoryUnknown), { type: 'button', className: 'filter-chip', disabled: !directoryData, onclick: () => {
        directoryFilter = key; renderDirectoryFilters(); renderDirectoryRows();
      } });
      chip.setAttribute('aria-pressed', String(directoryFilter === key)); return chip;
    }));
  }
  function renderDirectoryRows() {
      const x = directoryData;
      const body = header(dirTable, ['姓名', '邮箱', '手机号', '已绑定 IM', 'Casdoor 群组', '部门', '问题', '手动分配']);
      emailCapability.hidden = !x || x.emailCompletion?.available === true;
      emailCapability.textContent = emailCapability.hidden ? '' : '邮箱补填服务尚未启用，请联系系统管理员。';
      if (!x) return;
      const label = issueFilters.find(([key]) => key === directoryFilter)?.[1];
      const users = x.users.filter(u => directoryFilter === 'all' || (directoryFilter === 'ready' ? !u.issues.length : u.issues.includes(label)));
      users.forEach(u => {
        const tr = el('tr');
        const dept = u.departmentName ? u.departmentName + (u.source === 'manual' ? '（手动）' : '') : '未分配';
        tr.append(el('td', u.displayName));
        const mailbox = el('td', u.email || '—');
        if (!u.email && u.canCompleteEmail === true && u.id) mailbox.append(el('button', '补工作邮箱', { type: 'button', className: 'button-secondary employee-email-action', disabled: emailBusy || emailNeedsRefresh || x.emailCompletion?.available !== true, onclick: () => startEmailForm(u) }));
        if (u.workEmailConfirmed) mailbox.append(el('span', '（工作邮箱已确认）'));
        else if (u.email && u.canConfirmWorkEmail === true && u.id) mailbox.append(el('button', '确认工作邮箱', { type: 'button', className: 'button-secondary employee-email-action', disabled: emailBusy || emailNeedsRefresh || x.emailCompletion?.available !== true, onclick: () => startEmailForm(u) }));
        tr.append(mailbox);
        [u.phone || '—', u.im.join('、') || '—', u.groups.join('、') || '—', dept].forEach(v => tr.append(el('td', v)));
        tr.append(el('td', u.issues.join('、') || '✓', { className: u.issues.length ? 'bad' : 'ok' }));
        const td = el('td');
        if (u.email) {
          const select = el('select');
          select.append(el('option', '按群组自动', { value: '' }));
          departments.forEach(d => select.append(el('option', d.name, { value: d.code })));
          select.value = u.source === 'manual' ? u.department : '';
          select.onchange = async () => {
            try { renderDepartments(await api('/api/admin/assignments', { method: 'POST', body: JSON.stringify({ email: u.email, code: select.value || null }) })); JadminState.invalidate('departments', 'directory'); say('已更新 ' + u.email + ' 的部门'); } catch (e) { if (superseded(e)) return false; say(e.message, true); }
          };
          td.append(select);
        } else td.textContent = '先补邮箱';
        tr.append(td); body.append(tr);
      });
      if (!users.length) { const tr = el('tr'); tr.append(el('td', x.total === 0 ? '员工目录为空，无法评估匹配情况。' : '当前筛选没有员工。', { colSpan: 8, className: 'muted' })); body.append(tr); }
      JadminShell.labelTables?.(card);
  }
  renderDirectoryFilters();
  async function refreshDirectory({ force = false } = {}) {
    let currentSession = true;
    dirButton.disabled = true; dirSummary.textContent = '读取中…'; dirSummary.className = 'muted';
    try {
      const x = await JadminState.read('directory', () => api('/api/admin/directory'), { force });
      directoryData = x;
      emailNeedsRefresh = false;
      if (emailTarget && !emailBusy && (!x.emailCompletion?.available || !x.users.some(u => u.id === emailTarget && (emailExisting ? u.email === emailExisting && u.canConfirmWorkEmail === true : u.canCompleteEmail === true && !u.email)))) { closeEmailForm(); emailFeedback.textContent = '员工资料已变化，请重新选择员工。'; }
      const c = x.counts;
      dirSummary.textContent = '共 ' + x.total + ' 人，资料完整 ' + x.ready + ' 人；缺邮箱 ' + c.missingEmail + '，缺手机号 ' + c.missingPhone + '，邮箱重复 ' + c.duplicateEmail + '，手机号重复 ' + c.duplicatePhone + '，未绑定 IM ' + c.noIm + '，未分配部门 ' + c.unassigned + '。';
      renderDirectoryFilters(); renderDirectoryRows();
    } catch (e) { if (superseded(e)) { currentSession = false; return false; } directoryData = null; directoryUnknown = '未知'; renderDirectoryFilters(); renderDirectoryRows(); dirSummary.textContent = '无法读取员工目录（身份服务未配置或不可用）'; dirSummary.className = 'bad'; throw e; }
    finally { if (currentSession) dirButton.disabled = false; }
  }
  dirButton.onclick = () => refreshDirectory({ force: true }).catch(() => {});

  async function selectPeopleTab(tab, { force = false, load = true } = {}) {
    if (!['departments', 'directory'].includes(tab)) throw Error('unknown_people_tab');
    const directory = tab === 'directory';
    if (!directory && !emailBusy) closeEmailForm();
    departmentPanel.hidden = directory; directoryPanel.hidden = !directory;
    departmentTab.setAttribute('aria-selected', String(!directory)); directoryTab.setAttribute('aria-selected', String(directory));
    departmentTab.tabIndex = directory ? -1 : 0; directoryTab.tabIndex = directory ? 0 : -1;
    if (directory && load) await refreshDirectory({ force });
  }
  departmentTab.onclick = () => selectPeopleTab('departments');
  directoryTab.onclick = () => selectPeopleTab('directory').catch(() => {});
  [departmentTab, directoryTab].forEach(tab => { tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? departmentTab : event.key === 'End' ? directoryTab : tab === departmentTab ? directoryTab : departmentTab;
    target.focus?.(); target.onclick();
  }; });

  async function refreshDepartments({ force = false } = {}) { try { renderDepartments(await JadminState.read('departments', () => api('/api/admin/departments'), { force })); } catch (e) { if (superseded(e)) return false; say(e.message, true); throw e; } }

  // ---- 统一登录配置
  const imCard = el('section', null, { className: 'card', id: 'login-config-card' });
  const imState = el('p', '', { className: 'muted' });
  const credentialFeedback = el('p', '', { role: 'status' });
  credentialFeedback.setAttribute('aria-live', 'polite');
  const connectionState = el('p', '', { className: 'muted' });
  const warning = el('p', '切换期间可能同时显示新旧登录方式。旧方式在等待期内保留；系统只能记录配置已发送，无法确认各应用缓存已更新，离线应用可能一直保留旧策略。企业微信切换期间，邮箱未验证的员工可能暂时无法登录。', { className: 'muted' });
  const imSync = el('table'), revisionTable = el('table'), continuityState = el('p', '', { className: 'muted' });
  const ownerArea = el('div', null, { hidden: true }), revisionForm = el('form'), actions = el('div'), testLink = el('p');
  const progress = el('div', null, { className: 'login-progress' }), drainState = el('p', '', { className: 'muted' });
  const advanced = el('details'), advancedActions = el('div'), operationReasons = el('div'), errorDetails = el('details');
  advanced.append(el('summary', '高级操作'), advancedActions);
  errorDetails.hidden = true;
  const switchingNotes = el('details');
  switchingNotes.append(el('summary', '切换说明'), warning, el('p', '配置回读只核对可见字段，无法检测密钥是否被另行修改。读取不代表应用确认更新；连接中断的应用可能持续保留旧配置。', { className: 'muted' }));
  const inputs = {
    clientId: el('input', null, { name: 'clientId', required: true, autocomplete: 'off' }),
    clientSecret: el('input', null, { name: 'clientSecret', type: 'password', autocomplete: 'new-password' }),
    appId: el('input', null, { name: 'appId', type: 'text', autocomplete: 'off' }),
    useIdAsName: el('input', null, { name: 'useIdAsName', type: 'checkbox' }),
    emailDomains: el('input', null, { name: 'emailDomains', placeholder: 'example.com, example.cn' }),
    copySecretFrom: el('select', null, { name: 'copySecretFrom' }),
  };
  const platforms = {
    lark: { name: '飞书', clientId: 'App ID', clientSecret: 'App Secret', docs: ['https://casdoor.org/docs/provider/oauth/lark/', 'https://open.feishu.cn/document/common-capabilities/sso/web-application-sso/web-app-overview'] },
    dingtalk: { name: '钉钉', clientId: 'Client ID（原 AppKey）', clientSecret: 'Client Secret（原 AppSecret）', docs: ['https://casdoor.org/docs/provider/oauth/DingTalk/', 'https://open.dingtalk.com/document/orgapp/tutorial-obtaining-user-personal-information'] },
    wecom: { name: '企业微信', clientId: '企业 ID（CorpID）', clientSecret: '应用 Secret', docs: ['https://casdoor.org/docs/provider/oauth/weCom/', 'https://developer.work.weixin.qq.com/document/path/98151'] },
  };
  let platform = 'lark', drafts = {}, formMutable = false;
  const platformGroup = el('fieldset', null, { className: 'login-platforms' }), radios = {}, wrappers = {}, fieldLabels = {};
  const platformNotice = el('p'); platformNotice.setAttribute('aria-live', 'polite');
  const setupGuide = el('div', null, { className: 'login-setup-guide' });
  platformGroup.append(el('legend', '选择登录平台'));
  Object.entries(platforms).forEach(([value, spec]) => {
    const radio = radios[value] = el('input', null, { type: 'radio', name: 'im', value, checked: value === platform, onchange: () => { if (radio.checked) switchPlatform(value); } });
    const label = el('label', null, { className: 'login-platform-choice' }); label.append(radio, el('span', spec.name)); platformGroup.append(label);
  });
  revisionForm.append(platformGroup, platformNotice);
  const labels = { clientId: 'App ID', clientSecret: 'App Secret', appId: 'AgentId', useIdAsName: '按企业微信 userid 匹配员工', emailDomains: '公司邮箱域（可选，逗号分隔）', copySecretFrom: '密钥来源（留空需填写新密钥）' };
  Object.entries(inputs).forEach(([key, input]) => {
    const wrapper = wrappers[key] = el('div');
    wrapper.setAttribute('data-platforms', ['appId', 'useIdAsName'].includes(key) ? 'wecom' : 'lark dingtalk wecom');
    const label = el('label', null, { className: key === 'useIdAsName' ? 'login-checkbox' : 'field' }), caption = fieldLabels[key] = el('span', labels[key]); label.append(caption, input); wrapper.append(label);
    if (key === 'clientSecret') wrapper.append(el('button', '显示密钥', { type: 'button', onclick: event => {
      const show = input.type === 'password'; input.type = show ? 'text' : 'password'; event.currentTarget.textContent = show ? '隐藏密钥' : '显示密钥';
    } }));
    input.oninput = () => { stashDraft(); updateFields(); };
    revisionForm.append(wrapper);
  });
  const identityHelp = el('p', '员工的身份服务用户名必须等于企业微信 userid；此匹配规则固定开启。', { className: 'muted' });
  wrappers.useIdAsName.append(identityHelp);
  const wecomNotice = el('p', '企业微信通常不返回邮箱，填写后无邮箱员工会被拒绝', { className: 'muted', hidden: true });
  wrappers.emailDomains.append(wecomNotice);
  inputs.copySecretFrom.onchange = () => { if (inputs.copySecretFrom.value) clearSecret(); updateFields(); };
  const saveRevision = el('button', '保存并测试凭据', { type: 'submit' }); revisionForm.append(saveRevision);
  ownerArea.append(el('h3', '新建登录配置版本'), el('p', '保存时自动测试凭据。凭据通过后，请在 Jadmin 试用并完成一次真实登录，再启用到各应用。密钥不会通过接口返回。', { className: 'muted' }), revisionForm);
  imCard.append(el('h2', '企业登录'), el('p', '后台邮箱密码登录始终可用', { className: 'muted' }),
    connectionState, imState, errorDetails, progress, drainState, continuityState, testLink, switchingNotes,
    ownerArea, setupGuide, credentialFeedback, revisionTable, el('h3', '各应用当前登录方式'), imSync,
    actions, advanced, operationReasons, el('p', '界面隐藏仅为方便；权限由服务器检查。', { className: 'muted' }));
  JadminShell.mount('login', imCard);
  let configView = {}, activeAttempt = '', pollUntil = 0, pollTimer = null, polling = false, busy = false, drainTimer = null;
  function stashDraft() {
    drafts[platform] = { clientId: inputs.clientId.value, emailDomains: inputs.emailDomains.value,
      ...(platform === 'wecom' ? { appId: inputs.appId.value } : {}) };
  }
  function clearSecret() {
    inputs.clientSecret.value = ''; inputs.clientSecret.type = 'password';
    wrappers.clientSecret.querySelector('button').textContent = '显示密钥';
  }
  function secretCandidates() {
    const draft = drafts[platform] || {};
    return (configView.revisions || []).filter(r => r.im === platform && !['retired', 'provisioning'].includes(r.role) &&
      r.clientId === (draft.clientId || '').trim() && (platform !== 'wecom' || r.appId === (draft.appId || '').trim()));
  }
  function updateFields() {
    const candidates = secretCandidates(), chosen = inputs.copySecretFrom.value;
    inputs.copySecretFrom.replaceChildren(el('option', '填写新密钥，不复制', { value: '' }), ...candidates.map(r => el('option', '明确复制 r' + r.id + ' 的密钥', { value: String(r.id) })));
    inputs.copySecretFrom.value = candidates.some(r => String(r.id) === chosen) ? chosen : '';
    Object.entries(inputs).forEach(([key, input]) => {
      const visible = (!['appId', 'useIdAsName'].includes(key) || platform === 'wecom') && (key !== 'copySecretFrom' || candidates.length > 0);
      wrappers[key].hidden = !visible;
      input.disabled = !formMutable || !visible || key === 'useIdAsName';
      input.required = visible && formMutable && (['clientId', 'appId', 'useIdAsName'].includes(key) || (key === 'clientSecret' && !inputs.copySecretFrom.value));
    });
    inputs.useIdAsName.checked = platform === 'wecom';
    wecomNotice.hidden = platform !== 'wecom'; identityHelp.hidden = platform !== 'wecom';
    fieldLabels.clientId.textContent = platforms[platform].clientId;
    fieldLabels.clientSecret.textContent = platforms[platform].clientSecret;
  }
  function switchPlatform(next) {
    stashDraft(); platform = next;
    const draft = drafts[platform] || {};
    ['clientId', 'appId', 'emailDomains'].forEach(key => { inputs[key].value = draft[key] || ''; });
    clearSecret(); inputs.copySecretFrom.value = '';
    Object.entries(radios).forEach(([key, radio]) => { radio.checked = key === platform; });
    platformNotice.textContent = '已切换到' + platforms[platform].name + '；未保存的密钥已清空';
    updateFields(); renderSetup();
  }
  function renderSetup() {
    const setup = configView.setup || {}, spec = platforms[platform];
    const unavailable = '无法确定身份服务对外地址（签发方未配置或不是 HTTPS），请联系部署管理员；请勿自行猜测地址。';
    setupGuide.replaceChildren(el('h3', spec.name + '接入步骤'));
    function address(parent, label, value) {
      const row = el('div'); row.append(el('p', label));
      if (value) {
        const status = el('span'); status.setAttribute('aria-live', 'polite');
        const generation = JadminState.generation?.();
        row.append(el('code', value), el('button', '复制' + label, { type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(value); if (generation === JadminState.generation?.()) status.textContent = '已复制'; }
          catch (_) { if (generation === JadminState.generation?.()) status.textContent = '复制失败，请手动选择地址复制。'; }
        } }), status);
      } else row.append(el('p', unavailable + ' 原因：' + (setup.reason || 'setup_unavailable'), { className: 'bad' }));
      parent.append(row);
    }
    address(setupGuide, '填到企业平台的回调地址', setup.casdoorCallback);
    address(setupGuide, '可信域名/回调域名（如平台只要求域名）', setup.casdoorHost);
    const deployment = el('details'); deployment.append(el('summary', '由部署管理员在身份服务中配置，不要填到飞书/钉钉/企业微信'));
    address(deployment, '部署信息：Jadmin 登录回调', setup.jadminCallback); setupGuide.append(deployment);
    const callback = setup.casdoorCallback || '（地址不可用，请联系部署管理员）', host = setup.casdoorHost || '（域名不可用，请联系部署管理员）';
    const steps = {
      lark: ['在飞书开放平台创建企业自建应用（需要企业管理员权限），取得 App ID 和 App Secret。', '在应用的网页登录/重定向配置中添加：' + callback + '（具体位置见飞书官方文档）。', '按 Casdoor 与飞书文档开通网页登录及读取用户基本信息（邮箱/手机号）所需权限；设置可用范围包含需要登录的员工，并按平台要求发布应用版本。', '在 Jadmin 选择「飞书」，填写 App ID、App Secret（可选：公司邮箱域），保存为新版本。', '依次：测试凭据 → 在 Jadmin 试用 → 测试真实登录 → 启用到所有应用。'],
      dingtalk: ['在钉钉开放平台创建企业内部应用，取得 Client ID（原 AppKey）和 Client Secret（原 AppSecret）。', '在应用登录配置中添加回调地址 ' + callback + '；如平台要求填写回调域名，填写 ' + host + '。', '申请通讯录个人信息读权限 Contact.User.Read（Casdoor 文档要求），设置可见范围并发布应用。', '在 Jadmin 选择「钉钉」，填写 Client ID、Client Secret，保存为新版本。', '依次：测试凭据 → 在 Jadmin 试用 → 测试真实登录 → 启用到所有应用。'],
      wecom: ['在企业微信管理后台创建自建应用，记下企业 ID（CorpID）、应用 AgentId 和 Secret。', '为应用开启企业微信网页登录，把可信域名/授权回调域设为 ' + host + '；平台可能要求验证域名归属或设置企业可信 IP，请按官方文档完成。', '设置应用可见范围包含需要登录的员工。', '确认员工在身份服务中的用户名等于其企业微信 userid（系统按 userid 匹配已有员工，此规则不会自动改变）。', '在 Jadmin 选择「企业微信」，填写企业 ID、AgentId、Secret，保持「按 userid 匹配」开启，保存为新版本，然后测试、试用、启用。'],
    };
    const list = el('ol'); steps[platform].forEach(step => list.append(el('li', step))); setupGuide.append(list);
    if (platform === 'lark') setupGuide.append(el('p', '国际版 Lark 未经验证', { className: 'muted' }));
    if (platform === 'dingtalk') setupGuide.append(el('p', 'Casdoor 最新文档提到的组织/通讯录同步等行为取决于身份服务版本，Jadmin 不负责配置。', { className: 'muted' }));
    spec.docs.forEach((href, index) => { const p = el('p'); p.append(el('a', index ? spec.name + '官方文档' : 'Casdoor ' + spec.name + '文档', { href, target: '_blank', rel: 'noopener noreferrer' })); setupGuide.append(p); });
    setupGuide.append(el('p', '官方文档为最新版本；本系统安装的身份服务版本可能有差异，以下字段对应以本页为准。', { className: 'muted' }),
      el('p', 'Jadmin 无法替您创建企业应用或生成密钥。「测试凭据」只证明 ID/密钥可换取平台令牌，不代表员工能登录；启用前必须完成真实登录测试。保存新版本不会自动启用，后台邮箱密码登录始终可用。', { className: 'muted' }));
  }
  const statusNames = { lark: '飞书', dingtalk: '钉钉', wecom: '企业微信', passed: '通过', failed: '失败', pending: '等待中', untested: '未测试', unavailable: '暂不可验证', active: '当前启用', staged: 'Jadmin 试用中', previous: '上一版本', draft: '草稿', provisioning: '创建中', retired: '已退役', consistent: '一致', needs_attention: '需处理', unknown: '待核对', legacy: '原有配置', detached: '已停用企业登录', stage: '试用', cancel_stage: '取消试用', activate: '启用', restore: '恢复', detach: '停用', signup_pause: '暂停注册', signup_resume: '恢复注册', attach: '同步中', draining: '等待缓存更新', cleanup: '清理旧配置', cleanup_incomplete: '旧配置待清理', done: '已完成', cancelled: '已取消', compensated: '已还原', compensation_failed: '还原未完成', interrupted: '操作中断', running: '进行中' };
  Object.assign(statusNames, { save_revision: '保存版本', created: '已创建', test_credentials: '测试凭据', tested: '已测试', snapshot: '保存快照', complete: '完成核对', restored: '已恢复', failed: '失败', retired: '已退役' });
  statusNames.active = '当前配置';
  const statusText = value => statusNames[value] || (value ? '状态待核对' : '未测试');
  const report = (message, bad) => { imState.textContent = message; imState.className = bad ? 'bad' : 'ok'; };
  function technical(code) { errorDetails.hidden = !code; errorDetails.replaceChildren(el('summary', '技术详情'), el('pre', code || '')); }
  const timeText = value => value ? new Date(value * 1000).toLocaleString() : '时间未知';
  function testStatusCell(status, at, code) {
    const cell = el('td', statusText(status));
    if (status === 'passed' || status === 'failed') cell.append(el('small', ' · ' + timeText(at)));
    if (code && String(code) !== '0') { const detail = el('details'); detail.append(el('summary', '技术详情'), el('code', String(code))); cell.append(detail); }
    return cell;
  }
  async function confirmed(title, message, danger = false) { return !!(await JadminShell.dialog({ title, message, danger, confirmText: '确认' })); }
  async function requiredReason(title, message) {
    const answer = await JadminShell.dialog({ title, message: message + ' 原因保存在本次登录操作记录中（企业登录页可见）。', reason: true, danger: true, confirmText: '记录原因并继续' });
    return typeof answer === 'string' && answer.trim() ? answer.trim() : null;
  }
  const errorNames = {
    edge_guard_missing: '注册保护尚未生效，暂时无法继续。请联系部署管理员。',
    operation_running: '另一个操作正在进行，请稍后刷新。',
    tests_missing: '请先完成该版本的凭据测试和真实登录测试。',
    needs_attention: '当前配置需要修复，请先核对状态。',
    directory_unavailable: '暂时无法读取员工目录，请稍后再试。',
    session_expired: '本次登录即将过期，请重新登录后台后测试。',
    session_expiring: '本次登录即将过期，请重新登录后台后测试。',
    owner_required: '此操作仅供后台所有者使用。',
    drain_pending: '仍在等待各应用刷新，稍后可完成切换。',
    credential_fields_invalid: '请检查应用 ID；企业微信还需 Agent ID，并启用用户 ID 作为用户名。',
    platform_fields_invalid: '提交的字段不适用于所选登录平台，请检查后重试。',
    secret_invalid: '请填写应用密钥，或明确选择复制某一版本的密钥。',
    secret_source_invalid: '所选密钥来源无效，请选择可用版本。',
    secret_unavailable: '身份服务不会返回已保存的密钥。请点击本版本的「更多 → 修改后另存为新版本」，重新填写密钥并保存测试。',
    email_domains_invalid: '公司邮箱域格式不正确，请只填写域名，例如 example.com。',
    staging_exists: '已有试用版本，请先取消当前试用。',
    staging_missing: '请先将这个版本设为 Jadmin 试用版本。',
    stale_staging: '试用配置已变更，请重新开始登录测试。',
    signup_paused: '新员工注册已暂停，请先恢复注册。',
    restore_unavailable: '当前没有可恢复的切换记录。',
    restore_revision_missing: '原有登录方式没有独立配置版本，无法自动恢复；请保存并启用所需版本。',
    provider_drift: '身份服务中的配置已被另行修改，请保存新版本后重新测试。',
    reconcile_restore_required: '本次操作未完成，请选择恢复操作前快照。',
    reconcile_unavailable: '当前没有需要修复的操作。',
  };
  async function mutation(path, data, options) {
    if (busy || !configView.owner) return;
    const generation = JadminState.generation?.();
    busy = true; technical(''); let submitted = false;
    const disabled = [...imCard.querySelectorAll('button')].map(button => [button, button.disabled]);
    disabled.forEach(([button]) => { button.disabled = true; });
    const credentialRequest = path === '/revisions' || path.endsWith('/test-credentials');
    const revisionId = path.endsWith('/test-credentials') ? path.split('/')[2] : '';
    const feedback = (message, bad = false) => {
      report(message, bad);
      if (credentialRequest) {
        credentialFeedback.textContent = (revisionId ? 'r' + revisionId + '：' : '') + message;
        credentialFeedback.className = bad ? 'bad' : 'ok';
        if (revisionId) credentialFeedback.scrollIntoView({ block: 'nearest' });
      }
    };
    if (credentialRequest) feedback(path === '/revisions' ? '正在保存并测试凭据…' : '正在测试凭据…');
    if (path === '/activate' || path === '/restore' || path === '/detach') switchingNotes.open = true;
    try {
      const response = await fetch('/api/admin/login-config' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(data || {}) });
      const result = await response.json();
      if (generation !== JadminState.generation?.()) return;
      if (!response.ok) {
        if (result.code === 'needs_confirmation' && options && options.confirm) {
          const c = result.continuity;
          continuityState.textContent = c && c.total === 0 ? '员工目录为空，无法评估匹配情况。' :
            (c ? '最新目标方式匹配估计：共 ' + c.total + ' 人；已绑定 ' + c.alreadyLinked + '，可能匹配 ' + c.possibleMatch + '，暂无依据 ' + c.noBasis + '。实际匹配取决于企业应用返回的资料。' : '员工匹配情况需重新核对。');
          if (await confirmed('确认启用企业登录', options.confirm + ' ' + continuityState.textContent, true)) {
            busy = false; return await mutation(path, { ...data, confirm: true }, null);
          }
          report('已取消，配置未启用'); return;
        }
        JadminState.invalidate('login', 'audit');
        let refreshFailed = false;
        try { if (await refreshLoginIm() === false) return; } catch (e) { if (superseded(e)) return false; refreshFailed = true; }
        technical(result.code || 'request_failed');
        feedback((errorNames[result.code] || '操作未完成，请查看技术详情或联系部署管理员。') + (refreshFailed ? ' 状态读取失败，请刷新核对结果。' : ''), true);
        return;
      }
      submitted = true;
      if (path === '/revisions') {
        clearSecret();
        const check = result.credentialTest || {};
        const passed = check.ok === true;
        const message = passed ? '凭据测试通过，配置仍未启用。下一步：在 Jadmin 试用并完成一次真实登录。' : check.code && errorNames[check.code] ? '草稿已保存。' + errorNames[check.code] :
          !check.vendorCode || check.vendorCode === 'unavailable' ? '草稿已保存，但暂时无法确认凭据。请在本版本重试。' :
          '凭据测试未通过，配置仅保存为草稿。请检查企业应用凭据。';
        JadminState.invalidate('login', 'audit');
        let refreshFailed = false;
        try { if (await refreshLoginIm() === false) return false; }
        catch (e) { if (superseded(e)) return false; refreshFailed = true; }
        feedback(message + (refreshFailed ? ' 请刷新页面核对状态。' : ''), !passed || refreshFailed);
        return result;
      }
      JadminState.invalidate('login', 'audit'); if (await refreshLoginIm() === false) return;
      if (revisionId) feedback(result.ok === true ? '凭据测试通过。' : result.vendorCode === 'unavailable' ? '暂时无法完成平台检测，请重试。' : '平台未接受凭据，请核对应用 ID 和密钥。', result.ok !== true);
      else if (result.ok === false) report('操作尚未完成，请按当前恢复提示继续处理。', true);
      else report(path === '/activate' || path === '/restore' ? '配置已发送到各应用，请查看切换进度。' : '操作已完成');
      return result;
    } catch (e) { if (superseded(e) || generation !== JadminState.generation?.()) return false; technical(e.message); feedback(submitted ? '操作已提交，但状态未能读取。请刷新核对结果。' : '操作未完成，请重试；具体原因见技术详情。', true); }
    finally { if (generation === JadminState.generation?.()) { busy = false; disabled.forEach(([button, wasDisabled]) => { button.disabled = wasDisabled; }); } }
  }
  function operationButton(text, path, data, confirmation) {
    return el('button', text, { type: 'button', onclick: async () => {
      if (confirmation && !(await confirmed(text, confirmation, path === '/detach' || path === '/stage/cancel'))) return;
      await mutation(path, confirmation ? { ...(data || {}), confirm: true } : (data || {}));
    } });
  }
  function prefillRevision(r) {
    switchPlatform(r.im); inputs.clientId.value = r.clientId || ''; inputs.appId.value = r.appId || '';
    inputs.emailDomains.value = (r.emailDomains || []).join(', ');
    stashDraft(); updateFields();
    inputs.copySecretFrom.value = secretCandidates().some(candidate => candidate.id === r.id) ? String(r.id) : '';
    updateFields();
    ownerArea.scrollIntoView(); report('已填入 r' + r.id + ' 的非秘密字段；修改后将另存为新版本。');
  }
  const activateButton = r => el('button', '启用到所有应用', { type: 'button', onclick: () => mutation('/activate', { revisionId: r.id }, { confirm: '已核对最新员工匹配估计，仍要启用此版本吗？' }) });
  function overrideButton(r) {
    return el('button', '记录原因并跳过测试启用 r' + r.id, { type: 'button', className: 'danger', onclick: async () => {
      const reason = await requiredReason('跳过测试启用', '跳过测试可能导致员工无法登录。');
      if (reason) await mutation('/activate', { revisionId: r.id, overrideTests: true, overrideReason: reason }, { confirm: '本次将跳过测试，仍要启用吗？' });
    } });
  }
  function nextAction(r, x) {
    const op = x.operation || {}, stable = x.loginState === 'consistent' && op.status !== 'running';
    if (!x.owner || !stable || !(x.connection || {}).ok || ['retired', 'provisioning'].includes(r.role)) return null;
    if (r.credTestStatus !== 'passed') return operationButton('测试凭据', '/revisions/' + encodeURIComponent(r.id) + '/test-credentials');
    const ready = (x.guard || {}).ok && !(x.signup || {}).paused;
    if (!ready || r.role === 'active') return null;
    if (r.role === 'staged' && String(x.stagedRevisionId) === String(r.id)) {
      return r.signinTestStatus === 'passed' ? activateButton(r) :
        el('button', '测试真实登录', { type: 'button', onclick: () => startSignin(r.id) });
    }
    if (r.signinTestStatus === 'passed') return activateButton(r);
    if (['draft', 'previous'].includes(r.role) && !x.stagedRevisionId) return operationButton('在 Jadmin 试用', '/stage', { revisionId: r.id });
    return null;
  }
  async function pollTest() {
    if (!activeAttempt || polling) return;
    polling = true;
    try {
      const x = await api('/api/admin/login-config/test-signin/' + encodeURIComponent(activeAttempt));
      const status = x.status || x.signinTestStatus;
      if (status && status !== 'pending') {
        clearInterval(pollTimer); activeAttempt = '';
        testLink.replaceChildren(); JadminState.invalidate('login'); if (await refreshLoginIm() === false) return;
        technical(x.reason); report('真实登录测试：' + statusText(status) + (x.reason ? '。' + (errorNames[x.reason] || '具体原因见技术详情。') : ''), status !== 'passed');
      } else if (Date.now() >= pollUntil) {
        clearInterval(pollTimer); activeAttempt = ''; report('测试等待已结束，请刷新查看已保存的结果', true);
      }
    } catch (e) { if (superseded(e)) return false; clearInterval(pollTimer); activeAttempt = ''; technical(e.message); report('暂时无法读取测试结果，请刷新重试。', true); }
    finally { polling = false; }
  }
  async function startSignin(revisionId) {
    // Open synchronously within the click, before awaiting the authenticated start request.
    const popup = window.open('', 'jadmin-login-test');
    try {
      const x = await api('/api/admin/login-config/test-signin', { method: 'POST', body: JSON.stringify({ revisionId }) });
      JadminState.invalidate('login');
      if (popup && !popup.closed) popup.location.href = x.url;
      else {
        const link = el('a', '在新标签页中打开测试登录', { href: x.url, target: '_blank', rel: 'noopener' });
        testLink.replaceChildren(link);
      }
      activeAttempt = x.attemptId; pollUntil = Date.now() + 600000;
      clearInterval(pollTimer); pollTimer = setInterval(pollTest, 2000); report('请在测试窗口完成企业登录，本页面会自动更新结果。');
    } catch (e) { if (superseded(e)) return false; if (popup && !popup.closed) popup.close(); technical(e.message); report('无法开始真实登录测试，请查看技术详情。', true); }
  }
  window.addEventListener('focus', () => { if (activeAttempt) pollTest(); });
  window.addEventListener('message', event => { if (event.origin === location.origin && event.data && event.data.type === 'jadmin-login-test') pollTest(); });
  function renderLoginIm(x) {
    configView = x; ownerArea.hidden = !x.owner; testLink.hidden = !x.owner;
    actions.replaceChildren(); advancedActions.replaceChildren(); progress.replaceChildren(); operationReasons.replaceChildren();
    if (drainTimer) clearInterval(drainTimer); drainTimer = null;
    const connection = x.connection || {}, guard = x.guard || {}, op = x.operation || {};
    connectionState.textContent = '身份服务：' + (connection.ok ? '已连接' : (connection.configured ? '连接失败' : '未配置')) +
      ' · 注册保护：' + (guard.ok ? '已生效' : '未生效') + ' · 配置：' + statusText(x.loginState);
    connectionState.className = connection.ok && guard.ok ? 'ok' : 'bad';
    const transport = el('details'); transport.append(el('summary', '连接详情'), el('p', '签发方：' + (connection.expectedIssuer || '尚未配置') + '；连接：' + (/loopback/.test(connection.transport || '') ? 'HTTPS 或仅本机 HTTP（依赖主机隔离）' : (connection.transport || '未知')))); connectionState.append(transport);
    report('当前：' + (x.activeRevisionId ? 'r' + x.activeRevisionId : statusText((x.loginProvider || {}).name ? 'legacy' : 'detached')) +
      (x.stagedRevisionId ? ' · 试用 r' + x.stagedRevisionId : '') + (op.id ? ' · ' + statusText(op.kind) + ' / ' + statusText(op.phase || op.status) : ''), x.loginState !== 'consistent');
    const cont = x.continuity || {};
    continuityState.textContent = cont.checked ? (cont.total === 0 ? '员工目录为空，无法评估匹配情况。' :
      '员工匹配估计：共 ' + cont.total + ' 人；已绑定 ' + cont.alreadyLinked + '，可能匹配 ' + cont.possibleMatch + '，暂无依据 ' + cont.noBasis + '。实际匹配取决于企业应用返回的资料。') + ' 数据时间：' + timeText(cont.at) :
      '员工匹配情况未检查；启用前会重新读取目录。';
    const revisions = x.revisions || [], staged = revisions.find(r => String(r.id) === String(x.stagedRevisionId));
    const active = revisions.find(r => r.role === 'active' && String(r.id) === String(x.activeRevisionId));
    const pending = staged || revisions.find(r => r.role === 'draft');
    const current = pending || active;
    if (current) {
      progress.append(el('h3', '当前进行中：r' + current.id + ' ' + statusText(current.im)),
        el('p', '① 保存版本 ✓ · ② 凭据 ' + statusText(current.credTestStatus) + ' · ③ 试用 ' + (current.role === 'staged' || current.role === 'active' ? '已设置' : '未开始') + ' · ④ 真实登录 ' + statusText(current.signinTestStatus) + ' · ⑤ ' + (current.role === 'active' ? '已发送到各应用' : '待启用')));
    } else progress.append(el('p', '尚无配置版本。由所有者保存版本、测试并启用；也可继续使用后台邮箱密码登录。'));
    if (!x.owner) progress.append(el('p', '以下登录设置需由所有者完成。', { className: 'muted' }));
    const recovery = ['interrupted', 'compensation_failed'].includes(op.status);
    const idle = x.loginState === 'consistent' && op.status !== 'running' && !recovery;
    const mutable = !!x.owner && idle && !!connection.ok;
    const ready = mutable && !!guard.ok && !(x.signup || {}).paused;
    ownerArea.querySelectorAll('input,select,button').forEach(n => { n.disabled = !mutable; });
    formMutable = mutable; updateFields(); renderSetup();
    const body = header(revisionTable, ['登录方式', '状态', '凭据测试', '真实登录测试', '下一步操作']);
    [active, pending].filter(Boolean).forEach(r => {
      const tr = el('tr'), ops = el('td');
      tr.append(el('td', statusText(r.im)), el('td', r === active ? '正在使用' : '待启用'),
        testStatusCell(r.credTestStatus, r.credTestAt, r.credTestCode), testStatusCell(r.signinTestStatus, r.signinTestAt, r.signinTestReason));
      const button = nextAction(r, x); if (button) ops.append(button);
      else ops.append(el('span', r.role === 'active' ? '当前配置' : (recovery ? '先恢复未完成操作' : '等待前置条件'), { className: 'muted' }));
      if (mutable && !['retired', 'provisioning'].includes(r.role)) {
        const more = el('details'), moreActions = el('div'); more.append(el('summary', '更多'), moreActions);
        moreActions.append(el('button', '修改后另存为新版本', { type: 'button', onclick: () => prefillRevision(r) }));
        if (r.credTestStatus === 'passed') moreActions.append(operationButton('重新测试凭据', '/revisions/' + encodeURIComponent(r.id) + '/test-credentials'));
        if (ready && r.role === 'staged' && r.signinTestStatus === 'passed') moreActions.append(el('button', '重新测试真实登录', { type: 'button', onclick: () => startSignin(r.id) }));
        ops.append(more);
        if (ready && (r.credTestStatus !== 'passed' || r.signinTestStatus !== 'passed')) advancedActions.append(overrideButton(r));
      }
      tr.append(ops); body.append(tr);
    });
    revisionTable.hidden = !active && !pending;
    drainState.hidden = true;
    if (x.owner && recovery) {
      progress.append(el('p', '上次操作未完成，请先选择核对状态或恢复快照。', { className: 'bad' }));
      actions.append(operationButton('重新核对状态', '/reconcile', { action: 'complete' }),
        operationButton('恢复操作前快照', '/reconcile', { action: 'restore' }, '恢复到此次未完成操作之前的配置？'));
    } else if (x.owner && op.status === 'running' && ['draining', 'cleanup_incomplete'].includes(op.phase)) {
      switchingNotes.open = true; drainState.hidden = false;
      const updateDrain = () => {
        const served = op.feed_served_at || op.feedServedAt;
        const remaining = served ? Math.max(0, Math.ceil(served + 360 - Date.now() / 1000)) : null;
        drainState.textContent = remaining === null ? '等待 os-bridge 读取新配置' : (remaining > 0 ? '等待切换完成：剩余 ' + remaining + ' 秒。' : '缓存等待已结束，可完成切换。');
        const finish = [...actions.querySelectorAll('button')].find(b => b.textContent === '完成切换');
        if (finish) finish.disabled = remaining === null || remaining > 0;
      };
      if (op.phase === 'cleanup_incomplete') actions.append(operationButton('重试清理旧配置', '/cleanup/retry'));
      else actions.append(operationButton('完成切换', '/activate/finish'));
      advancedActions.append(el('button', '立即完成（跳过等待）', { type: 'button', className: 'danger', onclick: async () => {
        const reason = await requiredReason('立即完成切换', '部分应用可能仍使用旧登录提示和旧策略。');
        if (reason) await mutation('/activate/finish', { force: true, reason });
      } }));
      updateDrain(); drainTimer = setInterval(updateDrain, 1000);
    }
    if (mutable) {
      if (x.stagedRevisionId) advancedActions.append(operationButton('取消 Jadmin 试用', '/stage/cancel'));
      if (!staged && revisions.some(r => ['draft', 'retired', 'previous'].includes(r.role))) advancedActions.append(operationButton('清除未使用的配置', '/revisions/clear-unused', {}, '清除未启用的配置？正在使用的登录方式会保留。'));
      advancedActions.append(operationButton('停用企业登录', '/detach', {}, '停用后新的企业登录会不可用；后台邮箱密码登录始终可用。继续？'));
      const paused = x.signup && x.signup.paused;
      const signup = operationButton(paused ? '恢复新员工注册' : '暂停新员工注册', paused ? '/signup/resume' : '/signup/pause', {},
        paused ? '恢复新员工首次登录注册？' : '暂停后已有员工仍可登录，新员工暂时无法首次注册。继续？');
      signup.disabled = !!paused && !guard.ok; advancedActions.append(signup);
    }
    advanced.hidden = !x.owner || !advancedActions.children.length;
    const results = op.results || {};
    ['overrideReason', 'finishReason'].forEach(key => {
      if (results[key]) operationReasons.append(el('p', (key === 'overrideReason' ? '本次操作跳过测试原因：' : '本次操作跳过等待原因：') + results[key]));
    });
    if (results.signupClosedBeforeDrain) operationReasons.append(el('p', '注册保护缺失，本次操作先关闭新员工注册，再等待旧配置退出。', { className: 'bad' }));
    if (!connection.ok) progress.append(el('p', '身份服务未连接，请所有者联系部署管理员处理后再继续。', { className: 'bad' }));
    else if (!guard.ok) progress.append(el('p', '注册保护未生效，启用与试用已暂停；请联系部署管理员。', { className: 'bad' }));
    if ((x.signup || {}).paused) progress.append(el('p', '新员工注册已暂停；已有员工仍可登录。恢复注册后再试用或启用新版本。', { className: 'muted' }));
    const appsBody = header(imSync, ['应用', '当前提供商', '新员工注册']);
    (x.apps || []).forEach(a => {
      const providers = (a.providers || []).map(p => typeof p === 'string' ? p : p.name || '').filter(Boolean);
      const tr = el('tr'); tr.append(el('td', a.app), el('td', providers.join('、') || '无企业登录方式'), el('td', a.enableSignUp ? '开启' : '关闭')); appsBody.append(tr);
    });
    JadminShell.labelTables?.(imCard);
  }
  async function refreshLoginIm({ force = false } = {}) {
    try { renderLoginIm(await JadminState.read('login', () => api('/api/admin/login-config'), { force, timeout: 8000 })); return true; } catch (e) { if (superseded(e)) return false; technical(e.message); report('无法读取企业登录状态，请重试。', true); throw e; }
  }
  updateFields(); renderSetup();
  revisionForm.onsubmit = async event => {
    event.preventDefault();
    if (!formMutable) return;
    const draft = drafts[platform] || {};
    const payload = { im: platform, clientId: (draft.clientId || '').trim(), emailDomains: (draft.emailDomains || '').split(/[,，\s]+/).filter(Boolean) };
    if (inputs.clientSecret.value) payload.clientSecret = inputs.clientSecret.value;
    else if (inputs.copySecretFrom.value) payload.copySecretFrom = inputs.copySecretFrom.value;
    if (payload.im === 'wecom') { payload.appId = (draft.appId || '').trim(); payload.useIdAsName = true; }
    await mutation('/revisions', payload);
  };

  // ---- 企业账号关联（管理员）
  const linkCard = el('section', null, { className: 'card' });
  const linkState = el('p', '', { className: 'muted' });
  const linkButton = el('button', '关联企业账号', { type: 'button' });
  const unlinkButton = el('button', '解除我的关联', { type: 'button', className: 'danger' });
  const linkTable = el('table');
  linkCard.append(
    el('h2', '企业账号关联'),
    el('p', '后台邮箱密码登录始终可用。管理员需先用邮箱和密码登录，再点击「关联企业账号」并在 Casdoor 完成一次登录，之后才能用企业账号进入后台。关联链接 10 分钟内有效，只能使用一次。', { className: 'muted' }),
    linkState, linkButton, unlinkButton, linkTable,
  );
  JadminShell.mount('admins', linkCard);
  function renderLinks(x) {
    linkCard.hidden = false;
    linkState.textContent = x.self ? '已关联 Casdoor 用户 ' + x.self.subject + '（' + new Date(x.self.created * 1000).toLocaleString() + '）' : (x.enabled ? '尚未关联企业账号' : '企业账号登录未配置；后台邮箱密码登录始终可用');
    linkButton.textContent = x.self ? '重新关联企业账号' : '关联企业账号';
    linkButton.disabled = !x.enabled; unlinkButton.hidden = !x.self;
    const body = header(linkTable, ['管理员邮箱', 'Casdoor 用户 ID', '关联时间', '操作']);
    (x.bindings || []).forEach(b => {
      const tr = el('tr'); const ops = el('td');
      if (x.owner) ops.append(el('button', '解除', { type: 'button', className: 'danger', onclick: () => unlinkEmail(b.email) }));
      tr.append(el('td', b.email), el('td', b.subject), el('td', new Date(b.created * 1000).toLocaleString()), ops); body.append(tr);
    });
    JadminShell.labelTables?.(linkCard);
  }
  async function refreshLinks({ force = false } = {}) { try { renderLinks(await JadminState.read('links', () => api('/api/admin/sso/links'), { force })); } catch (e) { if (superseded(e)) return false; linkState.textContent = e.message; linkState.className = 'bad'; throw e; } }
  async function unlinkEmail(email) {
    if (!(await confirmed('解除企业账号关联', '解除 ' + (email || '我') + ' 的企业账号关联？之后需用邮箱密码登录，或重新关联。', true))) return;
    try { await api('/api/admin/sso/unlink', { method: 'POST', body: JSON.stringify(email ? { email } : {}) }); JadminState.invalidate('links'); await refreshLinks(); } catch (e) { if (superseded(e)) return false; linkState.textContent = e.message; linkState.className = 'bad'; }
  }
  linkButton.onclick = async () => {
    try { const x = await api('/api/admin/sso/link', { method: 'POST', body: '{}' }); JadminState.invalidate('links'); location.href = x.url; } catch (e) { if (superseded(e)) return false; linkState.textContent = e.message; linkState.className = 'bad'; }
  };
  unlinkButton.onclick = () => unlinkEmail('');

  let sessionGeneration = JadminState.generation?.();
  JadminState.subscribe?.(() => {
    const current = JadminState.generation?.();
    if (current === sessionGeneration) return;
    sessionGeneration = current;
    clearInterval(drainTimer); drainTimer = null; drainState.hidden = true;
    progress.replaceChildren(); advancedActions.replaceChildren(); advanced.hidden = true; operationReasons.replaceChildren(); technical('');
    const secretToggle = [...revisionForm.querySelectorAll('button')].find(button => button.textContent === '隐藏密钥'); if (secretToggle) secretToggle.textContent = '显示密钥';
    clearInterval(pollTimer); pollTimer = null; activeAttempt = ''; pollUntil = 0; polling = false; busy = false; configView = {};
    drafts = {}; platform = 'lark'; formMutable = false;
    Object.values(inputs).forEach(input => { input.value = ''; }); clearSecret();
    Object.entries(radios).forEach(([key, radio]) => { radio.checked = key === platform; });
    platformNotice.textContent = ''; updateFields(); setupGuide.replaceChildren();
    ownerArea.hidden = true; ownerArea.querySelectorAll('input,select,button').forEach(node => { node.disabled = true; });
    testLink.replaceChildren(); testLink.hidden = true; actions.replaceChildren(); revisionTable.replaceChildren(); imSync.replaceChildren();
    connectionState.textContent = ''; imState.textContent = ''; continuityState.textContent = '';
    departments = []; directoryData = null; directoryFilter = 'all'; directoryUnknown = '未检查';
    closeEmailForm(); emailNeedsRefresh = false; emailFeedback.textContent = ''; emailPerson.textContent = ''; emailCapability.hidden = true;
    deptTable.replaceChildren(); renderDirectoryFilters(); renderDirectoryRows(); dirButton.disabled = false;
    dirSummary.textContent = '尚未检查员工资料；选择此页签或点击检查后读取员工目录。'; dirSummary.className = 'muted'; notice.textContent = '';
    Object.values(fields).forEach(input => { input.value = ''; }); fields.code.readOnly = false;
    selectPeopleTab('departments', { load: false });
  });

  JadminShell.register('people', refreshDepartments);
  JadminShell.register('login', refreshLoginIm);
  JadminShell.register('admins', refreshLinks);
  window.JadminEnterprise = { refreshDepartments, refreshDirectory, refreshLoginIm, refreshLinks, selectPeopleTab,
    cards: { people: card, login: imCard, links: linkCard } };

  // Shell starts authentication only after every feature script has registered.
  if (hash.get('sso-token')) {
    token = hash.get('sso-token');
    window.JadminPendingSso = { notice: hash.get('sso-notice') || '', linked: !!hash.get('sso-notice') };
  }
})();
