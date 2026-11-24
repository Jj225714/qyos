"""QYOS enterprise mail HTTP adapters.

Jadmin routes (owner only: actor exactly host.EMAIL; errors are {"error": code}):
  GET  /api/admin/enterprise-mail/config -> config, departmentChoices, boolean credential flags, count
  POST /api/admin/enterprise-mail/config  {revision, enabled, provider, webmailUrl, departments[, credentials]}
  POST /api/admin/enterprise-mail/test    {revision}
Employee transport: fixed Unix socket SOCKET_PATH; SO_PEERCRED UID must equal QYOS_MAIL_PORTAL_UID.
  POST /employee {"subject": <Casdoor user id from the portal's authenticated session>}
  -> 200 {visible:true, revision, provider, mailbox, webmailUrl, unread, status} | 200 {visible:false}
  -> 400/403/503 {"error": code}
Importing has no side effects; server.main calls start(host) and stop(). Nothing is logged.
"""
import atexit
import json
import os
import sqlite3
import stat
import threading
from http.server import BaseHTTPRequestHandler

import employee_email
import mail_service
import work_http
from mail_service import MailError

CONFIG_PATH = '/api/admin/enterprise-mail/config'
TEST_PATH = '/api/admin/enterprise-mail/test'
ROUTES = {CONFIG_PATH: ('GET', 'POST'), TEST_PATH: ('POST',)}
ADMIN_MAX_BODY = 16 * 1024
SOCKET_PATH = '/run/qyos-work-calendar/mail.sock'  # code-owned; independent of calendar feature flag
ENV_PORTAL_UID = 'QYOS_MAIL_PORTAL_UID'
EMPLOYEE_MAX_BODY = 1024
MAX_REPLY = 8 * 1024
IO_TIMEOUT = 5
MAX_CONCURRENCY = 8
_ADMIN_SINGLE = ('Authorization', 'Content-Type', 'Content-Length', 'Transfer-Encoding', 'Content-Encoding')

_state_lock = threading.Lock()
_server = None


def matches(path):
    return isinstance(path, str) and path.split('?', 1)[0].split('#', 1)[0] in ROUTES


# ---------------------------------------------------------------- Jadmin routes
def _owner(handler, host):
    """(actor, status): 401 without a valid session, 403 unless the actor is exactly the owner."""
    actor = work_http._bearer_actor(handler, host)  # verifies signature and expiry every time
    if actor is None:
        return None, 401
    owner = getattr(host, 'EMAIL', '')
    if not isinstance(owner, str) or not owner or actor != owner:
        return actor, 403
    if host.is_admin_actor(handler.conn(), actor) is not True:
        return actor, 403
    return actor, 200


def _admin(handler, host, svc):
    path = handler.path
    if path not in ROUTES:
        raise MailError('invalid_request')  # query strings / fragments are refused
    for name in _ADMIN_SINGLE:
        work_http._one(handler.headers, name)
    actor, status = _owner(handler, host)
    if status == 401:
        raise MailError('unauthorized', 401)
    if status != 200:
        raise MailError('owner_required', 403)
    if handler.command not in ROUTES[path]:
        raise MailError('method_not_allowed', 405)
    c = handler.conn()
    if handler.command == 'GET':
        if (handler.headers.get_all('Transfer-Encoding')
                or work_http._one(handler.headers, 'Content-Length') not in (None, '0')):
            raise MailError('unexpected_body')
        return svc.admin_view(c)
    data = handler.read_email_json(ADMIN_MAX_BODY)

    def authorize():  # re-read the signed session immediately before persistence
        return _owner(handler, host) == (actor, 200)

    if path == CONFIG_PATH:
        return svc.save(c, data, actor, authorize)
    return svc.test(c, data, authorize)


def handle(handler, host, service=None):
    """Entry point for server.H; fixed error codes only, no bodies/tokens/stacks in replies or logs."""
    try:
        svc = service if service is not None else mail_service.service(host)
        return handler.out(_admin(handler, host, svc))
    except MailError as error:
        code, status = error.code, error.status
    except work_http._Refuse as refusal:
        code, status = refusal.code, refusal.status
    except employee_email.EmailError as error:
        code, status = error.code, error.status
    except sqlite3.Error:
        code, status = 'storage_unavailable', 503
    except Exception:
        code, status = 'internal_error', 500
    handler.close_connection = True
    extra = ()
    if status == 405:
        extra = [('Allow', ', '.join(ROUTES.get(handler.path, ('GET', 'POST'))))]
    elif status == 429:
        extra = [('Retry-After', str(mail_service.TEST_INTERVAL))]
    return handler.out({'error': code}, status, extra=extra)


# ---------------------------------------------------------------- employee transport (UDS only)
def employee_reply(svc, raw):
    """Body bytes from a UID-verified peer -> (status, value). Identity comes only from `subject`."""
    try:
        body = work_http._parse_object(raw)
    except work_http._Refuse:
        return 400, {'error': 'invalid_request'}
    if set(body) != {'subject'} or not employee_email.valid_id(body['subject']):
        return 400, {'error': 'invalid_request'}
    try:
        return 200, svc.employee_summary(body['subject'])
    except MailError as error:
        return error.status, {'error': error.code}
    except Exception:
        return 503, {'error': 'unavailable'}


class EmployeeHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'  # one request per connection
    timeout = IO_TIMEOUT
    server_version = 'qyos-mail'
    sys_version = ''

    def log_message(self, *args):
        return  # never log paths, bodies or subjects

    def do_POST(self):
        if self.path != '/employee':
            return self._reply(404, {'error': 'not_found'})
        try:
            for header in work_http._SINGLE:
                work_http._one(self.headers, header)
            raw = work_http._read_body(self.rfile, self.headers, EMPLOYEE_MAX_BODY)
        except work_http._Refuse as refusal:
            return self._reply(refusal.status, {'error': refusal.code})
        status, value = employee_reply(self.server.service, raw)
        return self._reply(status, value)

    def _unsupported(self):
        return self._reply(405, {'error': 'method_not_allowed'})

    do_GET = do_HEAD = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _unsupported

    def _reply(self, status, value):
        try:
            data = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
        except (TypeError, ValueError):
            status, data = 503, b'{"error":"unavailable"}'
        if len(data) > MAX_REPLY:
            status, data = 503, b'{"error":"reply_too_large"}'
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)


def _server_class():
    import socketserver

    class MailEmployeeServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True
        block_on_close = False
        request_queue_size = 16

        def __init__(self, path, service, portal_uid, slots=MAX_CONCURRENCY):
            self.service, self.portal_uid, self.endpoint, self.identity = service, portal_uid, path, None
            self._slots = threading.BoundedSemaphore(slots)
            super().__init__(path, EmployeeHandler, bind_and_activate=False)

        def open_endpoint(self):
            dir_st = work_http._verify_directory(os.path.dirname(self.endpoint), self.portal_uid)
            work_http._clear_stale(self.endpoint)
            try:
                self.server_bind()
                st = os.lstat(self.endpoint)
                if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.geteuid():
                    raise work_http.ConfigError('socket_path_occupied')
                self.identity = (st.st_dev, st.st_ino)
                work_http._secure_socket(self.endpoint, dir_st)
                self.server_activate()  # listen only after permissions are verified
            except BaseException:
                self.close_endpoint()
                raise

        def close_endpoint(self):
            try:
                self.server_close()
            except OSError:
                pass
            identity, self.identity = self.identity, None
            if identity is None:
                return
            try:
                st = os.lstat(self.endpoint)
                if stat.S_ISSOCK(st.st_mode) and (st.st_dev, st.st_ino) == identity:
                    os.unlink(self.endpoint)
            except OSError:
                pass

        def verify_request(self, request, client_address):
            try:  # before reading any byte
                return work_http.peer_allowed(work_http._peercred(request), self.portal_uid)
            except OSError:
                return False

        def process_request(self, request, client_address):
            if not self._slots.acquire(blocking=False):
                self.shutdown_request(request)  # bounded concurrency
                return
            try:
                super().process_request(request, client_address)
            except BaseException:
                self._slots.release()
                raise

        def process_request_thread(self, request, client_address):
            try:
                super().process_request_thread(request, client_address)
            finally:
                self._slots.release()

    return MailEmployeeServer


def portal_uid():
    """Resolve the code-owned portal account; explicit configuration must match that account."""
    import pwd
    try:
        expected = pwd.getpwnam('qyos-portal').pw_uid
    except KeyError:
        raise work_http.ConfigError('portal_identity_unknown') from None
    if type(expected) is not int or expected <= 0:
        raise work_http.ConfigError('portal_uid_invalid')
    raw = os.environ.get(ENV_PORTAL_UID, os.environ.get(work_http.ENV_PORTAL_UID))
    if raw is not None and work_http._portal_uid(raw) != expected:
        raise work_http.ConfigError('portal_uid_mismatch')
    return expected


def start(host, service=None):
    """Bind the independent socket even when mail is disabled; disabled summaries remain invisible."""
    global _server
    try:
        uid = portal_uid()
        svc = service if service is not None else mail_service.service(host)
        server = _server_class()(SOCKET_PATH, svc, uid)
        server.open_endpoint()
    except (work_http.ConfigError, OSError) as error:
        raise SystemExit('qyos-enterprise-mail: ' + getattr(error, 'code', 'endpoint_unavailable')) from None
    with _state_lock:
        _server = server
    threading.Thread(target=server.serve_forever, name='qyos-mail-employee', daemon=True).start()
    atexit.register(stop)
    return server


def stop():
    global _server
    with _state_lock:
        server, _server = _server, None
    if server is None:
        return
    try:
        server.shutdown()
    except Exception:
        pass
    server.close_endpoint()
