"""Tests for the enterprise OS additions to Jadmin. Run: python3 -m unittest jadmin/test_enterprise.py"""
import base64, contextlib, copy, hashlib, http.client, json, os, re, sqlite3, sys, tempfile, threading, time, unittest, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
TMP = tempfile.mkdtemp(prefix='jadmin-test-')
os.environ.update({
    'ADMIN_DB': os.path.join(TMP, 'admin.db'), 'ADMIN_SECRET': 'x' * 64, 'ADMIN_EMAIL': 'owner@acme.cn', 'ADMIN_PASSWORD': 'owner-password',
    'CASDOOR_ORG': 'acme', 'CASDOOR_CLIENT_ID': 'jadmin-client', 'CASDOOR_CLIENT_SECRET': 'jadmin-secret',
    'JADMIN_ORIGIN': 'https://jadmin.example', 'OS_BRIDGE_TOKEN': 'bridge-token',
    'LIBRECHAT_ENV': os.path.join(TMP, 'librechat.env'), 'LIBRECHAT_CONFIG': os.path.join(TMP, 'librechat.yaml'),
    'SUB2API_ENV': os.path.join(TMP, 'missing-sub2api.env'),
})
for name in ('CASDOOR_ADMIN_ACCESS_KEY', 'CASDOOR_ADMIN_ACCESS_SECRET', 'CASDOOR_APPS', 'CASDOOR_IM_PROVIDERS'):
    os.environ.pop(name, None)
    os.environ.pop(name + '_FILE', None)
import enterprise  # noqa: E402

PEOPLE = [
    {'name': 'alice', 'displayName': '张三', 'email': 'Alice@acme.cn', 'phone': '13800000001', 'countryCode': 'CN', 'groups': ['acme/sales'], 'lark': 'ou_1'},
    {'name': 'bob', 'displayName': '李四', 'email': 'bob@acme.cn', 'phone': '', 'groups': ['acme/rd'], 'wecom': 'w1', 'dingtalk': 'd1'},
    {'name': 'carol', 'displayName': '王五', 'email': '', 'phone': '13800000001', 'countryCode': 'CN', 'groups': []},
    {'name': 'dave', 'displayName': '赵六', 'email': 'dave@acme.cn', 'phone': '13800000009', 'groups': ['acme/sales', 'acme/rd'], 'lark': 'ou_4'},
    {'name': 'gone', 'email': 'gone@acme.cn', 'isDeleted': True},
]


def item(name, provider, **extra):
    value = {'owner': 'admin', 'name': name, 'canSignUp': False, 'canSignIn': True, 'canUnlink': True, 'bindingRule': None,
             'countryCodes': [], 'prompted': False, 'signupGroup': '', 'rule': 'None', 'provider': provider}
    value.update(extra)
    return value


def casdoor_apps():
    return {name: {
        'owner': 'admin', 'name': name, 'organization': 'acme', 'clientId': name + '-id', 'clientSecret': name + '-secret', 'enableSignUp': True,
        'providers': [
            item('provider_captcha_default', {'category': 'Captcha', 'type': 'Default'}),
            item('provider_lark', {'category': 'OAuth', 'type': 'Lark'}, canSignUp=True, bindingRule=['Email', 'Phone'], signupGroup='acme/staff'),
            item('provider_wecom', {'category': 'OAuth', 'type': 'WeCom'}),
            item('provider_email', {'category': 'Email', 'type': 'SMTP'}),
        ],
    } for name in ('jchat', 'jimage', 'jadmin')}


