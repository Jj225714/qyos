(() => {
  const { el } = JadminDOM;
  const root = el('section'); root.id = 'media-capabilities';
  const title = el('h2', '媒体能力');
  const notice = el('p'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const target = el('select'); target.setAttribute('aria-label', '媒体功能');
  const targets = { text_edit: '原图文字编辑', 'video.t2v': '文生视频', 'video.i2v.first_frame': '首帧图生视频' };
  for (const [value, label] of Object.entries(targets)) { const option = el('option', label); option.value = value; target.append(option); }
  const form = el('form'), connection = el('div'), bindings = el('div'), state = el('div'), actions = el('div');
  connection.className = 'media-grid'; bindings.className = 'media-bindings'; actions.className = 'media-actions';
  let response, selected, ticket = 0, busy = false, generation = JadminState.generation();
  const connections = [], rows = [], connectionSelectors = [];
  function button(label, action) { const b = el('button', label); b.type = 'button'; b.onclick = action; return b; }
  const refresh = button('刷新', () => load());
  const save = button('保存草稿', () => mutate('config', { config: collect() }));
  const prepare = button('准备发布', () => mutate('prepare'));
  const activate = button('激活', () => mutate('activate'));
  const revoke = button('撤销发布', () => mutate('revoke'));
  const addConnection = button('增加服务连接', () => {
    if (busy || !response || !response.canEdit) return;
    const draft = collect(); draft.connections.push({}); selected.draft = draft; render();
  });
  actions.append(save, prepare, activate, revoke); form.append(connection, addConnection, bindings, actions);
  form.onsubmit = event => event.preventDefault();
  const style = el('style', '#media-capabilities{border-top:1px solid #d9e0ea;padding-top:20px;margin-top:24px}#media-capabilities .media-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}#media-capabilities label{display:flex;flex-direction:column;gap:5px;min-width:0}#media-capabilities input,#media-capabilities select{width:100%;min-width:0;box-sizing:border-box}#media-capabilities input[type=checkbox]{width:18px;height:18px}#media-capabilities fieldset{border:0;border-top:1px solid #e0e5eb;margin:18px 0 0;padding:14px 0}#media-capabilities .media-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}#media-capabilities .media-state{overflow-wrap:anywhere}');
  root.append(style, title, target, refresh, notice, state, form); JadminShell.mount('models', root);
  function field(parent, label, value = '', choices) {
    const wrapper = el('label', label), input = el(choices ? 'select' : 'input');
    if (choices) for (const item of choices) { const option = el('option', String(item)); option.value = String(item); input.append(option); }
    input.value = String(value ?? ''); wrapper.append(input); parent.append(wrapper); return input;
  }
  function parameters(parent, model, policy) {
    const box = el('fieldset'); box.append(el('legend', model + ' 参数'));
    const allowed = {}, defaults = {}, fixed = policy?.fixed || {};
    for (const [name, values] of Object.entries(policy?.allowed || {})) {
      const select = field(box, name, policy.defaults?.[name], values);
      allowed[name] = values; defaults[name] = () => values[select.selectedIndex];
    }
    parent.append(box);
    return () => ({ allowed, defaults: Object.fromEntries(Object.entries(defaults).map(([name, read]) => [name, read()])), fixed });
  }
  function render() {
    selected = response.targets[target.value]; rows.length = 0; connections.length = 0; connectionSelectors.length = 0;
    connection.replaceChildren(); bindings.replaceChildren(); state.replaceChildren();
    const preview = response.configurationPreview === true;
    const draft = selected?.draft || { connections: [], bindings: [] };
    if (preview) state.append(el('p', '线上配置试用：可以选择模型、保存草稿。服务未接通，不能测试生成或启用员工功能。请填写凭据编号，不要填写 API Key。'));
    const publication = selected?.publication || selected?.active;
    state.className = 'media-state';
    state.append(el('p', '草稿修订 ' + (selected?.revision || 0) + ' · ' + (selected?.available ? '已激活' : '未就绪')));
    if (publication) state.append(el('p', '发布状态：' + ({ preparing: '等待服务准备', prepared: '已准备', activating: '等待激活确认', active: '已激活', rejected: '已拒绝', disabled: '已停用', revoked: '已撤销' }[publication.state] || '未就绪')));
    const sampleConnection = preview ? { connectionId: 'dashscope', providerFamily: 'dashscope', origin: response.registry.trustedOrigins[0] || '', region: 'cn-beijing', workspace: 'default', credentialRef: 'cred:dashscope-draft' } : {};
    for (const first of draft.connections.length ? draft.connections : [sampleConnection]) {
      const controls = {}, group = el('fieldset'); group.append(el('legend', '服务连接'));
      for (const [key, label] of [['connectionId', '连接名称'], ['providerFamily', '服务商'], ['region', '地域'], ['workspace', '工作空间'], ['credentialRef', '凭据引用'], ['credentialGeneration', '凭据版本']]) {
        controls[key] = field(group, label, first[key] ?? (key === 'credentialGeneration' ? 1 : ''));
        if (key === 'credentialGeneration') { controls[key].type = 'number'; controls[key].min = '1'; controls[key].step = '1'; }
      }
      controls.origin = field(group, '受信任服务地址', first.origin || '', response.registry.trustedOrigins);
      controls.connectionId.onchange = () => updateConnections();
      connections.push(controls); connection.append(group);
    }
    const ops = target.value === 'text_edit' ? ['image.text_edit.ocr', 'image.text_edit.erase'] : [target.value];
    for (const operation of ops) {
      const old = draft.bindings.find(item => item.operation === operation) || {};
      const box = el('fieldset'); box.append(el('legend', operation === 'image.text_edit.ocr' ? '文字识别' : operation === 'image.text_edit.erase' ? '擦除旧字' : targets[operation]));
      const grid = el('div'); grid.className = 'media-grid'; box.append(grid);
      const connectionId = field(grid, '服务连接', old.connectionId || connections[0]?.connectionId.value || '', connections.map(controls => controls.connectionId.value));
      connectionSelectors.push(connectionId);
      const registry = response.registry.adapters;
      const compatible = Object.keys(registry).filter(key => registry[key].operations.includes(operation));
      const clientChoices = preview ? compatible.filter(key => key.startsWith('qyos.web.')) : compatible;
      const serverChoices = preview ? compatible.filter(key => !key.startsWith('qyos.web.')) : compatible;
      const version = (descriptor, choices) => descriptor ? descriptor.id + '@' + descriptor.version : choices[0] || '';
      const client = field(grid, '客户端协议', version(old.clientAdapter, clientChoices), clientChoices);
      const server = field(grid, '服务端协议', version(old.serverAdapter, serverChoices), serverChoices);
      const models = field(grid, '批准模型', '', []); models.multiple = true; models.size = 3;
      const defaultModel = field(grid, '默认模型', '', []);
      const enableLabel = el('label', '准备启用'), enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = !preview && old.enabled === true; enableLabel.append(enabled); if (!preview) grid.append(enableLabel);
      const policyBox = el('div'); box.append(policyBox); let readers = {};
      function modelState(initial = false) {
        if (initial) {
          models.replaceChildren();
          const candidates = registry[server.value]?.models || [];
          const available = preview ? candidates.filter(model => (registry[client.value]?.models || []).includes(model)) : candidates;
          for (const model of available) { const option = el('option', model); option.value = model; option.selected = (old.allowedModels || (preview ? available : [])).includes(model); models.append(option); }
        }
        const names = Array.from(models.selectedOptions).map(option => option.value);
        const previous = defaultModel.value || old.defaultModel; defaultModel.replaceChildren();
        for (const model of names) { const option = el('option', model); option.value = model; defaultModel.append(option); }
        defaultModel.value = names.includes(previous) ? previous : names[0] || '';
        policyBox.replaceChildren(); readers = {};
        for (const model of names) {
          const values = registry[server.value]?.parameters || {};
          const allowed = values[model] || values;
          const policy = old.parameters?.[model] || { allowed, defaults: Object.fromEntries(Object.entries(allowed).map(([name, options]) => [name, options[0]])), fixed: {} };
          readers[model] = parameters(policyBox, model, policy);
        }
      }
      server.onchange = client.onchange = () => modelState(true); models.onchange = () => modelState(); modelState(true);
      rows.push(() => {
        const descriptor = value => { const index = value.lastIndexOf('@'); return { id: value.slice(0, index), version: value.slice(index + 1) }; };
        return { operation, connectionId: connectionId.value, clientAdapter: descriptor(client.value), serverAdapter: descriptor(server.value), allowedModels: Array.from(models.selectedOptions).map(option => option.value), defaultModel: defaultModel.value, enabled: enabled.checked, parameters: Object.fromEntries(Object.entries(readers).map(([model, read]) => [model, read()])) };
      });
      bindings.append(box);
    }
    if (!response.registry.trustedOrigins.length || !Object.keys(response.registry.adapters).length) notice.textContent = '媒体服务尚未安装，暂不可发布。';
    save.disabled = !response.canEdit || !response.registry.trustedOrigins.length || !Object.keys(response.registry.adapters).length;
    prepare.hidden = preview; activate.hidden = preview; revoke.hidden = preview;
    prepare.disabled = preview || !response.canEdit || !selected?.draft;
    activate.disabled = !response.canEdit || !response.activationEnabled;
    revoke.disabled = !response.canEdit || !publication?.publicationId;
    addConnection.disabled = !response.canEdit || connections.length >= 16;
    for (const input of form.querySelectorAll('input,select')) input.disabled = !response.canEdit;
  }
  function collect() {
    const items = connections.map(controls => Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, key === 'credentialGeneration' ? Number(input.value) : input.value.trim()])));
    return { connections: items, bindings: rows.map(read => read()) };
  }
  function updateConnections() {
    for (const select of connectionSelectors) {
      const previous = select.value; select.replaceChildren();
      for (const controls of connections) { const option = el('option', controls.connectionId.value); option.value = controls.connectionId.value; select.append(option); }
      select.value = connections.some(controls => controls.connectionId.value === previous) ? previous : connections[0].connectionId.value;
    }
  }
  async function load() {
    const request = ++ticket, session = JadminState.generation(); response = undefined; form.hidden = true; notice.textContent = '正在读取媒体配置…';
    try {
      const result = await api('/api/admin/media/config');
      if (request !== ticket || session !== JadminState.generation()) return;
      if (result.schema !== 'qyos.media-control.v1') throw Error('invalid_response');
      response = result; notice.textContent = ''; render();
    } catch (_) { if (request === ticket && session === JadminState.generation()) { form.hidden = true; state.replaceChildren(); notice.textContent = '媒体配置暂不可用。'; } }
    finally { if (request === ticket && response) form.hidden = false; }
  }
  async function mutate(action, extra = {}) {
    if (busy || !response) return;
    const session = JadminState.generation(), publication = selected?.publication || selected?.active;
    busy = true; target.disabled = true; refresh.disabled = true; addConnection.disabled = true; for (const b of actions.querySelectorAll('button')) b.disabled = true;
    const data = { expectedRevision: selected.revision, ...extra,
      ...(['activate', 'revoke'].includes(action) ? { publicationId: publication?.publicationId } : { target: target.value }) };
    try {
      await api('/api/admin/media/' + action, { method: 'POST', body: JSON.stringify(data) });
      if (session !== JadminState.generation()) return;
      await load(); notice.textContent = action === 'config' ? '草稿已保存。' : action === 'prepare' ? '发布准备已记录，等待服务确认。' : '操作已记录。';
    } catch (error) { if (session === JadminState.generation()) { await load(); notice.textContent = error.status === 409 ? '配置已更新，请核对后重试。' : '操作未完成，当前版本未自动替换。'; } }
    finally { if (session === JadminState.generation()) { busy = false; target.disabled = false; refresh.disabled = false; if (response) render(); } }
  }
  target.onchange = () => { if (response && !busy) render(); };
  JadminState.subscribe(() => { if (generation === JadminState.generation()) return; generation = JadminState.generation(); ticket++; busy = false; response = undefined; selected = undefined; target.disabled = false; refresh.disabled = false; connection.replaceChildren(); bindings.replaceChildren(); state.replaceChildren(); notice.textContent = ''; form.hidden = true; });
  JadminShell.register('models', load);
  window.JadminMedia = { load, root };
})();
