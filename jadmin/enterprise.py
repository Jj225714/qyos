"""企业OS：Casdoor 单点登录、部门目录、员工资料检查，以及供 os-bridge 读取的部门接口。

部门的生效规则（os-bridge 与本模块一致）：
1. 管理员在「员工分配」里为某个邮箱指定的部门优先；
2. 否则按部门排序，取第一个与员工 Casdoor 群组有交集的部门；
3. 都不满足则为「未分配」。
"""
import base64, hashlib, hmac, json, os, re, secrets, time
import urllib.error, urllib.parse, urllib.request

CODE = re.compile(r'^[a-z][a-z0-9_-]{1,31}$')
GROUP = re.compile(r'^[^\s/]{1,100}/[^\s/]{1,100}$')
EMAIL = re.compile(r'^[^\s@]{1,128}@[^\s@]{1,255}$')
STATE_SECONDS = 600
STATE_COOKIE = 'jadmin_sso_state'
LINK_SECONDS = 600
# 登录方式（三选一）：Jadmin 内部代号 -> 显示名称；Casdoor provider 类型用于识别名称不同的同类 IM 项。
IM_TYPES = ('lark', 'wecom', 'dingtalk')
IM_LABELS = {'lark': '飞书', 'wecom': '企业微信', 'dingtalk': '钉钉'}
IM_CASDOOR_TYPES = ('Lark', 'WeCom', 'DingTalk')
DEFAULT_IM = 'lark'
DEFAULT_IM_PROVIDERS = {'lark': 'provider_lark', 'wecom': 'provider_wecom', 'dingtalk': 'provider_dingtalk'}


class EnterpriseError(Exception):
    def __init__(self, message, status=400, data=None):
        super().__init__(message)
        self.status = status
        self.data = data or {}


def _secret(name):
    """Reads NAME, or the file named by NAME_FILE (preferred for secrets)."""
    path = os.environ.get(name + '_FILE')
    if path:
        try:
            with open(path, encoding='utf-8') as f:
                return f.read().strip()
        except OSError:
            return ''
    return os.environ.get(name, '').strip()


def settings():
    return {
        'casdoorUrl': os.environ.get('CASDOOR_URL', '').rstrip('/'),
        'organization': os.environ.get('CASDOOR_ORG', ''),
        'clientId': os.environ.get('CASDOOR_CLIENT_ID', ''),
        'clientSecret': _secret('CASDOOR_CLIENT_SECRET'),
        'origin': os.environ.get('JADMIN_ORIGIN', '').rstrip('/'),
        'bridgeToken': _secret('OS_BRIDGE_TOKEN'),
        # A dedicated Casdoor global administrator's accessKey/accessSecret: only it may update applications.
        'adminAccessKey': _secret('CASDOOR_ADMIN_ACCESS_KEY'),
        'adminAccessSecret': _secret('CASDOOR_ADMIN_ACCESS_SECRET'),
        'apps': [a.strip() for a in os.environ.get('CASDOOR_APPS', 'jchat,jimage,jadmin').split(',') if a.strip()],
        'imProviders': _im_providers(os.environ.get('CASDOOR_IM_PROVIDERS', '')),
    }


def _im_providers(raw):
    """Parses "lark=provider_lark,wecom=provider_wecom,dingtalk=provider_dingtalk"; missing entries use the defaults."""
    out = dict(DEFAULT_IM_PROVIDERS)
    for part in (raw or '').split(','):
        key, sep, value = part.strip().partition('=')
        key, value = key.strip().lower(), value.strip()
        if sep and key in out and value:
            out[key] = value
    return out


def sso_enabled(cfg=None):
    cfg = cfg or settings()
    return all(cfg[k] for k in ('casdoorUrl', 'clientId', 'clientSecret', 'origin'))


