"""Narrow, Basic-auth-only boundary around Casdoor's global machine credential.

The credential has global authority in Casdoor. This allowlist is application
code, not a claim that the upstream credential is scoped.
"""
import base64
import copy
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

APPS = ('portal', 'jchat', 'jimage', 'japi', 'jadmin')
PROVIDER_NAME = re.compile(r'^qyos_(lark|dingtalk|wecom)_r[0-9]{1,6}$')
TYPES = {'lark': 'Lark', 'dingtalk': 'DingTalk', 'wecom': 'WeCom'}


class AdminError(Exception):
    def __init__(self, code, status=502):
        super().__init__(code)
        self.code, self.status = code, status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def trusted_url(url, expected=None):
    p = urllib.parse.urlsplit(url)
    if p.username or p.password or p.fragment:
        raise AdminError('endpoint_invalid', 409)
    if p.scheme == 'https' and p.hostname:
        if expected:
            e = urllib.parse.urlsplit(expected)
            if (p.scheme, p.hostname, p.port) != (e.scheme, e.hostname, e.port):
                raise AdminError('endpoint_invalid', 409)
        return url
    if p.scheme == 'http' and p.hostname in ('127.0.0.1', '::1', 'localhost'):
        if expected:
            e = urllib.parse.urlsplit(expected)
            if (p.scheme, p.hostname, p.port) != (e.scheme, e.hostname, e.port):
                raise AdminError('endpoint_invalid', 409)
        return url
    raise AdminError('endpoint_invalid', 409)


def request_json(url, headers=None, data=None, opener=None):
    trusted_url(url)
    req = urllib.request.Request(url, data=data, headers=headers or {}, method='POST' if data is not None else 'GET')
    try:
        with (opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())).open(req, timeout=15) as response:
            raw = response.read(1048577)
            if len(raw) > 1048576:
                raise AdminError('upstream_invalid')
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise AdminError('upstream_invalid')
            return result
    except urllib.error.HTTPError as e:
        raise AdminError('upstream_http_%d' % e.code) from None
    except (urllib.error.URLError, OSError, ValueError):
        raise AdminError('upstream_unavailable', 503) from None


