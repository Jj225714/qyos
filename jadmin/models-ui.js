// General endpoint settings and the Jchat configuration share a revision.
var JadminModelConfig = (function () {
  const { el, table } = JadminDOM;
  let busy = false, endpointBusy = false, sessionGeneration = JadminState.generation();
  let loadedRevision = null, loadedEndpoint = null, loadedBaseURL = '', endpointAvailable = false, activeRefresh = null;
  let firstSetup = false, apply = null, operationBusy = false, configuredModel = '', fallbackModel = '';
  let models = [], catalogError = false, pollTimer = null, applyEpoch = 0;
  let draftCatalog = null, readingDraft = false, draftEpoch = 0;
  const listeners = new Set();
  const reuse = $('reuseKeyForNewOrigin') || el('input', null, { id: 'reuseKeyForNewOrigin', type: 'checkbox' });
  const reuseLabel = reuse.parentElement && reuse.parentElement.tagName.toLowerCase() === 'label' ? reuse.parentElement : el('label');
  const reuseText = el('span');
  reuseLabel.id = 'reuse-key-label'; reuseLabel.className = 'model-checkbox'; reuseLabel.replaceChildren(reuse, reuseText);
  if (!reuseLabel.parentElement) $('apiKey').after(reuseLabel);
  let reuseOrigin = '', providerAvailable = false, providerBusy = false;
  const providerSection = el('section', null, { id: 'provider-name-controls' });
  const providerInput = el('input', null, { id: 'provider-name', type: 'text', maxLength: 40, autocomplete: 'off' });
  const providerLabel = el('label', '服务商名称', { className: 'field', htmlFor: providerInput.id }); providerLabel.append(providerInput);
  const providerSave = el('button', '保存名称', { id: 'save-provider-name', type: 'button' });
  const providerNotice = el('p', '', { id: 'provider-name-notice', role: 'status', ariaLive: 'polite' });
  providerSection.append(providerLabel, providerSave, providerNotice); $('config').after(providerSection);
  const managed = el('details', null, { id: 'server-managed-settings' });
  managed.append(el('summary', '由服务器管理的设置'), el('p', '所有者登录与内部服务连接由部署管理员维护。'));
  $('modelConfigCard').append(managed);
  for (const old of $('modelConfigCard').querySelectorAll('.unsupported')) old.remove();
  const endpointNotice = $('endpoint-notice');
  const endpointCard = $('modelConfigCard');
  endpointCard.querySelector('h2').textContent = '1. 设置总接口';
  for (const old of [$('loadmodels').parentElement, $('model').parentElement, $('modelNotice'), ...[...endpointCard.children].filter(node => node.tagName === 'H3' || node.tagName === 'P' && node.classList.contains('muted'))]) old.remove();
  $('endpoint-controls').querySelector('h3').remove();
  $('endpoint-controls').querySelector('p.muted:last-of-type').textContent = '填写服务商提供的 API 地址（包括所需的 /v1 路径）。应用接口后，Jchat 和 Jimage 都使用该企业接口；地址或 Key 变更时，需在下方重新测试并应用 Jimage 默认模型。';
  $('save-endpoint').textContent = '测试并保存接口';
  const applyStatus = el('p', '', { id: 'apply-status', role: 'status', ariaLive: 'polite' });
  const endpointsWarning = el('p', '', { role: 'status', className: 'bad' });
  const applyButton = el('button', '应用已保存的配置', { id: 'apply-model-config', type: 'button' });
  const verifyButton = el('button', '重新核对', { id: 'verify-model-config', type: 'button' });
  const rollbackButton = el('button', '回退到上次已生效配置', { id: 'rollback-model-config', type: 'button' });
  const applySection = el('section');
  const applyActions = el('div', null, { className: 'actions' });
  applyActions.append(applyButton, verifyButton, rollbackButton);
  applySection.append(applyStatus, endpointsWarning, applyActions); endpointNotice.after(applySection);
  const validModel = id => /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(id);
  const applying = () => apply && ['queued', 'applying'].includes(apply.state);
  const endpointChanged = () => JadminShell.isOwner() && ($('baseURL').value.trim() !== loadedBaseURL || !!$('apiKey').value);
  const cleanModels = ids => [...new Set((Array.isArray(ids) ? ids : []).filter(x => typeof x === 'string' && validModel(x)))];
  const draftAddress = () => $('baseURL').value.trim();
  function clearDraftCatalog() { draftEpoch++; draftCatalog = null; readingDraft = false; }
  async function discoverDraft() {
    if (!firstSetup || !JadminShell.isOwner() || readingDraft || !draftAddress() || !$('apiKey').value) return;
    const epoch = ++draftEpoch, generation = JadminState.generation();
    draftCatalog = null; readingDraft = true; updateModelControls();
    try {
      const found = await api('/api/admin/model-config/discover', { method: 'POST', body: JSON.stringify({ baseURL: draftAddress(), apiKey: $('apiKey').value }) });
      if (epoch === draftEpoch && generation === JadminState.generation()) draftCatalog = cleanModels(found?.models);
    } finally {
      if (epoch === draftEpoch && generation === JadminState.generation()) { readingDraft = false; updateModelControls(); }
    }
  }
  const readyToApply = () => apply?.helperAvailable === true && (JadminShell.isOwner() || apply.canApply === true);
  function snapshot() {
    const busyNow = !!(busy || endpointBusy || operationBusy || applying());
    const confirmed = apply?.state === 'applied_healthy' && apply.appliedRevision === loadedRevision;
    return { revision: loadedRevision, chat: configuredModel, fallback: fallbackModel,
      models: firstSetup ? (draftCatalog || []) : endpointChanged() ? [] : models, catalogError, readingDraft,
      canDiscoverDraft: firstSetup && JadminShell.isOwner() && !busyNow && !!draftAddress() && !!$('apiKey').value,
      busy: busyNow, available: endpointAvailable, firstSetup, confirmed, endpointChanged: endpointChanged(),
      canWrite: endpointAvailable && !busyNow && readyToApply() && (firstSetup ? JadminShell.isOwner() : !endpointChanged()),
      applyState: apply?.state || 'unknown' };
  }
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; applyEpoch++; }
  function updateModelControls() {
    const locked = endpointBusy || operationBusy || applying() || busy;
    applyButton.disabled = !endpointAvailable || !!locked || !apply || apply.canApply !== true || apply.helperAvailable !== true || firstSetup;
    verifyButton.disabled = !endpointAvailable || !!locked || !apply || apply.helperAvailable !== true || firstSetup;
    rollbackButton.hidden = !JadminShell.isOwner();
    rollbackButton.disabled = !JadminShell.isOwner() || !endpointAvailable || !!locked || !apply || apply.canRollback !== true || apply.helperAvailable !== true;
    for (const notify of listeners) notify();
  }
  function renderApply() {
    const n = apply && apply.configRevision, m = apply && apply.lastGoodRevision;
    const messages = {
      none: '尚未配置模型接口。请填写 API 地址、Key 和默认模型后保存。',
      persisted_unapplied: '配置已保存，等待应用到 Jchat。',
      queued: '正在等待应用到 Jchat。',
      applying: '正在应用到 Jchat。服务更新期间，对话可能短暂中断。',
      applied_healthy: '已核对：Jchat 已加载保存的配置（版本 ' + n + '）。',
      failed: '版本 ' + n + ' 未能生效（' + (apply && apply.lastErrorCode || '原因未知') + '）。可重试' + (m != null ? '，或回退到上次已生效的版本 ' + m : '') + '。',
      unknown: '无法确认 Jchat 是否已采用版本 ' + n + '，请点击「重新核对」。',
    };
    applyStatus.textContent = apply ? messages[apply.state] || messages.unknown : '应用状态未知，请重新读取。';
    if (apply && apply.state === 'applied_healthy' && apply.appliedRevision !== n) applyStatus.textContent = '先前版本已被更新的配置取代，请应用当前版本 ' + n + '。';
    if (apply && apply.helperAvailable === false) applyStatus.textContent += ' 应用服务不可用：配置可保存，但无法从后台生效，请联系部署管理员。';
    if (apply && !JadminShell.isOwner() && !apply.canApply && !firstSetup) applyStatus.textContent += ' 接口或 Key 有未生效的更改时，需所有者应用。';
    updateModelControls();
  }
  function acceptApply(value) {
    if (value && value.configRevision !== loadedRevision) value = null;
    stopPolling(); apply = value || null; renderApply(); updateEndpointControls();
    if (applying()) schedulePoll();
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    const generation = JadminState.generation(), epoch = applyEpoch;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      try {
        const result = await api('/api/admin/model-config/apply-status');
        if (generation !== JadminState.generation() || epoch !== applyEpoch) return;
        if (result.configRevision > loadedRevision) { await refreshModels({ force: true }); return; }
        if (result.configRevision !== loadedRevision) { schedulePoll(); return; }
        JadminState.invalidate('model', 'configDetails');
        acceptApply(result);
      } catch (error) {
        if (generation !== JadminState.generation() || epoch !== applyEpoch) return;
        acceptApply({ ...apply, state: 'unknown' });
      }
    }, 1500);
  }
  const details = el('div'), detailsNotice = el('p', '', { className: 'muted', role: 'status' });
  const detailsButton = el('button', '查看配置详情', { type: 'button', className: 'button-secondary', onclick: async () => {
    const generation = JadminState.generation();
    detailsButton.disabled = true; detailsNotice.textContent = '正在读取配置详情…';
    try {
      const result = await JadminState.read('configDetails', () => api('/api/config')), current = result.current || {};
      const rows = [['Key 状态', current.keyConfigured ? '已配置' : '未配置'], ['客户端域名', current.domainClient || '未配置'], ['Jchat API 地址', current.librechatBaseURL || '未配置'], ...Object.entries(result.config || {}).map(([name, value]) => [({ defaultModel: 'Jchat 默认模型', fallbackModel: '默认兜底模型', baseURL: '已保存 API 地址', providerName: '服务商名称' })[name] || name, value])];
      const list = el('table'), body = table(list, ['配置项', '当前值']);
      for (const [name, value] of rows) { const row = el('tr'); row.append(el('td', name), el('td', String(value))); body.append(row); }
      details.replaceChildren(list); detailsNotice.textContent = '数据时间 ' + JadminDOM.time(JadminState.get('configDetails').at) + '。此读取会同时探测模型；不作为业务验收。';
      if (JadminShell.labelTables) JadminShell.labelTables($('modelConfigCard'));
    } catch (error) { if (error.code === 'superseded_read') return; JadminDOM.error(details, error, () => detailsButton.onclick()); detailsNotice.textContent = '配置详情未知。'; }
    finally { if (generation === JadminState.generation()) detailsButton.disabled = false; }
  } });
  const detailsSection = el('section'); detailsSection.append(detailsButton, detailsNotice, details); $('config').after(detailsSection);
  JadminState.subscribe(() => {
    const generation = JadminState.generation();
    if (generation !== sessionGeneration) {
      sessionGeneration = generation; busy = false; activeRefresh = null; endpointBusy = false;
      stopPolling(); operationBusy = false; firstSetup = false; apply = null;
      loadedRevision = null; loadedEndpoint = null; loadedBaseURL = ''; endpointAvailable = false;
      $('baseURL').value = ''; $('apiKey').value = ''; $('apiKey').type = 'password'; toggle.textContent = '显示 Key';
      configuredModel = fallbackModel = ''; models = []; catalogError = false;
      clearDraftCatalog();
      applyStatus.textContent = ''; endpointsWarning.textContent = ''; endpointNotice.textContent = '';
      reuse.checked = false; reuseOrigin = ''; providerAvailable = false; providerBusy = false; providerInput.value = ''; providerNotice.textContent = '';
      updateProviderControls(); updateEndpointControls(); detailsButton.disabled = false;
    }
    const entry = JadminState.get('configDetails');
    if (entry.stale && entry.at) detailsNotice.textContent = '先前配置详情可能已过期，请再次点击查看。';
    if (entry.status === 'unloaded') { details.replaceChildren(); detailsNotice.textContent = ''; }
  });
  const toggle = el('button', '显示 Key', { type: 'button', className: 'button-secondary', onclick: () => { const input = $('apiKey'); input.type = input.type === 'password' ? 'text' : 'password'; toggle.textContent = input.type === 'password' ? '显示 Key' : '隐藏 Key'; } });
  $('apiKey').after(toggle);
  function origin(value) {
    try { const url = new URL(value.trim()); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : ''; }
    catch (_) { return ''; }
  }
  function updateReuse() {
    const target = origin($('baseURL').value), state = loadedEndpoint && loadedEndpoint.state;
    const visible = endpointAvailable && !firstSetup && loadedEndpoint.keyConfigured === true && JadminShell.isOwner() && (state === 'unbound' || (state === 'ok' && !$('apiKey').value && (target !== origin(loadedBaseURL) || loadedEndpoint.bindingMatches === false)));
    if (target !== reuseOrigin || !visible || !target) reuse.checked = false;
    reuseOrigin = target; reuseLabel.hidden = !visible;
    reuse.disabled = !visible || !target || endpointBusy || operationBusy || !!applying() || state === 'pending';
    reuseText.textContent = '确认沿用服务器上现有的 Key，并发送到 ' + (target || '（请先填写有效的 API 地址）');
  }
  function endpointEdited() {
    clearDraftCatalog();
    updateReuse(); updateModelControls();
  }
  $('baseURL').oninput = endpointEdited; $('apiKey').oninput = endpointEdited;
  function updateProviderControls() {
    const owner = JadminShell.isOwner();
    providerInput.readOnly = !owner; providerInput.disabled = !providerAvailable || providerBusy || !owner;
    providerSave.hidden = !owner; providerSave.disabled = !owner || !providerAvailable || providerBusy;
  }
  async function readProvider({ force = false } = {}) {
    const generation = JadminState.generation(); providerAvailable = false; updateProviderControls();
    providerNotice.textContent = '正在读取服务商名称…'; providerNotice.className = 'muted';
    try {
      const result = await JadminState.read('providers', () => api('/api/admin/providers'), { force });
      const provider = (result.providers || [])[0];
      if (!provider || typeof provider.name !== 'string') throw Error('服务商名称未返回');
      providerInput.value = provider.name; providerAvailable = true;
      providerNotice.textContent = JadminShell.isOwner() ? '' : '仅所有者可修改服务商名称。';
      return result;
    } catch (error) {
      if (error.code === 'superseded_read' || generation !== JadminState.generation()) throw error;
      providerInput.value = ''; providerNotice.textContent = '服务商名称读取未完成：' + error.message; providerNotice.className = 'bad'; throw error;
    } finally { if (generation === JadminState.generation()) updateProviderControls(); }
  }
  providerSave.onclick = async () => {
    if (!JadminShell.isOwner() || !providerAvailable || providerBusy) return;
    const providerName = providerInput.value.trim(), generation = JadminState.generation();
    if (!providerName || [...providerName].length > 40 || /[\x00-\x1f\x7f-\x9f]/.test(providerInput.value)) { providerNotice.textContent = '服务商名称须为 1–40 个字符，不能包含控制字符或换行。'; providerNotice.className = 'bad'; return; }
    providerBusy = true; updateProviderControls(); providerNotice.textContent = '正在保存服务商名称…';
    try {
      await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ providerName }) });
      JadminState.invalidate('providers', 'configDetails');
      await readProvider({ force: true });
      providerNotice.textContent = '服务商名称已保存。'; providerNotice.className = 'ok';
    } catch (error) {
      if (error.code === 'superseded_read') return;
      providerNotice.textContent = '服务商名称保存或核对未完成：' + error.message; providerNotice.className = 'bad';
    } finally { if (generation === JadminState.generation()) { providerBusy = false; updateProviderControls(); } }
  };
  function updateEndpointControls() {
    const owner = JadminShell.isOwner(), disabled = !owner || !endpointAvailable || busy || endpointBusy || operationBusy || !!applying();
    const pending = loadedEndpoint && loadedEndpoint.state === 'pending';
    $('baseURL').readOnly = disabled; $('baseURL').disabled = disabled;
    $('apiKey').disabled = disabled; $('apiKey').required = !!pending || firstSetup;
    $('save-endpoint').disabled = disabled || firstSetup; toggle.disabled = disabled;
    updateReuse();
    $('endpoint-owner-note').textContent = !owner ? firstSetup ? '首次设置需由所有者完成。' : '仅所有者可修改接口。管理员可单独设置默认模型。'
      : !endpointAvailable ? '当前接口状态未知，请先重新读取聊天设置。'
        : firstSetup ? '请先填写 API 地址和 Key，再在下方设置 Jchat 默认模型；首次设置会一起测试并保存。'
        : pending ? '保存接口未完成，接口与 Key 可能未完全写入；请重新填写 API Key 后保存。'
          : loadedEndpoint.state === 'unbound' ? '接口与 Key 尚未绑定，请所有者重新保存接口。'
            : loadedEndpoint.bindingMatches === false ? '接口地址已在服务器上被修改，请所有者重新保存接口。'
            : 'API Key 留空保持原值。保存后需应用到 Jchat。';
    updateModelControls();
  }
  function showConfig(model, statusEpoch = applyEpoch) {
    const endpoint = model && model.endpoint;
    if (endpoint && loadedRevision !== null && endpoint.revision < loadedRevision) return;
    const keepEndpointDraft = endpointChanged() && !!loadedEndpoint;
    if (endpoint) {
      configuredModel = model.firstSetup ? '' : (model.defaultModel || '');
      fallbackModel = model.firstSetup ? '' : (model.fallbackModel || '');
    }
    endpointAvailable = !!endpoint && Number.isInteger(endpoint.revision);
    firstSetup = model && model.firstSetup === true;
    endpointsWarning.textContent = model && model.endpointsWarning ? '服务器设置 ENDPOINTS 未包含自定义接口，员工可能看不到该模型，请联系部署管理员。' : '';
    if (endpoint) {
      if (reuse && (loadedRevision !== endpoint.revision || loadedBaseURL !== endpoint.baseURL)) reuse.checked = false;
      loadedEndpoint = endpoint; loadedRevision = endpoint.revision; loadedBaseURL = endpoint.baseURL;
    } else { loadedEndpoint = null; loadedBaseURL = ''; loadedRevision = null; }
    if (statusEpoch === applyEpoch || !apply || apply.configRevision !== loadedRevision) acceptApply(model && model.apply);
    const base = loadedBaseURL;
    const list = el('table'), body = table(list, ['配置项', '当前值']);
    for (const [key, value] of [['API 地址', base || (endpoint && endpoint.baseURLInvalid ? '地址无效，请重新填写' : '未知')], ['统一 Key', endpoint ? endpoint.keyConfigured === true ? '已配置' : endpoint.keyConfigured === false ? '未配置' : '未知' : '未知'], ['客户端域名', '点击「查看配置详情」读取']]) { const row = el('tr'); row.append(el('td', key), el('td', value)); body.append(row); }
    $('config').replaceChildren(list);
    if (!keepEndpointDraft) $('baseURL').value = base;
    updateEndpointControls();
    if (JadminShell.labelTables) JadminShell.labelTables($('modelConfigCard'));
  }
  async function refreshModels({ force = false } = {}) {
    const generation = JadminState.generation();
    if (busy) {
      await activeRefresh.catch(() => {});
      if (force && generation === JadminState.generation()) return refreshModels({ force });
      return;
    }
    activeRefresh = readModels({ force });
    return activeRefresh;
  }
  async function readModels({ force }) {
    const generation = JadminState.generation(), statusEpoch = applyEpoch;
    if (busy) return; busy = true;
    updateEndpointControls();
    try {
      const values = await Promise.allSettled([readProvider({ force }), JadminState.read('model', () => api('/api/admin/model-status'), { force })]);
      if (generation !== JadminState.generation()) return;
      if (values.some(result => result.status === 'rejected' && result.reason.code === 'superseded_read')) return;
      const modelStatus = values[1].status === 'fulfilled' ? values[1].value : values[1].reason.data;
      showConfig(modelStatus, statusEpoch);
      catalogError = values[1].status === 'rejected' || !!modelStatus?.error;
      models = !catalogError && modelStatus?.revision === loadedRevision ? cleanModels(modelStatus.models) : [];
      if (values[1].status === 'rejected') throw values[1].reason;
    } finally { if (generation === JadminState.generation()) { busy = false; updateEndpointControls(); } }
  }
  async function runOperation(op, revision = loadedRevision, afterSave = false) {
    if (!endpointAvailable || firstSetup || operationBusy || applying() || !apply || apply.helperAvailable !== true) return;
    if (op === 'rollback' && (!JadminShell.isOwner() || apply.canRollback !== true)) return;
    if (op === 'apply' && apply.canApply !== true) return;
    if (endpointBusy && !afterSave) return;
    const generation = JadminState.generation(); stopPolling(); operationBusy = true; updateEndpointControls();
    try {
      const result = await api('/api/admin/model-config/' + op, { method: 'POST', body: JSON.stringify({ expectedRevision: revision }) });
      if (generation !== JadminState.generation()) return;
      if (result.ok !== true || !result.requestId) throw Error('未返回应用请求编号，请重新核对');
      JadminState.invalidate('model', 'configDetails', 'audit');
      acceptApply({ ...apply, state: 'queued', operation: { requestId: result.requestId, op } });
      return true;
    } catch (error) {
      if (generation !== JadminState.generation()) return;
      if (error.status === 409 || error.status === 403) {
        try { await refreshModels({ force: true }); } catch (_) { /* Retain the operation error. */ }
      } else acceptApply({ ...apply, state: 'unknown' });
      if (generation === JadminState.generation()) applyStatus.textContent += ' 操作未完成：' + error.message;
    } finally { if (generation === JadminState.generation()) { operationBusy = false; updateEndpointControls(); } }
  }
  applyButton.onclick = () => runOperation('apply'); verifyButton.onclick = () => runOperation('verify'); rollbackButton.onclick = () => runOperation('rollback');
  async function saveConfig({ field = null, model = '', report = null, expectedRevision = loadedRevision } = {}) {
    const generation = JadminState.generation();
    if (field !== null && field !== 'defaultModel' && field !== 'fallbackModel') return;
    if (expectedRevision !== loadedRevision || busy || endpointBusy || operationBusy || applying() || !endpointAvailable) return;
    const editEndpoint = !field || firstSetup;
    if (editEndpoint && !JadminShell.isOwner()) return;
    if (field && (!snapshot().canWrite || (firstSetup && field !== 'defaultModel'))) return;
    const say = report || ((text, style = '') => { endpointNotice.textContent = text; endpointNotice.className = style; });
    const data = {}, base = $('baseURL').value.trim(), key = $('apiKey').value;
    if (field) {
      if (!validModel(model) && !(field === 'fallbackModel' && model === '')) { say('请填写有效的模型 ID。', 'bad'); return; }
      data[field] = model;
    }
    if (editEndpoint) {
      if (firstSetup && !field) return;
      if ((loadedEndpoint.state === 'pending' || firstSetup) && !key) { say('请先在总接口填写 API Key。', 'bad'); return; }
      if (!origin(base)) { say('请先在总接口填写有效的 API 地址。', 'bad'); return; }
      updateReuse();
      const reuseConfirmed = !reuse.disabled && reuse.checked === true;
      if (base && (base !== loadedBaseURL || firstSetup)) data.baseURL = base; if (key) data.apiKey = key;
      if (!Object.keys(data).length && !reuseConfirmed) { say('没有需要保存的接口更改。'); return; }
      data.reuseKeyForNewOrigin = reuseConfirmed;
    }
    data.expectedRevision = expectedRevision;
    stopPolling();
    endpointBusy = true; updateEndpointControls();
    say(field && !model ? '正在清除兜底配置…' : '正在测试并保存…', 'muted');
    try {
      const result = await api('/api/config', { method: 'POST', body: JSON.stringify(data) });
      if (generation !== JadminState.generation()) return;
      if (result.ok !== true || !Number.isInteger(result.revision)) throw Error('保存结果缺少配置版本，请重新读取');
      loadedRevision = result.revision;
      if (field === 'defaultModel') configuredModel = model;
      if (field === 'fallbackModel') fallbackModel = model;
      if (editEndpoint) {
        loadedBaseURL = base;
        $('apiKey').value = ''; $('apiKey').type = 'password'; toggle.textContent = '显示 Key'; reuse.checked = false;
      }
      firstSetup = false;
      acceptApply({ ...apply, state: 'persisted_unapplied', configRevision: result.revision });
      say('已保存，等待应用。', 'muted');
      await refreshModels({ force: true });
      if (generation !== JadminState.generation()) return;
      if (field && loadedRevision === result.revision) {
        const queued = await runOperation('apply', result.revision, true);
        if (generation !== JadminState.generation()) return;
        say(queued ? '已提交应用，请等待 Jchat 确认生效。' : '已保存，但应用未提交。请核对应用状态。', queued ? 'muted' : 'bad');
        if (queued) return result.revision;
      } else if (field) say('已保存版本已被更新的配置取代，请核对当前版本。', 'bad');
      else say('接口已保存，请点击「应用已保存的配置」使其生效。', 'ok');
    }
    catch (error) {
      if (error.code === 'superseded_read' || generation !== JadminState.generation()) return;
      say('保存或核对未完成：' + error.message, 'bad');
      if (reuse) reuse.checked = false;
      if (error.status === 409 || error.status >= 500 || !error.status) {
        JadminState.invalidate('model', 'providers');
        try { await refreshModels({ force: true }); } catch (_) { /* Keep the save error visible. */ }
      }
    }
    finally { if (generation === JadminState.generation()) { endpointBusy = false; updateEndpointControls(); } }
  }
  $('save-endpoint').onclick = () => saveConfig();
  updateProviderControls(); updateEndpointControls();
  JadminShell.register('models', refreshModels);
  return { snapshot, refresh: refreshModels, discoverDraft, save: saveConfig, subscribe: fn => listeners.add(fn) };
})();
