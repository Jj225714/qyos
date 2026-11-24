"""QYOS-WORK-01 HTTP/runtime adapter: Jadmin admin routes + private employee Unix-socket service.

Off unless QYOS_WORK_CALENDAR_ENABLED is exactly '1'. Importing has no side effects (no env parsing, DB,
directory or socket). server.py calls matches()/handle() for ADMIN_PREFIX and start()/stop() from main().

Frozen shapes. Employee replies are HTTP 200 {"status", "body"} (HTTP 503 {"error"} when unavailable):
  GET  /bootstrap[?from&to&unscheduled]     {profile, lists, tasks, assigned, truncated, today}
  POST /task-draft -> {title, notes, dueDate, assigneeQuery}; preview only
  GET  /todo-summary -> {today, pending, completed, truncated}
  GET  /lists -> {lists}   POST /lists -> list   GET|PATCH|DELETE /lists/:uuid -> list | core result
  GET  /tasks?from&to[&listId][&unscheduled] -> {tasks, truncated}     POST /tasks -> task
  GET|PATCH|DELETE /tasks/:uuid   POST /tasks/:uuid/complete|undo -> task
  GET  /assignments?from&to -> {assigned, truncated}   GET /assignments/:uuid -> assignment
  POST /assignments/:uuid/complete|undo -> assignment
  GET|PATCH /reports/:day   POST /reports/:day/prefill (body {})   POST /reports/:day/submit
Admin (HTTP JSON, errors {"error": code}) under /jadmin/team-work:
  GET bootstrap[?from&to] -> {employees:[{employeeId,displayName,department,active,startDate}],
      startDateMappingRequired, today}
  POST task-draft -> same preview contract as employee
  GET|POST assignments   PATCH assignments/:uuid   POST assignments/:uuid/cancel|reopen
  GET assignments/:uuid/history -> {history}   GET reports?from&to...   GET reports/:employeeId/:day
"""
import atexit
import json
import os
import re
import socket
import sqlite3
import stat
import struct
import threading
from collections import Counter
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import unquote, urlsplit

import employee_email
import work_core
import work_task_draft
from work_core import SHANGHAI, AdminContext, EmployeeContext, WorkError, WorkService
from work_reports import ReportService

FLAG = 'QYOS_WORK_CALENDAR_ENABLED'
ENV_DB = 'QYOS_WORK_CALENDAR_DB'
ENV_ORIGIN = 'QYOS_WORK_CALENDAR_ORIGIN'
ENV_PORTAL_UID = 'QYOS_WORK_CALENDAR_PORTAL_UID'
ENV_START_DATES = 'QYOS_WORK_CALENDAR_START_DATES'
ENV_PILOT_DEPARTMENT = 'QYOS_WORK_CALENDAR_PILOT_DEPARTMENT'
ADMIN_PREFIX = '/jadmin/team-work'
SOCKET_PATH = '/run/qyos-work-calendar/employee.sock'  # code-owned; never configurable
ADMIN_MAX_BODY = 16 * 1024
EMPLOYEE_MAX_ENVELOPE = work_core.ENVELOPE_MAX_BYTES
MAX_REPLY = work_core.RESPONSE_MAX_BYTES
MAX_START_DATES = 256 * 1024
LIST_LIMIT, BOOTSTRAP_LIMIT = 200, 100
MAX_CONCURRENCY = 16
IO_TIMEOUT = 5
INACTIVE_FLAGS = ('isDeleted', 'isForbidden', 'isDisabled', 'pendingApproval')
_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
_DAY = r'\d{4}-\d{2}-\d{2}'
_UUID_RE = re.compile(_UUID + r'\Z')
_DAY_RE = re.compile(_DAY + r'\Z')
_DEPT_RE = re.compile(r'[a-z][a-z0-9_-]{1,31}\Z')
_UID_RE = re.compile(r'[1-9][0-9]{0,9}\Z')
_CTRL = re.compile(r'[\x00-\x1f\x7f]')
_PEERCRED = struct.Struct('3i')
_ENVELOPE = frozenset(('subject', 'method', 'path', 'body'))
_SINGLE = ('Authorization', 'Origin', 'Sec-Fetch-Site', 'Content-Type', 'Content-Length',
           'Transfer-Encoding', 'Content-Encoding')


class ConfigError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class _Refuse(Exception):
    def __init__(self, status, code, allow=None):
        super().__init__(code)
        self.status, self.code, self.allow = status, code, allow


# ---------------------------------------------------------------- configuration
@dataclass(frozen=True)
class Config:
    enabled: bool
    db_path: str = None
    origin: str = None
    portal_uid: int = None
    start_dates: dict = field(default_factory=dict)
    pilot_department: str = None


def enabled(env=None):
    return (os.environ if env is None else env).get(FLAG) == '1'