def init_db(c):
    c.execute('create table if not exists departments(code text primary key, name text not null, groups text not null default \'[]\', japi_group_id integer, sort integer not null default 0, updated integer)')
    c.execute('create table if not exists assignments(email text primary key, code text not null, note text, updated integer)')
    c.execute('create table if not exists sso_states(state text primary key, verifier text not null, created integer not null, link_email text)')
    if 'link_email' not in {r[1] for r in c.execute('pragma table_info(sso_states)')}:
        c.execute('alter table sso_states add column link_email text')
    # Administrator email -> Casdoor user ID (OIDC `sub`). Rows are created only by the explicit link flow
    # (a password-authenticated administrator clicks「关联企业账号」); SSO login looks the user up by `sub`.
    c.execute('create table if not exists sso_bindings(email text primary key, subject text not null, created integer not null)')
    # One-time link tokens (SHA-256 only), valid for LINK_SECONDS.
    c.execute('create table if not exists sso_links(token text primary key, email text not null, created integer not null)')
    c.execute('create table if not exists enterprise_settings(k text primary key, v text not null, updated integer)')
    c.commit()


# ---------------------------------------------------------------- departments

def _department(row):
    return {'code': row['code'], 'name': row['name'], 'groups': json.loads(row['groups'] or '[]'), 'japiGroupId': row['japi_group_id'], 'sort': row['sort']}


def list_departments(c):
    return [_department(r) for r in c.execute('select * from departments order by sort, code')]


def list_assignments(c):
    return [dict(r) for r in c.execute('select email, code, note, updated from assignments order by email')]


def save_department(c, data):
    code = str(data.get('code', '')).strip()
    name = str(data.get('name', '')).strip()
    if not CODE.match(code):
        raise EnterpriseError('部门代码需为 2–32 位小写字母、数字、- 或 _，且以字母开头')
    if not 1 <= len(name) <= 40:
        raise EnterpriseError('部门名称需为 1–40 个字符')
    groups = data.get('groups') or []
    if isinstance(groups, str):
        groups = [g.strip() for g in re.split(r'[\s,，;；]+', groups) if g.strip()]
    if not isinstance(groups, list) or len(groups) > 50 or not all(isinstance(g, str) and GROUP.match(g) for g in groups):
        raise EnterpriseError('Casdoor 群组格式为「组织/群组」，例如 jpmamoru/sales，最多 50 个')
    groups = list(dict.fromkeys(groups))
    japi = data.get('japiGroupId')
    if japi in ('', None):
        japi = None
    else:
        try:
            japi = int(japi)
        except (TypeError, ValueError):
            raise EnterpriseError('JAPI 分组 ID 需为正整数')
        if japi <= 0:
            raise EnterpriseError('JAPI 分组 ID 需为正整数')
    try:
        sort = int(data.get('sort') or 0)
    except (TypeError, ValueError):
        raise EnterpriseError('排序需为整数')
    # One Casdoor group belongs to one department, otherwise resolution would depend on sort order silently.
    for other in list_departments(c):
        if other['code'] != code:
            clash = set(other['groups']) & set(groups)
            if clash:
                raise EnterpriseError('群组 %s 已属于部门「%s」' % ('、'.join(sorted(clash)), other['name']), 409)
    c.execute('insert into departments(code,name,groups,japi_group_id,sort,updated) values(?,?,?,?,?,?) on conflict(code) do update set name=excluded.name, groups=excluded.groups, japi_group_id=excluded.japi_group_id, sort=excluded.sort, updated=excluded.updated',
              (code, name, json.dumps(groups, ensure_ascii=False), japi, sort, int(time.time())))
    c.commit()
    return _department(c.execute('select * from departments where code=?', (code,)).fetchone())


def delete_department(c, code):
    used = c.execute('select count(*) from assignments where code=?', (code,)).fetchone()[0]
    if used:
        raise EnterpriseError('还有 %d 名员工被手动分配到该部门，请先改分配' % used, 409)
    if not c.execute('delete from departments where code=?', (code,)).rowcount:
        raise EnterpriseError('部门不存在', 404)
    c.commit()


def set_assignment(c, email, code, note=''):
    email = str(email or '').strip().lower()
    if not EMAIL.match(email):
        raise EnterpriseError('请填写有效邮箱')
    if not code:
        c.execute('delete from assignments where email=?', (email,))
        c.commit()
        return None
    if not c.execute('select 1 from departments where code=?', (code,)).fetchone():
        raise EnterpriseError('部门不存在', 404)
    c.execute('insert into assignments(email,code,note,updated) values(?,?,?,?) on conflict(email) do update set code=excluded.code, note=excluded.note, updated=excluded.updated',
              (email, code, str(note or '')[:200], int(time.time())))
    c.commit()
    return {'email': email, 'code': code}


def resolve(departments, assignments, email, groups):
    """Returns the department code for one employee (see module docstring), or None."""
    email = (email or '').strip().lower()
    if email in assignments:
        return assignments[email]
    for dept in departments:
        if set(dept['groups']) & set(groups or []):
            return dept['code']
    return None


def bridge_payload(c, cfg=None):
    departments = list_departments(c)
    updated = c.execute('select max(m) from (select max(updated) m from departments union all select max(updated) m from assignments)').fetchone()[0] or 0
    return {
        'version': updated,
        'departments': [{'code': d['code'], 'name': d['name'], 'groups': d['groups'], 'japiGroupId': d['japiGroupId']} for d in departments],
        'assignments': {r['email']: r['code'] for r in list_assignments(c)},
        'loginProvider': login_provider(c, cfg),
    }


def bridge_authorized(header_value, cfg=None):
    expected = (cfg or settings())['bridgeToken']
    given = header_value or ''
    return bool(expected) and hmac.compare_digest(hashlib.sha256(given.encode()).digest(), hashlib.sha256(expected.encode()).digest())


# ---------------------------------------------------------------- Casdoor directory

def _http_json(url, headers=None, data=None, timeout=15):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method='POST' if data is not None else 'GET')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as e:
        raise EnterpriseError('Casdoor 返回 HTTP %d' % e.code, 502)
    except (urllib.error.URLError, OSError, ValueError):
        raise EnterpriseError('Casdoor 暂时不可用', 503)


def casdoor_users(cfg=None):
    cfg = cfg or settings()
    if not (cfg['casdoorUrl'] and cfg['organization'] and cfg['clientId'] and cfg['clientSecret']):
        raise EnterpriseError('未配置 Casdoor（CASDOOR_URL、CASDOOR_ORG、CASDOOR_CLIENT_ID、CASDOOR_CLIENT_SECRET）', 409)
    basic = base64.b64encode((cfg['clientId'] + ':' + cfg['clientSecret']).encode()).decode()
    # Application credentials (Basic auth) let Casdoor return unmasked email/phone for this check.
    body = _http_json(cfg['casdoorUrl'] + '/api/get-users?' + urllib.parse.urlencode({'owner': cfg['organization']}), {'Authorization': 'Basic ' + basic, 'Accept': 'application/json'})
    if not isinstance(body, dict) or body.get('status') != 'ok' or not isinstance(body.get('data'), list):
        raise EnterpriseError('Casdoor 拒绝读取用户列表：%s' % (body.get('msg') if isinstance(body, dict) else '格式错误'), 502)
    return body['data']


def _mask_phone(phone):
    phone = str(phone or '')
    return phone[:3] + '****' + phone[-4:] if len(phone) >= 8 else ('*' * len(phone))


