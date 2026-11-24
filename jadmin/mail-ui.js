// Enterprise mail owner configuration. Credential values live only in password inputs; never stored, logged or exported.
(function () {
  'use strict';
  const { el } = JadminDOM;
  const PATH = '/api/admin/enterprise-mail/config', TEST_PATH = '/api/admin/enterprise-mail/test', FIXED_MAILBOX = 'sales@example.invalid';
  const DEFAULT_URL = { tencent: 'https://exmail.qq.com/', google: 'https://mail.google.com/', custom: '' };
  const PROVIDERS = [['tencent', '腾讯企业邮箱'], ['google', 'Google Workspace 邮箱'], ['custom', '自定义链接（仅跳转）']];
  const ERRORS = {
    revision_conflict: '配置已被其他会话修改，请点击“重新读取”核对后再保存。',
    config_incomplete: '配置不完整，暂不能启用。请补全凭据，或取消“启用”后再保存。',
    test_rate_limited: '测试过于频繁，请 10 秒后再试。',
    owner_required: '仅所有者可执行此操作。',
    network: '网络错误，请检查连接后重试。',
    https_required: '网页邮箱地址必须以 https:// 开头。',
    invalid_credentials: '凭据格式无效，清除与填写新凭据不能同时选择。',
  };
  const COUNT_LABELS = { ok: '正常', error: '检查失败', link_only: '仅跳转，不检查' };
  let gen = JadminState.generation(), seq = 0, cfg = null, dirty = false, busy = false, testResult = null, autoTried = false;

  function check(text, attrs = {}) {
    const input = el('input', null, { type: 'checkbox', ...attrs }), label = el('label', null, { className: 'checkbox-field' });
    label.append(input, ' ' + text); return [label, input];
  }
  function field(text, input) { const label = el('label', text, { className: 'field' }); input.setAttribute('aria-label', text); label.append(input); return label; }
  function secret(name) { return el('input', null, { type: 'password', name, autocomplete: 'new-password', spellcheck: false }); }

  const root = el('section', null, { className: 'mail-config page-section', id: 'mailConfigSection' });
  const gate = el('p', '仅所有者可查看和修改企业邮箱配置。', { className: 'muted', hidden: true });
  const banner = el('div', null, { role: 'alert', hidden: true });
  const statusLine = el('p', '', { role: 'status', className: 'muted' });
  const form = el('form', null, { noValidate: true, hidden: true });
  const [enabledLabel, enabled] = check('启用企业邮箱入口', { name: 'enabled' });
  const provider = el('select', null, { name: 'provider' });
  PROVIDERS.forEach(([value, text]) => provider.append(el('option', text, { value })));
  const url = el('input', null, { type: 'url', name: 'webmailUrl', autocomplete: 'off', inputMode: 'url', placeholder: 'https://' });
  const mailbox = el('p', '', { className: 'muted' });
  const deptSet = el('fieldset'), deptList = el('div');
  deptSet.append(el('legend', '可使用企业邮箱的部门'), deptList);
  const credSet = el('fieldset'), credState = el('p', '', { className: 'muted' });
  const tPass = secret('tencentPassword'), [tClearLabel, tClear] = check('清除已保存的腾讯凭据');
  const gId = secret('googleClientId'), gSecret = secret('googleClientSecret'), gToken = secret('googleRefreshToken');
  const [gClearLabel, gClear] = check('清除已保存的 Google 凭据');
  const tencentBox = el('div'), googleBox = el('div');
  const customBox = el('p', '自定义链接只提供网页跳转，不保存凭据，也不检查未读数。', { className: 'muted' });
  tencentBox.append(field('腾讯企业邮箱客户端专用密码', tPass), tClearLabel);
  googleBox.append(field('Google OAuth 客户端 ID', gId), field('Google OAuth 客户端密钥', gSecret), field('Google 刷新令牌', gToken), gClearLabel);
  credSet.append(el('legend', '服务商凭据'), credState, tencentBox, googleBox, customBox);
  const validity = el('p', '', { className: 'muted' }), testOut = el('p', '', { role: 'status' });
  const saveBtn = el('button', '保存配置', { type: 'submit' });
  const testBtn = el('button', '测试已保存配置', { type: 'button', className: 'button-secondary' });
  const reloadBtn = el('button', '重新读取', { type: 'button', className: 'button-secondary' });
  const actions = el('div', null, { className: 'form-actions' });
  actions.append(saveBtn, testBtn, reloadBtn);
  form.append(enabledLabel, field('邮箱服务商', provider), field('网页邮箱地址', url), mailbox, deptSet, credSet, validity, actions, testOut);
  root.append(gate, banner, statusLine, form);
  JadminShell.mount('mail', root);

  const secrets = [tPass, gId, gSecret, gToken], clears = [tClear, gClear];
  function clearSecrets() { secrets.forEach(i => { i.value = ''; }); clears.forEach(c => { c.checked = false; }); }
  function fresh(g, mine) { return g === gen && g === JadminState.generation() && mine === seq; }
  function showBanner(text) { banner.textContent = text || ''; banner.className = text ? 'error-banner' : ''; banner.hidden = !text; }
  function fail(error) {
    if (error && error.code === 'superseded_read') return;
    const code = error && (error.code || (error.data && error.data.error));
    const key = ERRORS[code] ? code : error && error.status === 403 ? 'owner_required' : !(error && error.status) ? 'network' : '';
    showBanner(ERRORS[key] || '操作未完成，请重试。');
  }
  function ownerNow() {
    return JadminShell.isOwner();
  }

  function renderProvider() {
    const p = provider.value, c = (cfg && cfg.credentials) || {};
    tencentBox.hidden = p !== 'tencent'; googleBox.hidden = p !== 'google'; customBox.hidden = p !== 'custom';
    tPass.placeholder = c.tencentPassword ? '已保存，留空则保持不变' : '未设置';
    gId.placeholder = c.googleClientId ? '已保存，留空则保持不变' : '未设置';
    gSecret.placeholder = c.googleClientSecret ? '已保存，留空则保持不变' : '未设置';
    gToken.placeholder = c.googleRefreshToken ? '已保存，留空则保持不变' : '未设置';
    credState.textContent = p === 'tencent' ? (c.tencentConfigured ? '腾讯凭据：已保存（已保存不代表连接测试已通过）。' : '腾讯凭据：未保存。')
      : p === 'google' ? (c.googleConfigured ? 'Google 凭据：已保存（已保存不代表连接测试已通过）。' : 'Google 凭据：未保存或不完整。')
      : '自定义链接无需凭据。';
  }
  function testText() {
    if (dirty) return '有未保存的修改，保存后才能测试连接。';
    if (!testResult) return '本页尚未测试连接。';
    if (testResult.stale) return '测试结果对应旧版本配置，请点击“重新读取”。';
    if (testResult.status === 'link_only') return '自定义链接仅提供跳转，未检测邮箱连接。';
    if (testResult.status === 'ok' && testResult.ok) return '连接测试通过' + (Number.isInteger(testResult.unread) ? '：未读 ' + testResult.unread + ' 封' : '') + '（测试的是已保存的配置）。';
    return '连接测试未通过，请检查已保存的凭据后重试。';
  }
  function renderState() {
    form.querySelectorAll('input,select').forEach(input => { input.disabled = busy || !cfg; });
    saveBtn.disabled = busy || !cfg;
    testBtn.disabled = busy || dirty || !cfg;
    reloadBtn.disabled = busy;
    testOut.textContent = cfg ? testText() : '';
    if (!cfg) { validity.textContent = ''; return; }
    const count = cfg.count || {}, countLabel = COUNT_LABELS[count.status] || '未检查';
    validity.textContent = '当前状态：' + (cfg.enabled ? '已启用' : '未启用') + '。'
      + (cfg.valid ? '已保存的配置完整，可以启用。' : '已保存的配置不完整，启用前需补全。')
      + '最近未读检查：' + countLabel + (Number.isInteger(count.unread) ? '，未读 ' + count.unread + ' 封' : '') + '。';
  }
  function fill() {
    enabled.checked = !!cfg.enabled;
    provider.value = DEFAULT_URL.hasOwnProperty(cfg.provider) ? cfg.provider : 'tencent';
    url.value = typeof cfg.webmailUrl === 'string' ? cfg.webmailUrl : DEFAULT_URL[provider.value];
    mailbox.textContent = '企业邮箱账号（固定）：' + FIXED_MAILBOX;
    const chosen = new Set(Array.isArray(cfg.departments) ? cfg.departments : []), choices = Array.isArray(cfg.departmentChoices) ? cfg.departmentChoices : [];
    deptList.replaceChildren();
    choices.forEach(d => { const [label, box] = check(String(d.name || d.code), { value: String(d.code), name: 'departments' }); box.checked = chosen.has(d.code); deptList.append(label); });
    if (!choices.length) deptList.append(el('p', '暂无可选部门。', { className: 'muted' }));
    dirty = false; form.hidden = !ownerNow();
    renderProvider(); renderState();
  }
  function wipe() {
    seq++; cfg = null; dirty = false; busy = false; testResult = null; autoTried = false;
    clearSecrets(); url.value = ''; enabled.checked = false; provider.value = 'tencent';
    deptList.replaceChildren(); mailbox.textContent = ''; credState.textContent = '';
    showBanner(''); statusLine.textContent = ''; form.hidden = true; renderState();
  }

  async function load({ force = false } = {}) {
    syncOwner();
    if (!ownerNow()) return;
    autoTried = true;
    if (cfg && !force) { renderState(); return; }
    const g = gen, mine = ++seq;
    cfg = null; dirty = false; testResult = null; clearSecrets(); form.hidden = true;
    busy = true; showBanner(''); statusLine.textContent = '正在读取企业邮箱配置…'; renderState();
    try {
      const data = await JadminState.read('enterpriseMail', () => api(PATH), { force: true });
      if (!fresh(g, mine)) return;
      cfg = data; testResult = null; clearSecrets(); fill(); statusLine.textContent = '';
    } catch (error) {
      if (!fresh(g, mine)) return;
      statusLine.textContent = ''; fail(error);
    } finally { if (fresh(g, mine)) { busy = false; renderState(); } }
  }

  async function save(event) {
    event.preventDefault();
    if (!cfg || busy || !ownerNow()) return;
    if ((enabled.checked || url.value.trim()) && !/^https:\/\/\S+$/i.test(url.value.trim())) { showBanner(ERRORS.https_required); url.focus(); return; }
    const credentials = {}, p = provider.value;
    [['tencentPassword', tPass], ['googleClientId', gId], ['googleClientSecret', gSecret], ['googleRefreshToken', gToken]]
      .forEach(([key, input]) => { if (input.value.trim()) credentials[key] = input.value.trim(); });
    const clear = [];
    if (p === 'tencent' && tClear.checked) clear.push('tencent');
    if (p === 'google' && gClear.checked) clear.push('google');
    if (clear.length) credentials.clear = clear;
    const departments = Array.from(deptList.querySelectorAll('input[type=checkbox]:checked'), box => box.value);
    let body = JSON.stringify({ revision: cfg.revision, enabled: enabled.checked, provider: p, webmailUrl: url.value.trim(), departments, credentials });
    const g = gen, mine = ++seq;
    busy = true; showBanner(''); statusLine.textContent = '正在保存…'; renderState();
    try {
      const data = await api(PATH, { method: 'POST', body });
      body = null;
      if (!fresh(g, mine)) return;
      await JadminState.read('enterpriseMail', () => Promise.resolve(data), { force: true });
      if (!fresh(g, mine)) return;
      cfg = data; testResult = null; fill();
      statusLine.textContent = '已保存。' + (cfg.enabled ? '' : '企业邮箱入口当前未启用。');
    } catch (error) {
      body = null;
      if (!fresh(g, mine)) return;
      statusLine.textContent = ''; fail(error);
      if (error && error.code !== 'superseded_read') statusLine.textContent = '出于安全考虑，已清空凭据输入，请重新填写。';
    } finally { if (fresh(g, mine)) { clearSecrets(); busy = false; renderState(); } }
  }

  async function runTest() {
    if (!cfg || busy || dirty || !ownerNow()) return;
    const g = gen, mine = ++seq, revision = cfg.revision;
    busy = true; testResult = null; showBanner(''); statusLine.textContent = '正在测试已保存的配置…'; renderState();
    try {
      const result = await api(TEST_PATH, { method: 'POST', body: JSON.stringify({ revision }) });
      if (!fresh(g, mine)) return;
      testResult = result && result.revision === cfg.revision ? { ok: result.ok === true, status: result.status, unread: result.unread } : { stale: true };
      statusLine.textContent = '';
    } catch (error) {
      if (!fresh(g, mine)) return;
      statusLine.textContent = ''; fail(error);
    } finally { if (fresh(g, mine)) { clearSecrets(); busy = false; renderState(); } }
  }

  function onProvider() {
    clearSecrets(); testResult = null; url.value = DEFAULT_URL[provider.value] || '';
    dirty = true; renderProvider(); renderState();
  }
  function markDirty(event) { if (event.target === provider) return; if (cfg) { dirty = true; renderState(); } }

  function syncOwner() {
    const owner = ownerNow();
    document.querySelectorAll('a[href="#/mail"], [data-route="mail"], #nav-mail').forEach(node => { node.hidden = !owner; });
    gate.hidden = owner;
    if (!owner) { clearSecrets(); form.hidden = true; return; }
    if (cfg) form.hidden = false;
  }

  form.addEventListener('submit', save);
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);
  provider.addEventListener('change', onProvider);
  testBtn.addEventListener('click', runTest);
  reloadBtn.addEventListener('click', () => load({ force: true }));
  window.addEventListener('hashchange', () => { if (location.hash !== '#/mail') clearSecrets(); });
  JadminState.subscribe(() => {
    const now = JadminState.generation();
    if (now !== gen) { gen = now; wipe(); }
    syncOwner();
  });
  JadminShell.register('mail', options => load(options || {}));
  (JadminShell.discoverHooks = JadminShell.discoverHooks || []).push(syncOwner);
  window.JadminMailUI = Object.freeze({ discover: syncOwner });
  syncOwner();
})();
