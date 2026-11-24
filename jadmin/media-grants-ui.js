(() => {
  const { el } = JadminDOM;
  const root = el('section'); root.id = 'media-video-grants';
  const notice = el('p'); notice.setAttribute('role', 'status');
  const body = el('div'); body.className = 'table-wrap';
  const refresh = el('button', '刷新视频授权'); refresh.type = 'button';
  root.append(el('h2', '企业视频授权'), notice, refresh, body); JadminShell.mount('people', root);
  let ticket = 0, generation = JadminState.generation();
  async function load() {
    const request = ++ticket, session = generation; body.replaceChildren(); notice.textContent = '正在读取…';
    try {
      const response = await api('/api/admin/capability-grants');
      if (request !== ticket || session !== generation) return;
      if (response.schema !== 'qyos.capability-grants.v1' || !Array.isArray(response.employees)) throw Error('invalid_response');
      const table = el('table'), head = el('tr'); for (const label of ['员工', '允许生成', '额度方案', '操作']) head.append(el('th', label)); table.append(head);
      for (const employee of response.employees) {
        const row = el('tr'), identity = el('td', employee.displayName + ' · ' + employee.employeeId);
        const allowedCell = el('td'), allowed = el('input'); allowed.type = 'checkbox'; allowed.checked = employee.video_generate; allowed.disabled = !response.canEdit || employee.inactive; allowed.setAttribute('aria-label', employee.displayName + ' 允许视频生成'); allowedCell.append(allowed);
        const quotaCell = el('td'), quota = el('input'); quota.value = employee.quotaProfile || ''; quota.maxLength = 128; quota.disabled = !response.canEdit; quota.setAttribute('aria-label', employee.displayName + ' 额度方案'); quotaCell.append(quota);
        const action = el('td'), save = el('button', '保存'); save.type = 'button'; save.disabled = !response.canEdit;
        save.onclick = async () => {
          if (save.disabled) return;
          const expectedSession = generation; save.disabled = true; refresh.disabled = true;
          try {
            await api('/api/admin/capability-grants', { method: 'POST', body: JSON.stringify({ employeeId: employee.employeeId, expectedRevision: employee.revision, video_generate: allowed.checked, quotaProfile: quota.value.trim() || null }) });
            if (expectedSession !== generation) return;
            await load(); notice.textContent = '授权已保存；媒体服务仍需单独验收和激活。';
          } catch (error) { if (expectedSession === generation) { await load(); notice.textContent = error.status === 409 ? '授权已更新，请核对后重试。' : '保存失败，请检查额度方案。'; } }
          finally { if (expectedSession === generation) refresh.disabled = false; }
        };
        action.append(save); row.append(identity, allowedCell, quotaCell, action); table.append(row);
      }
      body.append(table); notice.textContent = response.employees.length ? '' : '暂无员工记录。';
    } catch (_) { if (request === ticket && session === generation) notice.textContent = '视频授权暂不可用，未新增任何授权。'; }
  }
  refresh.onclick = load;
  JadminState.subscribe(() => { if (generation === JadminState.generation()) return; generation = JadminState.generation(); ticket++; body.replaceChildren(); notice.textContent = ''; refresh.disabled = false; });
  JadminShell.register('people', load); window.JadminMediaGrants = { root, load };
})();
