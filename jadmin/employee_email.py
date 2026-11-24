"""Complete an empty employee email through an independently deployed atomic writer.

No Casdoor update-user fallback exists. See EMPLOYEE_EMAIL_CONTRACT.md.
"""
import copy
import http.client
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

SCHEMA = 'jadmin.employee-email.v1'
MAX_BODY = 2048
MAX_RESPONSE = 4 * 1024 * 1024
ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z')
CAPABILITY = {
    'schema': SCHEMA, 'atomicEmptyEmail': True, 'stableIdentity': True,
    'preserveBindings': True, 'preserveOtherFields': True,
    'organizationUniqueIncludingDeleted': True, 'emailVerifiedFalse': True,
    'completeSnapshotIncludingDeleted': True,
}
CONFLICTS = frozenset(('employee_not_found', 'employee_inactive', 'email_not_empty',
                       'email_conflict', 'employee_changed'))


class EmailError(Exception):
    def __init__(self, code, status=409):
        super().__init__(code)
        self.code, self.status = code, status


def valid_id(value):
    return isinstance(value, str) and ID.fullmatch(value) is not None


def normalize_email(value):
    # Deliberately conservative ASCII mailbox syntax; no display names or IDNs.
    if not isinstance(value, str) or not value.isascii():
        raise EmailError('email_invalid', 400)
    email = value.strip().lower()
    if len(email) > 254 or email.count('@') != 1:
        raise EmailError('email_invalid', 400)
    local, domain = email.split('@')
    labels = domain.split('.')
    if (not 1 <= len(local) <= 64 or not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+", local)
            or local.startswith('.') or local.endswith('.') or '..' in local
            or len(labels) < 2 or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', p) for p in labels)):
        raise EmailError('email_invalid', 400)
    return email


def validate_body(body):
    if not isinstance(body, dict) or set(body) != {'employeeId', 'email'}:
        raise EmailError('invalid_request', 400)
    if not valid_id(body['employeeId']):
        raise EmailError('invalid_employee_id', 400)
    return body['employeeId'], normalize_email(body['email'])


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate key')
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError('invalid constant')

    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)


