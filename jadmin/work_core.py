"""QYOS-WORK-01 batch A: private lists/tasks and shared assignments. Domain logic only (no HTTP).

CONTRACT (stable seam for work_reports.py and the later portal/Jadmin adapters)
  WorkService(conn, *, clock, directory, authorize_admin)
    conn      caller-owned sqlite3.Connection (legacy isolation_level or autocommit=True). Every call
              refuses to start while conn.in_transaction, so caller work is never committed implicitly.
    clock()   -> timezone-aware datetime; persisted as UTC 'YYYY-MM-DDTHH:MM:SSZ'.
    directory(organization, subject) -> list of {'organization','subject','active': bool,
              'displayName','department','startDate'?}. Exact Casdoor subject only, no email fallback.
              Raise on lookup failure (-> 503 directory_unavailable).
    authorize_admin(AdminContext) -> True only for a current Jadmin administrator.
  Trusted contexts (built by adapters, never from request bodies):
    EmployeeContext(organization, subject)   AdminContext(organization, actor)  # actor = admin email
  Employee: list_lists() create_list(d) update_list(id,d) delete_list(id,d) create_task(d)
    update_task(id,d) delete_task(id,d) complete_task(id,d) undo_task(id,d)
    complete_assignment(id,d) undo_assignment(id,d) employee_overview(start,end,unscheduled,limit)
    employee_profile() employee_todo_summary(limit) completions_for_day(day)  <- report prefill seam (completion Shanghai day)
      completions_for_day: complete or refused; more than MAX_LIMIT of either kind -> 409 prefill_too_large
      employee_profile().startDateVerified is a core constant; adapters project it from trusted config only
  Admin: admin_create_assignment(d) admin_update_assignment(id,d) admin_cancel_assignment(id,d)
    admin_reopen_assignment(id,d) admin_list_assignments(start,end,employee_id,department,status,limit)
    admin_assignment_history(id)
  Errors: WorkError(code, status), fixed codes only. 404 hides foreign/private rows.
"""

import json
import re
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo('Asia/Shanghai')
TITLE_MAX, NOTES_MAX, NAME_MAX, DEPT_MAX = 100, 1000, 100, 100
SUBTASK_MAX, SUBTASK_TITLE_MAX = 8, 80
PRIORITIES = ('high', 'normal', 'low')
MAX_LISTS, MAX_TASKS, MAX_LIMIT, MAX_RANGE_DAYS = 200, 5000, 500, 62
MIN_YEAR, MAX_YEAR = 2000, 2100
# Byte budgets shared with portal-auth src/work-routes.mjs (MAX_WORK_BODY / MAX_WORK_ENVELOPE / MAX_WORK_RESULT).
# The Python HTTP adapters must enforce these exact values and serialize replies with ensure_ascii=False. Worst
# legal overview (500 tasks + 500 assignments, including bounded subtasks) is < 8 MiB.
EMPLOYEE_BODY_MAX_BYTES = 64 * 1024
ENVELOPE_MAX_BYTES = 128 * 1024
RESPONSE_MAX_BYTES = 8 * 1024 * 1024
# No verified hire/effective-start field exists in the live directory. Never derive one from createdTime.
STARTDATE_LIVE_MAPPING = False
_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z')
_DATE = re.compile(r'\d{4}-\d{2}-\d{2}\Z')
_TIME = re.compile(r'(?:[01]\d|2[0-3]):[0-5]\d\Z')
_CTRL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')
_CTRL_LINE = re.compile(r'[\x00-\x1f\x7f]')
_LIST_COLS = ('id', 'name', 'version', 'created_at', 'updated_at')
_TASK_COLS = ('id', 'list_id', 'title', 'notes', 'due_at', 'due_time', 'state', 'completed_at',
              'version', 'created_at', 'updated_at', 'priority', 'subtasks')
_ASG_COLS = ('id', 'assignee_subject', 'assignee_name', 'assignee_department', 'title', 'notes', 'due_at',
             'due_time', 'state', 'completed_at', 'canceled_at', 'notice', 'version', 'created_by',
             'created_at', 'updated_at', 'priority', 'subtasks')

