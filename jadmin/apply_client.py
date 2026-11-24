"""Bounded synchronous transport for the privileged apply helper.

Callers own background execution and persistent state. Transport errors leave
the helper's outcome unknown; they must not be converted to successful results.
"""

from contextlib import contextmanager
import errno
import json
import math
import os
import re
import socket
import stat
import time

try:
    import fcntl as _fcntl
except ImportError:  # Windows tests inject a synthetic flock implementation.
    _fcntl = None


LOCK_PATH = '/run/qyos-librechat-apply/config.lock'
SOCKET_PATH = '/run/qyos-librechat-apply/apply.sock'
MAX_REQUEST_BYTES = 4096
MAX_RESPONSE_BYTES = 65536  # Total across accepted and final frames.
_IDENTITY = ('requestId', 'op', 'configRevision', 'yamlSha256')
_RESULTS = frozenset(('applied_healthy', 'verified_adopted', 'not_adopted',
                     'stale_revision', 'busy', 'rejected', 'failed', 'interrupted'))
_RESULT_FIELDS = frozenset(_IDENTITY + ('event', 'result', 'errorCode', 'phase',
                                      'startedAt', 'finishedAt', 'api',
                                      'adoption', 'untouched'))


class ConfigBusy(RuntimeError):
    def __init__(self):
        super().__init__('config_busy')


class ApplyClientError(RuntimeError):
    """Fixed local error codes, never helper output or OS exception text."""


def _seconds(value, allow_zero=False):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or value < 0
            or (not allow_zero and value == 0)):
        raise ValueError('invalid_timeout')
    return value


def _open_lock_file(path):
    # Fail closed on platforms without Linux's no-follow/readonly flock path.
    if _fcntl is None or not hasattr(os, 'O_NOFOLLOW'):
        raise OSError('config_lock_unavailable')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                 | getattr(os, 'O_CLOEXEC', 0))
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                or info.st_nlink != 1 or info.st_mode & 0o022):
            raise OSError('config_lock_unavailable')
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextmanager
def config_lock(path=LOCK_PATH, timeout=5):
    """Hold an existing root-owned lock; never create or modify the file.

    Synthetic Windows tests can inject _open_lock_file and _fcntl. There is
    deliberately no automatic process-local fallback for production callers.
    """
    _seconds(timeout, allow_zero=True)
    fd = None
    acquired = False
    try:
        try:
            deadline = time.monotonic() + timeout
            fd = _open_lock_file(path)
            while True:
                try:
                    _fcntl.flock(fd, _fcntl.LOCK_EX | _fcntl.LOCK_NB)
                    acquired = True
                    break
                except OSError as exc:
                    if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EINTR):
                        raise
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ConfigBusy() from None
                    time.sleep(min(0.05, remaining))
        except ConfigBusy:
            raise
        except Exception:
            raise ApplyClientError('config_lock_unavailable') from None
        yield
    finally:
        if fd is not None:
            try:
                try:
                    if acquired:
                        _fcntl.flock(fd, _fcntl.LOCK_UN)
                finally:
                    os.close(fd)
            except Exception:
                raise ApplyClientError('config_lock_unavailable') from None


def _identity_valid(frame):
    return (frame.get('op') in ('apply', 'verify')
            and isinstance(frame.get('requestId'), str)
            and re.fullmatch(r'[0-9a-fA-F]{32}', frame['requestId']) is not None
            and type(frame.get('configRevision')) is int
            and frame['configRevision'] >= 0
            and isinstance(frame.get('yamlSha256'), str)
            and re.fullmatch(r'[0-9a-fA-F]{64}', frame['yamlSha256']) is not None)


def _encode_request(payload):
    if type(payload) is not dict or type(payload.get('v')) is not int or payload['v'] != 1:
        raise ValueError()
    if payload.get('op') == 'status':
        if set(payload) != {'v', 'op'}:
            raise ValueError()
    elif set(payload) != set(_IDENTITY) | {'v'} or not _identity_valid(payload):
        raise ValueError()
    encoded = json.dumps(payload, separators=(',', ':'), allow_nan=False).encode('utf-8') + b'\n'
    if len(encoded) > MAX_REQUEST_BYTES:
        raise ValueError()
    return encoded


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def _reject_constant(value):
    raise ValueError()


def _result_valid(frame):
    return (type(frame) is dict and _identity_valid(frame)
            and not set(frame) - _RESULT_FIELDS
            and frame.get('event', 'result') == 'result'
            and frame.get('result') in _RESULTS)


def request(payload, on_accepted=None, timeout=420, socket_path=SOCKET_PATH):
    """Return status or the matching final result, invoking callback(frame) once.

    A direct result is valid for cached requests and pre-acceptance rejection.
    The deadline covers connect, send, every read, and callback elapsed time.
    No retries are made: a disconnected request may still be running remotely.
    """
    sock = None
    try:
        _seconds(timeout)
        encoded = _encode_request(payload)
        expected = json.loads(encoded)
        if on_accepted is not None and not callable(on_accepted):
            raise ValueError()
    except Exception:
        raise ApplyClientError('apply_invalid_request') from None
    deadline = time.monotonic() + timeout

    def remaining():
        value = deadline - time.monotonic()
        if value <= 0:
            raise TimeoutError()
        return value

    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(remaining())
        sock.connect(socket_path)
        sock.settimeout(remaining())
        sock.sendall(encoded)
        pending = b''
        received = 0
        accepted = False
        while True:
            remaining()
            if b'\n' not in pending:
                sock.settimeout(remaining())
                chunk = sock.recv(min(4096, MAX_RESPONSE_BYTES - received + 1))
                if not chunk:
                    raise ValueError()
                received += len(chunk)
                if received > MAX_RESPONSE_BYTES:
                    raise ValueError()
                pending += chunk
                continue
            line, pending = pending.split(b'\n', 1)
            frame = json.loads(line.decode('utf-8'), object_pairs_hook=_unique_object,
                               parse_constant=_reject_constant)
            if type(frame) is not dict:
                raise ValueError()
            if expected['op'] == 'status':
                if (set(frame) != {'available', 'last'} or frame['available'] is not True
                        or (frame['last'] is not None and not _result_valid(frame['last']))
                        or pending):
                    raise ValueError()
                return frame
            if not _identity_valid(frame) or any(frame[k] != expected[k] for k in _IDENTITY):
                raise ValueError()
            if frame.get('event') == 'accepted':
                if accepted or set(frame) - set(_IDENTITY + ('event', 'phase', 'startedAt')):
                    raise ValueError()
                accepted = True
                if on_accepted is not None:
                    on_accepted(frame)
            elif frame.get('event') == 'result' and _result_valid(frame) and not pending:
                return frame
            else:
                raise ValueError()
    except (TimeoutError, socket.timeout):
        raise ApplyClientError('apply_timeout') from None
    except Exception:
        raise ApplyClientError('apply_unavailable') from None
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass
