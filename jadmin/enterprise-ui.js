// 企业OS：企业账号登录、部门目录、员工资料检查。所有文字用 textContent 写入，不拼接 HTML。
(function () {
  const el = (tag, text, attrs) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = text; Object.assign(node, attrs || {}); return node; };

  // ---- 企业账号登录（Casdoor）
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('sso-token') || hash.get('sso-error')) history.replaceState(null, '', location.pathname + location.search);
  fetch('/api/sso/status').then(r => r.json()).then(x => {
    if (!x.enabled) return;
    const button = el('button', '企业账号登录', { type: 'button' });
    button.onclick = () => { location.href = '/api/sso/start'; };
    $('loginbox').insertBefore(button, $('loginbox').querySelector('h2').nextSibling);
    $('loginbox').insertBefore(el('p', '企业账号需先由管理员本人在后台「企业账号关联」中关联；也可继续使用下面的邮箱和密码登录', { className: 'muted' }), button.nextSibling);
  }).catch(() => {});
  if (hash.get('sso-error')) { $('msg').textContent = hash.get('sso-error'); $('msg').className = 'bad'; }

  // ---- 部门与员工
  const card = el('section', null, { className: 'card' });
  card.append(
    el('h2', '部门与员工'),
    el('p', '员工的部门按以下顺序确定：手动分配 → 第一个包含其 Casdoor 群组的部门 → 未分配。部门决定 JAPI 分组（额度与可用模型）和可检索的 RAGFlow 知识库；RAGFlow Key 按部门代码配置在 os-bridge 的 secrets.json 中。', { className: 'muted' }),
  );
  const deptTable = el('table'); card.append(el('h3', '部门目录'), deptTable);
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
  card.append(form, notice);

  const dirButton = el('button', '检查员工资料（读取 Casdoor）', { type: 'button' });
  const dirSummary = el('p', '', { className: 'muted' });
  const dirTable = el('table');
  card.append(el('h3', '员工资料检查'), el('p', '逐个核对：公司邮箱、手机号是否填写且不重复（三个 IM 靠它们合并为同一账号）、是否绑定了 IM、是否有部门。', { className: 'muted' }), dirButton, dirSummary, dirTable);
  document.querySelector('#app').appendChild(card);

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
        if (!confirm('删除部门「' + d.name + '」？')) return;
        try { renderDepartments(await api('/api/admin/departments/delete', { method: 'POST', body: JSON.stringify({ code: d.code }) })); say('已删除'); } catch (e) { say(e.message, true); }
      } });
      const ops = el('td'); ops.append(edit, ' ', del);
      [d.code, d.name, d.groups.join('、') || '—', d.japiGroupId || '默认', counts[d.code] || 0].forEach(v => tr.append(el('td', String(v))));
      tr.append(ops); body.append(tr);
    });
    if (!departments.length) { const tr = el('tr'); tr.append(el('td', '还没有部门。先在 Casdoor 建群组，再在这里建部门并填入群组。', { colSpan: 6, className: 'muted' })); body.append(tr); }
  }

  save.onclick = async () => {
    try {
      const data = await api('/api/admin/departments', { method: 'POST', body: JSON.stringify({ code: fields.code.value.trim(), name: fields.name.value.trim(), groups: fields.groups.value, japiGroupId: fields.japiGroupId.value.trim(), sort: fields.sort.value.trim() || 0 }) });
      renderDepartments(data); clear.onclick(); say('已保存，os-bridge 一分钟内生效');
    } catch (e) { say(e.message, true); }
  };

  dirButton.onclick = async () => {
    dirButton.disabled = true; dirSummary.textContent = '读取中…'; dirSummary.className = 'muted';
    try {
      const x = await api('/api/admin/directory');
      const c = x.counts;
      dirSummary.textContent = '共 ' + x.total + ' 人，资料完整 ' + x.ready + ' 人；缺邮箱 ' + c.missingEmail + '，缺手机号 ' + c.missingPhone + '，邮箱重复 ' + c.duplicateEmail + '，手机号重复 ' + c.duplicatePhone + '，未绑定 IM ' + c.noIm + '，未分配部门 ' + c.unassigned + '。';
      const body = header(dirTable, ['姓名', '邮箱', '手机号', '已绑定 IM', 'Casdoor 群组', '部门', '问题', '手动分配']);
      x.users.forEach(u => {
        const tr = el('tr');
        const dept = u.departmentName ? u.departmentName + (u.source === 'manual' ? '（手动）' : '') : '未分配';
        [u.displayName, u.email || '—', u.phone || '—', u.im.join('、') || '—', u.groups.join('、') || '—', dept].forEach(v => tr.append(el('td', v)));
        tr.append(el('td', u.issues.join('、') || '✓', { className: u.issues.length ? 'bad' : 'ok' }));
        const td = el('td');
        if (u.email) {
          const select = el('select');
          select.append(el('option', '按群组自动', { value: '' }));
          departments.forEach(d => select.append(el('option', d.name, { value: d.code })));
          select.value = u.source === 'manual' ? u.department : '';
          select.onchange = async () => {
            try { renderDepartments(await api('/api/admin/assignments', { method: 'POST', body: JSON.stringify({ email: u.email, code: select.value || null }) })); say('已更新 ' + u.email + ' 的部门'); } catch (e) { say(e.message, true); }
          };
          td.append(select);
        } else td.textContent = '先补邮箱';
        tr.append(td); body.append(tr);
      });
    } catch (e) { dirSummary.textContent = e.message; dirSummary.className = 'bad'; }
    finally { dirButton.disabled = false; }
  };

  async function refreshDepartments() { try { renderDepartments(await api('/api/admin/departments')); } catch (e) { say(e.message, true); } }

  // ---- 登录方式（飞书 / 企业微信 / 钉钉三选一）
  const imCard = el('section', null, { className: 'card' });
  const imSelect = el('select');
  const imSave = el('button', '保存登录方式', { type: 'button' });
  const imState = el('p', '', { className: 'muted' });
  const imSync = el('table');
  const imRisk = el('p', '', { className: 'muted' });
  const imNotes = el('ul');
  const imSteps = el('ol');
  imCard.append(
    el('h2', '登录方式'),
    el('p', '员工只能用这里选定的一种 IM 登录 Jchat、Jimage 和 Jadmin。保存后会同步修改 Casdoor 中各应用的登录提供商（需配置 Casdoor 全局管理员凭据），否则显示需要手动调整的步骤。', { className: 'muted' }),
    imSelect, imSave, imState, imRisk, imNotes, el('h3', 'Casdoor 同步状态'), imSync, imSteps,
  );
  card.after(imCard);
  const syncLabels = { ok: '一致', mismatch: '不一致', error: '读取失败', unknown: '未知（未配置管理凭据）' };

  function renderRisk(risk, current) {
    if (!risk) { imRisk.textContent = ''; return; }
    if (!risk.checked) { imRisk.textContent = '无法核对员工的企业微信绑定情况：' + risk.error; imRisk.className = 'bad'; return; }
    const names = risk.examples && risk.examples.length ? '（' + risk.examples.join('、') + (risk.unbound > risk.examples.length ? ' 等' : '') + '）' : '';
    imRisk.textContent = risk.unbound
      ? (current === 'wecom' ? '' : '切到企业微信前注意：') + '共 ' + risk.total + ' 人，其中 ' + risk.unbound + ' 人尚未绑定企业微信' + names + '，使用企业微信登录时他们会失败。'
      : '全部 ' + risk.total + ' 名员工都已绑定企业微信。';
    imRisk.className = risk.unbound ? 'bad' : 'muted';
  }
  function renderSync(apps) {
    const body = header(imSync, ['应用', '状态', 'Casdoor 中的 IM 提供商', '说明']);
    (apps || []).forEach(a => {
      const tr = el('tr');
      const status = a.status || (a.ok ? 'ok' : 'error');
      tr.append(el('td', a.app), el('td', syncLabels[status] || status, { className: status === 'ok' ? 'ok' : (status === 'unknown' ? 'muted' : 'bad') }),
        el('td', (a.providers || []).join('、') || '—'), el('td', a.error || (a.enableSignUp === false ? '未开启注册' : '')));
      body.append(tr);
    });
  }
  function renderList(list, items) { list.replaceChildren(...(items || []).map(t => el('li', t))); }
  function renderLoginIm(x) {
    imSelect.replaceChildren(...x.options.map(o => el('option', o.label + '（' + o.provider + '）', { value: o.type })));
    imSelect.value = x.im;
    imState.textContent = '当前：' + x.label + '（' + x.provider + '）；Casdoor 同步：' + (syncLabels[x.sync.status] || x.sync.status);
    imState.className = x.sync.status === 'ok' ? 'ok' : 'muted';
    renderSync(x.sync.apps); renderRisk(x.wecomRisk, x.im); renderList(imNotes, x.notes); renderList(imSteps, []);
  }
  async function refreshLoginIm() {
    try { renderLoginIm(await api('/api/admin/login-im')); } catch (e) { imState.textContent = e.message; imState.className = 'bad'; }
  }
  async function saveLoginIm(confirmed) {
    imSave.disabled = true;
    try {
      const response = await fetch('/api/admin/login-im', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ im: imSelect.value, confirm: confirmed }) });
      const x = await response.json();
      if (response.status === 409 && x.needConfirm) {
        renderRisk(x.wecomRisk, '');
        if (confirm(x.error + '\n\n仍然切换到企业微信？')) return saveLoginIm(true);
        imState.textContent = '未保存'; imState.className = 'muted'; return;
      }
      if (!x.saved) throw Error(x.error || '保存失败');
      imState.textContent = x.error || ('已保存为' + x.label + (x.sync.configured ? '，并已同步到 Casdoor' : '；未配置 Casdoor 管理凭据，请按下面的步骤手动调整'));
      imState.className = x.error ? 'bad' : 'ok';
      renderSync(x.sync.apps); renderList(imSteps, x.sync.steps);
    } catch (e) { imState.textContent = e.message; imState.className = 'bad'; }
    finally { imSave.disabled = false; }
  }
  imSave.onclick = () => saveLoginIm(false);

  // ---- 企业账号关联（管理员）
  const linkCard = el('section', null, { className: 'card' });
  const linkState = el('p', '', { className: 'muted' });
  const linkButton = el('button', '关联企业账号', { type: 'button' });
  const unlinkButton = el('button', '解除我的关联', { type: 'button', className: 'danger' });
  const linkTable = el('table');
  linkCard.append(
    el('h2', '企业账号关联'),
    el('p', '管理员需先用邮箱和密码登录，再点击「关联企业账号」并在 Casdoor 完成一次登录，之后才能用企业账号进入后台。关联链接 10 分钟内有效，只能使用一次。', { className: 'muted' }),
    linkState, linkButton, unlinkButton, linkTable,
  );
  imCard.after(linkCard);
  function renderLinks(x) {
    linkCard.hidden = !x.enabled && !(x.bindings || []).length;
    linkState.textContent = x.self ? '已关联 Casdoor 用户 ' + x.self.subject + '（' + new Date(x.self.created * 1000).toLocaleString() + '）' : '尚未关联企业账号';
    linkButton.textContent = x.self ? '重新关联企业账号' : '关联企业账号';
    linkButton.disabled = !x.enabled; unlinkButton.hidden = !x.self;
    const body = header(linkTable, ['管理员邮箱', 'Casdoor 用户 ID', '关联时间', '操作']);
    (x.bindings || []).forEach(b => {
      const tr = el('tr'); const ops = el('td');
      if (x.owner) ops.append(el('button', '解除', { type: 'button', className: 'danger', onclick: () => unlinkEmail(b.email) }));
      tr.append(el('td', b.email), el('td', b.subject), el('td', new Date(b.created * 1000).toLocaleString()), ops); body.append(tr);
    });
  }
  async function refreshLinks() { try { renderLinks(await api('/api/admin/sso/links')); } catch (e) { linkState.textContent = e.message; linkState.className = 'bad'; } }
  async function unlinkEmail(email) {
    if (!confirm('解除 ' + (email || '我') + ' 的企业账号关联？解除后不能再用企业账号登录，需重新关联。')) return;
    try { await api('/api/admin/sso/unlink', { method: 'POST', body: JSON.stringify(email ? { email } : {}) }); await refreshLinks(); } catch (e) { linkState.textContent = e.message; linkState.className = 'bad'; }
  }
  linkButton.onclick = async () => {
    try { const x = await api('/api/admin/sso/link', { method: 'POST', body: '{}' }); location.href = x.url; } catch (e) { linkState.textContent = e.message; linkState.className = 'bad'; }
  };
  unlinkButton.onclick = () => unlinkEmail('');

  const enterpriseLoad = load;
  load = async function () { await Promise.allSettled([enterpriseLoad(), refreshDepartments(), refreshLoginIm(), refreshLinks()]); };

  // SSO 回跳：带着令牌直接进入后台
  if (hash.get('sso-token')) {
    token = hash.get('sso-token'); $('loginbox').hidden = true; $('app').hidden = false;
    const notice = hash.get('sso-notice');
    load().then(() => { if (notice) { linkState.textContent = notice + '。' + linkState.textContent; linkState.className = 'ok'; linkCard.scrollIntoView(); } });
  }
})();