def load_config(env, admin_db=None):
    """Validates the whole configuration or raises ConfigError(code). Disabled reads nothing else."""
    if env.get(FLAG) != '1':
        return Config(False)
    pilot = env.get(ENV_PILOT_DEPARTMENT)
    if pilot is not None and not _DEPT_RE.fullmatch(pilot):
        raise ConfigError('pilot_department_invalid')
    return Config(True, _db_path(env.get(ENV_DB), admin_db), _origin(env.get(ENV_ORIGIN)),
                  _portal_uid(env.get(ENV_PORTAL_UID)), _start_dates(env.get(ENV_START_DATES)), pilot)


def _db_path(value, admin_db):
    if (not isinstance(value, str) or not value or _CTRL.search(value) or not os.path.isabs(value)
            or os.path.normpath(value) != value or value.endswith(('-wal', '-shm', '-journal'))):
        raise ConfigError('db_path_invalid')
    real = os.path.realpath(value)
    if admin_db and real == os.path.realpath(admin_db):
        raise ConfigError('db_path_shared')
    if not os.path.isdir(os.path.dirname(real)):
        raise ConfigError('db_directory_missing')
    if os.path.lexists(value) and (os.path.islink(value) or not os.path.isfile(value)):
        raise ConfigError('db_path_unsafe')
    return value


def _origin(value):
    if not isinstance(value, str) or _CTRL.search(value) or len(value) > 255:
        raise ConfigError('origin_invalid')
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        raise ConfigError('origin_invalid') from None
    if parts.scheme != 'https' or not parts.hostname or port in (0, 443):
        raise ConfigError('origin_invalid')
    if value != 'https://' + parts.hostname + ('' if port is None else ':%d' % port):
        raise ConfigError('origin_invalid')  # no path, userinfo, query, uppercase or trailing slash
    return value


def _portal_uid(value):
    if not isinstance(value, str) or not _UID_RE.fullmatch(value) or int(value) > 2**31 - 2:
        raise ConfigError('portal_uid_invalid')
    return int(value)


def _start_dates(value):
    """Optional explicit subject -> YYYY-MM-DD map; one bad entry rejects the whole map."""
    if value is None:
        return {}
    if not isinstance(value, str) or len(value) > MAX_START_DATES:
        raise ConfigError('start_dates_invalid')
    try:
        data = employee_email.strict_json(value)
    except (ValueError, RecursionError):
        raise ConfigError('start_dates_invalid') from None
    if not isinstance(data, dict) or len(data) > 20000:
        raise ConfigError('start_dates_invalid')
    for subject, day in data.items():
        if not employee_email.valid_id(subject):
            raise ConfigError('start_dates_invalid')
        try:
            work_core._date(day)
        except WorkError:
            raise ConfigError('start_dates_invalid') from None
    return dict(data)


# ---------------------------------------------------------------- directory (fresh per request)
def build_records(users, organization, department_of, start_dates):
    """Casdoor users -> core.directory records. Exact owner + stable id; no email/name identity fallback."""
    if not isinstance(users, list):
        raise ValueError('directory')
    out = []
    for user in users:
        if not isinstance(user, dict) or user.get('owner') != organization:
            continue
        subject = user.get('id')
        if not employee_email.valid_id(subject):
            continue  # fail closed: no name fallback for unusable ids
        active = all(user.get(flag) is None or user.get(flag) is False for flag in INACTIVE_FLAGS)
        email = user.get('email') if isinstance(user.get('email'), str) else ''
        raw_groups = user.get('groups')
        groups = [g for g in raw_groups if isinstance(g, str)] if isinstance(raw_groups, list) else []
        department = department_of(email, groups)  # email only feeds the existing department resolver
        name = user.get('displayName') or user.get('name')
        name = _CTRL.sub('', name).strip()[:200] if isinstance(name, str) else ''
        out.append({'organization': organization, 'subject': subject, 'active': active,
                    'displayName': name or subject,
                    'department': department if isinstance(department, str) and department else None,
                    'startDate': start_dates.get(subject)})
    return out


class DirectorySnapshot:
    """One fresh directory read per request, memoized only within that request."""

    def __init__(self, fetch, organization, start_dates, pilot_department=None):
        self._fetch, self.organization, self._start, self._records = fetch, organization, start_dates, None
        self._pilot = pilot_department

    def roster(self, organization):
        if organization != self.organization:
            return []
        if self._records is None:
            try:
                users, department_of = self._fetch()
                records = build_records(users, organization, department_of, self._start)
                if self._pilot is not None:
                    counts = Counter(r['subject'] for r in records)
                    records = [r for r in records if r['department'] == self._pilot and counts[r['subject']] == 1]
                self._records = records
            except Exception:
                raise WorkError('directory_unavailable', 503) from None
        return [dict(r) for r in self._records]

    def lookup(self, organization, subject):
        return [r for r in self.roster(organization) if r['subject'] == subject]