def directory_report(c, users=None):
    """Checks every Casdoor employee: email, phone, duplicates, bound IMs and resolved department."""
    users = casdoor_users() if users is None else users
    departments = list_departments(c)
    names = {d['code']: d['name'] for d in departments}
    assignments = {r['email']: r['code'] for r in list_assignments(c)}
    active = [u for u in users if isinstance(u, dict) and not u.get('isDeleted')]
    by_email, by_phone = {}, {}
    for u in active:
        email = str(u.get('email') or '').strip().lower()
        phone = re.sub(r'\D', '', str(u.get('phone') or ''))
        if email:
            by_email.setdefault(email, []).append(u)
        if phone:
            by_phone.setdefault((str(u.get('countryCode') or ''), phone), []).append(u)
    rows, counts = [], {'missingEmail': 0, 'missingPhone': 0, 'duplicateEmail': 0, 'duplicatePhone': 0, 'unassigned': 0, 'noIm': 0}
    for u in active:
        email = str(u.get('email') or '').strip().lower()
        phone = re.sub(r'\D', '', str(u.get('phone') or ''))
        groups = [g for g in (u.get('groups') or []) if isinstance(g, str)]
        bound = [label for key, label in (('lark', '飞书'), ('wecom', '企业微信'), ('dingtalk', '钉钉')) if u.get(key)]
        code = resolve(departments, assignments, email, groups)
        issues = []
        if not email or not EMAIL.match(email):
            issues.append('缺邮箱'); counts['missingEmail'] += 1
        elif len(by_email.get(email, [])) > 1:
            issues.append('邮箱重复'); counts['duplicateEmail'] += 1
        if not phone:
            issues.append('缺手机号'); counts['missingPhone'] += 1
        elif len(by_phone.get((str(u.get('countryCode') or ''), phone), [])) > 1:
            issues.append('手机号重复'); counts['duplicatePhone'] += 1
        if not bound:
            issues.append('未绑定 IM'); counts['noIm'] += 1
        if not code:
            issues.append('未分配部门'); counts['unassigned'] += 1
        rows.append({
            'name': u.get('name'), 'displayName': u.get('displayName') or u.get('name'),
            'email': email, 'phone': _mask_phone(phone), 'groups': groups, 'im': bound,
            'department': code, 'departmentName': names.get(code, ''),
            'source': 'manual' if email in assignments else ('group' if code else ''),
            'forbidden': bool(u.get('isForbidden')), 'issues': issues,
        })
    rows.sort(key=lambda r: (not r['issues'], r['departmentName'] or '~', r['displayName'] or ''))
    return {'total': len(rows), 'ready': sum(1 for r in rows if not r['issues']), 'counts': counts, 'users': rows}


# ---------------------------------------------------------------- login IM (one of Lark / WeCom / DingTalk)
#
# Casdoor only accepts an OAuth login whose provider is listed (and visible) in the application's providers, so
# "only one IM" means: in every application (CASDOOR_APPS) keep exactly the chosen IM provider item, and leave
# the other items (captcha, email, ...) untouched.

def get_login_im(c):
    row = c.execute("select v from enterprise_settings where k='login_im'").fetchone()
    return row[0] if row and row[0] in IM_TYPES else DEFAULT_IM


def set_login_im(c, im):
    if im not in IM_TYPES:
        raise EnterpriseError('登录方式只能是飞书（lark）、企业微信（wecom）或钉钉（dingtalk）')
    c.execute("insert into enterprise_settings(k,v,updated) values('login_im',?,?) on conflict(k) do update set v=excluded.v, updated=excluded.updated", (im, int(time.time())))
    c.commit()


def login_provider(c, cfg=None):
    cfg = cfg or settings()
    im = get_login_im(c)
    return {'type': im, 'name': cfg['imProviders'][im]}


def binding_rule(im):
    # WeCom internal apps never report a verified email/phone, so Casdoor can only match an existing user by
    # name (= WeCom userid, needs UseIdAsName on the provider). Lark and DingTalk report verified email/phone.
    return ['Name'] if im == 'wecom' else ['Email', 'Phone']


def admin_api_configured(cfg=None):
    cfg = cfg or settings()
    return bool(cfg['casdoorUrl'] and cfg['adminAccessKey'] and cfg['adminAccessSecret'])


def _admin_call(cfg, path, params, body=None):
    query = urllib.parse.urlencode(dict(params, accessKey=cfg['adminAccessKey'], accessSecret=cfg['adminAccessSecret']))
    data = json.dumps(body).encode() if body is not None else None
    headers = {'Accept': 'application/json'}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    result = _http_json(cfg['casdoorUrl'] + path + '?' + query, headers, data)
    if not isinstance(result, dict) or result.get('status') != 'ok':
        raise EnterpriseError('Casdoor 拒绝请求：%s' % ((result.get('msg') or '未知原因') if isinstance(result, dict) else '格式错误'), 502)
    return result


