/* One form for the three model roles; route-specific validation stays on the server. */
(() => {
  const { el, table } = JadminDOM;
  const config = JadminModelConfig;
  const imageUrl = '/api/admin/runtime-models';
  const definitions = {
    chat: { label: 'Jchat 默认模型', field: 'defaultModel', help: '用于 Jchat 新对话。模型通过聊天测试后，系统会提交应用。' },
    image: { label: 'Jimage 默认模型', help: '用于 Jimage 生图及多张参考图融合。员工无需另配渠道或 Key。更换模型前会测试生图；更换后可到 Jimage 上传多张图验证融合效果。' },
    fallback: { label: '默认兜底模型', field: 'fallbackModel', help: 'Jchat 主模型不可用时，可在聊天中手动切换到这个备用模型。选择「取消兜底模型」可清除。' },
  };
  const errorLabels = {
    model_not_available: '此模型未通过生图测试。请确认已在 Jimage 的网关分组开通。',
    probe_failed: '生图测试未通过。请确认模型可在 Jimage 的线路上出图。',
    revision_conflict: '配置已被其他人修改，请重新读取后再测试。',
    config_busy: '正在处理另一项更改，请稍后再试。',
    test_required: '生图测试已过期，请重新测试。',
    probe_rate_limited: '两次生图测试之间至少间隔 10 秒。',
    runtime_unavailable: '暂时无法确认生图服务状态，请重新读取后再试。',
    MODEL_PROBE_FAILED: '生图测试未通过。请确认模型可在 Jimage 的线路上出图。',
    MODEL_REVISION_CONFLICT: '配置已被其他人修改，请重新读取后再测试。',
    MODEL_PROBE_REQUIRED: '生图测试已过期，请重新测试。',
    MODEL_PROBE_RATE_LIMITED: '本系统每小时最多生成 5 张测试图，已达到上限。',
    MODEL_PROBE_IN_PROGRESS: '已有生图测试在运行，请等待结果。',
    MODEL_UPSTREAM_RATE_LIMITED: '生图网关返回限流，请等待后再试。',
    MODEL_CONTROL_UNAVAILABLE: '暂时无法确认生图服务状态，请重新读取后再试。',
  };
  let generation = JadminState.generation(), imageState = null, lastImage = '', refreshEpoch = 0, imageLoading = false;
  let inProgress = false, draft = null, pending = null, retryUntil = 0, retryTimer;
  const card = el('section', null, { id: 'default-model-settings', className: 'card' });
  const summary = el('table'), rows = table(summary, ['模型用途', '当前状态']), values = {};
  const role = el('select', null, { id: 'default-model-role' });
  for (const [value, definition] of Object.entries(definitions)) {
    const cell = values[value] = el('td', '待读取', { id: 'default-model-status-' + value });
    const row = el('tr'); row.append(el('td', definition.label), cell); rows.append(row);
    role.append(el('option', definition.label, { value }));
  }
  const input = el('select', null, { id: 'default-model-choice' });
  const roleField = el('label', '设置用途', { htmlFor: role.id, className: 'field' }); roleField.append(role);
  const modelField = el('label', '模型 ID', { htmlFor: input.id, className: 'field' }); modelField.append(input);
  const help = el('p', '', { id: 'default-model-help', className: 'muted' }); input.setAttribute('aria-describedby', help.id);
  const note = el('p', '', { id: 'default-model-notice', role: 'status', ariaLive: 'polite' });
  const submit = el('button', '测试并应用', { type: 'submit', id: 'apply-default-model' });
  const reload = el('button', '重新读取', { type: 'button', id: 'reload-default-models', className: 'button-secondary' });
  const discover = el('button', '读取上游模型', { type: 'button', id: 'read-draft-catalog', className: 'button-secondary' });
  const actions = el('div', null, { className: 'actions' }); actions.append(submit, reload, discover);
  const form = el('form', null, { id: 'default-model-form' });
  form.append(roleField, modelField, help, actions, note);
  card.append(el('h2', '2. 设置默认模型'), summary, form);
  $('modelConfigCard').after(card);
  if (JadminShell.labelTables) JadminShell.labelTables(card);

  const report = (text, style = '') => { note.textContent = text; note.className = style; };
  const modelValue = () => input.value;
  const savedModel = (name, status) => name === 'image' ? (imageState?.model || lastImage) : status[name];
  const validModel = (name, value) => name === 'image' ? /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$/.test(value)
    : (name === 'fallback' && value === '') || /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(value);
  const listed = (name, status) => status.models.filter(value => validModel(name, value) && (name !== 'fallback' || value !== status.chat));
  function allowed(name, value, status) { return name === 'fallback' && value === '' || listed(name, status).includes(value); }
  const normalizedImage = image => typeof image?.model === 'string' && typeof image.revision === 'string' ? image : null;
  function render() {
    const status = config.snapshot(), name = role.value;
    if (pending && status.available) {
      if (status.revision !== pending.revision) { report('已提交的配置已被更新版本取代，请核对当前状态。', 'bad'); pending = null; }
      else if (status.confirmed) { report('已核对：Jchat 已加载此配置。', 'ok'); pending = null; }
      else if (status.applyState === 'failed') { report('配置未能生效，请在上方查看详情。', 'bad'); pending = null; }
      else if (status.applyState === 'unknown') { report('无法确认配置是否生效，请在上方点击「重新核对」。', 'bad'); pending = null; }
    }
    const chatValue = (value, empty) => value ? value + (!status.available ? '（上次读取）' : status.confirmed ? '（已生效）' : '（已保存，待核对）') : status.available ? empty : '待读取';
    values.chat.textContent = chatValue(status.chat, '未设置');
    const needsImageVerification = name === 'image' && imageState?.routeVerified === false;
    values.image.textContent = imageState?.model ? imageState.model + (imageState.routeVerified === false ? '（新接口待测试）' : '（已生效）') : lastImage ? lastImage + '（上次读取）' : '待读取';
    values.fallback.textContent = chatValue(status.fallback, status.confirmed ? '未设置' : '未设置（当前应用状态待核对）');
    role.disabled = inProgress;
    const enabled = !inProgress && (name === 'image' ? !imageLoading && imageState?.editable === true : status.canWrite && !(name === 'fallback' && status.firstSetup));
    const current = savedModel(name, status) || '';
    const models = listed(name, status);
    const options = [['!', '请选择上游模型', true], ...models.map(value => [value, value, false])];
    if (current && !models.includes(current)) options.splice(1, 0, [current, current + '（当前使用，未在上游列表中）', true]);
    if (name === 'fallback' && current) options.push(['', '取消兜底模型', false]);
    if (options.length !== input.options.length || options.some(([value, label, disabled], i) => {
      const option = input.options[i]; return option.value !== value || option.textContent !== label || option.disabled !== disabled;
    })) input.replaceChildren(...options.map(([value, label, disabled]) => el('option', label, { value, disabled })));
    if (draft !== null && !allowed(name, draft, status)) draft = null;
    input.value = draft ?? (current || '!');
    const canClear = name === 'fallback' && !!current;
    input.disabled = !enabled || (!models.length && !canClear);
    const candidate = modelValue();
    submit.textContent = name === 'fallback' && candidate === '' ? '取消兜底模型' : '测试并应用';
    const remaining = name === 'image' ? Math.ceil((retryUntil - Date.now()) / 1000) : 0;
    const selectable = allowed(name, candidate, status) || needsImageVerification && candidate === current;
    submit.disabled = !enabled || !selectable || candidate === current && !needsImageVerification || remaining > 0;
    if (remaining > 0) submit.textContent = '可重试于 ' + new Date(retryUntil).toLocaleTimeString('zh-CN');
    reload.disabled = inProgress || status.busy || imageLoading;
    discover.hidden = !status.firstSetup || name !== 'chat';
    discover.disabled = !status.canDiscoverDraft || status.readingDraft || inProgress;
    const extra = name === 'image' ? (imageState?.editable ? '' : (imageLoading ? ' 正在读取。' : ' 暂时无法更改，请先重新读取。'))
      : status.firstSetup ? (name === 'fallback' ? ' 请先完成总接口和 Jchat 默认模型设置。' : ' 填写地址和 Key 后，先点击「读取上游模型」。') : '';
    const catalogHelp = !status.firstSetup && status.endpointChanged ? ' 请先保存上方的接口更改。'
      : !status.firstSetup && !models.length ? ' 暂无可选的上游模型，可点击「重新读取」。' : '';
    help.textContent = definitions[name].help + extra + catalogHelp + (needsImageVerification ? ' 总接口已变更，请测试并应用当前或新的生图模型。' : '');
  }
  role.onchange = () => { draft = null; pending = null; report(''); render(); };
  input.onchange = () => { draft = input.value; pending = null; report(''); render(); };
  config.subscribe(render);
  JadminState.subscribe(() => {
    if (generation === JadminState.generation()) return;
    generation = JadminState.generation(); refreshEpoch++; imageState = null; lastImage = '';
    clearTimeout(retryTimer); retryUntil = 0;
    inProgress = false; draft = null; pending = null; imageLoading = false; role.value = 'chat'; report(''); render();
  });
  async function refreshImage() {
    const expectedSession = generation, epoch = ++refreshEpoch;
    imageLoading = true; render();
    let result;
    try { result = await api(imageUrl); } catch (_) { result = null; }
    if (generation !== expectedSession || epoch !== refreshEpoch) return;
    imageState = normalizedImage(result?.image);
    if (imageState) lastImage = imageState.model;
    imageLoading = false; render();
  }
  async function imageAction(action, payload, expectedSession) {
    let result = await api(imageUrl + '/image/' + action, { method: 'POST', body: JSON.stringify(payload) });
    if (typeof result?.jobId !== 'string') return result;
    const path = imageUrl + '/jobs/' + encodeURIComponent(result.jobId), end = Date.now() + 8 * 60 * 1000;
    do {
      await new Promise(resolve => setTimeout(resolve, 1200));
      if (expectedSession !== generation) return null;
      result = await api(path);
    } while (result?.pending && Date.now() < end);
    if (result?.pending) throw Object.assign(Error(), { code: 'config_busy' });
    return result;
  }
  async function setImage(model, expectedSession) {
    const revision = imageState?.revision;
    if (!await JadminShell.dialog({ title: '测试并应用生图模型', message: '将生成一张测试图片，可能产生用量。测试通过后，系统会应用模型：' + model, confirmText: '生成测试图并应用' })) return;
    const isCurrent = () => expectedSession === generation && revision === imageState?.revision && imageState?.editable === true && !imageLoading && role.value === 'image' && model === modelValue();
    if (!isCurrent()) return;
    try {
      report('正在生成测试图片…', 'muted');
      const payload = { model, revision };
      const tested = await imageAction('probe', { ...payload, confirmImageProbe: true }, expectedSession);
      if (!isCurrent()) throw Object.assign(Error(), { code: 'revision_conflict' });
      if (!tested?.probeId) throw Object.assign(Error(), { code: 'probe_failed' });
      report('测试通过，正在应用…', 'muted');
      const saved = await imageAction('save', { ...payload, probeId: tested.probeId }, expectedSession);
      if (expectedSession !== generation) return;
      if (saved?.applied !== true || saved.model !== model) throw Object.assign(Error(), { code: 'runtime_unavailable' });
      await refreshImage();
      if (expectedSession !== generation) return;
      if (imageState?.model !== model || imageState.routeVerified === false) { report('已提交，请重新读取并确认当前生效模型。', 'bad'); return; }
      draft = null;
      report('测试通过，已应用。', 'ok');
    } catch (error) {
      if (expectedSession !== generation) return;
      await refreshImage();
      if (expectedSession !== generation) return;
      const seconds = error?.data?.retryAfterSeconds;
      const message = errorLabels[error?.code] || '操作未完成，请重新读取后再试。';
      if (Number.isInteger(seconds) && seconds > 0 && seconds <= 3600) {
        retryUntil = Date.now() + seconds * 1000;
        clearTimeout(retryTimer);
        const limited = message + ' 可在 ' + new Date(retryUntil).toLocaleTimeString('zh-CN') + ' 后重试。';
        retryTimer = setTimeout(() => {
          if (role.value === 'image' && note.textContent === limited) report('现在可以重新测试。', 'muted');
          render();
        }, seconds * 1000 + 50);
        report(limited, 'bad');
      } else report(message, 'bad');
    }
  }
  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled) return;
    const expectedSession = generation, name = role.value, model = modelValue(), status = config.snapshot();
    const verifyingCurrentRoute = name === 'image' && imageState?.routeVerified === false && model === imageState.model;
    if (!verifyingCurrentRoute && (!allowed(name, model, status) || model === savedModel(name, status))) return;
    inProgress = true; pending = null; report(''); render();
    try {
      if (name === 'image') await setImage(model, expectedSession);
      else {
        const revision = await config.save({ field: definitions[name].field, model, report, expectedRevision: status.revision });
        if (generation === expectedSession && Number.isInteger(revision)) { pending = { revision }; draft = null; }
      }
    } finally {
      if (generation === expectedSession) { inProgress = false; render(); }
    }
  };
  reload.onclick = () => Promise.allSettled([config.refresh({ force: true }), refreshImage()]);
  discover.onclick = async () => {
    const expectedSession = generation;
    report('正在读取上游模型…', 'muted');
    try { await config.discoverDraft(); if (generation === expectedSession) report(config.snapshot().models.length ? '已读取上游模型，请从列表选择。' : '上游接口未返回可选模型。'); }
    catch (error) { if (generation === expectedSession) report(error?.code === 'discovery_rate_limited' ? '请间隔 5 秒后再读取。' : '读取上游模型失败，请核对 API 地址和 Key。', 'bad'); }
  };
  JadminShell.register('models', refreshImage);
  render();
})();