def _deny(_ctx):
    return False


def _no_directory(_organization, _subject):
    return []


def _no_roster(_organization):
    return []


class Runtime:
    """Injectable runtime: storage, directory, clock and report service factory."""

    def __init__(self, config, host, *, connect=None, fetch_directory=None, clock=None, report_factory=None):
        self.config, self.host = config, host
        self._connect = connect or self._default_connect
        self._fetch = fetch_directory or self._default_fetch
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self._reports = report_factory or (lambda core, roster: ReportService(
            core, roster=roster, start_dates_verified=bool(config.start_dates)))
        self._lock, self._ready = threading.Lock(), False

    def organization(self):
        try:
            organization = self.host.enterprise.settings().get('organization')
        except Exception:
            organization = None
        if not employee_email.valid_id(organization):
            raise WorkError('organization_unconfigured', 503)
        return organization

    def today(self):
        return self.clock().astimezone(SHANGHAI).date().isoformat()

    def _default_connect(self):
        return sqlite3.connect(self.config.db_path, timeout=5, isolation_level=None)

    def _default_fetch(self):
        enterprise = self.host.enterprise
        users = enterprise.casdoor_users()
        with closing(self.host.db()) as c:  # pure reads; never directory_report
            departments = enterprise.list_departments(c)
            assignments = {r['email']: r['code'] for r in enterprise.list_assignments(c)}
        return users, lambda email, groups: enterprise.resolve(departments, assignments, email, groups)

    def open(self):
        """A new connection per request; schema/WAL prepared once (additive)."""
        try:
            conn = self._connect()
        except sqlite3.Error:
            raise WorkError('storage_unavailable', 503) from None
        try:
            if not self._ready:
                with self._lock:
                    if not self._ready:
                        try:
                            work_core.configure_wal(conn)
                        except sqlite3.Error:
                            raise WorkError('storage_unavailable', 503) from None
                        core = WorkService(conn, clock=self.clock, directory=_no_directory, authorize_admin=_deny)
                        core.init_db()
                        self._reports(core, _no_roster).init_db()
                        self._ready = True
        except BaseException:
            conn.close()
            raise
        return conn

    def services(self, conn, organization, authorize):
        snapshot = self.directory(organization)
        core = WorkService(conn, clock=self.clock, directory=snapshot.lookup, authorize_admin=authorize)
        return core, self._reports(core, snapshot.roster), snapshot

    def directory(self, organization):
        return DirectorySnapshot(self._fetch, organization, self.config.start_dates, self.config.pilot_department)


_state_lock = threading.Lock()
_runtime = None
_server = None


def current_runtime(host):
    """None when disabled (nothing else read); raises ConfigError when enabled but misconfigured."""
    global _runtime
    if not enabled():
        return None
    with _state_lock:
        if _runtime is None:
            _runtime = Runtime(load_config(os.environ, getattr(host, 'DB', None)), host)
        return _runtime


# ---------------------------------------------------------------- shared request helpers
def _one(headers, name):
    values = headers.get_all(name) or []
    if len(values) > 1:
        raise _Refuse(400, 'ambiguous_headers')
    return values[0] if values else None


def _read_body(rfile, headers, limit, connection=None):
    ctype = _one(headers, 'Content-Type')
    media, _, params = (ctype or '').partition(';')
    if media.strip().lower() != 'application/json' or params.strip().lower().replace(' ', '') not in ('', 'charset=utf-8'):
        raise _Refuse(415, 'unsupported_media_type')
    if headers.get_all('Transfer-Encoding') or headers.get_all('Content-Encoding'):
        raise _Refuse(400, 'invalid_body')
    length = _one(headers, 'Content-Length')
    if length is None or not (length.isascii() and length.isdigit()) or len(length) > 9:
        raise _Refuse(411, 'length_required')
    size = int(length)
    if size > limit:
        raise _Refuse(413, 'too_large')
    if size < 1:
        raise _Refuse(400, 'invalid_body')
    prior = connection.gettimeout() if connection is not None else None
    try:
        if connection is not None:
            connection.settimeout(IO_TIMEOUT)
        raw = rfile.read(size)
    except OSError:
        raise _Refuse(400, 'invalid_body') from None
    finally:
        if connection is not None:
            try:
                connection.settimeout(prior)
            except OSError:
                pass
    if len(raw) != size:
        raise _Refuse(400, 'invalid_body')
    return raw


def _parse_object(raw):
    try:
        value = employee_email.strict_json(raw.decode('utf-8'))  # duplicate keys / NaN rejected
    except (ValueError, RecursionError):
        raise _Refuse(400, 'invalid_body') from None
    if not isinstance(value, dict):
        raise _Refuse(400, 'invalid_body')
    return value