_SCHEMA = (
    'CREATE TABLE IF NOT EXISTS wc_lists (id TEXT PRIMARY KEY, organization TEXT NOT NULL, '
    'owner_subject TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), '
    'created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS wc_lists_owner ON wc_lists(organization, owner_subject)',
    'CREATE TABLE IF NOT EXISTS wc_tasks (id TEXT PRIMARY KEY, organization TEXT NOT NULL, '
    'owner_subject TEXT NOT NULL, list_id TEXT, title TEXT NOT NULL, notes TEXT NOT NULL, due_at TEXT, '
    "due_time TEXT, state TEXT NOT NULL CHECK(state IN ('open','completed')), completed_at TEXT, "
    'version INTEGER NOT NULL CHECK(version >= 1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS wc_tasks_owner ON wc_tasks(organization, owner_subject, due_at)',
    'CREATE TABLE IF NOT EXISTS wc_assignments (id TEXT PRIMARY KEY, organization TEXT NOT NULL, '
    'assignee_subject TEXT NOT NULL, assignee_name TEXT NOT NULL, assignee_department TEXT, '
    'title TEXT NOT NULL, notes TEXT NOT NULL, due_at TEXT NOT NULL, due_time TEXT NOT NULL, '
    "state TEXT NOT NULL CHECK(state IN ('open','completed','canceled')), completed_at TEXT, "
    'canceled_at TEXT, notice TEXT, version INTEGER NOT NULL CHECK(version >= 1), '
    'created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS wc_asg_assignee ON wc_assignments(organization, assignee_subject, due_at)',
    'CREATE INDEX IF NOT EXISTS wc_asg_due ON wc_assignments(organization, due_at)',
    'CREATE TABLE IF NOT EXISTS wc_assignment_history (id INTEGER PRIMARY KEY AUTOINCREMENT, '
    'organization TEXT NOT NULL, assignment_id TEXT NOT NULL, '
    "actor_kind TEXT NOT NULL CHECK(actor_kind IN ('admin','employee')), actor TEXT NOT NULL, "
    'action TEXT NOT NULL, old_value TEXT, new_value TEXT, at TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS wc_history_asg ON wc_assignment_history(organization, assignment_id)',
    'CREATE TRIGGER IF NOT EXISTS wc_history_no_update BEFORE UPDATE ON wc_assignment_history '
    "BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    'CREATE TRIGGER IF NOT EXISTS wc_history_no_delete BEFORE DELETE ON wc_assignment_history '
    "BEGIN SELECT RAISE(ABORT, 'append_only'); END",
)


class WorkError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)