class FakeCasdoor(BaseHTTPRequestHandler):
    codes = {}
    tokens = {}
    apps = casdoor_apps()
    updates = []
    fail_update = set()
    log_message = lambda *a: None

    def send_json(self, value, status=200):
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(json.dumps(value).encode())

    def admin_ok(self, query):
        return query.get('accessKey') == ['admin-ak'] and query.get('accessSecret') == ['admin-as']

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        if url.path == '/.well-known/openid-configuration':
            base = 'http://127.0.0.1:%d' % self.server.server_port
            return self.send_json({'authorization_endpoint': base + '/login/oauth/authorize', 'token_endpoint': base + '/api/login/oauth/access_token', 'userinfo_endpoint': base + '/api/userinfo'})
        if url.path == '/api/userinfo':
            info = self.tokens.get(self.headers.get('Authorization', '').replace('Bearer ', ''))
            return self.send_json(info) if info else self.send_json({'error': 'invalid_token'}, 401)
        if url.path == '/api/get-users':
            expected = 'Basic ' + base64.b64encode(b'jadmin-client:jadmin-secret').decode()
            if self.headers.get('Authorization') != expected or query.get('owner') != ['acme']:
                return self.send_json({'status': 'error', 'msg': 'unauthorized'})
            return self.send_json({'status': 'ok', 'data': PEOPLE})
        if url.path == '/api/get-application':
            if not self.admin_ok(query):
                return self.send_json({'status': 'error', 'msg': 'Unauthorized operation'})
            owner, _, name = query.get('id', [''])[0].partition('/')
            return self.send_json({'status': 'ok', 'msg': '', 'data': copy.deepcopy(self.apps.get(name)) if owner == 'admin' else None})
        self.send_json({}, 404)

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if url.path == '/api/update-application':
            query = urllib.parse.parse_qs(url.query)
            body = json.loads(raw)
            type(self).updates.append({'query': query, 'body': body})
            name = query.get('id', [''])[0].partition('/')[2]
            if not self.admin_ok(query) or name in self.fail_update:
                return self.send_json({'status': 'error', 'msg': 'boom'})
            self.apps[name]['providers'] = body['providers']
            return self.send_json({'status': 'ok', 'msg': '', 'data': 'Affected'})
        form = urllib.parse.parse_qs(raw.decode())
        grant = self.codes.pop(form.get('code', [''])[0], None)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(form.get('code_verifier', [''])[0].encode()).digest()).decode().rstrip('=')
        if not grant or form.get('client_secret') != ['jadmin-secret'] or form.get('redirect_uri') != ['https://jadmin.example/api/sso/callback'] or grant['challenge'] != challenge:
            return self.send_json({'error': 'invalid_grant'}, 400)
        access = os.urandom(12).hex()
        self.tokens[access] = grant['info']
        self.send_json({'access_token': access})


def serve(handler):
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


CASDOOR = serve(FakeCasdoor)
os.environ['CASDOOR_URL'] = 'http://127.0.0.1:%d' % CASDOOR.server_port
import server  # noqa: E402  (reads the environment above)

server.H.log_message = lambda *a: None
JADMIN = serve(server.H)


def call(method, path, body=None, headers=None):
    conn = http.client.HTTPConnection('127.0.0.1', JADMIN.server_port, timeout=10)
    data = json.dumps(body).encode() if body is not None else None
    conn.request(method, path, body=data, headers={**({'Content-Type': 'application/json'} if data else {}), **(headers or {})})
    response = conn.getresponse()
    raw = response.read()
    try: payload = json.loads(raw)
    except ValueError: payload = None
    return response.status, dict(response.getheaders()), payload


def memory_db():
    c = sqlite3.connect(':memory:'); c.row_factory = sqlite3.Row
    enterprise.init_db(c)
    return c


@contextlib.contextmanager
def casdoor_admin():
    os.environ.update({'CASDOOR_ADMIN_ACCESS_KEY': 'admin-ak', 'CASDOOR_ADMIN_ACCESS_SECRET': 'admin-as'})
    try:
        yield
    finally:
        os.environ.pop('CASDOOR_ADMIN_ACCESS_KEY', None)
        os.environ.pop('CASDOOR_ADMIN_ACCESS_SECRET', None)