def get_application(cfg, app):
    data = _admin_call(cfg, '/api/get-application', {'id': 'admin/' + app}).get('data')
    if not isinstance(data, dict) or not isinstance(data.get('providers') or [], list):
        raise EnterpriseError('Casdoor 中找不到应用 %s' % app, 404)
    return data


def _is_im_item(item, names):
    if item.get('name') in names:
        return True
    provider = item.get('provider')
    return isinstance(provider, dict) and provider.get('type') in IM_CASDOOR_TYPES


def application_im_items(data, cfg):
    names = set(cfg['imProviders'].values())
    return [i.get('name') for i in (data.get('providers') or []) if isinstance(i, dict) and _is_im_item(i, names)]


def build_providers(data, im, cfg):
    """The application's provider list with every IM item replaced by the chosen one; other items stay as they are."""
    names = set(cfg['imProviders'].values())
    chosen = cfg['imProviders'][im]
    out, slot, previous = [], None, None
    for item in data.get('providers') or []:
        if not isinstance(item, dict) or not item.get('name'):
            raise EnterpriseError('应用的 provider 列表格式异常，已停止同步', 502)
        if _is_im_item(item, names):
            slot = len(out) if slot is None else slot
            if item.get('name') == chosen:
                previous = item
            continue
        out.append(item)
    previous = previous or {}
    out.insert(len(out) if slot is None else slot, {
        'owner': previous.get('owner') or 'admin', 'name': chosen,
        'canSignUp': True, 'canSignIn': True, 'canUnlink': False, 'bindingRule': binding_rule(im),
        'countryCodes': previous.get('countryCodes') or [], 'prompted': False,
        'signupGroup': previous.get('signupGroup') or '', 'rule': 'None', 'provider': None,
    })
    return out


def sync_login_im(c, cfg=None):
    """Writes the chosen IM into every application's providers (columns=providers). One result per application."""
    cfg = cfg or settings()
    im = get_login_im(c)
    results = []
    for app in cfg['apps']:
        try:
            data = get_application(cfg, app)
            # A non-global-admin gets a masked application (secret "***", Email/SMS items stripped); writing that
            # back would delete provider items, so stop here instead.
            if data.get('clientSecret') == '***':
                raise EnterpriseError('管理凭据不是 Casdoor 全局管理员（应用信息被脱敏），已停止同步该应用', 403)
            data['providers'] = build_providers(data, im, cfg)
            _admin_call(cfg, '/api/update-application', {'id': 'admin/' + app, 'columns': 'providers'}, data)
            results.append({'app': app, 'ok': True})
        except EnterpriseError as e:
            results.append({'app': app, 'ok': False, 'error': str(e)})
    return results


def manual_steps(im, cfg=None):
    cfg = cfg or settings()
    name = cfg['imProviders'][im]
    others = '、'.join(v for k, v in cfg['imProviders'].items() if k != im)
    steps = [
        '登录 Casdoor 管理后台，依次打开应用：%s。' % '、'.join(cfg['apps']),
        '在每个应用的「提供商」列表中删除 %s，只保留 %s（验证码等非 IM 提供商不动）。' % (others, name),
        '%s 一项设置：可注册、可登录、不可解绑、不提示（prompted 关）、规则 None，绑定规则 %s。' % (name, '、'.join(binding_rule(im))),
        '确认每个应用都开启了「启用注册」，否则新员工首次登录会失败。',
    ]
    if im == 'wecom':
        steps.append('在 %s 上开启「使用 ID 作为用户名」（UseIdAsName），并确认每位员工的 Casdoor 用户名等于其企业微信 userid。' % name)
    return steps


def wecom_risk(c, users=None):
    """How many employees would be locked out by switching to WeCom (no WeCom bound on their Casdoor user)."""
    try:
        report = directory_report(c, users)
    except EnterpriseError as e:
        return {'checked': False, 'error': str(e)}
    unbound = [r for r in report['users'] if IM_LABELS['wecom'] not in r['im']]
    return {'checked': True, 'total': report['total'], 'unbound': len(unbound),
            'examples': [r['displayName'] or r['email'] or r['name'] for r in unbound[:20]]}


