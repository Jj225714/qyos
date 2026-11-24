(() => {
  const modules = [['chat', 'Chat'], ['image', 'Image'], ['my_api_usage', 'My API Usage']];
  const root = document.createElement('section'); root.id = 'employee-module-grants';
  function el(tag, text) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; }
  function button(text, action) { const n = el('button', text); n.type = 'button'; n.onclick = action; return n; }
  const title = el('h2', '员工功能授权'), mode = el('p', '观察中 · 不影响现有访问');
  const notice = el('p'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const body = el('div'); body.className = 'table-wrap'; body.setAttribute('style', 'overflow-x:auto');
  const refresh = button('刷新授权', () => load({ force: true }).catch(() => {}));
  const backfill = el('details'), summary = el('summary', '现有权限回填');
  const fileLabel = el('label', '权限快照 '), file = el('input'); file.type = 'file'; file.accept = '.json,application/json';
  const diff = el('div'), previewButton = button('查看差异', preview), applyButton = button('应用回填', apply);
  applyButton.disabled = true; fileLabel.append(file); backfill.hidden = true;
  backfill.append(summary, fileLabel, previewButton, diff, applyButton);
  const style = el('style', '#employee-module-grants{margin-top:24px;border-top:1px solid #d9e0ea;padding-top:20px}#employee-module-grants table{width:100%;min-width:560px}#employee-module-grants td,#employee-module-grants th{padding:10px;text-align:left;overflow-wrap:anywhere}#employee-module-grants input[type=checkbox]{width:18px;height:18px}#employee-module-grants input[type=file]{max-width:100%}#employee-module-grants details{margin-top:16px}#employee-module-grants .grant-person{max-width:240px}');
  root.append(style, title, mode, refresh, notice, body, backfill); JadminShell.mount('people', root);
  let generation = JadminState.generation(), sequence = 0, busy = false, approved = null;
  const current = ticket => ticket === sequence && generation === JadminState.generation();
  function message(value, bad = false) { notice.textContent = value; notice.className = bad ? 'bad' : 'muted'; }
  function errorMessage(error) {
    const code = error.code || error.data?.error || error.message;
    return ({ revision_conflict: '授权已被其他管理员更新，请刷新后重试。', employee_not_found: '员工已不在当前目录，请刷新。',
      directory_unavailable: '员工目录暂时不可用。', grants_unavailable: '授权记录暂时不可用，现有访问不受影响。',
      invalid_snapshot: '权限快照格式不正确。', snapshot_conflict: '快照编号与已应用内容不一致。',
      owner_required: '仅所有者可回填权限。' })[code] || '操作未完成，请刷新核对后重试。';
  }
  function render(data) {
    if (data.mode !== 'shadow' || data.schema !== 'qyos.module-grants.v1' || !Array.isArray(data.employees)) throw Error('invalid_response');
    const table = el('table'), head = el('thead'), header = el('tr'), rows = el('tbody');
    for (const name of ['员工', 'Chat', 'Image', 'My API Usage', '状态', '操作']) header.append(el('th', name));
    head.append(header);
    for (const employee of data.employees) {
      const row = el('tr'), who = el('td'), name = el('div', employee.displayName), id = el('small', employee.employeeId);
      who.className = 'grant-person'; who.append(name, id); row.append(who);
      const inputs = {};
      const save = button('保存', async () => {
        if (busy || save.disabled) return;
        const ticket = sequence, session = generation; busy = true; refresh.disabled = true; save.disabled = true;
        root.querySelectorAll('input,button').forEach(n => { n.disabled = true; });
        try {
          await api('/api/admin/module-grants', { method: 'POST', body: JSON.stringify({ employeeId: employee.employeeId,
            expectedRevision: employee.revision, grants: Object.fromEntries(modules.map(([key]) => [key, inputs[key].checked])) }) });
          if (!current(ticket)) return;
          JadminState.invalidate('module-grants'); await load({ force: true }); if (session === generation) message('已保存，仍处于观察阶段。');
        } catch (error) {
          if (current(ticket) && error.code !== 'superseded_read') { body.replaceChildren(); message(errorMessage(error), true); }
        } finally {
          if (session === generation) { busy = false; refresh.disabled = false; file.disabled = false; previewButton.disabled = false; }
        }
      });
      save.disabled = true;
      for (const [key, label] of modules) {
        const td = el('td'), input = el('input'); input.type = 'checkbox'; input.checked = employee.grants?.[key] === true;
        input.indeterminate = employee.status === 'unknown'; input.setAttribute('aria-label', employee.displayName + ' ' + label);
        input.onchange = () => { input.indeterminate = false; save.disabled = Object.values(inputs).some(n => n.indeterminate); };
        inputs[key] = input; td.append(input); row.append(td);
      }
      row.append(el('td', employee.status === 'unknown' ? '未回填' : employee.inactive ? '账号停用' : '已设置'));
      const action = el('td'); action.append(save); row.append(action); rows.append(row);
    }
    table.append(head, rows); body.replaceChildren(data.employees.length ? table : el('p', '暂无员工记录'));
    backfill.hidden = !data.canBackfill;
  }
  async function load({ force = false } = {}) {
    const ticket = ++sequence; approved = null; applyButton.disabled = true; diff.replaceChildren(); message('正在读取授权…');
    try {
      const data = await JadminState.read('module-grants', () => api('/api/admin/module-grants'), { force });
      if (!current(ticket)) return;
      render(data); message('已读取 ' + data.employees.length + ' 位员工。');
    } catch (error) { if (current(ticket) && error.code !== 'superseded_read') { body.replaceChildren(); backfill.hidden = true; message(errorMessage(error), true); } throw error; }
  }
  file.onchange = () => { approved = null; applyButton.disabled = true; diff.replaceChildren(); };
  async function preview() {
    if (busy || !file.files?.[0]) return;
    if (file.files[0].size > 256 * 1024) { message('权限快照过大。', true); return; }
    const ticket = sequence, session = generation, selected = file.files[0]; busy = true; approved = null; applyButton.disabled = true; previewButton.disabled = true; file.disabled = true; refresh.disabled = true;
    try {
      const data = JSON.parse(await selected.text());
      const result = await api('/api/admin/module-grants/backfill/preview', { method: 'POST', body: JSON.stringify(data) });
      if (!current(ticket)) return;
      diff.replaceChildren(el('p', result.alreadyApplied ? '该快照已应用。' : '待回填 ' + result.changes.length + ' 位；保留已设置 ' + result.preserved.length + ' 位。'));
      const list = el('ul'); for (const item of result.changes) list.append(el('li', item.employeeId + '：' + modules.map(([key, label]) => label + (item.after[key] ? ' 允许' : ' 不允许')).join('；')));
      diff.append(list); approved = data; applyButton.disabled = result.alreadyApplied || !result.changes.length;
    } catch (error) { if (current(ticket) && error.code !== 'superseded_read') message(errorMessage(error), true); }
    finally { if (session === generation) { busy = false; previewButton.disabled = false; file.disabled = false; refresh.disabled = false; } }
  }
  async function apply() {
    if (busy || !approved || applyButton.disabled) return;
    const ticket = sequence, session = generation, snapshot = approved; busy = true; applyButton.disabled = true; file.disabled = true; previewButton.disabled = true; refresh.disabled = true;
    try {
      await api('/api/admin/module-grants/backfill', { method: 'POST', body: JSON.stringify(snapshot) });
      if (!current(ticket)) return;
      JadminState.invalidate('module-grants'); await load({ force: true }); if (session === generation) message('回填已保存，仍处于观察阶段。');
    } catch (error) { if (current(ticket) && error.code !== 'superseded_read') { approved = null; message(errorMessage(error), true); } }
    finally { if (session === generation) { busy = false; file.disabled = false; previewButton.disabled = false; refresh.disabled = false; } }
  }
  JadminState.subscribe(() => {
    if (generation === JadminState.generation()) return;
    generation = JadminState.generation(); sequence++; busy = false; approved = null;
    body.replaceChildren(); diff.replaceChildren(); backfill.hidden = true; file.value = ''; file.disabled = false;
    refresh.disabled = false; previewButton.disabled = false; applyButton.disabled = true; message('');
  });
  JadminShell.register('people', load);
  window.JadminGrants = { load, root };
})();