# ---------------------------------------------------------------- admin (Jadmin) routes
_ADMIN_ROUTES = (
    ('bootstrap', re.compile(r'/bootstrap\Z'), {'GET': ((), ('from', 'to'))}),
    ('task_draft', re.compile(r'/task-draft\Z'), {'POST': None}),
    ('assignments', re.compile(r'/assignments\Z'),
     {'GET': (('from', 'to'), ('employeeId', 'department', 'status')), 'POST': None}),
    ('assignment', re.compile(r'/assignments/(%s)\Z' % _UUID), {'PATCH': None}),
    ('assignment_action', re.compile(r'/assignments/(%s)/(cancel|reopen)\Z' % _UUID), {'POST': None}),
    ('history', re.compile(r'/assignments/(%s)/history\Z' % _UUID), {'GET': ((), ())}),
    ('reports', re.compile(r'/reports\Z'),
     {'GET': (('from', 'to'), ('employeeId', 'department', 'reportStatus'))}),
    ('report', re.compile(r'/reports/([^/]{1,384})/(%s)\Z' % _DAY), {'GET': ((), ())}),
)


def matches(path):
    if not isinstance(path, str):
        return False
    base = path.split('?', 1)[0].split('#', 1)[0]
    return base == ADMIN_PREFIX or base.startswith(ADMIN_PREFIX + '/')


def _path_id(segment):
    try:
        value = unquote(segment, errors='strict')
    except UnicodeDecodeError:
        value = None
    if not employee_email.valid_id(value):  # decoded '/', '%', spaces etc. never form a valid id
        raise _Refuse(404, 'not_found')
    return value


def _admin_query(raw, required, optional):
    allowed, params = set(required) | set(optional), {}
    if raw is not None:
        if not raw or len(raw) > 512:
            raise _Refuse(400, 'invalid_query')
        for part in raw.split('&'):
            key, eq, value = part.partition('=')
            if not eq or key not in allowed or key in params:
                raise _Refuse(400, 'invalid_query')
            try:
                value = unquote(value, errors='strict')
            except UnicodeDecodeError:
                raise _Refuse(400, 'invalid_query') from None
            if not value or len(value) > 128 or _CTRL.search(value):
                raise _Refuse(400, 'invalid_query')
            params[key] = value
    if not set(required) <= set(params) or ('from' in params) != ('to' in params):
        raise _Refuse(400, 'invalid_query')
    if 'employeeId' in params and not employee_email.valid_id(params['employeeId']):
        raise _Refuse(400, 'invalid_query')
    if 'department' in params and not _DEPT_RE.fullmatch(params['department']):
        raise _Refuse(400, 'invalid_query')
    return params


def _admin_target(raw, method):
    if not isinstance(raw, str) or '#' in raw or len(raw) > 2048:
        raise _Refuse(404, 'not_found')
    path, sep, query = raw.partition('?')
    resource = path[len(ADMIN_PREFIX):]
    for name, rx, methods in _ADMIN_ROUTES:
        found = rx.match(resource)
        if not found:
            continue
        if method not in methods:
            raise _Refuse(405, 'method_not_allowed', ', '.join(sorted(methods)))
        spec = methods[method]
        if spec is None:
            if sep:
                raise _Refuse(400, 'invalid_query')
            params = {}
        else:
            params = _admin_query(query if sep else None, *spec)
        groups = found.groups()
        if name == 'report':
            groups = (_path_id(groups[0]), groups[1])
        return name, groups, params
    raise _Refuse(404, 'not_found')


def _bearer_actor(handler, host):
    values = handler.headers.get_all('Authorization') or []
    if len(values) != 1 or not values[0].startswith('Bearer ') or not 1 <= len(values[0]) - 7 <= 4096:
        return None
    try:
        actor = host.who(values[0][7:])  # verifies signature and expiry every time
    except Exception:
        return None
    return actor if isinstance(actor, str) and actor else None


def _admin_bootstrap(rt, core, reports, snapshot, ctx, groups, query, data):
    if 'from' in query:
        work_core._range(query['from'], query['to'], True)
    core._check_admin(ctx)
    records = snapshot.roster(ctx.organization)
    counts = Counter(r['subject'] for r in records)
    employees = [{'employeeId': r['subject'], 'displayName': r['displayName'], 'department': r['department'],
                  'active': r['active'], 'startDate': r['startDate']} for r in records if counts[r['subject']] == 1]
    employees.sort(key=lambda e: (not e['active'], e['department'] or '~', e['displayName'], e['employeeId']))
    return {'employees': employees,
            'startDateMappingRequired': any(e['active'] and e['startDate'] is None for e in employees),
            'today': rt.today()}