def _option(im, cfg):
    return {'type': im, 'label': IM_LABELS[im], 'provider': cfg['imProviders'][im]}


def login_im_status(c, cfg=None, users=None):
    cfg = cfg or settings()
    im = get_login_im(c)
    expected = cfg['imProviders'][im]
    apps, notes = [], []
    if admin_api_configured(cfg):
        for app in cfg['apps']:
            try:
                data = get_application(cfg, app)
                actual = application_im_items(data, cfg)
                apps.append({'app': app, 'status': 'ok' if actual == [expected] else 'mismatch', 'providers': actual, 'enableSignUp': bool(data.get('enableSignUp'))})
                if not data.get('enableSignUp'):
                    notes.append('应用 %s 未开启注册，新员工首次登录会失败' % app)
            except EnterpriseError as e:
                apps.append({'app': app, 'status': 'error', 'error': str(e)})
        states = {a['status'] for a in apps}
        overall = 'error' if 'error' in states else ('mismatch' if 'mismatch' in states else 'ok')
    else:
        apps = [{'app': app, 'status': 'unknown'} for app in cfg['apps']]
        overall = 'unknown'
        notes.append('未配置 CASDOOR_ADMIN_ACCESS_KEY / CASDOOR_ADMIN_ACCESS_SECRET，无法读取或修改 Casdoor 应用，需手动调整')
    if im == 'wecom':
        notes.append('企业微信按用户名合并账号：%s 需开启「使用 ID 作为用户名」，员工的 Casdoor 用户名必须等于企业微信 userid' % expected)
    return {
        'im': im, 'label': IM_LABELS[im], 'provider': expected,
        'options': [_option(k, cfg) for k in IM_TYPES],
        'sync': {'configured': admin_api_configured(cfg), 'status': overall, 'apps': apps},
        'notes': notes,
        'wecomRisk': wecom_risk(c, users),
    }


def change_login_im(c, im, confirm=False, cfg=None, users=None):
    """Saves the login IM and (with admin credentials) updates every application. Returns (result, http status)."""
    cfg = cfg or settings()
    im = str(im or '').strip().lower()
    if im not in IM_TYPES:
        raise EnterpriseError('登录方式只能是飞书（lark）、企业微信（wecom）或钉钉（dingtalk）')
    previous = get_login_im(c)
    risk = None
    if im == 'wecom' and previous != 'wecom':
        risk = wecom_risk(c, users)
        if confirm is not True and (not risk['checked'] or risk['unbound']):
            message = ('有 %d 名员工尚未绑定企业微信，切换后他们将无法登录。确认后再保存。' % risk['unbound']) if risk['checked'] \
                else ('无法核对员工的企业微信绑定情况（%s）。确认后再保存。' % risk['error'])
            raise EnterpriseError(message, 409, {'needConfirm': True, 'wecomRisk': risk})
    set_login_im(c, im)
    result = {'im': im, 'label': IM_LABELS[im], 'provider': cfg['imProviders'][im], 'previous': previous, 'saved': True}
    if risk is not None:
        result['wecomRisk'] = risk
    if not admin_api_configured(cfg):
        result['sync'] = {'configured': False, 'status': 'manual', 'apps': [], 'steps': manual_steps(im, cfg)}
        return result, 200
    apps = sync_login_im(c, cfg)
    failed = [a for a in apps if not a['ok']]
    result['sync'] = {'configured': True, 'status': 'error' if failed else 'ok', 'apps': apps, 'failed': [a['app'] for a in failed]}
    if failed:
        result['error'] = '设置已保存，但以下应用同步到 Casdoor 失败：%s。修复后请重新保存。' % '；'.join('%s（%s）' % (a['app'], a['error']) for a in failed)
        return result, 502
    return result, 200


# ---------------------------------------------------------------- SSO for Jadmin administrators

_discovery = {}