class DepartmentRules(unittest.TestCase):
    def test_validation_clash_delete_and_assignment(self):
        c = memory_db()
        sales = enterprise.save_department(c, {'code': 'sales', 'name': '销售部', 'groups': 'acme/sales, acme/sales-east', 'japiGroupId': '3'})
        self.assertEqual(sales['groups'], ['acme/sales', 'acme/sales-east'])
        self.assertEqual(sales['japiGroupId'], 3)
        for bad in ({'code': 'Sales', 'name': 'x'}, {'code': 'ok', 'name': ''}, {'code': 'ok', 'name': 'x', 'groups': ['no-slash']}, {'code': 'ok', 'name': 'x', 'japiGroupId': '-1'}):
            with self.assertRaises(enterprise.EnterpriseError):
                enterprise.save_department(c, bad)
        with self.assertRaises(enterprise.EnterpriseError) as clash:
            enterprise.save_department(c, {'code': 'east', 'name': '华东', 'groups': ['acme/sales-east']})
        self.assertEqual(clash.exception.status, 409)
        enterprise.save_department(c, {'code': 'rd', 'name': '研发部', 'groups': ['acme/rd'], 'sort': 5})
        enterprise.set_assignment(c, 'Dave@Acme.cn', 'rd')
        with self.assertRaises(enterprise.EnterpriseError):
            enterprise.set_assignment(c, 'dave@acme.cn', 'missing')
        with self.assertRaises(enterprise.EnterpriseError) as used:
            enterprise.delete_department(c, 'rd')
        self.assertEqual(used.exception.status, 409)
        enterprise.set_assignment(c, 'dave@acme.cn', None)
        enterprise.delete_department(c, 'rd')
        self.assertEqual([d['code'] for d in enterprise.list_departments(c)], ['sales'])

    def test_resolution_order(self):
        depts = [{'code': 'sales', 'groups': ['acme/sales']}, {'code': 'rd', 'groups': ['acme/rd']}]
        self.assertEqual(enterprise.resolve(depts, {}, 'a@x', ['acme/rd', 'acme/sales']), 'sales')
        self.assertEqual(enterprise.resolve(depts, {'a@x': 'rd'}, 'A@X', ['acme/sales']), 'rd')
        self.assertIsNone(enterprise.resolve(depts, {}, 'a@x', ['acme/finance']))

    def test_directory_report(self):
        c = memory_db()
        enterprise.save_department(c, {'code': 'sales', 'name': '销售部', 'groups': ['acme/sales']})
        enterprise.set_assignment(c, 'bob@acme.cn', 'sales')
        report = enterprise.directory_report(c, PEOPLE)
        self.assertEqual(report['total'], 4)
        by = {u['displayName']: u for u in report['users']}
        self.assertEqual(by['张三']['issues'], ['手机号重复'])
        self.assertEqual(by['张三']['phone'], '138****0001')
        self.assertEqual(by['李四']['source'], 'manual')
        self.assertIn('缺手机号', by['李四']['issues'])
        self.assertEqual(set(by['王五']['issues']), {'缺邮箱', '手机号重复', '未绑定 IM', '未分配部门'})
        self.assertEqual(by['赵六']['issues'], [])
        self.assertEqual(report['ready'], 1)
        self.assertEqual(report['counts']['missingEmail'], 1)


class LoginImRules(unittest.TestCase):
    def test_setting_defaults_validation_and_provider_names(self):
        c = memory_db()
        self.assertEqual(enterprise.get_login_im(c), 'lark')
        with self.assertRaises(enterprise.EnterpriseError):
            enterprise.set_login_im(c, 'slack')
        enterprise.set_login_im(c, 'dingtalk')
        self.assertEqual(enterprise.get_login_im(c), 'dingtalk')
        self.assertEqual(enterprise._im_providers('wecom=wx , bogus=1, lark='), {'lark': 'provider_lark', 'wecom': 'wx', 'dingtalk': 'provider_dingtalk'})

    def test_build_providers_keeps_other_items(self):
        cfg = enterprise.settings()
        app = casdoor_apps()['jchat']
        out = enterprise.build_providers(app, 'dingtalk', cfg)
        self.assertEqual([i['name'] for i in out], ['provider_captcha_default', 'provider_dingtalk', 'provider_email'])
        self.assertEqual(out[0], app['providers'][0])
        self.assertEqual(out[2], app['providers'][3])
        self.assertEqual(out[1]['bindingRule'], ['Email', 'Phone'])
        # The kept settings of an existing item for the chosen provider are reused.
        lark = enterprise.build_providers(app, 'lark', cfg)[1]
        self.assertEqual((lark['signupGroup'], lark['canUnlink'], lark['canSignUp']), ('acme/staff', False, True))
        # An IM item under another name is still recognised by its Casdoor provider type.
        app['providers'].append(item('my_dingtalk', {'category': 'OAuth', 'type': 'DingTalk'}))
        self.assertEqual([i['name'] for i in enterprise.build_providers(app, 'wecom', cfg)], ['provider_captcha_default', 'provider_wecom', 'provider_email'])

    def test_wecom_confirmation(self):
        c = memory_db()
        with self.assertRaises(enterprise.EnterpriseError) as need:
            enterprise.change_login_im(c, 'wecom', users=PEOPLE)
        self.assertEqual(need.exception.status, 409)
        self.assertTrue(need.exception.data['needConfirm'])
        self.assertEqual(need.exception.data['wecomRisk']['unbound'], 3)
        self.assertEqual(enterprise.get_login_im(c), 'lark')
        result, status = enterprise.change_login_im(c, 'wecom', True, users=PEOPLE)
        self.assertEqual((status, result['im'], result['sync']['status']), (200, 'wecom', 'manual'))
        # Everyone already on WeCom: no confirmation needed.
        enterprise.set_login_im(c, 'lark')
        bound = [dict(p, wecom='w') for p in PEOPLE]
        self.assertEqual(enterprise.change_login_im(c, 'wecom', users=bound)[1], 200)


