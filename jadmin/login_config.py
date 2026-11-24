"""Immutable login revisions and recoverable, single-flight Casdoor transitions."""
import base64
import copy
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

from casdoor_admin import AdminClient, AdminError, APPS, TYPES, NoRedirect, request_json, trusted_url

DRAIN_SECONDS = 360
TEST_SECONDS = 600


def fail(code, status=409, **data):
    from enterprise import EnterpriseError
    raise EnterpriseError(code, status, dict(code=code, **data))


def init_db(c):
    c.execute('''create table if not exists login_provider_revisions (
        id integer primary key autoincrement, im text not null, casdoor_name text unique not null,
        client_id text not null, app_id text not null default '', email_domains text not null default '[]',
        use_id_as_name integer not null default 0, secret_source text not null, created_at integer not null,
        created_by text not null, role text not null default 'draft', cred_test_status text not null default 'untested',
        cred_test_code text, cred_test_at integer, signin_test_status text not null default 'untested',
        signin_test_at integer, signin_test_by text, signin_test_subject text)''')
    c.execute('''create table if not exists login_operations (
        id integer primary key autoincrement, kind text not null, actor text not null, revision_id integer,
        snapshot_json text not null, status text not null, phase text not null, results_json text not null default '{}',
        created_at integer not null, updated_at integer not null, commit_at integer, feed_served_at integer)''')
    c.execute('''create table if not exists login_test_attempts (
        attempt_id text primary key, revision_id integer not null, actor text not null, stage_op_id integer not null,
        session_exp integer not null, session_epoch text not null, created integer not null, status text not null,
        reason text, finished_at integer, subject text)''')
    if 'session_epoch' not in {r[1] for r in c.execute('pragma table_info(login_test_attempts)')}:
        c.execute("alter table login_test_attempts add column session_epoch text not null default ''")
    cols = {r[1] for r in c.execute('pragma table_info(sso_states)')}
    for name, kind in [('purpose', 'text'), ('nonce_hash', 'text'), ('test_revision_id', 'integer'), ('test_actor', 'text'), ('test_stage_op_id', 'integer'), ('attempt_id', 'text')]:
        if name not in cols:
            c.execute('alter table sso_states add column ' + name + ' ' + kind)
    c.commit()


def get(c, key, default=None):
    row = c.execute('select v from enterprise_settings where k=?', (key,)).fetchone()
    return row[0] if row else default


def put(c, key, value, now=None):
    if value is None:
        c.execute('delete from enterprise_settings where k=?', (key,))
    else:
        c.execute('insert into enterprise_settings(k,v,updated) values(?,?,?) on conflict(k) do update set v=excluded.v,updated=excluded.updated', (key, str(value), int(time.time()) if now is None else int(now)))


def cleanup_tests(c, now=None):
    now = int(time.time() if now is None else now)
    c.execute('delete from sso_states where created<?', (now - TEST_SECONDS,))
    c.execute("update login_test_attempts set status='failed',reason='expired',finished_at=? where status='pending' and created<?", (now, now - TEST_SECONDS))
    c.commit()


def invalidate_tests(c, now):
    c.execute("delete from sso_states where purpose='login_test'")
    c.execute("update login_test_attempts set status='failed',reason='stale_staging',finished_at=? where status='pending'", (int(now),))


def recover_startup(c):
    cleanup_tests(c)
    rows = c.execute("select id,phase from login_operations where status='running'").fetchall()
    for row in rows:
        if row['phase'] in ('draining', 'cleanup', 'cleanup_incomplete'):
            if row['phase'] == 'cleanup':
                c.execute("update login_operations set phase='cleanup_incomplete' where id=?", (row['id'],))
            continue
        c.execute("update login_operations set status='interrupted',updated_at=? where id=?", (int(time.time()), row['id']))
        put(c, 'login_state', 'unknown')
    c.commit()


def revision(c, ident):
    try:
        ident = int(ident)
    except (ValueError, TypeError):
        fail('revision_not_found', 404)
    row = c.execute('select * from login_provider_revisions where id=?', (ident,)).fetchone()
    if not row:
        fail('revision_not_found', 404)
    return dict(row)


def public_revision(row):
    mapping = {'casdoor_name': 'casdoorName', 'client_id': 'clientId', 'app_id': 'appId', 'email_domains': 'emailDomains', 'use_id_as_name': 'useIdAsName', 'secret_source': 'secretSource', 'created_at': 'createdAt', 'created_by': 'createdBy', 'cred_test_status': 'credTestStatus', 'cred_test_code': 'credTestCode', 'cred_test_at': 'credTestAt', 'signin_test_status': 'signinTestStatus', 'signin_test_at': 'signinTestAt', 'signin_test_by': 'signinTestBy', 'signin_test_subject': 'signinTestSubject'}
    out = {mapping.get(k, k): v for k, v in dict(row).items()}
    out['emailDomains'] = json.loads(out['emailDomains'])
    out['useIdAsName'] = bool(out['useIdAsName'])
    return out


def operation(c, ident=None):
    row = c.execute('select * from login_operations ' + ('where id=?' if ident is not None else 'order by id desc limit 1'), (ident,) if ident is not None else ()).fetchone()
    if not row:
        return None
    out = dict(row)
    out['snapshot'] = json.loads(out.pop('snapshot_json'))
    out['results'] = json.loads(out.pop('results_json'))
    return out


