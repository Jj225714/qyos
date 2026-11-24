"""Jadmin client for the two private runtime model settings sockets."""

import http.client
import json
import re
import socket


SOCKETS = {
    'chat': '/run/qyos-chat-model-control/admin.sock',
    'image': '/run/qyos-image-model-control/admin.sock',
}
MODEL = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}', re.ASCII)
IDENTIFIER = re.compile(r'[A-Za-z0-9_-]{1,128}', re.ASCII)
CODE = re.compile(r'[A-Za-z0-9_]{1,64}', re.ASCII)


class ModelError(Exception):
    def __init__(self, code, status=400, retry_after=None):
        self.code = code
        self.status = status
        self.retry_after = retry_after if status == 429 and type(retry_after) is int and 1 <= retry_after <= 3600 else None

    def public(self):
        result = {'code': self.code}
        if self.retry_after is not None:
            result['retryAfterSeconds'] = self.retry_after
        return result


class _Connection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__('localhost', timeout=timeout)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def request(module, operation, fields=None):
    if module not in SOCKETS or operation not in ('status', 'probe', 'allow', 'commit', 'revert', 'rollback'):
        raise ModelError('invalid_request')
    client = _Connection(SOCKETS[module], 100 if operation == 'probe' else 4)
    try:
        client.request('POST', '/' + operation, json.dumps(fields or {}),
                       {'Content-Type': 'application/json', 'Connection': 'close'})
        response = client.getresponse()
        raw = response.read(8193)
        if len(raw) > 8192:
            raise ModelError('runtime_unavailable', 503)
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ModelError('runtime_unavailable', 503)
        if not 200 <= response.status < 300:
            code = result.get('code')
            if not isinstance(code, str) or not CODE.fullmatch(code):
                code = 'runtime_unavailable'
            status = response.status if 400 <= response.status < 600 else 503
            raise ModelError(code, status, result.get('retryAfterSeconds'))
        return result
    except (OSError, ValueError, http.client.HTTPException):
        raise ModelError('runtime_unavailable', 503) from None
    finally:
        client.close()


def active(module):
    result = request(module, 'status')
    model, revision = result.get('model'), result.get('revision')
    if not valid(MODEL, model) or not valid(IDENTIFIER, revision):
        raise ModelError('runtime_unavailable', 503)
    return result


def valid(pattern, value):
    return isinstance(value, str) and bool(pattern.fullmatch(value))