def _ident(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise WorkError('invalid_identifier')
    return value


@dataclass(frozen=True)
class EmployeeContext:
    organization: str
    subject: str  # immutable Casdoor user id (OIDC sub), never an email

    def __post_init__(self):
        _ident(self.organization), _ident(self.subject)


@dataclass(frozen=True)
class AdminContext:
    organization: str
    actor: str  # Jadmin admin identity (email); not assumed to be a portal employee

    def __post_init__(self):
        _ident(self.organization)
        if not isinstance(self.actor, str) or not 1 <= len(self.actor) <= 254 or _CTRL_LINE.search(self.actor) \
                or ' ' in self.actor:
            raise WorkError('invalid_actor')


def configure_wal(conn):
    """Optional, for an isolated work DB connection only."""
    if conn.in_transaction:
        raise WorkError('caller_transaction_open', 500)
    conn.execute('PRAGMA busy_timeout=5000')
    return conn.execute('PRAGMA journal_mode=WAL').fetchone()[0]


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _date(value, code='invalid_date'):
    if not isinstance(value, str) or not _DATE.fullmatch(value):
        raise WorkError(code)
    try:
        parsed = date.fromisoformat(value)  # rejects 2026-02-30 instead of normalizing
    except ValueError:
        raise WorkError(code) from None
    if parsed.isoformat() != value or not MIN_YEAR <= parsed.year <= MAX_YEAR:
        raise WorkError(code)
    return parsed


def _day_start(day):
    return _iso(datetime.combine(day, time(0), SHANGHAI))


def parse_due(due_date, due_time=None):
    """Shanghai wall date [+ HH:MM] -> (UTC iso, due_time). Missing time = Shanghai day end."""
    day = _date(due_date)
    if due_time is None:
        return _iso(datetime.combine(day, time(23, 59, 59), SHANGHAI)), None
    if not isinstance(due_time, str) or not _TIME.fullmatch(due_time):
        raise WorkError('invalid_time')
    return _iso(datetime.combine(day, time(int(due_time[:2]), int(due_time[3:])), SHANGHAI)), due_time


def _text(value, maximum, code, required=True, line=True):
    if not isinstance(value, str):
        raise WorkError(code)
    value = value.strip()
    if (required and not value) or len(value) > maximum or (_CTRL_LINE if line else _CTRL).search(value):
        raise WorkError(code)
    return value


def _uuid(value):
    if isinstance(value, str) and len(value) == 36:
        try:
            if str(uuid.UUID(value)) == value:
                return value
        except ValueError:
            pass
    raise WorkError('invalid_id')


def _version(value):
    if type(value) is not int or not 1 <= value < 2**62:
        raise WorkError('invalid_version')
    return value


def _limit(value):
    if type(value) is not int or not 1 <= value <= MAX_LIMIT:
        raise WorkError('invalid_limit')
    return value


def _fields(data, required, optional=()):
    if not isinstance(data, dict) or not set(required) <= set(data) <= set(required) | set(optional):
        raise WorkError('invalid_request')


def _range(start, end, required):
    if start is None and end is None and not required:
        return None
    first, last = _date(start, 'invalid_range'), _date(end, 'invalid_range')
    if last < first or (last - first).days >= MAX_RANGE_DAYS:
        raise WorkError('invalid_range')
    return _day_start(first), _day_start(last + timedelta(days=1))


def _task_values(data):
    out = {}
    if 'title' in data:
        out['title'] = _text(data['title'], TITLE_MAX, 'invalid_title')
    if 'notes' in data:
        notes = '' if data['notes'] is None else data['notes']
        out['notes'] = _text(notes, NOTES_MAX, 'invalid_notes', required=False, line=False)
    if 'priority' in data:
        out['priority'] = _priority(data['priority'])
    if 'listId' in data:
        out['list_id'] = None if data['listId'] is None else _uuid(data['listId'])
    if 'dueTime' in data and 'dueDate' not in data:
        raise WorkError('invalid_request')
    if 'dueDate' in data:
        if data['dueDate'] is None:
            if data.get('dueTime') is not None:
                raise WorkError('invalid_time')
            out['due_at'] = out['due_time'] = None
        else:
            out['due_at'], out['due_time'] = parse_due(data['dueDate'], data.get('dueTime'))
    return out


def _priority(value):
    if value not in PRIORITIES:
        raise WorkError('invalid_priority')
    return value


def _subtask_specs(value, *, allow_ids=False):
    if not isinstance(value, list) or len(value) > SUBTASK_MAX:
        raise WorkError('invalid_subtasks')
    specs, seen = [], set()
    for entry in value:
        if (not isinstance(entry, dict) or 'title' not in entry or
                not set(entry) <= ({'title', 'id'} if allow_ids else {'title'})):
            raise WorkError('invalid_subtasks')
        title = _text(entry['title'], SUBTASK_TITLE_MAX, 'invalid_subtasks')
        try:
            title.encode('utf-8')
        except UnicodeError:
            raise WorkError('invalid_subtasks') from None
        spec = {'title': title}
        if 'id' in entry:
            sid = _uuid(entry['id'])
            if sid in seen:
                raise WorkError('invalid_subtasks')
            seen.add(sid)
            spec['id'] = sid
        specs.append(spec)
    return specs


def _dump_subtasks(items):
    return json.dumps(items, ensure_ascii=False, separators=(',', ':'))


def _merge_subtasks(data, row=None, *, reset=False):
    existing = {item['id']: item for item in json.loads(row['subtasks'])} if row else {}
    specs = (_subtask_specs(data['subtasks'], allow_ids=row is not None) if 'subtasks' in data else
             [{'id': item['id'], 'title': item['title']} for item in existing.values()])
    result = []
    for spec in specs:
        sid = spec.get('id')
        if sid is not None and sid not in existing:
            raise WorkError('invalid_subtasks')
        result.append({'id': sid or str(uuid.uuid4()), 'title': spec['title'],
                       'completed': bool(sid and not reset and existing[sid]['completed'])})
    return _dump_subtasks(result)


def _task_fields(row):
    return {'priority': row['priority'], 'subtasks': json.loads(row['subtasks'])}


def _due(row):
    if row['due_at'] is None:
        return {'dueDate': None, 'dueTime': None, 'dueAt': None}
    local = datetime.strptime(row['due_at'], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    return {'dueDate': local.astimezone(SHANGHAI).date().isoformat(), 'dueTime': row['due_time'],
            'dueAt': row['due_at']}


def _flags(row, now):
    due, done = row['due_at'], row['completed_at']
    return {'overdue': row['state'] == 'open' and due is not None and now > due,
            'completedLate': row['state'] == 'completed' and due is not None and done is not None and done > due}


def _task_out(r, now):
    return {'id': r['id'], 'kind': 'personal', 'listId': r['list_id'], 'title': r['title'], 'notes': r['notes'],
            **_due(r), 'state': r['state'], 'completedAt': r['completed_at'], 'version': r['version'],
            'createdAt': r['created_at'], 'updatedAt': r['updated_at'], **_task_fields(r), **_flags(r, now)}


def _list_out(r):
    return {'id': r['id'], 'name': r['name'], 'version': r['version'], 'createdAt': r['created_at'],
            'updatedAt': r['updated_at']}


def _asg_out(r, now, admin=False):
    out = {'id': r['id'], 'kind': 'assigned', 'assignedByAdmin': True, 'title': r['title'], 'notes': r['notes'],
           **_due(r), 'state': r['state'], 'completedAt': r['completed_at'], 'canceledAt': r['canceled_at'],
           'notice': r['notice'], 'version': r['version'], **_task_fields(r), **_flags(r, now)}
    if admin:
        out.update(assignee={'employeeId': r['assignee_subject'], 'displayName': r['assignee_name'],
                             'department': r['assignee_department']},
                   createdBy=r['created_by'], createdAt=r['created_at'], updatedAt=r['updated_at'])
    return out


def _public(r):
    return {'title': r['title'], 'notes': r['notes'], 'dueAt': r['due_at'], 'dueTime': r['due_time'],
            'state': r['state'], 'completedAt': r['completed_at'], 'assignee': r['assignee_subject'],
            'assigneeName': r['assignee_name'], **_task_fields(r)}


class WorkService:
    def __init__(self, conn, *, clock, directory, authorize_admin):
        self.conn, self._clock, self._directory, self._authorize = conn, clock, directory, authorize_admin

    # ---- infrastructure -------------------------------------------------------------------------
    @contextmanager
    def _txn(self, write):
        if self.conn.in_transaction:
            raise WorkError('caller_transaction_open', 500)
        try:
            self.conn.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
        except sqlite3.Error:
            raise WorkError('storage_unavailable', 503) from None
        try:
            yield
            self.conn.execute('COMMIT' if write else 'ROLLBACK')
        except BaseException as exc:
            if self.conn.in_transaction:
                self.conn.execute('ROLLBACK')
            if isinstance(exc, sqlite3.Error):
                raise WorkError('storage_unavailable', 503) from None
            raise

    def init_db(self):
        with self._txn(True):
            for statement in _SCHEMA:
                self.conn.execute(statement)
            for table in ('wc_tasks', 'wc_assignments'):
                columns = {row[1] for row in self.conn.execute(f'PRAGMA table_info({table})')}
                if 'priority' not in columns:
                    self.conn.execute(f"ALTER TABLE {table} ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' "
                                      "CHECK(priority IN ('high','normal','low'))")
                if 'subtasks' not in columns:
                    self.conn.execute(f"ALTER TABLE {table} ADD COLUMN subtasks TEXT NOT NULL DEFAULT '[]'")

    def _now(self):
        value = self._clock()
        if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
            raise WorkError('clock_invalid', 500)
        return _iso(value)

    def _lookup(self, organization, subject):
        try:
            records = self._directory(organization, subject)
        except Exception:
            raise WorkError('directory_unavailable', 503) from None
        if not isinstance(records, (list, tuple)) or any(not isinstance(r, dict) for r in records):
            raise WorkError('directory_unavailable', 503)
        found = [r for r in records if r.get('organization') == organization and r.get('subject') == subject]
        if len(found) > 1:
            raise WorkError('directory_ambiguous', 503)
        if not found:
            return None
        record = found[0]
        if type(record.get('active')) is not bool:
            raise WorkError('directory_unavailable', 503)
        try:
            start = None if record.get('startDate') is None else _date(record['startDate']).isoformat()
        except WorkError:
            start = None
        department = record.get('department')
        return {'employeeId': subject, 'displayName': str(record.get('displayName') or subject)[:200],
                'department': str(department)[:DEPT_MAX] if department else None,
                'active': record['active'], 'startDate': start}

    def _employee(self, ctx):
        if not isinstance(ctx, EmployeeContext):
            raise WorkError('not_found', 404)  # admins never reach private storage
        person = self._lookup(ctx.organization, ctx.subject)
        if person is None:
            raise WorkError('employee_unknown', 403)
        if not person['active']:
            raise WorkError('employee_inactive', 403)
        return person

    def _check_admin(self, ctx):
        if not isinstance(ctx, AdminContext):
            raise WorkError('not_found', 404)
        try:
            allowed = self._authorize(ctx)
        except Exception:
            raise WorkError('authorization_unavailable', 503) from None
        if allowed is not True:
            raise WorkError('admin_required', 403)

    def _target(self, ctx, employee_id):
        person = self._lookup(ctx.organization, _ident(employee_id))
        if person is None:
            raise WorkError('employee_not_found', 404)
        if not person['active']:
            raise WorkError('assignee_inactive', 409)
        return person

    def _own(self, ctx, table, cols, rid, code='not_found'):
        row = self.conn.execute(f"SELECT {','.join(cols)} FROM {table} WHERE id=? AND organization=? "
                                'AND owner_subject=?', (rid, ctx.organization, ctx.subject)).fetchone()
        if row is None:
            raise WorkError(code, 404)
        return dict(zip(cols, row))

    def _asg(self, organization, aid, subject=None):
        sql = f"SELECT {','.join(_ASG_COLS)} FROM wc_assignments WHERE id=? AND organization=?"
        args = [aid, organization]
        if subject is not None:
            sql, args = sql + ' AND assignee_subject=?', args + [subject]
        row = self.conn.execute(sql, args).fetchone()
        if row is None:
            raise WorkError('not_found', 404)
        return dict(zip(_ASG_COLS, row))

    @staticmethod
    def _expect(row, expected, states=None):
        if row['version'] != expected:
            raise WorkError('version_conflict', 409)
        if states is not None and row['state'] not in states:
            raise WorkError('invalid_transition', 409)

    def _apply(self, table, row, expected, values, now):
        values = {**values, 'updated_at': now}
        sets = ','.join(f'{key}=?' for key in values)
        cursor = self.conn.execute(f'UPDATE {table} SET {sets},version=version+1 WHERE id=? AND version=?',
                                   (*values.values(), row['id'], expected))
        if cursor.rowcount != 1:
            raise WorkError('version_conflict', 409)

    def _quota(self, ctx, table, maximum):
        count = self.conn.execute(f'SELECT COUNT(*) FROM {table} WHERE organization=? AND owner_subject=?',
                                  (ctx.organization, ctx.subject)).fetchone()[0]
        if count >= maximum:
            raise WorkError('quota_exceeded', 409)

    def _history(self, organization, aid, kind, actor, action, old, new, now):
        dump = lambda v: None if v is None else json.dumps(v, ensure_ascii=False, sort_keys=True)
        self.conn.execute('INSERT INTO wc_assignment_history(organization,assignment_id,actor_kind,actor,action,'
                          'old_value,new_value,at) VALUES(?,?,?,?,?,?,?,?)',
                          (organization, aid, kind, actor, action, dump(old), dump(new), now))

    def _transition(self, organization, row, expected, states, values, kind, actor, action, now):
        self._expect(row, expected, states)
        self._apply('wc_assignments', row, expected, values, now)
        new = self._asg(organization, row['id'])
        before, after = _public(row), _public(new)
        keys = [key for key in before if before[key] != after[key]]
        self._history(organization, row['id'], kind, actor, action,
                      {k: before[k] for k in keys}, {k: after[k] for k in keys}, now)
        return new

    # ---- private lists --------------------------------------------------------------------------
    def list_lists(self, ctx):
        self._employee(ctx)
        with self._txn(False):
            rows = self.conn.execute(f"SELECT {','.join(_LIST_COLS)} FROM wc_lists WHERE organization=? AND "
                                     'owner_subject=? ORDER BY name, id', (ctx.organization, ctx.subject)).fetchall()
        return [_list_out(dict(zip(_LIST_COLS, row))) for row in rows]

    def create_list(self, ctx, data):
        self._employee(ctx)
        _fields(data, {'name'})
        name, now = _text(data['name'], NAME_MAX, 'invalid_name'), self._now()
        with self._txn(True):
            self._quota(ctx, 'wc_lists', MAX_LISTS)
            lid = str(uuid.uuid4())
            self.conn.execute('INSERT INTO wc_lists VALUES(?,?,?,?,1,?,?)',
                              (lid, ctx.organization, ctx.subject, name, now, now))
            return _list_out(self._own(ctx, 'wc_lists', _LIST_COLS, lid))

    def update_list(self, ctx, list_id, data):
        self._employee(ctx)
        list_id = _uuid(list_id)
        _fields(data, {'expectedVersion', 'name'})
        expected, name, now = _version(data['expectedVersion']), _text(data['name'], NAME_MAX, 'invalid_name'), self._now()
        with self._txn(True):
            row = self._own(ctx, 'wc_lists', _LIST_COLS, list_id)
            self._expect(row, expected)
            self._apply('wc_lists', row, expected, {'name': name}, now)
            return _list_out(self._own(ctx, 'wc_lists', _LIST_COLS, list_id))

    def delete_list(self, ctx, list_id, data):
        """Only empty lists (no open or completed tasks) may be deleted; otherwise 409 list_not_empty."""
        self._employee(ctx)
        list_id = _uuid(list_id)
        _fields(data, {'expectedVersion'})
        expected = _version(data['expectedVersion'])
        with self._txn(True):
            row = self._own(ctx, 'wc_lists', _LIST_COLS, list_id)
            self._expect(row, expected)
            if self.conn.execute('SELECT 1 FROM wc_tasks WHERE organization=? AND owner_subject=? AND list_id=? '
                                 'LIMIT 1', (ctx.organization, ctx.subject, list_id)).fetchone():
                raise WorkError('list_not_empty', 409)
            self.conn.execute('DELETE FROM wc_lists WHERE id=? AND version=?', (list_id, expected))
        return {'id': list_id, 'deleted': True}

    # ---- private tasks --------------------------------------------------------------------------
    def create_task(self, ctx, data):
        self._employee(ctx)
        _fields(data, {'title'}, {'notes', 'listId', 'dueDate', 'dueTime', 'priority', 'subtasks'})
        values = {'notes': '', 'list_id': None, 'due_at': None, 'due_time': None, 'priority': 'normal',
                  **_task_values(data), 'subtasks': _merge_subtasks(data)}
        now = self._now()
        with self._txn(True):
            self._quota(ctx, 'wc_tasks', MAX_TASKS)
            if values['list_id']:
                self._own(ctx, 'wc_lists', _LIST_COLS, values['list_id'], 'list_not_found')
            tid = str(uuid.uuid4())
            self.conn.execute('INSERT INTO wc_tasks(id,organization,owner_subject,list_id,title,notes,due_at,'
                              "due_time,state,completed_at,version,created_at,updated_at,priority,subtasks) "
                              "VALUES(?,?,?,?,?,?,?,?,'open',NULL,1,?,?,?,?)", (tid, ctx.organization, ctx.subject, values['list_id'],
                                                     values['title'], values['notes'], values['due_at'],
                                                     values['due_time'], now, now, values['priority'], values['subtasks']))
            return _task_out(self._own(ctx, 'wc_tasks', _TASK_COLS, tid), now)

    def update_task(self, ctx, task_id, data):
        self._employee(ctx)
        task_id = _uuid(task_id)
        _fields(data, {'expectedVersion'}, {'title', 'notes', 'listId', 'dueDate', 'dueTime', 'priority', 'subtasks'})
        if len(data) < 2:
            raise WorkError('invalid_request')
        expected, values, now = _version(data['expectedVersion']), _task_values(data), self._now()
        with self._txn(True):
            row = self._own(ctx, 'wc_tasks', _TASK_COLS, task_id)
            if values.get('list_id'):
                self._own(ctx, 'wc_lists', _LIST_COLS, values['list_id'], 'list_not_found')
            self._expect(row, expected)
            if 'subtasks' in data:
                values['subtasks'] = _merge_subtasks(data, row)
            self._apply('wc_tasks', row, expected, values, now)
            return _task_out(self._own(ctx, 'wc_tasks', _TASK_COLS, task_id), now)

    def set_subtask_completed(self, ctx, item_id, subtask_id, data, *, assigned=False):
        self._employee(ctx)
        item_id, subtask_id = _uuid(item_id), _uuid(subtask_id)
        _fields(data, {'expectedVersion', 'completed'})
        if type(data['completed']) is not bool:
            raise WorkError('invalid_subtasks')
        expected, now = _version(data['expectedVersion']), self._now()
        with self._txn(True):
            def own_item():
                return (self._asg(ctx.organization, item_id, ctx.subject) if assigned else
                        self._own(ctx, 'wc_tasks', _TASK_COLS, item_id))

            row = own_item()
            self._expect(row, expected, {'open', 'completed'})
            items = json.loads(row['subtasks'])
            item = next((item for item in items if item['id'] == subtask_id), None)
            if item is None:
                raise WorkError('not_found', 404)
            if item['completed'] != data['completed']:
                item['completed'] = data['completed']
                values = {'subtasks': _dump_subtasks(items)}
                if assigned:
                    row = self._transition(ctx.organization, row, expected, {'open', 'completed'}, values,
                                           'employee', ctx.subject, 'subtask', now)
                else:
                    self._apply('wc_tasks', row, expected, values, now)
                    row = own_item()
            return (_asg_out if assigned else _task_out)(row, now)

    def _task_state(self, ctx, task_id, data, source, target):
        self._employee(ctx)
        task_id = _uuid(task_id)
        _fields(data, {'expectedVersion'})
        expected, now = _version(data['expectedVersion']), self._now()
        with self._txn(True):
            row = self._own(ctx, 'wc_tasks', _TASK_COLS, task_id)
            self._expect(row, expected, {source})
            self._apply('wc_tasks', row, expected,
                        {'state': target, 'completed_at': now if target == 'completed' else None}, now)
            return _task_out(self._own(ctx, 'wc_tasks', _TASK_COLS, task_id), now)

    def complete_task(self, ctx, task_id, data):
        return self._task_state(ctx, task_id, data, 'open', 'completed')

    def undo_task(self, ctx, task_id, data):
        return self._task_state(ctx, task_id, data, 'completed', 'open')

    def delete_task(self, ctx, task_id, data):
        self._employee(ctx)
        task_id = _uuid(task_id)
        _fields(data, {'expectedVersion'})
        expected = _version(data['expectedVersion'])
        with self._txn(True):
            self._expect(self._own(ctx, 'wc_tasks', _TASK_COLS, task_id), expected)
            self.conn.execute('DELETE FROM wc_tasks WHERE id=? AND version=?', (task_id, expected))
        return {'id': task_id, 'deleted': True}

    # ---- employee reads -------------------------------------------------------------------------
    def employee_profile(self, ctx):
        person = self._employee(ctx)
        return {**{k: person[k] for k in ('employeeId', 'displayName', 'department', 'startDate')},
                'startDateVerified': STARTDATE_LIVE_MAPPING}

    def employee_overview(self, ctx, *, start=None, end=None, unscheduled=True, limit=200):
        self._employee(ctx)
        bounds, limit, now = _range(start, end, False), _limit(limit), self._now()
        if type(unscheduled) is not bool:
            raise WorkError('invalid_request')
        task_where, task_args = 'organization=? AND owner_subject=?', [ctx.organization, ctx.subject]
        asg_where, asg_args = 'organization=? AND assignee_subject=?', [ctx.organization, ctx.subject]
        if bounds:
            task_where += ' AND ((due_at>=? AND due_at<?)' + (' OR due_at IS NULL)' if unscheduled else ')')
            asg_where += ' AND due_at>=? AND due_at<?'
            task_args, asg_args = task_args + list(bounds), asg_args + list(bounds)
        elif not unscheduled:
            task_where += ' AND due_at IS NOT NULL'
        with self._txn(False):
            tasks = self.conn.execute(f"SELECT {','.join(_TASK_COLS)} FROM wc_tasks WHERE {task_where} "
                                      'ORDER BY due_at IS NULL, due_at, id LIMIT ?', task_args + [limit + 1]).fetchall()
            assigned = self.conn.execute(f"SELECT {','.join(_ASG_COLS)} FROM wc_assignments WHERE {asg_where} "
                                         'ORDER BY due_at, id LIMIT ?', asg_args + [limit + 1]).fetchall()
        return {'tasks': [_task_out(dict(zip(_TASK_COLS, r)), now) for r in tasks[:limit]],
                'assigned': [_asg_out(dict(zip(_ASG_COLS, r)), now) for r in assigned[:limit]],
                'truncated': len(tasks) > limit or len(assigned) > limit}

    def employee_todo_summary(self, ctx, *, limit=100):
        """Own open work due today, plus work currently completed in the Shanghai week."""
        self._employee(ctx)
        limit, now = _limit(limit), self._now()
        today = datetime.strptime(now, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc).astimezone(SHANGHAI).date()
        monday = today - timedelta(days=today.weekday())
        sources = (('wc_tasks', 'owner_subject', _TASK_COLS, _task_out),
                   ('wc_assignments', 'assignee_subject', _ASG_COLS, _asg_out))

        def collect(state, stamp, first, last, order):
            bounds = (_day_start(first), _day_start(last))
            args = (ctx.organization, ctx.subject, state, *bounds, limit + 1)
            entries = []
            rank = "CASE priority WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END, " if state == 'open' else ''
            for table, subject, columns, render in sources:
                rows = self.conn.execute(
                    f"SELECT {','.join(columns)} FROM {table} WHERE organization=? AND {subject}=? AND state=? "
                    f'AND {stamp}>=? AND {stamp}<? ORDER BY {rank}{stamp} {order}, id {order} LIMIT ?', args)
                entries.extend(render(dict(zip(columns, row)), now) for row in rows)
            return entries

        with self._txn(False):
            pending = collect('open', 'due_at', today, today + timedelta(days=1), 'ASC')
            completed = collect('completed', 'completed_at', monday, monday + timedelta(days=7), 'DESC')
        pending.sort(key=lambda row: (PRIORITIES.index(row['priority']), row['dueAt'], row['id']))
        completed.sort(key=lambda row: (row['completedAt'], row['id']), reverse=True)
        return {'today': today.isoformat(), 'pending': pending[:limit], 'completed': completed[:limit],
                'truncated': len(pending) > limit or len(completed) > limit}

    def completions_for_day(self, ctx, day):
        """Report seam: own items completed on a Shanghai calendar day (by completion time, not due day).
        Complete or refused, never silently capped: more than MAX_LIMIT of either kind -> 409 prefill_too_large."""
        self._employee(ctx)
        first = _date(day)
        bounds = (_day_start(first), _day_start(first + timedelta(days=1)))
        sql = ("SELECT id,title,completed_at FROM {} WHERE organization=? AND {}=? AND state='completed' "
               'AND completed_at>=? AND completed_at<? ORDER BY completed_at, id LIMIT ?')
        args = (ctx.organization, ctx.subject, *bounds, MAX_LIMIT + 1)
        with self._txn(False):
            personal = self.conn.execute(sql.format('wc_tasks', 'owner_subject'), args).fetchall()
            assigned = self.conn.execute(sql.format('wc_assignments', 'assignee_subject'), args).fetchall()
        if len(personal) > MAX_LIMIT or len(assigned) > MAX_LIMIT:
            raise WorkError('prefill_too_large', 409)
        return ([{'kind': 'personal', 'id': r[0], 'title': r[1], 'completedAt': r[2]} for r in personal]
                + [{'kind': 'assigned', 'id': r[0], 'title': r[1], 'completedAt': r[2]} for r in assigned])

    # ---- assignments: employee ------------------------------------------------------------------
    def _employee_asg(self, ctx, aid, data, source, target, action):
        self._employee(ctx)
        aid = _uuid(aid)
        _fields(data, {'expectedVersion'})
        expected, now = _version(data['expectedVersion']), self._now()
        with self._txn(True):
            row = self._asg(ctx.organization, aid, ctx.subject)  # current assignee only
            new = self._transition(ctx.organization, row, expected, {source},
                                   {'state': target, 'completed_at': now if target == 'completed' else None},
                                   'employee', ctx.subject, action, now)
            return _asg_out(new, now)

    def complete_assignment(self, ctx, aid, data):
        return self._employee_asg(ctx, aid, data, 'open', 'completed', 'complete')

    def undo_assignment(self, ctx, aid, data):
        return self._employee_asg(ctx, aid, data, 'completed', 'open', 'undo')

    # ---- assignments: admin ---------------------------------------------------------------------
    def admin_create_assignment(self, ctx, data):
        self._check_admin(ctx)
        _fields(data, {'title', 'dueDate', 'dueTime', 'employeeId'}, {'notes', 'priority', 'subtasks'})
        if data['dueDate'] is None or data['dueTime'] is None:
            raise WorkError('invalid_date')
        values = {'notes': '', 'priority': 'normal', **_task_values(data), 'subtasks': _merge_subtasks(data)}
        person, now = self._target(ctx, data['employeeId']), self._now()
        with self._txn(True):
            self._check_admin(ctx)
            aid = str(uuid.uuid4())
            self.conn.execute(f"INSERT INTO wc_assignments(organization,{','.join(_ASG_COLS)}) VALUES"
                              "(?,?,?,?,?,?,?,?,?,'open',NULL,NULL,NULL,1,?,?,?,?,?)",
                              (ctx.organization, aid, person['employeeId'], person['displayName'],
                               person['department'], values['title'], values['notes'], values['due_at'],
                               values['due_time'], ctx.actor, now, now, values['priority'], values['subtasks']))
            row = self._asg(ctx.organization, aid)
            self._history(ctx.organization, aid, 'admin', ctx.actor, 'create', None, _public(row), now)
            return _asg_out(row, now, admin=True)

    def admin_update_assignment(self, ctx, aid, data):
        """Edit / reschedule / reassign; open assignments only."""
        self._check_admin(ctx)
        aid = _uuid(aid)
        _fields(data, {'expectedVersion'}, {'title', 'notes', 'dueDate', 'dueTime', 'employeeId', 'priority', 'subtasks'})
        if len(data) < 2 or ('dueDate' in data) != ('dueTime' in data):
            raise WorkError('invalid_request')
        if 'dueDate' in data and (data['dueDate'] is None or data['dueTime'] is None):
            raise WorkError('invalid_date')
        expected = _version(data['expectedVersion'])
        values = _task_values(data)
        person = self._target(ctx, data['employeeId']) if 'employeeId' in data else None
        now = self._now()
        with self._txn(True):
            self._check_admin(ctx)
            row = self._asg(ctx.organization, aid)
            self._expect(row, expected, {'open'})
            reassign = person is not None and person['employeeId'] != row['assignee_subject']
            if reassign:
                values.update(assignee_subject=person['employeeId'], assignee_name=person['displayName'],
                              assignee_department=person['department'])
            if 'subtasks' in data or reassign:
                values['subtasks'] = _merge_subtasks(data, row, reset=reassign)
            changed = {k: v for k, v in values.items() if row[k] != v}
            if not changed:
                return _asg_out(row, now, admin=True)
            action = ('reassign' if 'assignee_subject' in changed else
                      'reschedule' if {'due_at', 'due_time'} & set(changed) else 'edit')
            changed['notice'] = {'reassign': None, 'reschedule': 'due_changed', 'edit': 'details_changed'}[action]
            new = self._transition(ctx.organization, row, expected, {'open'}, changed, 'admin', ctx.actor,
                                   action, now)
            return _asg_out(new, now, admin=True)

    def _admin_state(self, ctx, aid, data, states, values, action):
        self._check_admin(ctx)
        aid = _uuid(aid)
        _fields(data, {'expectedVersion'})
        expected, now = _version(data['expectedVersion']), self._now()
        with self._txn(True):
            self._check_admin(ctx)
            row = self._asg(ctx.organization, aid)
            new = self._transition(ctx.organization, row, expected, states, values(now), 'admin', ctx.actor,
                                   action, now)
            return _asg_out(new, now, admin=True)

    def admin_cancel_assignment(self, ctx, aid, data):
        return self._admin_state(ctx, aid, data, {'open', 'completed'},
                                 lambda now: {'state': 'canceled', 'canceled_at': now, 'notice': 'canceled'}, 'cancel')

    def admin_reopen_assignment(self, ctx, aid, data):
        return self._admin_state(ctx, aid, data, {'completed'},
                                 lambda now: {'state': 'open', 'completed_at': None, 'notice': 'reopened'}, 'reopen')

    def admin_list_assignments(self, ctx, *, start, end, employee_id=None, department=None, status=None, limit=200):
        """Queries wc_assignments only; never private tables or counts."""
        bounds, limit, now = _range(start, end, True), _limit(limit), self._now()
        where, args = 'organization=? AND due_at>=? AND due_at<?', [None, *bounds]
        if employee_id is not None:
            where, args = where + ' AND assignee_subject=?', args + [_ident(employee_id)]
        if department is not None:
            where, args = where + ' AND assignee_department=?', args + [_text(department, DEPT_MAX, 'invalid_department')]
        if status == 'overdue':
            where, args = where + " AND state='open' AND due_at<?", args + [now]
        elif status in ('open', 'completed', 'canceled'):
            where, args = where + ' AND state=?', args + [status]
        elif status is not None:
            raise WorkError('invalid_status')
        with self._txn(False):
            self._check_admin(ctx)
            args[0] = ctx.organization
            rows = self.conn.execute(f"SELECT {','.join(_ASG_COLS)} FROM wc_assignments WHERE {where} "
                                     'ORDER BY due_at, id LIMIT ?', args + [limit + 1]).fetchall()
        return {'assignments': [_asg_out(dict(zip(_ASG_COLS, r)), now, admin=True) for r in rows[:limit]],
                'truncated': len(rows) > limit}

    def admin_assignment_history(self, ctx, aid):
        aid = _uuid(aid)
        with self._txn(False):
            self._check_admin(ctx)
            self._asg(ctx.organization, aid)
            rows = self.conn.execute('SELECT actor_kind,actor,action,old_value,new_value,at FROM '
                                     'wc_assignment_history WHERE organization=? AND assignment_id=? ORDER BY id',
                                     (ctx.organization, aid)).fetchall()
        return [{'actorKind': r[0], 'actor': r[1], 'action': r[2], 'old': json.loads(r[3]) if r[3] else None,
                 'new': json.loads(r[4]) if r[4] else None, 'at': r[5]} for r in rows]