class AdminClient:
    def __init__(self, cfg=None, opener=None):
        self.cfg = cfg or {}
        self.base = self.cfg.get('casdoorUrl', os.environ.get('CASDOOR_URL', '')).rstrip('/')
        self.opener = opener

    def _credentials(self):
        values = []
        for env, key in (('CASDOOR_ADMIN_CLIENT_ID_FILE', 'adminClientIdFile'), ('CASDOOR_ADMIN_CLIENT_SECRET_FILE', 'adminClientSecretFile')):
            try:
                with open(self.cfg.get(key) or os.environ.get(env, ''), encoding='utf-8') as stream:
                    values.append(stream.read().strip())
            except (OSError, TypeError):
                raise AdminError('admin_client_unconfigured', 409) from None
        if not all(values):
            raise AdminError('admin_client_unconfigured', 409)
        return values

    def configured(self):
        try:
            trusted_url(self.base)
            self._credentials()
            return True
        except AdminError:
            return False

    def _call(self, path, params=None, body=None):
        params = params or {}
        if path in ('/api/get-application', '/api/update-application'):
            expected = {'id'} if path == '/api/get-application' else {'id', 'columns'}
            if set(params) != expected or not str(params.get('id', '')).startswith('admin/'):
                raise AdminError('request_forbidden', 403)
            app = params['id'][6:]
            self._app(app)
            if path == '/api/update-application':
                columns = params['columns'].split(',')
                if not columns or len(columns) != len(set(columns)) or not set(columns) <= {'providers', 'enableSignUp'} or not isinstance(body, dict) or body.get('owner') != 'admin' or body.get('name') != app:
                    raise AdminError('columns_forbidden', 403)
        elif path == '/api/get-provider':
            if set(params) != {'id'} or not str(params.get('id', '')).startswith('admin/'):
                raise AdminError('request_forbidden', 403)
            self._provider(params['id'][6:])
        elif path == '/api/add-provider':
            fields = {'owner', 'name', 'displayName', 'category', 'type', 'subType', 'method', 'clientId', 'clientSecret', 'appId', 'emailRegex', 'disableSsl'}
            if params or not isinstance(body, dict) or set(body) - fields or body.get('owner') != 'admin' or body.get('category') != 'OAuth' or body.get('type') not in TYPES.values():
                raise AdminError('provider_fields_forbidden', 403)
            self._provider(body.get('name'))
            im = PROVIDER_NAME.fullmatch(body['name']).group(1)
            if TYPES[im] != body['type'] or (im != 'wecom' and set(body) & {'subType', 'method', 'appId', 'disableSsl'}) or (im == 'wecom' and (body.get('subType') != 'Internal' or body.get('method') != 'Normal')):
                raise AdminError('provider_fields_forbidden', 403)
        else:
            raise AdminError('endpoint_forbidden', 403)
        trusted_url(self.base)
        ident, secret = self._credentials()  # deliberately reread on every request
        headers = {'Accept': 'application/json', 'Authorization': 'Basic ' + base64.b64encode((ident + ':' + secret).encode()).decode()}
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body, ensure_ascii=False).encode()
        url = self.base + path + ('?' + urllib.parse.urlencode(params) if params else '')
        value = request_json(url, headers, data, self.opener)
        if value.get('status') != 'ok':
            raise AdminError('casdoor_rejected')
        return value.get('data')

    @staticmethod
    def _app(app):
        if app not in APPS:
            raise AdminError('application_forbidden', 403)

    @staticmethod
    def _provider(name):
        if not isinstance(name, str) or not PROVIDER_NAME.fullmatch(name):
            raise AdminError('provider_forbidden', 403)

    def get_application(self, app):
        self._app(app)
        value = self._call('/api/get-application', {'id': 'admin/' + app})
        if not isinstance(value, dict) or value.get('owner') != 'admin' or value.get('name') != app or value.get('clientSecret') == '***' or not isinstance(value.get('providers') or [], list):
            raise AdminError('application_unavailable')
        return value

    def update_application(self, app, *, providers=None, enable_signup=None):
        self._app(app)
        if providers is None and enable_signup is None:
            raise AdminError('columns_forbidden', 403)
        if providers is not None and not isinstance(providers, list):
            raise AdminError('providers_invalid', 400)
        if enable_signup is not None and not isinstance(enable_signup, bool):
            raise AdminError('signup_invalid', 400)
        value = copy.deepcopy(self.get_application(app))
        columns = []
        if providers is not None:
            value['providers'] = copy.deepcopy(providers)
            columns.append('providers')
        if enable_signup is not None:
            value['enableSignUp'] = enable_signup
            columns.append('enableSignUp')
        self._call('/api/update-application', {'id': 'admin/' + app, 'columns': ','.join(columns)}, value)

    def get_provider(self, name):
        self._provider(name)
        value = self._call('/api/get-provider', {'id': 'admin/' + name})
        if not isinstance(value, dict) or value.get('owner') != 'admin' or value.get('name') != name:
            raise AdminError('provider_unavailable')
        return value

    def add_provider(self, *, name, im, client_id, client_secret, app_id='', email_regex='', use_id_as_name=False):
        self._provider(name)
        if im not in TYPES or not name.startswith('qyos_' + im + '_r'):
            raise AdminError('provider_type_invalid', 400)
        value = {'owner': 'admin', 'name': name, 'displayName': name, 'category': 'OAuth', 'type': TYPES[im], 'clientId': client_id, 'clientSecret': client_secret, 'emailRegex': email_regex}
        if im == 'wecom':
            value.update(subType='Internal', method='Normal', appId=app_id, disableSsl=bool(use_id_as_name))
        self._call('/api/add-provider', body=value)
        return name