def eligible(user, organization):
    return bool(isinstance(user, dict) and valid_id(organization)
                and valid_id(user.get('id')) and user.get('owner') == organization
                and isinstance(user.get('name'), str) and user['name'].strip()
                and user.get('email') == ''
                and user.get('isForbidden', False) is False
                and user.get('isDisabled', False) is False
                and user.get('isDeleted', False) is False)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AtomicEmailClient:
    """Only this dedicated token, never application/global Casdoor credentials."""
    def __init__(self, cfg=None, opener=None):
        self.cfg = dict(cfg) if cfg is not None else {
            'url': os.environ.get('JADMIN_EMPLOYEE_EMAIL_WRITER_URL', ''),
            'tokenFile': os.environ.get('JADMIN_EMPLOYEE_EMAIL_WRITER_TOKEN_FILE', ''),
        }
        self.opener = opener

    def _config(self):
        base, path = self.cfg.get('url', ''), self.cfg.get('tokenFile', '')
        if not base or not path:
            raise EmailError('atomic_writer_unconfigured', 503)
        try:
            p = urllib.parse.urlsplit(base)
            if (not isinstance(base, str) or any(ch.isspace() or ord(ch) < 32 for ch in base)
                    or p.username is not None or p.password is not None or p.query or p.fragment
                    or not p.hostname or '\\' in base or '%' in p.netloc
                    or p.path not in ('', '/') or p.port == 0
                    or not (p.scheme == 'https' or (p.scheme == 'http' and p.hostname in ('127.0.0.1', '::1')))):
                raise ValueError('invalid endpoint')
            if not os.path.isabs(path):
                raise ValueError('absolute token path required')
        except (ValueError, TypeError, AttributeError):
            raise EmailError('writer_configuration_invalid', 503) from None
        try:
            with open(path, encoding='ascii') as stream:
                raw = stream.read(4097)
            token = raw.strip()
            if len(raw) > 4096 or not re.fullmatch(r'[A-Za-z0-9._~+/-]{32,4096}={0,2}', token):
                raise ValueError('invalid token')
        except (OSError, ValueError, UnicodeError):
            raise EmailError('writer_configuration_invalid', 503) from None
        return base.rstrip('/'), token

    def _call(self, endpoint, body=None, writing=False):
        if endpoint not in ('/capabilities', '/snapshot', '/complete-email'):
            raise EmailError('writer_configuration_invalid', 503)
        base, token = self._config()
        headers = {'Accept': 'application/json', 'Authorization': 'Bearer ' + token}
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=True, allow_nan=False).encode('ascii')
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(base + endpoint, data=data, headers=headers,
                                     method='POST' if body is not None else 'GET')
        failure = 'write_outcome_unknown' if writing else 'writer_unavailable'
        try:
            opener = self.opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(req, timeout=10) as response:
                if response.status != 200 or response.headers.get_content_type() != 'application/json':
                    raise EmailError(failure, 503)
                raw = response.read(MAX_RESPONSE + 1)
                if len(raw) > MAX_RESPONSE:
                    raise EmailError(failure, 503)
                value = strict_json(raw)
                if not isinstance(value, dict):
                    raise EmailError(failure, 503)
                return value
        except urllib.error.HTTPError as error:
            # Only the exact typed 409 contract guarantees no mutation took place.
            try:
                if writing and error.code == 409 and error.headers.get_content_type() == 'application/json':
                    raw = error.read(2049)
                    value = strict_json(raw) if len(raw) <= 2048 else None
                    if (isinstance(value, dict) and set(value) == {'schema', 'updated', 'code'}
                            and value['schema'] == SCHEMA and value['updated'] is False
                            and value['code'] in CONFLICTS):
                        raise EmailError(value['code'], 409) from None
            except (ValueError, TypeError, OSError, RecursionError, http.client.HTTPException):
                pass
            finally:
                error.close()
            raise EmailError(failure, 503) from None
        except (urllib.error.URLError, OSError, ValueError, TypeError, RecursionError, http.client.HTTPException):
            raise EmailError(failure, 503) from None

    def require_capability(self):
        value = self._call('/capabilities')
        if set(value) != set(CAPABILITY) or any(type(value[k]) is not type(v) or value[k] != v for k, v in CAPABILITY.items()):
            raise EmailError('writer_capability_missing', 503)

    def capability(self):
        try:
            self.require_capability()
            return {'available': True, 'reason': 'available'}
        except EmailError as error:
            return {'available': False, 'reason': error.code}

    def snapshot(self, organization):
        value = self._call('/snapshot', {'schema': SCHEMA, 'organization': organization})
        if (set(value) != {'schema', 'organization', 'complete', 'includesDeleted', 'users'}
                or value['schema'] != SCHEMA or value['organization'] != organization
                or value['complete'] is not True or value['includesDeleted'] is not True
                or not isinstance(value['users'], list)):
            raise EmailError('directory_unavailable', 503)
        seen = set()
        for user in value['users']:
            if (not isinstance(user, dict) or set(user) != {'id', 'owner', 'name', 'email', 'isForbidden', 'isDisabled', 'isDeleted', 'bindings'}
                    or not valid_id(user.get('id')) or user['id'] in seen
                    or user['owner'] != organization or not isinstance(user['name'], str) or not user['name'].strip()
                    or not isinstance(user['email'], str) or type(user['isForbidden']) is not bool
                    or type(user['isDisabled']) is not bool
                    or type(user['isDeleted']) is not bool or not isinstance(user['bindings'], dict)
                    or set(user['bindings']) != {'dingtalk', 'lark', 'wecom'}
                    or any(not isinstance(v, str) for v in user['bindings'].values())):
                raise EmailError('directory_unavailable', 503)
            seen.add(user['id'])
        return value['users']

    def complete(self, payload):
        fields = {'schema', 'organization', 'employeeId', 'expectedName', 'expectedEmail',
                  'expectedBindings', 'email', 'emailVerified'}
        if (not isinstance(payload, dict) or set(payload) != fields or payload['schema'] != SCHEMA
                or not valid_id(payload['organization']) or not valid_id(payload['employeeId'])
                or not isinstance(payload['expectedName'], str) or not payload['expectedName'].strip()
                or payload['expectedEmail'] != '' or payload['emailVerified'] is not False
                or not isinstance(payload['expectedBindings'], dict)
                or set(payload['expectedBindings']) != {'dingtalk', 'lark', 'wecom'}
                or any(not isinstance(v, str) for v in payload['expectedBindings'].values())
                or normalize_email(payload['email']) != payload['email']):
            raise EmailError('invalid_request', 400)
        value = self._call('/complete-email', payload, writing=True)
        expected = {'schema': SCHEMA, 'updated': True, 'employeeId': payload['employeeId'],
                    'email': payload['email'], 'emailVerified': False}
        if set(value) != set(expected) or any(type(value[k]) is not type(v) or value[k] != v for k, v in expected.items()):
            raise EmailError('write_outcome_unknown', 503)
        return {k: v for k, v in expected.items() if k != 'schema'}


def complete_email(body, *, authorized, organization=None, client=None, after_write=None):
    """Fresh preflight helps UX; the external transaction must repeat every guard."""
    employee_id, email = validate_body(body)
    if not authorized():
        raise EmailError('admin_required', 403)
    organization = os.environ.get('CASDOOR_ORG', '') if organization is None else organization
    if not valid_id(organization):
        raise EmailError('organization_unconfigured', 503)
    client = client or AtomicEmailClient()
    client.require_capability()
    users = client.snapshot(organization)
    matches = [u for u in users if u['id'] == employee_id]
    if len(matches) != 1:
        raise EmailError('employee_not_found', 404)
    user = matches[0]
    if user['isForbidden'] or user['isDisabled'] or user['isDeleted']:
        raise EmailError('employee_inactive')
    if user['email'] != '':
        raise EmailError('email_not_empty')
    if any(u['email'].strip().lower() == email for u in users):
        raise EmailError('email_conflict')
    payload = {
        'schema': SCHEMA, 'organization': organization, 'employeeId': employee_id,
        'expectedName': user['name'], 'expectedEmail': '',
        'expectedBindings': copy.deepcopy(user['bindings']), 'email': email,
        'emailVerified': False,
    }
    # Re-read the signed session and current administrator row after slow I/O.
    if not authorized():
        raise EmailError('admin_required', 403)
    result = client.complete(payload)
    if after_write is not None:
        after_write(payload['expectedBindings']['dingtalk'])
    return result