_ADMIN_ACTIONS = {
    'bootstrap': _admin_bootstrap,
    'assignments': lambda rt, core, rep, snap, ctx, g, q, d: (
        core.admin_create_assignment(ctx, d) if d is not None else
        core.admin_list_assignments(ctx, start=q['from'], end=q['to'], employee_id=q.get('employeeId'),
                                    department=q.get('department'), status=q.get('status'))),
    'assignment': lambda rt, core, rep, snap, ctx, g, q, d: core.admin_update_assignment(ctx, g[0], d),
    'assignment_action': lambda rt, core, rep, snap, ctx, g, q, d: (
        core.admin_cancel_assignment if g[1] == 'cancel' else core.admin_reopen_assignment)(ctx, g[0], d),
    'history': lambda rt, core, rep, snap, ctx, g, q, d: {'history': core.admin_assignment_history(ctx, g[0])},
    'reports': lambda rt, core, rep, snap, ctx, g, q, d: rep.admin_calendar(
        ctx, start=q['from'], end=q['to'], employee_id=q.get('employeeId'), department=q.get('department'),
        report_status=q.get('reportStatus')),
    'report': lambda rt, core, rep, snap, ctx, g, q, d: rep.admin_read(ctx, g[0], g[1]),
}


def _admin(handler, host, rt):
    write = handler.command != 'GET'
    name, groups, query = _admin_target(handler.path, handler.command)
    for header in _SINGLE:
        _one(handler.headers, header)
    if not write and (handler.headers.get_all('Transfer-Encoding')
                      or _one(handler.headers, 'Content-Length') not in (None, '0')):
        raise _Refuse(400, 'unexpected_body')
    actor = _bearer_actor(handler, host)
    if actor is None:
        raise _Refuse(401, 'unauthorized')
    if host.is_admin_actor(handler.conn(), actor) is not True:
        raise _Refuse(403, 'admin_required')
    data = None
    if write:
        if _one(handler.headers, 'Origin') != rt.config.origin:
            raise _Refuse(403, 'origin_mismatch')
        if _one(handler.headers, 'Sec-Fetch-Site') not in (None, 'same-origin'):
            raise _Refuse(403, 'cross_site')
        data = _parse_object(_read_body(handler.rfile, handler.headers, ADMIN_MAX_BODY, handler.connection))
    organization = rt.organization()
    ctx = AdminContext(organization, actor)

    def authorize(current):  # core repeats this inside its transactions, right before mutation
        return (current == ctx and _bearer_actor(handler, host) == actor
                and host.is_admin_actor(handler.conn(), actor) is True)

    if name == 'task_draft':
        draft = work_task_draft.suggest(rt.host, rt.today(), data)
        if not authorize(ctx):
            raise _Refuse(403, 'admin_required')
        return draft
    conn = rt.open()
    try:
        core, reports, snapshot = rt.services(conn, organization, authorize)
        return _ADMIN_ACTIONS[name](rt, core, reports, snapshot, ctx, groups, query, data)
    finally:
        conn.close()


def handle(handler, host, runtime=None):
    """Admin entry point for server.H; responds via handler.out with fixed error codes only."""
    try:
        rt = runtime if runtime is not None else current_runtime(host)
    except ConfigError:
        handler.close_connection = True
        return handler.out({'error': 'work_unconfigured'}, 503)
    if rt is None or not rt.config.enabled:
        handler.close_connection = True
        return handler.out({'error': 'not_found'}, 404)
    try:
        result = _admin(handler, host, rt)
    except _Refuse as refusal:
        handler.close_connection = True
        return handler.out({'error': refusal.code}, refusal.status,
                           extra=[('Allow', refusal.allow)] if refusal.allow else ())
    except WorkError as error:
        return handler.out({'error': error.code}, error.status)
    except Exception:
        handler.close_connection = True
        return handler.out({'error': 'internal_error'}, 500)
    return handler.out(result)


# ---------------------------------------------------------------- employee dispatcher (UDS only)
_EMP_ROUTES = (
    ('bootstrap', re.compile(r'/bootstrap\Z'), {'GET'}, ('from', 'to', 'unscheduled')),
    ('todo_summary', re.compile(r'/todo-summary\Z'), {'GET'}, ()),
    ('task_draft', re.compile(r'/task-draft\Z'), {'POST'}, ()),
    ('lists', re.compile(r'/lists\Z'), {'GET', 'POST'}, ()),
    ('list', re.compile(r'/lists/(%s)\Z' % _UUID), {'GET', 'PATCH', 'DELETE'}, ()),
    ('tasks', re.compile(r'/tasks\Z'), {'GET', 'POST'}, ('from', 'to', 'listId', 'unscheduled')),
    ('task', re.compile(r'/tasks/(%s)\Z' % _UUID), {'GET', 'PATCH', 'DELETE'}, ()),
    ('task_state', re.compile(r'/tasks/(%s)/(complete|undo)\Z' % _UUID), {'POST'}, ()),
    ('subtask', re.compile(r'/(tasks|assignments)/(%s)/subtasks/(%s)\Z' % (_UUID, _UUID)), {'POST'}, ()),
    ('assignments', re.compile(r'/assignments\Z'), {'GET'}, ('from', 'to')),
    ('assignment', re.compile(r'/assignments/(%s)\Z' % _UUID), {'GET'}, ()),
    ('assignment_state', re.compile(r'/assignments/(%s)/(complete|undo)\Z' % _UUID), {'POST'}, ()),
    ('report', re.compile(r'/reports/(%s)\Z' % _DAY), {'GET', 'PATCH'}, ()),
    ('report_action', re.compile(r'/reports/(%s)/(prefill|submit)\Z' % _DAY), {'POST'}, ()),
)
_EMP_QUERY = {'from': _DAY_RE.fullmatch, 'to': _DAY_RE.fullmatch, 'listId': _UUID_RE.fullmatch,
              'unscheduled': lambda v: v in ('true', 'false')}


def _employee_target(method, path):
    if len(path) > 512 or not path.isascii() or '#' in path:
        raise _Refuse(404, 'not_found')
    resource, sep, query = path.partition('?')
    for name, rx, methods, keys in _EMP_ROUTES:
        found = rx.match(resource)
        if not found:
            continue
        if method not in methods:
            raise _Refuse(404, 'not_found')
        params = {}
        if sep:
            if method != 'GET' or not query or len(query) > 256:
                raise _Refuse(400, 'invalid_query')
            for part in query.split('&'):
                key, eq, value = part.partition('=')
                if not eq or key not in keys or key in params or not _EMP_QUERY[key](value):
                    raise _Refuse(400, 'invalid_query')
                params[key] = value
        if ('from' in params) != ('to' in params) or (
                method == 'GET' and name in ('tasks', 'assignments') and 'from' not in params):
            raise _Refuse(400, 'invalid_query')
        return name, found.groups(), params
    raise _Refuse(404, 'not_found')


def _own_task(core, ctx, task_id):
    core.employee_profile(ctx)  # fresh active-directory check
    with core._txn(False):
        row = core._own(ctx, 'wc_tasks', work_core._TASK_COLS, task_id)  # owner-bound, no list scan
    return work_core._task_out(row, core._now())


def _own_assignment(core, ctx, assignment_id):
    core.employee_profile(ctx)
    with core._txn(False):
        row = core._asg(ctx.organization, assignment_id, ctx.subject)  # current assignee only
    return work_core._asg_out(row, core._now())


def _overview(core, ctx, query, limit):
    return core.employee_overview(ctx, start=query.get('from'), end=query.get('to'),
                                  unscheduled=query.get('unscheduled') == 'true', limit=limit)


def _e_bootstrap(rt, core, rep, ctx, method, g, q, body):
    profile = core.employee_profile(ctx)
    profile['startDateVerified'] = ctx.subject in rt.config.start_dates
    lists = core.list_lists(ctx)
    overview = _overview(core, ctx, q, BOOTSTRAP_LIMIT)
    return {'profile': profile, 'lists': lists, 'tasks': overview['tasks'], 'assigned': overview['assigned'],
            'truncated': overview['truncated'], 'today': rt.today()}


def _e_list(rt, core, rep, ctx, method, g, q, body):
    if method == 'GET':
        for item in core.list_lists(ctx):  # complete owner-scoped list (quota-bounded, never truncated)
            if item['id'] == g[0]:
                return item
        raise WorkError('not_found', 404)
    return (core.update_list if method == 'PATCH' else core.delete_list)(ctx, g[0], body)


def _e_tasks(rt, core, rep, ctx, method, g, q, body):
    if method == 'POST':
        return core.create_task(ctx, body)
    overview = _overview(core, ctx, q, LIST_LIMIT)
    tasks = overview['tasks']
    if 'listId' in q:
        tasks = [t for t in tasks if t['listId'] == q['listId']]
    return {'tasks': tasks, 'truncated': overview['truncated']}  # conservative: filter never hides truncation


def _e_report_action(rt, core, rep, ctx, method, g, q, body):
    if g[1] == 'prefill':
        if body != {}:
            raise WorkError('invalid_request')
        return rep.employee_prefill(ctx, g[0])  # never saves or submits
    return rep.employee_submit(ctx, g[0], body)  # explicit request with confirm:true only


_EMP_ACTIONS = {
    'bootstrap': _e_bootstrap,
    'todo_summary': lambda rt, core, rep, ctx, m, g, q, b: core.employee_todo_summary(ctx),
    'lists': lambda rt, core, rep, ctx, m, g, q, b: {'lists': core.list_lists(ctx)} if m == 'GET'
    else core.create_list(ctx, b),
    'list': _e_list,
    'tasks': _e_tasks,
    'task': lambda rt, core, rep, ctx, m, g, q, b: _own_task(core, ctx, g[0]) if m == 'GET'
    else (core.update_task if m == 'PATCH' else core.delete_task)(ctx, g[0], b),
    'task_state': lambda rt, core, rep, ctx, m, g, q, b: (
        core.complete_task if g[1] == 'complete' else core.undo_task)(ctx, g[0], b),
    'subtask': lambda rt, core, rep, ctx, m, g, q, b: (
        core.set_subtask_completed(ctx, g[1], g[2], b, assigned=g[0] == 'assignments')),
    'assignments': lambda rt, core, rep, ctx, m, g, q, b: (
        lambda ov: {'assigned': ov['assigned'], 'truncated': ov['truncated']})(_overview(core, ctx, q, LIST_LIMIT)),
    'assignment': lambda rt, core, rep, ctx, m, g, q, b: _own_assignment(core, ctx, g[0]),
    'assignment_state': lambda rt, core, rep, ctx, m, g, q, b: (
        core.complete_assignment if g[1] == 'complete' else core.undo_assignment)(ctx, g[0], b),
    'report': lambda rt, core, rep, ctx, m, g, q, b: rep.employee_get(ctx, g[0]) if m == 'GET'
    else rep.employee_save(ctx, g[0], b),
    'report_action': _e_report_action,
}