def live_guard(cfg):
    url = cfg.get('expectedIssuer') or os.environ.get('CASDOOR_EXPECTED_ISSUER', '')
    if not url:
        return False
    try:
        trusted_url(url)
        req = urllib.request.Request(url.rstrip('/') + '/api/signup', data=b'{}', headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(req, timeout=10) as response:
                return response.status == 403 and response.headers.get('X-Qyos-Signup-Guard') == 'jadmin07'
        except urllib.error.HTTPError as e:
            return e.code == 403 and e.headers.get('X-Qyos-Signup-Guard') == 'jadmin07'
    except (AdminError, urllib.error.URLError, OSError):
        return False


def domain_regex(domains):
    return r'^[^@\s]+@(' + '|'.join(re.escape(d) for d in domains) + ')$' if domains else ''


def safe_providers(items):
    result = copy.deepcopy(items or [])
    for item in result:
        if not isinstance(item, dict):
            fail('providers_invalid', 502)
        embedded = item.get('provider')
        if isinstance(embedded, dict):
            item['provider'] = {k: embedded[k] for k in ('type', 'category', 'name', 'owner') if k in embedded}
    return result


def provider_refs(items):
    return [{k: v for k, v in item.items() if k != 'provider'} for item in (items or [])]


def trusted_token_endpoint(url, issuer):
    # The approved direct local exchange is an explicit weaker transport case.
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', '::1', 'localhost'):
        return trusted_url(url)
    return trusted_url(url, issuer)


def setup_summary(cfg):
    def origin(value):
        if not isinstance(value, str) or not value or re.search(r'[\s\x00-\x1f\x7f]', value):
            return None, 'issuer_missing'
        try:
            parsed = urllib.parse.urlsplit(value)
            if parsed.scheme != 'https':
                return None, 'issuer_not_https'
            trusted_url(value)
            if parsed.path not in ('', '/'):
                return None, 'issuer_has_path'
            host = parsed.hostname
            if ':' in host:
                host = '[' + host + ']'
            if parsed.port is not None:
                host += ':' + str(parsed.port)
            return 'https://' + host, None
        except (AdminError, ValueError, TypeError):
            return None, 'issuer_missing'

    issuer, reason = origin(cfg.get('expectedIssuer'))
    jadmin, _ = origin(cfg.get('origin'))
    return {'casdoorCallback': issuer + '/callback' if issuer else None,
            'casdoorHost': urllib.parse.urlsplit(issuer).netloc if issuer else None,
            'jadminCallback': jadmin + '/api/sso/callback' if jadmin else None,
            'reason': reason}


class Service:
    def __init__(self, c, cfg=None, client=None, clock=None, guard_check=None, directory=None, vendor_request=None, owner_checker=None):
        from enterprise import settings, casdoor_users
        self.c, self.cfg = c, cfg or settings()
        self.client = client or AdminClient(self.cfg)
        self.clock = clock or time.time
        self.guard_check = guard_check or (lambda: live_guard(self.cfg))
        self.directory = directory or (lambda: casdoor_users(self.cfg))
        self.vendor_request = vendor_request or request_json
        self.owner_checker = owner_checker

    def now(self):
        return int(self.clock())

    def _guard(self):
        if not self.guard_check():
            fail('edge_guard_missing')

    def _not_paused(self):
        if get(self.c, 'signup_paused') == '1':
            fail('signup_paused')

    def _locked(self, recovery=False):
        self.c.execute('begin immediate')
        if self.c.execute("select 1 from login_operations where status='running'").fetchone():
            self.c.rollback()
            fail('operation_running')
        if not recovery and get(self.c, 'login_state', 'consistent') != 'consistent':
            self.c.rollback()
            fail('needs_attention')

    def _snapshot(self, apps):
        # Whitelist snapshot fields; never persist application client secrets.
        values = {}
        for app in apps:
            obj = self.client.get_application(app)
            values[app] = {k: copy.deepcopy(obj.get(k)) for k in ('providers', 'enableSignUp', 'signupItems')}
            values[app]['providers'] = safe_providers(obj.get('providers'))
        local = {k: get(self.c, k) for k in ('login_im', 'active_revision_id', 'staged_revision_id', 'staged_operation_id', 'login_detached', 'signup_paused', 'signup_resume_flags')}
        roles = {str(r['id']): r['role'] for r in self.c.execute('select id,role from login_provider_revisions')}
        return {'apps': values, 'local': local, 'roles': roles}

    def _begin(self, kind, actor, rev=None, apps=APPS, recovery=False, results=None):
        self._locked(recovery)
        try:
            if kind in ('stage', 'activate', 'restore'):
                self._not_paused()
            if kind == 'signup_pause' and get(self.c, 'signup_paused') == '1':
                fail('signup_already_paused')
            if kind == 'signup_resume' and get(self.c, 'signup_paused') != '1':
                fail('signup_not_paused')
            now = self.now()
            cur = self.c.execute("insert into login_operations(kind,actor,revision_id,snapshot_json,status,phase,results_json,created_at,updated_at) values(?,?,?,?,'running','snapshot',?,?,?)", (kind, actor, rev, json.dumps({'apps': {}, 'local': {}, 'roles': {}}), json.dumps(results or {}), now, now))
            ident = cur.lastrowid
            self.c.commit()  # claim single flight, release writer lock before network
        except Exception:
            self.c.rollback()
            raise
        try:
            snap = self._snapshot(apps)
            self.c.execute("update login_operations set snapshot_json=?,phase='attach',updated_at=? where id=?", (json.dumps(snap), self.now(), ident))
            self.c.commit()  # durable complete snapshot before any external write
        except Exception:
            self.c.execute("update login_operations set status='compensated',phase='snapshot_failed',updated_at=? where id=?", (self.now(), ident))
            self.c.commit()
            raise
        return operation(self.c, ident)

    def _save_op(self, op, **changes):
        allowed = {'status', 'phase', 'commit_at', 'feed_served_at'}
        for key, value in changes.items():
            if key in allowed:
                self.c.execute('update login_operations set ' + key + '=? where id=?', (value, op['id']))
                op[key] = value
        self.c.execute('update login_operations set results_json=?,updated_at=? where id=?', (json.dumps(op['results']), self.now(), op['id']))
        self.c.commit()

    def _write(self, app, providers=None, signup=None):
        self.client.update_application(app, providers=providers, enable_signup=signup)
        obj = self.client.get_application(app)
        if providers is not None and provider_refs(obj.get('providers')) != provider_refs(providers):
            fail('readback_mismatch', 502)
        if signup is not None and bool(obj.get('enableSignUp')) != signup:
            fail('readback_mismatch', 502)

    def _compensate(self, op):
        errors = []
        for app, snap in reversed(list(op['snapshot']['apps'].items())):
            try:
                signup_only = op['kind'].startswith('signup_')
                self._write(app, None if signup_only else snap['providers'], bool(snap['enableSignUp']))
            except Exception:
                errors.append(app)
        op['results']['compensationFailures'] = errors
        put(self.c, 'login_state', 'needs_attention' if errors else 'consistent', self.now())
        self._save_op(op, status='compensation_failed' if errors else 'compensated', phase='compensation')
        return not errors

    def _is_im(self, item):
        return isinstance(item, dict) and (item.get('name') in set(self.cfg.get('imProviders', {}).values()) or bool(re.fullmatch(r'qyos_(lark|wecom|dingtalk)_r[0-9]{1,6}', str(item.get('name', '')))) or (isinstance(item.get('provider'), dict) and item['provider'].get('type') in TYPES.values()))

    def _item(self, rev):
        return {'owner': 'admin', 'name': rev['casdoor_name'], 'canSignUp': True, 'canSignIn': True, 'canUnlink': False, 'bindingRule': ['Name'] if rev['im'] == 'wecom' else ['Email', 'Phone'], 'countryCodes': [], 'prompted': False, 'signupGroup': '', 'rule': 'None', 'provider': None}

    def _providers(self, app, rev, keep_old):
        current = copy.deepcopy(app.get('providers') or [])
        if not all(isinstance(x, dict) and x.get('name') for x in current):
            fail('providers_invalid', 502)
        if not keep_old:
            current = [x for x in current if not self._is_im(x)]
        if rev:
            current = [x for x in current if x.get('name') != rev['casdoor_name']]
            current.append(self._item(rev))
        return current

    def _verify_provider(self, rev):
        obj = self.client.get_provider(rev['casdoor_name'])
        expected = {'type': TYPES[rev['im']], 'category': 'OAuth', 'clientId': rev['client_id'], 'emailRegex': domain_regex(json.loads(rev['email_domains']))}
        if rev['im'] == 'wecom':
            expected.update(appId=rev['app_id'], subType='Internal', method='Normal', disableSsl=bool(rev['use_id_as_name']))
        if any(obj.get(k, '' if isinstance(v, str) else None) != v for k, v in expected.items()):
            fail('provider_drift')
        return obj

    def continuity(self, im):
        try:
            users = self.directory()
        except Exception:
            fail('directory_unavailable', 503)
        if not isinstance(users, list):
            fail('directory_unavailable', 503)
        out = {'checked': True, 'at': self.now(), 'total': 0, 'alreadyLinked': 0, 'possibleMatch': 0, 'noBasis': 0, 'estimate': True, 'note': 'Matching depends on data verified by the vendor at sign-in; email also requires EmailVerified or a RegisterType other than Application Signup.'}
        for user in users:
            if not isinstance(user, dict) or user.get('isDeleted'):
                continue
            out['total'] += 1
            if user.get(im):
                out['alreadyLinked'] += 1
            elif (im == 'wecom' and re.fullmatch(r'[A-Za-z0-9_@.\-]{1,64}', str(user.get('name') or ''))) or (im != 'wecom' and ((user.get('email') and (user.get('emailVerified') or user.get('registerType') != 'Application Signup')) or user.get('phone'))):
                out['possibleMatch'] += 1
            else:
                out['noBasis'] += 1
        return out

    def save_revision(self, data, actor, *, test_on_save=False):
        allowed = {'im', 'clientId', 'clientSecret', 'copySecretFrom', 'emailDomains', 'appId', 'useIdAsName'}
        if not isinstance(data, dict) or set(data) - allowed:
            fail('platform_fields_invalid', 400)
        im = data.get('im')
        if not isinstance(im, str) or im not in TYPES:
            fail('im_invalid', 400)
        if im != 'wecom' and (data.get('appId', '') != '' or
                              (data.get('useIdAsName') is not None and data.get('useIdAsName') is not False)):
            fail('platform_fields_invalid', 400)
        cid = data.get('clientId')
        aid = data.get('appId') if im == 'wecom' else ''
        use_id_as_name = im == 'wecom'
        if not isinstance(cid, str) or not re.fullmatch(r'[^\s\x00-\x1f\x7f]{1,512}', cid):
            fail('credential_fields_invalid', 400)
        if im == 'wecom' and (not isinstance(aid, str) or not re.fullmatch(r'[^\s\x00-\x1f\x7f]{1,512}', aid) or data.get('useIdAsName') is not True):
            fail('credential_fields_invalid', 400)
        domains = data.get('emailDomains') or []
        if not isinstance(domains, list) or len(domains) > 30:
            fail('email_domains_invalid', 400)
        domains = sorted(set(str(x).strip().lower() for x in domains))
        if any(not re.fullmatch(r'(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}', d) or '..' in d for d in domains):
            fail('email_domains_invalid', 400)
        if ('clientSecret' in data) == ('copySecretFrom' in data):
            fail('secret_invalid', 400)
        secret = data.get('clientSecret')
        source = 'entered'
        if 'clientSecret' in data and (not isinstance(secret, str) or not secret or len(secret) > 8192 or
                                       secret != secret.strip() or re.search(r'[\x00-\x1f\x7f-\x9f]', secret)):
            fail('secret_invalid', 400)
        old = None
        self._locked()
        try:
            if 'copySecretFrom' in data:
                copy_id = data['copySecretFrom']
                if not ((type(copy_id) is int and copy_id > 0) or
                        (isinstance(copy_id, str) and re.fullmatch(r'[0-9]{1,6}', copy_id))):
                    fail('secret_source_invalid', 400)
                row = self.c.execute('select * from login_provider_revisions where id=?', (str(copy_id),)).fetchone()
                if not row or row['im'] != im or row['role'] in ('provisioning', 'retired') or row['client_id'] != cid or (im == 'wecom' and row['app_id'] != aid):
                    fail('secret_source_invalid', 400)
                old = dict(row)
                source = 'copied:' + str(old['id'])
            ident = self.c.execute("select max(coalesce((select seq from sqlite_sequence where name='login_provider_revisions'),0),coalesce((select max(id) from login_provider_revisions),0),coalesce((select max(revision_id) from login_operations),0))+1").fetchone()[0]
            if ident > 999999:
                fail('revision_limit')
            name = 'qyos_%s_r%d' % (im, ident)
            # Reserve names before external creation so crashes never reuse one.
            self.c.execute("insert into login_provider_revisions(id,im,casdoor_name,client_id,app_id,email_domains,use_id_as_name,secret_source,created_at,created_by,role) values(?,?,?,?,?,?,?,?,?,?,'provisioning')", (ident, im, name, cid, aid, json.dumps(domains), use_id_as_name, source, self.now(), actor))
            cur = self.c.execute("insert into login_operations(kind,actor,revision_id,snapshot_json,status,phase,created_at,updated_at) values('save_revision',?,?,?,'running','create_provider',?,?)", (actor, ident, json.dumps({'apps': {}, 'local': {}, 'roles': {}}), self.now(), self.now()))
            op_id = cur.lastrowid
            self.c.commit()
        except Exception:
            self.c.rollback()
            raise
        op = operation(self.c, op_id)
        try:
            if old:
                secret = self.client.get_provider(old['casdoor_name']).get('clientSecret')
                if not secret or secret == '***':
                    fail('secret_unavailable')
            self.client.add_provider(name=name, im=im, client_id=cid, client_secret=secret, app_id=aid, email_regex=domain_regex(domains), use_id_as_name=use_id_as_name)
            self._verify_provider(revision(self.c, ident))
            self.c.execute("update login_provider_revisions set role='draft' where id=?", (ident,))
            if test_on_save:
                self.c.execute("delete from login_provider_revisions where role in ('draft','retired') and id!=?", (ident,))
            self._save_op(op, status='done', phase='created')
        except Exception:
            self.c.execute("update login_provider_revisions set role='retired' where id=?", (ident,))
            self._save_op(op, status='compensated', phase='create_failed')
            raise
        result = {}
        if test_on_save:
            from enterprise import EnterpriseError
            try:
                result['credentialTest'] = self.test_credentials(ident, actor, supplied_secret=secret)
            except (AdminError, EnterpriseError) as exc:
                code = exc.data.get('code') if isinstance(exc, EnterpriseError) else exc.code
                result['credentialTest'] = {'ok': False, 'code': code}
        result['revision'] = public_revision(revision(self.c, ident))
        return result

    def test_credentials(self, ident, actor, *, supplied_secret=None):
        rev = revision(self.c, ident)
        obj = self._verify_provider(rev)
        secret = supplied_secret if supplied_secret is not None else obj.get('clientSecret')
        if not secret or secret == '***':
            fail('secret_unavailable')
        op = self._begin('test_credentials', actor, rev['id'], apps=())
        im = rev['im']
        urls = {'lark': 'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', 'dingtalk': 'https://api.dingtalk.com/v1.0/oauth2/accessToken', 'wecom': 'https://qyapi.weixin.qq.com/cgi-bin/gettoken'}
        code, ok = 'unavailable', False
        try:
            if im == 'wecom':
                value = self.vendor_request(urls[im] + '?' + urllib.parse.urlencode({'corpid': rev['client_id'], 'corpsecret': secret}))
                ok = value.get('errcode', 0) == 0 and bool(value.get('access_token'))
                code = str(value.get('errcode', 0))
            else:
                body = {'app_id': rev['client_id'], 'app_secret': secret} if im == 'lark' else {'appKey': rev['client_id'], 'appSecret': secret}
                value = self.vendor_request(urls[im], {'Content-Type': 'application/json'}, json.dumps(body).encode())
                ok = (value.get('code') == 0 and bool(value.get('app_access_token'))) if im == 'lark' else bool(value.get('accessToken'))
                code = str(value.get('code', 'ok' if ok else 'rejected'))
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', code):
                code = 'rejected'
        except Exception:
            code = 'unavailable'
        self.c.execute('update login_provider_revisions set cred_test_status=?,cred_test_code=?,cred_test_at=? where id=?', ('passed' if ok else 'failed', code, self.now(), rev['id']))
        self._save_op(op, status='done', phase='tested')
        return {'ok': ok, 'vendorCode': code, 'at': self.now()}

    def stage(self, ident, actor):
        rev = revision(self.c, ident)
        self._not_paused()
        if rev['role'] not in ('draft', 'previous'):
            fail('revision_not_stageable')
        self._guard()
        self._verify_provider(rev)
        if get(self.c, 'staged_revision_id'):
            fail('staging_exists')
        op = self._begin('stage', actor, rev['id'], ('jadmin',))
        try:
            snap = op['snapshot']['apps']['jadmin']
            self._write('jadmin', self._providers(snap, rev, True), True)
            invalidate_tests(self.c, self.now())
            put(self.c, 'staged_revision_id', rev['id'])
            put(self.c, 'staged_operation_id', op['id'])
            self.c.execute("update login_provider_revisions set role='staged' where id=? and role!='active'", (rev['id'],))
            self._save_op(op, status='done', phase='staged')
        except Exception:
            self._compensate(op)
            raise
        return {'operation': operation(self.c, op['id']), 'revision': public_revision(revision(self.c, rev['id']))}

    def cancel_stage(self, actor):
        source = operation(self.c, get(self.c, 'staged_operation_id'))
        if not source or source['kind'] != 'stage':
            fail('staging_missing')
        op = self._begin('cancel_stage', actor, apps=('jadmin',))
        try:
            snap = source['snapshot']['apps']['jadmin']
            self._write('jadmin', snap['providers'], bool(snap['enableSignUp']))
            ident = get(self.c, 'staged_revision_id')
            self.c.execute("update login_provider_revisions set role='draft' where id=? and role='staged'", (ident,))
            put(self.c, 'staged_revision_id', None)
            put(self.c, 'staged_operation_id', None)
            invalidate_tests(self.c, self.now())
            self._save_op(op, status='done', phase='cancelled')
        except Exception:
            self._compensate(op)
            raise
        return {'operation': operation(self.c, op['id'])}

    def transition(self, ident, actor, data, kind='activate', restore_local=None):
        rev = revision(self.c, ident) if ident is not None else None
        if kind != 'detach':
            self._not_paused()
            self._guard()
        desired_legacy = kind == 'restore' and restore_local is not None and rev is None
        if rev:
            self._verify_provider(rev)
            if rev['cred_test_status'] != 'passed' or rev['signin_test_status'] != 'passed':
                if not data.get('overrideTests') or not str(data.get('overrideReason') or '').strip():
                    fail('tests_missing')
            continuity = self.continuity(rev['im'])
            if continuity['total'] and data.get('confirm') is not True:
                fail('needs_confirmation', continuity=continuity, needConfirm=True)
        else:
            continuity = self.continuity(get(self.c, 'login_im', 'lark')) if desired_legacy else {'checked': False, 'note': 'Detach retains the last email policy until provider removal.'}
            if desired_legacy and continuity['total'] and data.get('confirm') is not True:
                fail('needs_confirmation', continuity=continuity, needConfirm=True)
        detach_guard_missing = kind == 'detach' and not self.guard_check()
        op = self._begin(kind, actor, rev['id'] if rev else None, results={'continuity': continuity, 'overrideReason': str(data.get('overrideReason') or '')[:500], 'restoreLocal': restore_local, 'signupClosedBeforeDrain': detach_guard_missing})
        try:
            for app, snap in op['snapshot']['apps'].items():
                if kind == 'detach':
                    if detach_guard_missing:
                        self._write(app, signup=False)
                    continue  # publish detached first; retire old providers after drain
                providers = self._providers(snap, rev, True)
                if desired_legacy:
                    for item in restore_local['apps'][app]['providers'] or []:
                        if self._is_im(item) and item['name'] not in [x['name'] for x in providers]:
                            providers.append(copy.deepcopy(item))
                self._write(app, providers, bool(rev) or (desired_legacy and bool(restore_local['apps'][app]['enableSignUp'])))
            self.c.execute('begin immediate')
            invalidate_tests(self.c, self.now())
            self.c.execute("update login_provider_revisions set role='previous' where role='active'")
            self.c.execute("update login_provider_revisions set role='draft' where role='staged'")
            if rev:
                put(self.c, 'login_im', rev['im'])
                put(self.c, 'active_revision_id', rev['id'])
                put(self.c, 'login_detached', None)
                self.c.execute("update login_provider_revisions set role='active' where id=?", (rev['id'],))
            elif desired_legacy:
                local = restore_local['local']
                put(self.c, 'login_im', local.get('login_im') or 'lark')
                put(self.c, 'active_revision_id', None)
                put(self.c, 'login_detached', local.get('login_detached'))
            else:
                put(self.c, 'active_revision_id', None)
                put(self.c, 'login_detached', '1')
            put(self.c, 'staged_revision_id', None)
            put(self.c, 'staged_operation_id', None)
            put(self.c, 'login_state', 'consistent')
            self._save_op(op, phase='draining', commit_at=self.now())
        except Exception:
            self.c.rollback()
            if not operation(self.c, op['id']).get('commit_at'):
                self._compensate(op)
            raise
        old_names = {x.get('name') for snap in op['snapshot']['apps'].values() for x in (snap['providers'] or []) if self._is_im(x)}
        if rev:
            old_names.discard(rev['casdoor_name'])
        if not old_names:
            return self.finish(actor, first=True)
        return {'operation': operation(self.c, op['id']), 'draining': True, 'note': 'A served feed is not consumer acknowledgement. An unreachable consumer can keep stale policy indefinitely.'}

    def finish(self, actor, force=False, reason='', first=False):
        self.c.execute('begin immediate')
        op = operation(self.c)
        if op and op['status'] == 'running' and op['phase'] == 'cleanup':
            self.c.rollback()
            fail('operation_running')
        if not op or op['status'] != 'running' or op['phase'] not in ('draining', 'cleanup_incomplete'):
            self.c.rollback()
            fail('cleanup_missing')
        if not first:
            if force and not str(reason).strip():
                self.c.rollback()
                fail('reason_required', 400)
            ready = op['feed_served_at'] and self.now() >= op['feed_served_at'] + DRAIN_SECONDS
            if not ready and not force:
                self.c.rollback()
                fail('drain_pending', feedServedAt=op['feed_served_at'], drainSeconds=DRAIN_SECONDS)
        op['results']['finishReason'] = str(reason)[:500]
        self._save_op(op, phase='cleanup')
        rev = revision(self.c, op['revision_id']) if op['revision_id'] else None
        failures = []
        for app in APPS:
            try:
                actual = self.client.get_application(app)
                signup = bool(rev)
                if op['results'].get('restoreLocal'):
                    signup = bool(op['results']['restoreLocal']['apps'][app]['enableSignUp'])
                desired = self._providers(actual, rev, False)
                if op['results'].get('restoreLocal') and rev is None:
                    desired = copy.deepcopy(op['results']['restoreLocal']['apps'][app]['providers'])
                self._write(app, desired, signup)
            except Exception:
                failures.append(app)
        op['results']['cleanupFailures'] = failures
        if not failures:
            self.c.execute("delete from login_provider_revisions where role!='active'")
        put(self.c, 'login_state', 'needs_attention' if failures else 'consistent')
        self._save_op(op, status='running' if failures else 'done', phase='cleanup_incomplete' if failures else 'done')
        return {'operation': operation(self.c, op['id']), 'ok': not failures}

    def restore(self, ident, actor, data):
        source = operation(self.c, ident)
        if not source or source['kind'] not in ('activate', 'restore', 'detach') or not source.get('commit_at'):
            fail('restore_unavailable')
        previous = source['snapshot']['local'].get('active_revision_id')
        if previous and not self.c.execute('select 1 from login_provider_revisions where id=?', (previous,)).fetchone():
            fail('restore_unavailable')
        return self.transition(previous, actor, data, 'restore', source['snapshot'])

    def clear_unused(self):
        self._locked()
        try:
            if get(self.c, 'staged_revision_id'):
                fail('operation_running')
            active = get(self.c, 'active_revision_id')
            if active and revision(self.c, active)['role'] != 'active':
                fail('needs_attention')
            deleted = self.c.execute("delete from login_provider_revisions where role in ('draft','retired','previous') and id is not ?", (int(active) if active else None,)).rowcount
            self.c.commit()
            return {'removed': deleted}
        except Exception:
            self.c.rollback()
            raise

    def signup(self, actor, resume=False):
        if resume:
            self._guard()
            flags = json.loads(get(self.c, 'signup_resume_flags', '{}'))
            if not flags:
                fail('signup_not_paused')
        else:
            if get(self.c, 'signup_paused') == '1':
                return {'paused': True, 'unchanged': True, 'operation': operation(self.c)}
            flags = None
        op = self._begin('signup_resume' if resume else 'signup_pause', actor)
        try:
            if not resume:
                flags = {app: bool(s['enableSignUp']) for app, s in op['snapshot']['apps'].items()}
            for app in APPS:
                self._write(app, signup=bool(flags[app]) if resume else False)
            put(self.c, 'signup_paused', None if resume else '1')
            put(self.c, 'signup_resume_flags', None if resume else json.dumps(flags))
            self._save_op(op, status='done', phase='done')
        except Exception:
            self._compensate(op)
            raise
        return {'operation': operation(self.c, op['id']), 'paused': not resume}

    def reconcile(self, actor, action):
        old = operation(self.c)
        if not old or old['status'] not in ('interrupted', 'compensation_failed'):
            fail('reconcile_unavailable')
        if action not in ('restore', 'complete'):
            fail('reconcile_action_invalid', 400)
        if action == 'restore':
            self._locked(recovery=True)
            self.c.execute("update login_operations set status='running',phase='compensation' where id=?", (old['id'],))
            self.c.commit()
            self._compensate(old)
            if old['kind'] == 'save_revision':
                self.c.execute("update login_provider_revisions set role='retired' where id=?", (old['revision_id'],))
                self.c.commit()
            return {'operation': operation(self.c, old['id'])}
        # Complete explicitly reconciles observed application state; never guess after restart.
        target = revision(self.c, old['revision_id']) if old['revision_id'] else None
        if old['kind'] not in ('activate', 'restore', 'detach'):
            fail('reconcile_restore_required')
        self._locked(recovery=True)
        self.c.execute("update login_operations set status='running',phase='reconcile' where id=?", (old['id'],))
        self.c.commit()
        expected = target['casdoor_name'] if target else None
        try:
            if target:
                self._verify_provider(target)
            for app in APPS:
                obj = self.client.get_application(app)
                if target and (expected not in [p.get('name') for p in obj.get('providers') or []] or not obj.get('enableSignUp')):
                    fail('reconcile_incomplete')
        except Exception:
            self._save_op(old, status='interrupted', phase='reconcile')
            raise
        if target:
            put(self.c, 'active_revision_id', target['id'])
            put(self.c, 'login_im', target['im'])
            put(self.c, 'login_detached', None)
            self.c.execute("update login_provider_revisions set role='previous' where role='active'")
            self.c.execute("update login_provider_revisions set role='active' where id=?", (target['id'],))
        else:
            put(self.c, 'active_revision_id', None)
            put(self.c, 'login_detached', '1')
        invalidate_tests(self.c, self.now())
        put(self.c, 'staged_revision_id', None)
        put(self.c, 'staged_operation_id', None)
        put(self.c, 'login_state', 'consistent')
        self._save_op(old, status='running', phase='draining', commit_at=self.now())
        return {'operation': operation(self.c, old['id'])}

    def summary(self, actor=None):
        from enterprise import login_provider
        cleanup_tests(self.c, self.now())
        apps, connection = [], {'configured': self.client.configured(), 'ok': False}
        if connection['configured']:
            try:
                for app in APPS:
                    obj = self.client.get_application(app)
                    apps.append({'app': app, 'providers': [p.get('name') for p in obj.get('providers') or []], 'enableSignUp': bool(obj.get('enableSignUp'))})
                connection['ok'] = True
            except AdminError as e:
                connection['code'] = e.code
        else:
            connection['code'] = 'admin_client_unconfigured'
        try:
            continuity = self.continuity(login_provider(self.c, self.cfg)['type'])
        except Exception:
            continuity = {'checked': False, 'code': 'directory_unavailable'}
        restore_row = self.c.execute("select id from login_operations where kind in ('activate','restore','detach') and commit_at is not null order by id desc limit 1").fetchone()
        restore_id = restore_row['id'] if restore_row else None
        return {'setup': setup_summary(self.cfg), 'revisions': [public_revision(r) for r in self.c.execute('select * from login_provider_revisions order by id desc')], 'activeRevisionId': int(get(self.c, 'active_revision_id')) if get(self.c, 'active_revision_id') else None, 'stagedRevisionId': int(get(self.c, 'staged_revision_id')) if get(self.c, 'staged_revision_id') else None, 'loginState': get(self.c, 'login_state', 'consistent'), 'operation': operation(self.c), 'loginProvider': login_provider(self.c, self.cfg), 'connection': dict(connection, transport='Basic over HTTPS or exact loopback HTTP', expectedIssuer=self.cfg.get('expectedIssuer') or os.environ.get('CASDOOR_EXPECTED_ISSUER', '')), 'restoreOperationId': restore_id, 'guard': {'ok': bool(self.guard_check())}, 'continuity': continuity, 'apps': apps, 'signup': {'paused': get(self.c, 'signup_paused') == '1'}, 'cacheNote': 'Feed served is not consumer acknowledgement; an unreachable bridge can retain stale policy indefinitely.', 'credentialNote': 'Provider readback checks nonsecret fields only; external secret changes cannot be detected.'}

    def _attempt_check(self, attempt, epoch):
        if not attempt or attempt['status'] != 'pending':
            return 'attempt_not_pending'
        if self.now() > attempt['created'] + TEST_SECONDS:
            return 'expired'
        if self.now() >= attempt['session_exp'] or not epoch or not hmac.compare_digest(str(attempt['session_epoch']), str(epoch)):
            return 'session_expired'
        try:
            is_owner = self.owner_checker and self.owner_checker(attempt['actor'])
        except Exception:
            is_owner = False
        if not is_owner:
            return 'owner_required'
        if get(self.c, 'staged_revision_id') != str(attempt['revision_id']) or get(self.c, 'staged_operation_id') != str(attempt['stage_op_id']):
            return 'stale_staging'
        row = revision(self.c, attempt['revision_id'])
        stage = operation(self.c, attempt['stage_op_id'])
        if row['role'] != 'staged' or not stage or stage['status'] != 'done' or stage['kind'] != 'stage' or self.c.execute("select 1 from login_operations where status='running'").fetchone():
            return 'stale_staging'
        return None

    def start_test(self, ident, actor, session_exp, epoch):
        from enterprise import _endpoints, _redirect_uri, STATE_COOKIE
        cleanup_tests(self.c, self.now())
        rev = revision(self.c, ident)
        if not isinstance(session_exp, (int, float)) or session_exp < self.now() + TEST_SECONDS or not epoch:
            fail('session_expiring')
        stage_id = get(self.c, 'staged_operation_id')
        stage = operation(self.c, stage_id) if stage_id else None
        if rev['role'] != 'staged' or get(self.c, 'staged_revision_id') != str(rev['id']) or not stage or stage['status'] != 'done':
            fail('staging_missing')
        if self.c.execute("select 1 from login_operations where status='running'").fetchone():
            fail('operation_running')
        if self.c.execute('select count(*) from sso_states').fetchone()[0] > 1000:
            fail('too_many_attempts', 429)
        app = self.client.get_application('jadmin')
        if app.get('tokenFormat') != 'JWT' or app.get('isShared') is not False:
            fail('token_format_unsupported')
        ep = _endpoints(self.cfg)
        issuer = self.cfg.get('expectedIssuer') or os.environ.get('CASDOOR_EXPECTED_ISSUER', '')
        trusted_url(ep['authorization_endpoint'], issuer)
        state, verifier, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(48), secrets.token_urlsafe(32)
        attempt = secrets.token_hex(16)
        self.c.execute('begin immediate')
        try:
            if get(self.c, 'staged_revision_id') != str(rev['id']) or get(self.c, 'staged_operation_id') != str(stage['id']) or self.c.execute("select 1 from login_operations where status='running'").fetchone():
                fail('stale_staging')
            self.c.execute("insert into login_test_attempts(attempt_id,revision_id,actor,stage_op_id,session_exp,session_epoch,created,status) values(?,?,?,?,?,?,?,'pending')", (attempt, rev['id'], actor, stage['id'], int(session_exp), str(epoch), self.now()))
            self.c.execute("insert into sso_states(state,verifier,created,purpose,nonce_hash,test_revision_id,test_actor,test_stage_op_id,attempt_id) values(?,?,?,'login_test',?,?,?,?,?)", (hashlib.sha256(state.encode()).hexdigest(), verifier, self.now(), hashlib.sha256(nonce.encode()).hexdigest(), rev['id'], actor, stage['id'], attempt))
            self.c.commit()
        except Exception:
            self.c.rollback()
            raise
        query = {'response_type': 'code', 'client_id': self.cfg['clientId'], 'redirect_uri': _redirect_uri(self.cfg), 'scope': 'openid profile email', 'state': state, 'nonce': nonce, 'prompt': 'login', 'provider_hint': rev['casdoor_name'], 'code_challenge': base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('='), 'code_challenge_method': 'S256'}
        return {'attemptId': attempt, 'url': ep['authorization_endpoint'] + ('&' if '?' in ep['authorization_endpoint'] else '?') + urllib.parse.urlencode(query), 'cookie': '%s=%s; Path=/api/sso; HttpOnly; Secure; SameSite=Lax; Max-Age=600' % (STATE_COOKIE, state)}

    def _claims(self, token, state, attempt):
        if not isinstance(token, str) or len(token) > 16384 or len(token.split('.')) != 3:
            return 'token_invalid', None
        parts = token.split('.')
        if not all(re.fullmatch(r'[A-Za-z0-9_-]+', p) for p in parts):
            return 'token_invalid', None
        try:
            decoded = [base64.b64decode(p + '=' * (-len(p) % 4), altchars=b'-_', validate=True) for p in parts]
            header, claims = [json.loads(p) for p in decoded[:2]]
            if not isinstance(header, dict) or not isinstance(claims, dict):
                return 'token_invalid', None
        except (ValueError, UnicodeError):
            return 'token_invalid', None
        if header.get('alg') not in ('RS256', 'RS512', 'ES256', 'ES384', 'ES512', 'SM2'):
            return 'token_algorithm_invalid', None
        expected_issuer = self.cfg.get('expectedIssuer') or os.environ.get('CASDOOR_EXPECTED_ISSUER', '')
        if claims.get('iss') != expected_issuer:
            return 'issuer_mismatch', None
        cid = self.cfg['clientId']
        if claims.get('aud') not in (cid, [cid]):
            return 'audience_mismatch', None
        if claims.get('azp') != cid:
            return 'azp_mismatch', None
        if claims.get('tokenType') != 'id-token':
            return 'token_type_invalid', None
        def numeric(k):
            v = claims.get(k)
            return not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)
        if not all(numeric(k) for k in ('exp', 'iat', 'auth_time')) or ('nbf' in claims and not numeric('nbf')):
            return 'token_time_invalid', None
        if self.now() >= claims['exp'] + 60:
            return 'token_expired', None
        if not attempt['created'] - 60 <= claims['iat'] <= self.now() + 60:
            return 'token_iat_invalid', None
        if not attempt['created'] - 60 <= claims['auth_time'] <= self.now() + 60:
            return 'authentication_not_fresh', None
        if claims.get('nbf', 0) > self.now() + 60:
            return 'token_not_yet_valid', None
        if not isinstance(claims.get('nonce'), str) or not hmac.compare_digest(hashlib.sha256(claims['nonce'].encode()).hexdigest(), state['nonce_hash'] or ''):
            return 'nonce_mismatch', None
        rev = revision(self.c, attempt['revision_id'])
        if claims.get('provider') != rev['casdoor_name']:
            return 'provider_mismatch', None
        if not isinstance(claims.get('sub'), str) or not claims['sub'].strip() or len(claims['sub']) > 200:
            return 'subject_invalid', None
        return None, claims['sub']

    def finish_test(self, query, cookie, epoch):
        from enterprise import _endpoints, _redirect_uri
        params = urllib.parse.parse_qs(query or '')
        raw = (params.get('state') or [''])[0]
        if not raw or len(raw) > 200 or not cookie or not hmac.compare_digest(raw, cookie):
            cleanup_tests(self.c, self.now())
            fail('state_invalid', 401)
        key = hashlib.sha256(raw.encode()).hexdigest()
        state = self.c.execute('select * from sso_states where state=?', (key,)).fetchone()
        self.c.execute('delete from sso_states where state=?', (key,))
        self.c.commit()  # PKCE verifier must be gone before any network request
        cleanup_tests(self.c, self.now())
        if not state or state['purpose'] != 'login_test':
            fail('state_invalid', 401)
        attempt = self.c.execute('select * from login_test_attempts where attempt_id=?', (state['attempt_id'],)).fetchone()
        reason = 'state_expired' if state['created'] < self.now() - TEST_SECONDS else self._attempt_check(attempt, epoch)
        subject = None
        if not reason and params.get('error'):
            reason = 'authorization_error'
        code = (params.get('code') or [''])[0]
        if not reason and (not code or len(code) > 4096):
            reason = 'code_invalid'
        if not reason:
            try:
                ep = _endpoints(self.cfg)
                issuer = self.cfg.get('expectedIssuer') or os.environ.get('CASDOOR_EXPECTED_ISSUER', '')
                trusted_token_endpoint(ep['token_endpoint'], issuer)
                form = urllib.parse.urlencode({'grant_type': 'authorization_code', 'code': code, 'redirect_uri': _redirect_uri(self.cfg), 'client_id': self.cfg['clientId'], 'client_secret': self.cfg['clientSecret'], 'code_verifier': state['verifier']}).encode()
                # TLS-authenticated direct code exchange, approved exception: no local JWT signature verification.
                tokens = request_json(ep['token_endpoint'], {'Content-Type': 'application/x-www-form-urlencoded'}, form)
                reason, subject = self._claims(tokens.get('id_token'), state, attempt)
            except Exception:
                reason = 'token_exchange_failed'
        self.c.execute('begin immediate')
        try:
            current = self.c.execute('select * from login_test_attempts where attempt_id=?', (state['attempt_id'],)).fetchone()
            reason = self._attempt_check(current, epoch) or reason
            if current and current['status'] == 'pending':
                status = 'failed' if reason else 'passed'
                changed = self.c.execute("update login_test_attempts set status=?,reason=?,finished_at=?,subject=? where attempt_id=? and status='pending'", (status, reason, self.now(), subject if not reason else None, current['attempt_id'])).rowcount
                if changed:
                    self.c.execute('update login_provider_revisions set signin_test_status=?,signin_test_at=?,signin_test_by=?,signin_test_subject=? where id=?', (status, self.now(), current['actor'], subject if not reason else None, current['revision_id']))
            self.c.commit()
        except Exception:
            self.c.rollback()
            raise
        final = self.c.execute('select status,reason from login_test_attempts where attempt_id=?', (state['attempt_id'],)).fetchone()
        return {'login_test': True, 'attemptId': state['attempt_id'], 'status': final['status'] if final else 'failed', 'reason': final['reason'] if final else reason}


def summary(c, cfg=None, actor=None):
    try:
        return Service(c, cfg).summary(actor)
    except AdminError as e:
        fail(e.code, e.status)


def test_status(c, attempt_id, actor, cfg=None):
    cleanup_tests(c)
    row = c.execute('select * from login_test_attempts where attempt_id=? and actor=?', (attempt_id, actor)).fetchone()
    if not row:
        fail('attempt_not_found', 404)
    return {'attemptId': row['attempt_id'], 'revisionId': row['revision_id'], 'status': row['status'], 'reason': row['reason'], 'at': row['finished_at']}


def _dispatch(c, action, data, actor, cfg=None, session_exp=None, session_epoch=None):
    service = Service(c, cfg)
    data = data or {}
    try:
        if action == 'save_revision': return service.save_revision(data, actor, test_on_save=True)
        if action == 'clear_unused': return service.clear_unused()
        if action == 'test_credentials': return service.test_credentials(data.get('revisionId'), actor)
        if action == 'stage': return service.stage(data.get('revisionId'), actor)
        if action == 'cancel_stage': return service.cancel_stage(actor)
        if action == 'activate': return service.transition(data.get('revisionId'), actor, data)
        if action == 'legacy_activate':
            row = c.execute("select id from login_provider_revisions where im=? and cred_test_status='passed' and role not in ('retired','provisioning') order by id desc limit 1", (data.get('im'),)).fetchone()
            if not row: fail('tests_missing')
            return service.transition(row['id'], actor, data)
        if action == 'detach': return service.transition(None, actor, data, 'detach')
        if action == 'restore': return service.restore(data.get('operationId'), actor, data)
        if action in ('finish', 'retry_cleanup'): return service.finish(actor, bool(data.get('force')), data.get('reason', ''))
        if action == 'reconcile': return service.reconcile(actor, data.get('action'))
        if action == 'signup_pause': return service.signup(actor)
        if action == 'signup_resume': return service.signup(actor, True)
        if action == 'start_test': return service.start_test(data.get('revisionId'), actor, session_exp, session_epoch)
        fail('action_invalid', 400)
    except AdminError as e:
        fail(e.code, e.status)


def dispatch(c, action, data, actor, cfg=None, session_exp=None, session_epoch=None):
    result = _dispatch(c, action, data, actor, cfg, session_exp, session_epoch)
    if isinstance(result, dict):
        result = dict(result)
        if isinstance(result.get('revision'), dict):
            result.setdefault('revisionId', result['revision']['id'])
        if isinstance(result.get('operation'), dict):
            op = result['operation']
            result.setdefault('operationId', op['id'])
            result.setdefault('revisionId', op.get('revision_id'))
            result.setdefault('status', op['status'])
    return result