def _endpoints(cfg):
    cached = _discovery.get(cfg['casdoorUrl'])
    if cached and cached[1] > time.time():
        return cached[0]
    value = _http_json(cfg['casdoorUrl'] + '/.well-known/openid-configuration')
    if not all(isinstance(value.get(k), str) for k in ('authorization_endpoint', 'token_endpoint', 'userinfo_endpoint')):
        raise EnterpriseError('Casdoor OIDC 配置不完整', 502)
    _discovery[cfg['casdoorUrl']] = (value, time.time() + 3600)
    return value


def _redirect_uri(cfg):
    return cfg['origin'] + '/api/sso/callback'


def _hash(value):
    return hashlib.sha256(value.encode()).hexdigest()


def create_link(c, email):
    """One-time token (10 minutes) that ties the next SSO login to this administrator email; only its hash is stored."""
    email = str(email or '').strip().lower()
    if not EMAIL.match(email):
        raise EnterpriseError('管理员邮箱无效')
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    c.execute('delete from sso_links where created<? or email=?', (now - LINK_SECONDS, email))
    c.execute('insert into sso_links(token,email,created) values(?,?,?)', (_hash(token), email, now))
    c.commit()
    return token


def consume_link(c, token):
    if not isinstance(token, str) or not token or len(token) > 200:
        raise EnterpriseError('关联链接无效，请回到管理后台重新点击「关联企业账号」')
    key = _hash(token)
    row = c.execute('select email, created from sso_links where token=?', (key,)).fetchone()
    c.execute('delete from sso_links where token=?', (key,))
    c.commit()
    if not row or row['created'] < time.time() - LINK_SECONDS:
        raise EnterpriseError('关联链接无效或已过期，请回到管理后台重新点击「关联企业账号」')
    return row['email']


def sso_start(c, cfg=None, link=None):
    """Authorization redirect. With `link` (from create_link) the login links the administrator instead of signing in."""
    cfg = cfg or settings()
    if not sso_enabled(cfg):
        raise EnterpriseError('未启用企业登录', 404)
    endpoints = _endpoints(cfg)
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    now = int(time.time())
    c.execute('delete from sso_states where created<?', (now - STATE_SECONDS,))
    if c.execute('select count(*) from sso_states').fetchone()[0] > 1000:
        raise EnterpriseError('登录请求过多，请稍后再试', 429)
    link_email = consume_link(c, link) if link is not None else None
    c.execute('insert into sso_states(state,verifier,created,link_email) values(?,?,?,?)', (_hash(state), verifier, now, link_email))
    c.commit()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    # provider_hint makes Casdoor go straight to the chosen IM instead of showing its own login page.
    query = urllib.parse.urlencode({'response_type': 'code', 'client_id': cfg['clientId'], 'redirect_uri': _redirect_uri(cfg), 'scope': 'openid profile email', 'state': state, 'code_challenge': challenge, 'code_challenge_method': 'S256', 'provider_hint': login_provider(c, cfg)['name']})
    cookie = '%s=%s; Path=/api/sso; HttpOnly; Secure; SameSite=Lax; Max-Age=%d' % (STATE_COOKIE, state, STATE_SECONDS)
    return endpoints['authorization_endpoint'] + ('&' if '?' in endpoints['authorization_endpoint'] else '?') + query, cookie


def cookie_state(header):
    for part in (header or '').split(';'):
        name, _, value = part.strip().partition('=')
        if name == STATE_COOKIE:
            return value
    return ''


def link_subject(c, email, subject):
    """Binds an administrator email to a Casdoor user ID. Only called from the explicit link flow.

    Re-linking the same email replaces its old Casdoor user. A Casdoor user already linked to another
    administrator is refused, so one link never silently removes someone else's.
    """
    email = str(email or '').strip().lower()
    other = c.execute('select email from sso_bindings where subject=? and email<>?', (subject, email)).fetchone()
    if other:
        raise EnterpriseError('该企业账号已关联管理员 %s，请先在后台解除那条关联' % other['email'], 409)
    c.execute('insert into sso_bindings(email,subject,created) values(?,?,?) on conflict(email) do update set subject=excluded.subject, created=excluded.created',
              (email, subject, int(time.time())))
    c.commit()


