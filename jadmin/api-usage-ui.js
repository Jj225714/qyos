// Jadmin employee-directory API usage lookup. Never write employee data to the browser cache.
(function () {
  const el = (tag, text, attrs) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    return Object.assign(node, attrs || {});
  };
  const card = el('section', null, { className: 'card' });
  const employee = el('select', null, { required: true });
  const employeeLabel = el('label', '员工 ', { className: 'field' });
  employeeLabel.append(employee);
  const days = el('select');
  days.append(el('option', '最近 7 天', { value: '7' }), el('option', '最近 30 天', { value: '30' }));
  const daysLabel = el('label', '时间范围 ', { className: 'field' });
  daysLabel.append(days);
  const form = el('form');
  const query = el('button', '查询用量', { type: 'submit', disabled: true });
  const refresh = el('button', '读取员工目录', { type: 'button', className: 'button-secondary' });
  const info = el('p', '', { role: 'status', ariaLive: 'polite' });
  const values = el('dl');
  form.append(employeeLabel, daysLabel, query);
  card.append(el('h2', '员工 API 用量'), el('p', '只统计员工使用个人 Key 通过企业 API 网关的直接调用。', { className: 'muted' }), refresh, form, info, values);
  JadminShell.mount('people', card);
  let revision = 0;
  function clearFeedback() {
    revision++;
    values.replaceChildren();
    info.textContent = '';
    query.disabled = !employee.value;
  }
  function resetEmployees() {
    employee.replaceChildren(el('option', '选择员工', { value: '' }));
    clearFeedback();
  }
  resetEmployees();
  employee.onchange = days.onchange = clearFeedback;
  refresh.onclick = async () => {
    resetEmployees();
    const ticket = revision;
    refresh.disabled = true;
    info.textContent = '正在读取员工目录…';
    try {
      const dir = await JadminState.read('directory', () => api('/api/admin/directory'), { force: true });
      if (ticket !== revision) return;
      const users = dir.users.filter(user => typeof user.id === 'string' && user.id);
      const count = new Map();
      users.forEach(user => count.set(user.id, (count.get(user.id) || 0) + 1));
      const unique = users.filter(user => count.get(user.id) === 1);
      for (const user of unique) {
        const name = user.displayName || user.name || '未命名员工';
        employee.append(el('option', name + (user.email ? `（${user.email}）` : `（${user.id}）`), { value: user.id }));
      }
      info.textContent = unique.length ? '请选择员工与查询时间范围。' : '目录中没有可以查询的员工。';
    } catch (error) {
      if (ticket === revision && error?.code !== 'superseded_read') info.textContent = '员工目录暂时无法读取。';
    } finally {
      refresh.disabled = false;
    }
  };
  const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' });
  form.onsubmit = async event => {
    event.preventDefault();
    if (query.disabled || !employee.value) return;
    clearFeedback();
    const ticket = revision;
    query.disabled = true;
    info.textContent = '正在查询用量…';
    try {
      const data = await api('/api/admin/api-usage', { method: 'POST', body: JSON.stringify({ employeeId: employee.value, days: Number(days.value) }) });
      if (ticket !== revision) return;
      if (data.status !== 'ok') {
        info.textContent = data.status === 'unlinked' ? '该员工的企业账号尚未关联 API 网关。' : '当前尚未配置可归属到员工的直接调用统计。';
        return;
      }
      info.textContent = `${data.requests === 0 ? '该员工在统计范围内没有直接调用。' : '已取得员工用量。'} 北京时间 ${date.format(new Date(data.since))} 至 ${date.format(new Date(data.as_of))}。`;
      for (const [key, text] of [['requests', '请求次数'], ['input_tokens', '输入 Token'], ['output_tokens', '输出 Token'], ['cache_read_tokens', '缓存读取 Token'], ['cache_creation_tokens', '缓存写入 Token']]) {
        values.append(el('dt', text), el('dd', data[key].toLocaleString('zh-CN')));
      }
    } catch (error) {
      if (ticket !== revision || error?.code === 'superseded_read') return;
      info.textContent = error?.status === 404 ? '目录中已找不到该员工，请重新读取目录。' : '暂时无法查询员工 API 用量。';
    } finally {
      if (ticket === revision) query.disabled = !employee.value;
    }
  };
  let generation = JadminState.generation();
  JadminState.subscribe(() => {
    if (generation === JadminState.generation()) return;
    generation = JadminState.generation();
    resetEmployees(); days.value = '7'; refresh.disabled = false;
  });
}());