class HttpFlows(unittest.TestCase):
    def setUp(self):
        server._sso_hits.clear()
        FakeCasdoor.apps = casdoor_apps()
        FakeCasdoor.updates = []
        FakeCasdoor.fail_update = set()
        with contextlib.closing(server.db()) as c:
            enterprise.set_login_im(c, 'lark')
            c.execute('delete from sso_bindings'); c.commit()

    def login_token(self):
        status, _, body = call('POST', '/api/login', {'email': 'owner@acme.cn', 'password': 'owner-password'})
        self.assertEqual(status, 200)
        return body['token']

    def auth(self):
        return {'Authorization': 'Bearer ' + self.login_token()}

    def start(self, path='/api/sso/start', headers=None):
        status, headers, _ = call('GET', path, headers=headers)
        self.assertEqual(status, 302)
        return headers

    def sso(self, email, with_cookie=True, sub=None, verified=True, link=None):
        headers = self.start('/api/sso/start' + ('?link=' + urllib.parse.quote(link) if link else ''))
        if headers['Location'].startswith('/#'):
            return headers['Location'], None, None
        location = urllib.parse.urlsplit(headers['Location'])
        params = urllib.parse.parse_qs(location.query)
        self.assertEqual(params['code_challenge_method'], ['S256'])
        cookie = headers['Set-Cookie'].split(';')[0]
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        code = os.urandom(8).hex()
        FakeCasdoor.codes[code] = {'challenge': params['code_challenge'][0], 'info': {'sub': sub or email.lower(), 'email': email, 'email_verified': verified}}
        callback = '/api/sso/callback?' + urllib.parse.urlencode({'code': code, 'state': params['state'][0]})
        status, headers, _ = call('GET', callback, headers={'Cookie': cookie} if with_cookie else {})
        self.assertEqual(status, 302)
        return headers['Location'], callback, cookie

    def link(self, auth):
        status, _, body = call('POST', '/api/admin/sso/link', {}, auth)
        self.assertEqual(status, 200)
        self.assertTrue(body['url'].startswith('/api/sso/start?link='))
        return urllib.parse.parse_qs(urllib.parse.urlsplit(body['url']).query)['link'][0]

    def test_admin_sso_requires_explicit_link(self):
        self.assertEqual(call('GET', '/api/sso/status')[2], {'enabled': True})
        # No binding yet: even the configured administrator email is refused.
        location, _, _ = self.sso('owner@acme.cn', sub='owner-cas')
        self.assertTrue(location.startswith('/#sso-error='))
        self.assertIn(urllib.parse.quote('尚未关联'), location)
        self.assertEqual(call('POST', '/api/admin/sso/link', {})[0], 401)
        # The password-authenticated administrator links their Casdoor account.
        auth = self.auth()
        token = self.link(auth)
        location, _, _ = self.sso('someone-else@acme.cn', sub='owner-cas', link=token)
        self.assertTrue(location.startswith('/#sso-token='), location)
        self.assertIn('sso-notice=', location)
        # The link token is single-use.
        location, _, _ = self.sso('owner@acme.cn', sub='owner-cas', link=token)
        self.assertTrue(location.startswith('/#sso-error='))
        self.assertIn(urllib.parse.quote('关联链接无效'), location)
        # Now the linked Casdoor user signs in.
        location, callback, cookie = self.sso('owner@acme.cn', sub='owner-cas')
        self.assertTrue(location.startswith('/#sso-token='))
        sso_token = urllib.parse.unquote(location.split('=', 1)[1])
        status, _, body = call('GET', '/api/admin/departments', headers={'Authorization': 'Bearer ' + sso_token})
        self.assertEqual(status, 200)
        self.assertTrue(body['sso'])
        # Replaying the callback fails: the state was single-use.
        status, headers, _ = call('GET', callback, headers={'Cookie': cookie})
        self.assertTrue(headers['Location'].startswith('/#sso-error='))
        # Another Casdoor user who set their email to the administrator's is refused.
        location, _, _ = self.sso('Owner@Acme.cn', sub='intruder-id')
        self.assertIn(urllib.parse.quote('尚未关联'), location)
        status, _, links = call('GET', '/api/admin/sso/links', headers=auth)
        self.assertEqual((links['self']['email'], links['self']['subject'], links['owner']), ('owner@acme.cn', 'owner-cas', True))
        # Unlinking removes SSO access again.
        self.assertEqual(call('POST', '/api/admin/sso/unlink', {}, auth)[0], 200)
        self.assertTrue(self.sso('owner@acme.cn', sub='owner-cas')[0].startswith('/#sso-error='))
        self.assertEqual(call('POST', '/api/admin/sso/unlink', {}, auth)[0], 404)
        actions = [a['action'] for a in call('GET', '/api/admin/audit', headers=auth)[2]['audit']]
        self.assertTrue({'sso_link_start', 'sso_link', 'sso_login', 'sso_unlink'} <= set(actions))

    def test_sso_requires_verified_email(self):
        auth = self.auth()
        location, _, _ = self.sso('owner@acme.cn', sub='owner-cas', verified=False, link=self.link(auth))
        self.assertIn(urllib.parse.quote('未经验证'), location)
        self.assertIsNone(call('GET', '/api/admin/sso/links', headers=auth)[2]['self'])
        self.assertTrue(self.sso('owner@acme.cn', sub='owner-cas', link=self.link(auth))[0].startswith('/#sso-token='))
        location, _, _ = self.sso('owner@acme.cn', sub='owner-cas', verified=False)
        self.assertIn(urllib.parse.quote('未经验证'), location)
        location, _, _ = self.sso('owner@acme.cn', sub='owner-cas', verified='true')
        self.assertTrue(location.startswith('/#sso-error='))
        # WeCom never reports a verified email: with WeCom chosen only the explicit link counts.
        with contextlib.closing(server.db()) as c:
            enterprise.set_login_im(c, 'wecom')
        self.assertTrue(self.sso('owner@acme.cn', sub='owner-cas', verified=False)[0].startswith('/#sso-token='))
        self.assertTrue(self.sso('', sub='owner-cas', verified=False)[0].startswith('/#sso-token='))
        self.assertIn(urllib.parse.quote('尚未关联'), self.sso('owner@acme.cn', sub='wecom-intruder', verified=False)[0])
        self.assertTrue(self.sso('', sub='other-cas', verified=False, link=self.link(auth))[0].startswith('/#sso-token='))

    def test_sso_rejects_non_admins_and_missing_state_cookie(self):
        location, _, _ = self.sso('alice@acme.cn')
        self.assertTrue(location.startswith('/#sso-error='))
        location, _, _ = self.sso('owner@acme.cn', with_cookie=False)
        self.assertTrue(location.startswith('/#sso-error='))
        # A binding left for an email that is no longer an administrator does not grant access.
        with contextlib.closing(server.db()) as c:
            enterprise.link_subject(c, 'alice@acme.cn', 'alice-cas')
        location, _, _ = self.sso('alice@acme.cn', sub='alice-cas')
        self.assertIn(urllib.parse.quote('不是 Jadmin 管理员'), location)

    def test_link_subject_and_link_tokens(self):
        c = memory_db()
        enterprise.link_subject(c, 'A@acme.cn', 'cas-1')
        self.assertEqual(enterprise.bound_email(c, 'cas-1'), 'a@acme.cn')
        enterprise.link_subject(c, 'a@acme.cn', 'cas-2')
        self.assertIsNone(enterprise.bound_email(c, 'cas-1'))
        with self.assertRaises(enterprise.EnterpriseError) as taken:
            enterprise.link_subject(c, 'b@acme.cn', 'cas-2')
        self.assertEqual(taken.exception.status, 409)
        self.assertEqual(enterprise.unlink(c, 'A@acme.cn'), 1)
        self.assertIsNone(enterprise.bound_email(c, 'cas-2'))
        token = enterprise.create_link(c, 'a@acme.cn')
        self.assertIsNone(c.execute('select 1 from sso_links where token=?', (token,)).fetchone())
        self.assertEqual(enterprise.consume_link(c, token), 'a@acme.cn')
        with self.assertRaises(enterprise.EnterpriseError):
            enterprise.consume_link(c, token)
        old = enterprise.create_link(c, 'a@acme.cn')
        c.execute('update sso_links set created=?', (int(time.time()) - enterprise.LINK_SECONDS - 1,))
        with self.assertRaises(enterprise.EnterpriseError):
            enterprise.consume_link(c, old)

    def test_provider_hint_follows_login_im(self):
        params = urllib.parse.parse_qs(urllib.parse.urlsplit(self.start()['Location']).query)
        self.assertEqual(params['provider_hint'], ['provider_lark'])
        with contextlib.closing(server.db()) as c:
            enterprise.set_login_im(c, 'dingtalk')
        params = urllib.parse.parse_qs(urllib.parse.urlsplit(self.start()['Location']).query)
        self.assertEqual(params['provider_hint'], ['provider_dingtalk'])

    def test_sso_start_rate_limit(self):
        for _ in range(server.SSO_START_LIMIT):
            self.start(headers={'X-Forwarded-For': '198.51.100.1, 203.0.113.9'})
        status, headers, _ = call('GET', '/api/sso/start', headers={'X-Forwarded-For': '198.51.100.2, 203.0.113.9'})
        self.assertEqual(status, 429)
        self.assertEqual(headers['Retry-After'], str(server.SSO_START_WINDOW))
        self.start(headers={'X-Forwarded-For': '203.0.113.10'})

    def test_security_headers(self):
        status, headers, _ = call('GET', '/')
        self.assertEqual(status, 200)
        self.assertEqual((headers['X-Frame-Options'], headers['X-Content-Type-Options'], headers['Referrer-Policy']), ('DENY', 'nosniff', 'no-referrer'))
        csp = headers['Content-Security-Policy']
        self.assertIn("frame-ancestors 'none'", csp)
        script_src = re.search(r"script-src ([^;]+)", csp).group(1)
        self.assertNotIn('unsafe-inline', script_src)
        for h in server.script_hashes(server.HTML):
            self.assertIn(h, script_src)
        self.assertEqual(len(server.script_hashes(server.HTML)), 5)
        self.assertNotIn("$('rows').innerHTML", server.HTML)
        self.assertIn('nosniff', call('GET', '/api/sso/status')[1]['X-Content-Type-Options'])

    def test_sqlite_uses_wal(self):
        with contextlib.closing(server.db()) as c:
            self.assertEqual(c.execute('pragma journal_mode').fetchone()[0].lower(), 'wal')

    def test_departments_api_bridge_feed_and_directory(self):
        auth = self.auth()
        status, _, body = call('POST', '/api/admin/departments', {'code': 'design', 'name': '设计部', 'groups': 'acme/design', 'japiGroupId': 7}, auth)
        self.assertEqual(status, 200)
        self.assertEqual(body['departments'][0]['code'], 'design')
        self.assertEqual(call('POST', '/api/admin/departments', {'code': 'x', 'name': 'bad'}, auth)[0], 400)
        self.assertEqual(call('POST', '/api/admin/assignments', {'email': 'bob@acme.cn', 'code': 'design'}, auth)[0], 200)
        self.assertEqual(call('GET', '/api/internal/departments')[0], 401)
        self.assertEqual(call('GET', '/api/internal/departments', headers={'X-Internal-Token': 'wrong'})[0], 401)
        status, _, feed = call('GET', '/api/internal/departments', headers={'X-Internal-Token': 'bridge-token'})
        self.assertEqual(status, 200)
        self.assertEqual(feed['assignments'], {'bob@acme.cn': 'design'})
        self.assertEqual(feed['departments'][0], {'code': 'design', 'name': '设计部', 'groups': ['acme/design'], 'japiGroupId': 7})
        self.assertEqual(feed['loginProvider'], {'type': 'lark', 'name': 'provider_lark'})
        status, _, report = call('GET', '/api/admin/directory', headers=auth)
        self.assertEqual(status, 200)
        self.assertEqual(report['total'], 4)
        status, _, audit = call('GET', '/api/admin/audit', headers=auth)
        self.assertIn('department_save', [a['action'] for a in audit['audit']])
        self.assertEqual(call('GET', '/api/admin/departments')[0], 401)

    def test_login_im_without_admin_credentials(self):
        auth = self.auth()
        self.assertEqual(call('GET', '/api/admin/login-im')[0], 401)
        status, _, body = call('GET', '/api/admin/login-im', headers=auth)
        self.assertEqual(status, 200)
        self.assertEqual((body['im'], body['provider'], body['sync']['status'], body['sync']['configured']), ('lark', 'provider_lark', 'unknown', False))
        self.assertEqual([a['status'] for a in body['sync']['apps']], ['unknown'] * 3)
        self.assertEqual(body['wecomRisk']['unbound'], 3)
        self.assertEqual([o['type'] for o in body['options']], ['lark', 'wecom', 'dingtalk'])
        self.assertEqual(call('POST', '/api/admin/login-im', {'im': 'slack'}, auth)[0], 400)
        status, _, body = call('POST', '/api/admin/login-im', {'im': 'dingtalk'}, auth)
        self.assertEqual(status, 200)
        self.assertEqual((body['saved'], body['sync']['status']), (True, 'manual'))
        self.assertTrue(any('provider_dingtalk' in s for s in body['sync']['steps']))
        self.assertEqual(FakeCasdoor.updates, [])
        self.assertEqual(call('GET', '/api/admin/login-im', headers=auth)[2]['im'], 'dingtalk')
        self.assertEqual(call('GET', '/api/internal/departments', headers={'X-Internal-Token': 'bridge-token'})[2]['loginProvider'], {'type': 'dingtalk', 'name': 'provider_dingtalk'})
        self.assertIn('login_im_set', [a['action'] for a in call('GET', '/api/admin/audit', headers=auth)[2]['audit']])

    def test_switch_to_wecom_requires_confirm(self):
        auth = self.auth()
        status, _, body = call('POST', '/api/admin/login-im', {'im': 'wecom'}, auth)
        self.assertEqual(status, 409)
        self.assertTrue(body['needConfirm'])
        self.assertEqual(body['wecomRisk']['unbound'], 3)
        self.assertEqual(call('GET', '/api/admin/login-im', headers=auth)[2]['im'], 'lark')
        self.assertEqual(call('POST', '/api/admin/login-im', {'im': 'wecom', 'confirm': 'yes'}, auth)[0], 409)
        status, _, body = call('POST', '/api/admin/login-im', {'im': 'wecom', 'confirm': True}, auth)
        self.assertEqual((status, body['im'], body['previous']), (200, 'wecom', 'lark'))

    def test_casdoor_sync_request_body(self):
        auth = self.auth()
        with casdoor_admin():
            status, _, body = call('GET', '/api/admin/login-im', headers=auth)
            # Each app lists both Lark and WeCom: not the single chosen provider.
            self.assertEqual(body['sync']['status'], 'mismatch')
            self.assertEqual(body['sync']['apps'][0]['providers'], ['provider_lark', 'provider_wecom'])
            status, _, body = call('POST', '/api/admin/login-im', {'im': 'wecom', 'confirm': True}, auth)
            self.assertEqual(status, 200, body)
            self.assertEqual(body['sync'], {'configured': True, 'status': 'ok', 'apps': [{'app': a, 'ok': True} for a in ('jchat', 'jimage', 'jadmin')], 'failed': []})
            self.assertEqual(len(FakeCasdoor.updates), 3)
            for update, app in zip(FakeCasdoor.updates, ('jchat', 'jimage', 'jadmin')):
                self.assertEqual(update['query']['id'], ['admin/' + app])
                self.assertEqual(update['query']['columns'], ['providers'])
                sent = update['body']
                self.assertEqual((sent['name'], sent['clientSecret'], sent['enableSignUp']), (app, app + '-secret', True))
                self.assertEqual([i['name'] for i in sent['providers']], ['provider_captcha_default', 'provider_wecom', 'provider_email'])
                self.assertEqual(sent['providers'][0], casdoor_apps()[app]['providers'][0])
                self.assertEqual(sent['providers'][2], casdoor_apps()[app]['providers'][3])
                chosen = sent['providers'][1]
                self.assertEqual({k: chosen[k] for k in ('canSignUp', 'canSignIn', 'canUnlink', 'prompted', 'rule', 'bindingRule')},
                                 {'canSignUp': True, 'canSignIn': True, 'canUnlink': False, 'prompted': False, 'rule': 'None', 'bindingRule': ['Name']})
            status, _, body = call('GET', '/api/admin/login-im', headers=auth)
            self.assertEqual(body['sync']['status'], 'ok')
            # Lark and DingTalk merge accounts by verified email/phone.
            FakeCasdoor.updates = []
            self.assertEqual(call('POST', '/api/admin/login-im', {'im': 'dingtalk'}, auth)[0], 200)
            self.assertEqual(FakeCasdoor.updates[0]['body']['providers'][1]['bindingRule'], ['Email', 'Phone'])
            # One failing and one masked (not global admin) application are reported by name.
            FakeCasdoor.updates = []
            FakeCasdoor.fail_update = {'jimage'}
            FakeCasdoor.apps['jadmin']['clientSecret'] = '***'
            status, _, body = call('POST', '/api/admin/login-im', {'im': 'lark'}, auth)
            self.assertEqual(status, 502)
            self.assertEqual(body['sync']['failed'], ['jimage', 'jadmin'])
            self.assertIn('jimage（', body['error'])
            self.assertIn('jadmin（', body['error'])
            self.assertTrue(body['saved'])
            self.assertEqual([u['query']['id'][0] for u in FakeCasdoor.updates], ['admin/jchat', 'admin/jimage'])
            self.assertEqual(call('GET', '/api/admin/login-im', headers=auth)[2]['im'], 'lark')

    def test_credentials_are_masked(self):
        with open(server.LCENV, 'w') as f:
            f.write('ZHITOUZHUAN_API_KEY=sk-abcdefghijklmnopqrstuvwxyz\n')
        original = server.sub2api_request
        server.sub2api_request = lambda path, *a, **k: {'data': {'items': [{'id': 1, 'name': 'team', 'key': 'sk-japi-0123456789abcdef'}]}}
        try:
            status, _, body = call('GET', '/api/admin/credentials', headers=self.auth())
        finally:
            server.sub2api_request = original
        self.assertEqual(status, 200)
        raw = json.dumps(body, ensure_ascii=False)
        for secret in ('owner-password', 'sk-abcdefghijklmnopqrstuvwxyz', 'sk-japi-0123456789abcdef'):
            self.assertNotIn(secret, raw)
        self.assertEqual(body['librechatApiKey'], 'sk-abcd…wxyz')
        self.assertEqual(body['keys']['data']['items'][0]['keyMasked'], 'sk-japi…cdef')
        self.assertEqual(body['adminLogin'], {'email': 'owner@acme.cn', 'passwordConfigured': True})
        self.assertEqual(server.mask('short'), '****')

    def test_env_newline_injection_is_rejected(self):
        auth = self.auth()
        original = 'ZHITOUZHUAN_API_KEY=sk-old\nDOMAIN_CLIENT=https://chat.example\n'
        with open(server.LCENV, 'w') as f:
            f.write(original)
        with open(server.LCYAML, 'w') as f:
            f.write('baseURL: "http://old"\ndefault: [m1]\n')
        for payload in ({'apiKey': 'sk-new\nALLOW_REGISTRATION=true'}, {'apiKey': 'sk-new\r'}, {'apiKey': 'sk\0'},
                        {'baseURL': 'http://x\ninjected: 1'}, {'defaultModel': 'm2\nother: 1'}, {'defaultModel': 'm2], [x'}):
            status, _, body = call('POST', '/api/config', payload, auth)
            self.assertEqual(status, 400, payload)
        with open(server.LCENV) as f:
            self.assertEqual(f.read(), original)
        with self.assertRaises(ValueError):
            server.save_endpoint(api_key='a\nb')
        server.save_endpoint(base_url='http://new\\1', api_key='sk-new')
        with open(server.LCENV) as f:
            self.assertIn('ZHITOUZHUAN_API_KEY=sk-new\n', f.read())
        with open(server.LCYAML) as f:
            self.assertIn('baseURL: "http://new\\\\1"', f.read())

    def test_short_secret_never_validates_tokens(self):
        token = server.tok('owner@acme.cn')
        self.assertEqual(server.who(token), 'owner@acme.cn')
        original = server.KEY
        try:
            server.KEY = ''
            self.assertIsNone(server.who(token))
        finally:
            server.KEY = original


if __name__ == '__main__':
    unittest.main()