def dispatch(rt, raw):
    """Envelope bytes from a UID-verified peer -> (http_status, json value). No logging of content."""
    if not isinstance(raw, bytes) or len(raw) > EMPLOYEE_MAX_ENVELOPE:
        return 413, {'error': 'request_too_large'}
    try:
        envelope = _parse_object(raw)
    except _Refuse:
        return 400, {'error': 'invalid_envelope'}
    if set(envelope) != _ENVELOPE:
        return 400, {'error': 'invalid_envelope'}
    subject, method, path, body = (envelope[k] for k in ('subject', 'method', 'path', 'body'))
    if (not isinstance(subject, str) or not isinstance(path, str) or not isinstance(method, str)
            or method not in ('GET', 'POST', 'PATCH', 'DELETE') or not (body is None or isinstance(body, dict))):
        return 400, {'error': 'invalid_envelope'}
    try:
        try:
            size = 0 if body is None else len(json.dumps(body, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8'))
        except UnicodeEncodeError:
            raise _Refuse(400, 'invalid_body') from None
        if size > work_core.EMPLOYEE_BODY_MAX_BYTES:
            raise _Refuse(400, 'request_too_large')
        if not employee_email.valid_id(subject):
            raise _Refuse(404, 'not_found')
        name, groups, query = _employee_target(method, path)
        if method == 'GET' and body is not None:
            raise _Refuse(400, 'unexpected_body')
        if method != 'GET' and not isinstance(body, dict):
            raise _Refuse(400, 'invalid_request')
        organization = rt.organization()  # fixed server side; never from the envelope
        ctx = EmployeeContext(organization, subject)
        if name == 'task_draft':
            snapshot = rt.directory(organization)
            matches = snapshot.lookup(organization, subject)
            if not matches:
                raise WorkError('employee_unknown', 403)
            if len(matches) != 1:
                raise WorkError('directory_ambiguous', 503)
            if matches[0]['active'] is not True:
                raise WorkError('employee_inactive', 403)
            result = work_task_draft.suggest(rt.host, rt.today(), body)
        else:
            conn = rt.open()
            try:
                core, reports, _ = rt.services(conn, organization, _deny)
                result = _EMP_ACTIONS[name](rt, core, reports, ctx, method, groups, query, body)
            finally:
                conn.close()
    except _Refuse as refusal:
        return 200, {'status': refusal.status, 'body': {'error': refusal.code}}
    except WorkError as error:
        if error.code == 'work_ai_unavailable':
            return 200, {'status': 503, 'body': {'error': error.code}}
        if error.status >= 500:
            return 503, {'error': error.code}
        return 200, {'status': error.status, 'body': {'error': error.code}}
    except Exception:
        return 503, {'error': 'unavailable'}
    return 200, {'status': 200, 'body': result}


# ---------------------------------------------------------------- UDS transport and peer policy
def peer_allowed(cred, expected_uid):
    """Pure SO_PEERCRED policy: exactly the configured, non-root portal UID."""
    if type(expected_uid) is not int or expected_uid <= 0:
        return False
    if not isinstance(cred, (bytes, bytearray)) or len(cred) != _PEERCRED.size:
        return False
    pid, uid, _gid = _PEERCRED.unpack(bytes(cred))
    return pid > 0 and uid == expected_uid


def _peercred(sock):
    return sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, _PEERCRED.size)


class EmployeeHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'  # one request per connection
    timeout = IO_TIMEOUT
    server_version = 'qyos-work'
    sys_version = ''

    def log_message(self, *args):
        return  # never log paths, bodies, subjects or credentials

    def do_POST(self):
        if self.path != '/employee':
            return self._reply(404, {'error': 'not_found'})
        try:
            raw = _read_body(self.rfile, self.headers, EMPLOYEE_MAX_ENVELOPE)
            for header in _SINGLE:
                _one(self.headers, header)
        except _Refuse as refusal:
            return self._reply(refusal.status, {'error': refusal.code})
        status, value = dispatch(self.server.runtime, raw)
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


def _verify_directory(directory, portal_uid):
    import grp
    import pwd
    euid = os.geteuid()
    try:
        st = os.lstat(directory)
    except FileNotFoundError:
        raise ConfigError('socket_directory_missing') from None
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != euid or stat.S_IMODE(st.st_mode) != 0o750:
        raise ConfigError('socket_directory_unsafe')  # symlinks fail S_ISDIR on lstat
    parent = os.lstat(os.path.dirname(directory))
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid not in (0, euid) or parent.st_mode & 0o022:
        raise ConfigError('socket_parent_unsafe')
    if portal_uid == euid:
        raise ConfigError('portal_uid_is_service_uid')
    try:
        portal, group = pwd.getpwuid(portal_uid), grp.getgrgid(st.st_gid)
    except KeyError:
        raise ConfigError('portal_identity_unknown') from None
    if portal.pw_gid != st.st_gid and portal.pw_name not in group.gr_mem:
        raise ConfigError('portal_not_in_socket_group')
    return st


def _clear_stale(path):
    """Only an existing socket owned by this UID that refuses connections is removed."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.geteuid():
        raise ConfigError('socket_path_occupied')
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(1)
    try:
        probe.connect(path)
    except ConnectionRefusedError:
        pass
    except OSError:
        raise ConfigError('socket_path_occupied') from None
    else:
        raise ConfigError('socket_in_use')
    finally:
        probe.close()
    again = os.lstat(path)
    if (again.st_dev, again.st_ino) != (st.st_dev, st.st_ino):
        raise ConfigError('socket_path_occupied')
    os.unlink(path)


def _secure_socket(path, dir_st):
    os.chmod(path, 0o660)  # path was just bound by us inside a 0750 directory only we can write
    st = os.lstat(path)
    if st.st_gid != dir_st.st_gid:
        os.chown(path, -1, dir_st.st_gid)
        st = os.lstat(path)
    if (not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.geteuid() or st.st_gid != dir_st.st_gid
            or stat.S_IMODE(st.st_mode) != 0o660):
        raise ConfigError('socket_permissions_unverified')


def _server_class():
    import socketserver

    class EmployeeServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True
        block_on_close = False
        request_queue_size = 32

        def __init__(self, path, runtime, portal_uid, slots=MAX_CONCURRENCY):
            self.runtime, self.portal_uid, self.endpoint, self.identity = runtime, portal_uid, path, None
            self._slots = threading.BoundedSemaphore(slots)
            super().__init__(path, EmployeeHandler, bind_and_activate=False)

        def open_endpoint(self):
            dir_st = _verify_directory(os.path.dirname(self.endpoint), self.portal_uid)
            _clear_stale(self.endpoint)
            try:
                self.server_bind()
                st = os.lstat(self.endpoint)
                if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.geteuid():
                    raise ConfigError('socket_path_occupied')
                self.identity = (st.st_dev, st.st_ino)
                _secure_socket(self.endpoint, dir_st)
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
            try:  # before any byte of the request, directory lookup or DB access
                return peer_allowed(_peercred(request), self.portal_uid)
            except OSError:
                return False

        def process_request(self, request, client_address):
            if not self._slots.acquire(blocking=False):
                self.shutdown_request(request)  # bounded concurrency: portal maps to 503
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

    return EmployeeServer


def start(host, runtime=None):
    """Called only from server.main when enabled. Fails the process closed on any config/endpoint issue."""
    global _server
    try:
        rt = runtime if runtime is not None else current_runtime(host)
        if rt is None or not rt.config.enabled:
            raise ConfigError('disabled')
        rt.organization()
        rt.open().close()
        server = _server_class()(SOCKET_PATH, rt, rt.config.portal_uid)
        server.open_endpoint()
    except (ConfigError, WorkError, OSError) as error:
        raise SystemExit('qyos-work-calendar: ' + getattr(error, 'code', 'endpoint_unavailable')) from None
    with _state_lock:
        _server = server
    threading.Thread(target=server.serve_forever, name='qyos-work-employee', daemon=True).start()
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
