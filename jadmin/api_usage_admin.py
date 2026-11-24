"""Admin-only entry to the local direct API usage reader."""
import datetime
import http.client
import json
import re
import socket
from urllib.parse import urlsplit

import employee_email

PATH = '/api/admin/api-usage'
SOCKET = '/run/qyos-api-usage/query.sock'
MAX_RESPONSE = 4096
FIELDS = ('requests', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens')


def matches(path):
    return urlsplit(path).path == PATH


class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET)


def _timestamp(value):
    if not isinstance(value, str) or len(value) > 40 or not re.fullmatch(
        r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})', value
    ):
        raise ValueError('invalid timestamp')
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))


def query(subject, days):
    conn = UnixConnection('localhost', timeout=5)
    try:
        conn.request('POST', '/query', json.dumps({'subject': subject, 'days': days}),
                     {'Content-Type': 'application/json'})
        response = conn.getresponse()
        if response.status != 200:
            raise ValueError('usage unavailable')
        raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise ValueError('oversized response')
        obj = employee_email.strict_json(raw.decode('utf-8'))
        if not isinstance(obj, dict) or obj.get('status') not in ('ok', 'unlinked', 'unconfigured'):
            raise ValueError('invalid usage state')
        safe = {'status': obj['status']}
        if safe['status'] != 'ok':
            return safe
        for key in FIELDS:
            value = obj.get(key)
            if type(value) is not int or not 0 <= value <= 2**53 - 1:
                raise ValueError('invalid usage value')
            safe[key] = value
        if _timestamp(obj.get('since')) >= _timestamp(obj.get('as_of')):
            raise ValueError('invalid usage period')
        safe.update(as_of=obj['as_of'], since=obj['since'])
        return safe
    finally:
        conn.close()


def handle(handler, host):
    try:
        headers = handler.headers.get_all('Authorization', [])
        actor = host.who(headers[0][7:]) if len(headers) == 1 and headers[0].startswith('Bearer ') else None
        if not actor:
            return handler.out({'error': 'unauthorized'}, 401)
        c = handler.conn()
        if not host.is_admin_actor(c, actor):
            return handler.out({'error': 'admin_required'}, 403)
        if handler.path != PATH:
            return handler.out({'error': 'invalid_request'}, 400)
        if handler.command != 'POST':
            return handler.out({'error': 'method_not_allowed'}, 405, extra=[('Allow', 'POST')])
        try:
            obj = handler.read_email_json(max_body=512)
        except employee_email.EmailError as error:
            return handler.out({'error': error.code}, error.status)
        if (not isinstance(obj, dict) or set(obj) != {'employeeId', 'days'}
                or not employee_email.valid_id(obj['employeeId'])
                or type(obj['days']) is not int or obj['days'] not in (7, 30)):
            return handler.out({'error': 'invalid_request'}, 400)
        subject = obj['employeeId']
        # The gateway mapping must also be unique. Only directory employees are
        # accepted here, independent of IDs that may exist in the gateway.
        organization = host.enterprise.settings().get('organization')
        if not organization:
            return handler.out({'status': 'unconfigured'})
        try:
            matches = [item for item in host.enterprise.casdoor_users()
                       if isinstance(item, dict) and item.get('id') == subject]
        except host.enterprise.EnterpriseError:
            return handler.out({'error': 'directory_unavailable'}, 503)
        if (len(matches) != 1 or matches[0].get('owner') != organization or matches[0].get('isDeleted')):
            return handler.out({'error': 'employee_not_found'}, 404)
        if not host.is_admin_actor(c, actor):
            return handler.out({'error': 'admin_required'}, 403)
        try:
            return handler.out(query(subject, obj['days']))
        except (OSError, ValueError, http.client.HTTPException, RecursionError):
            return handler.out({'error': 'usage_unavailable'}, 503)
    finally:
        handler.close_connection = True