def bound_email(c, subject, email_hint=''):
    """The administrator email linked to this Casdoor user, or None."""
    rows = [r['email'] for r in c.execute('select email from sso_bindings where subject=?', (subject,))]
    if len(rows) == 1:
        return rows[0]
    # Bindings made before explicit linking may tie one Casdoor user to several emails; use the one it signed in with.
    hint = (email_hint or '').strip().lower()
    return hint if hint in rows else None


def list_bindings(c, email=None):
    sql, args = 'select email, subject, created from sso_bindings', ()
    if email is not None:
        sql, args = sql + ' where email=?', (str(email).strip().lower(),)
    return [dict(r) for r in c.execute(sql + ' order by email', args)]


def unlink(c, email):
    removed = c.execute('delete from sso_bindings where email=?', (str(email or '').strip().lower(),)).rowcount
    c.commit()
    return removed


def sso_finish(c, query, state_cookie, cfg=None):
    """Completes the OIDC login.

    Returns {'email': administrator email, 'linked': bool}. In the link flow the email is the administrator who
    requested the link, now bound to this Casdoor user; otherwise it is the administrator already linked to it.
    """
    cfg = cfg or settings()
    if not sso_enabled(cfg):
        raise EnterpriseError('未启用企业登录', 404)
    params = urllib.parse.parse_qs(query or '')
    state = (params.get('state') or [''])[0]
    code = (params.get('code') or [''])[0]
    if not state or not code or len(code) > 4096 or not state_cookie or not hmac.compare_digest(state, state_cookie):
        raise EnterpriseError('登录状态无效，请重新登录', 401)
    key = _hash(state)
    row = c.execute('select verifier, created, link_email from sso_states where state=?', (key,)).fetchone()
    c.execute('delete from sso_states where state=?', (key,))
    c.commit()
    if not row or row['created'] < time.time() - STATE_SECONDS:
        raise EnterpriseError('登录已过期，请重新登录', 401)
    endpoints = _endpoints(cfg)
    form = urllib.parse.urlencode({'grant_type': 'authorization_code', 'code': code, 'redirect_uri': _redirect_uri(cfg), 'client_id': cfg['clientId'], 'client_secret': cfg['clientSecret'], 'code_verifier': row['verifier']}).encode()
    try:
        tokens = _http_json(endpoints['token_endpoint'], {'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json'}, form)
    except EnterpriseError:
        raise EnterpriseError('Casdoor 登录校验失败', 401)
    access = tokens.get('access_token') if isinstance(tokens, dict) else None
    if not isinstance(access, str) or not access:
        raise EnterpriseError('Casdoor 登录校验失败', 401)
    info = _http_json(endpoints['userinfo_endpoint'], {'Authorization': 'Bearer ' + access, 'Accept': 'application/json'})
    if not isinstance(info, dict):
        raise EnterpriseError('Casdoor 登录校验失败', 401)
    email = str(info.get('email') or '').strip().lower()
    # Lark/DingTalk report a verified email, so an unverified one is refused. WeCom never does (Casdoor sets
    # EmailVerified=false for WeComInternal users); there the explicit link binding alone identifies the administrator.
    if get_login_im(c) != 'wecom':
        if not EMAIL.match(email):
            raise EnterpriseError('该企业账号没有邮箱，无法登录管理后台', 403)
        if info.get('email_verified') is not True:
            raise EnterpriseError('该企业账号的邮箱未经验证，无法登录管理后台，请在 Casdoor 中验证邮箱后重试', 403)
    subject = str(info.get('sub') or '').strip()
    if not subject or len(subject) > 200:
        raise EnterpriseError('Casdoor 未返回用户 ID，无法登录管理后台', 403)
    if row['link_email']:
        link_subject(c, row['link_email'], subject)
        return {'email': row['link_email'], 'linked': True}
    admin = bound_email(c, subject, email)
    if not admin:
        raise EnterpriseError('该企业账号尚未关联 Jadmin 管理员。请先用邮箱和密码登录后台，在「企业账号关联」中点击「关联企业账号」', 403)
    return {'email': admin, 'linked': False}
