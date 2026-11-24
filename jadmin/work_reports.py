"""QYOS-WORK-01 batch A2: daily work reports. Domain logic only (no HTTP).

CONTRACT (seam for the later portal/Jadmin adapters)
  ReportService(core, *, roster, start_dates_verified=False)
    core      work_core.WorkService. Its connection, clock, directory lookup, admin authorizer and
              transaction helper are reused; this module never opens a transaction inside another.
    roster(organization) -> fresh list of directory records in exactly core.directory shape
              {'organization','subject','active': bool,'displayName','department','startDate'?}.
              Fail closed (503) on errors, duplicates, foreign organization, bad subject, non-bool active.
    start_dates_verified  explicit adapter configuration. Only when True is record['startDate'] used, and
              only if it is a valid YYYY-MM-DD (otherwise treated as absent -> 'unknown'). The live directory
              has no verified start date; nothing is ever derived from createdTime.
  Employee (EmployeeContext): employee_get(day) employee_prefill(day) employee_save(day,d) employee_submit(day,d)
  Admin (AdminContext):       admin_calendar(start=,end=,employee_id=,department=,report_status=)
                              admin_read(employee_id, day)
  Day status: submitted | late | missing | pending | not_required | unknown.
  Admin paths read wc_report_snapshots only (and append wc_report_audit); never drafts, tasks or lists.
"""

import re
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone

from work_core import DEPT_MAX, MAX_RANGE_DAYS, SHANGHAI, WorkError, _CTRL, _date, _fields, _ident, _text

TEXT_MAX = 10000
_VERSION_LIMIT = 2 ** 62
STATUSES = ('submitted', 'late', 'missing', 'pending', 'not_required', 'unknown')
_TAG = re.compile(r'<[/!?]?[A-Za-z][^<>]*>|<!--')
_SNAP_COLS = ('subject', 'day', 'text', 'display_name', 'department', 'submitted_at', 'late')

_SCHEMA = (
    'CREATE TABLE IF NOT EXISTS wc_report_drafts (organization TEXT NOT NULL, subject TEXT NOT NULL, '
    'day TEXT NOT NULL, text TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), '
    'created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(organization, subject, day))',
    'CREATE TABLE IF NOT EXISTS wc_report_snapshots (id TEXT PRIMARY KEY, organization TEXT NOT NULL, '
    'subject TEXT NOT NULL, day TEXT NOT NULL, '
    'text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 10000), display_name TEXT NOT NULL, '
    'department TEXT, submitted_at TEXT NOT NULL, late INTEGER NOT NULL CHECK(late IN (0, 1)), '
    'UNIQUE(organization, subject, day))',
    'CREATE INDEX IF NOT EXISTS wc_report_snap_day ON wc_report_snapshots(organization, day)',
    'CREATE TABLE IF NOT EXISTS wc_report_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, '
    'organization TEXT NOT NULL, actor TEXT NOT NULL, subject TEXT NOT NULL, day TEXT NOT NULL, '
    "action TEXT NOT NULL CHECK(action = 'view'), at TEXT NOT NULL)",
    'CREATE INDEX IF NOT EXISTS wc_report_audit_subject ON wc_report_audit(organization, subject, day)',
    'CREATE TRIGGER IF NOT EXISTS wc_report_snapshots_no_update BEFORE UPDATE ON wc_report_snapshots '
    "BEGIN SELECT RAISE(ABORT, 'immutable'); END",
    'CREATE TRIGGER IF NOT EXISTS wc_report_snapshots_no_delete BEFORE DELETE ON wc_report_snapshots '
    "BEGIN SELECT RAISE(ABORT, 'immutable'); END",
    'CREATE TRIGGER IF NOT EXISTS wc_report_audit_no_update BEFORE UPDATE ON wc_report_audit '
    "BEGIN SELECT RAISE(ABORT, 'append_only'); END",
    'CREATE TRIGGER IF NOT EXISTS wc_report_audit_no_delete BEFORE DELETE ON wc_report_audit '
    "BEGIN SELECT RAISE(ABORT, 'append_only'); END",
)


def _report_text(value):
    """Plain text up to 10000 Unicode code points; no control chars (tab/newline ok), no HTML tags."""
    if not isinstance(value, str) or len(value) > TEXT_MAX:
        raise WorkError('invalid_text')
    try:
        value.encode('utf-8')  # lone surrogates cannot be stored
    except UnicodeEncodeError:
        raise WorkError('invalid_text') from None
    if _CTRL.search(value) or _TAG.search(value):
        raise WorkError('invalid_text')
    return value.replace('\r\n', '\n').replace('\r', '\n')


def _strip_tags(title):
    previous = None
    while previous != title:
        previous, title = title, _TAG.sub('', title)
    return title.strip()


def _expected(value, minimum):
    if type(value) is not int or not minimum <= value < _VERSION_LIMIT:
        raise WorkError('invalid_version')
    return value


def _status(day, today, start, late):
    """late is None when no snapshot exists, else the snapshot's late flag."""
    if late is not None:
        return 'late' if late else 'submitted'
    if day > today or day.weekday() >= 5:
        return 'not_required'
    if start is None:
        return 'unknown'
    if day < start:
        return 'not_required'
    return 'pending' if day == today else 'missing'


def _public(snap):
    return {'date': snap['day'], 'text': snap['text'], 'submittedAt': snap['submitted_at'],
            'late': bool(snap['late']), 'displayName': snap['display_name'], 'department': snap['department']}


class ReportService:
    def __init__(self, core, *, roster, start_dates_verified=False):
        if type(start_dates_verified) is not bool:
            raise TypeError('start_dates_verified must be bool')
        self.core, self.conn, self._roster, self._verified = core, core.conn, roster, start_dates_verified

    # ---- infrastructure -------------------------------------------------------------------------
    def init_db(self):
        with self.core._txn(True):
            for statement in _SCHEMA:
                self.conn.execute(statement)

    def _clock(self):
        stamp = self.core._now()
        moment = datetime.strptime(stamp, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
        return stamp, moment.astimezone(SHANGHAI).date()

    def _start(self, raw):
        if not self._verified or raw is None:
            return None
        try:
            return _date(raw)
        except WorkError:
            return None  # configured but malformed: never guessed, reported as unknown

    def _me(self, ctx, day, allow_future=True):
        person = self.core._employee(ctx)  # AdminContext -> 404; unknown/inactive -> 403
        parsed = _date(day)
        stamp, today = self._clock()
        if not allow_future and parsed > today:
            raise WorkError('future_date')
        return person, parsed, stamp, today

    def _snapshot(self, organization, subject, day):
        row = self.conn.execute(f"SELECT {','.join(_SNAP_COLS)} FROM wc_report_snapshots WHERE organization=? "
                                'AND subject=? AND day=?', (organization, subject, day)).fetchone()
        return None if row is None else dict(zip(_SNAP_COLS, row))

    def _draft(self, organization, subject, day):
        return self.conn.execute('SELECT text, version FROM wc_report_drafts WHERE organization=? AND subject=? '
                                 'AND day=?', (organization, subject, day)).fetchone()

    def _roster_people(self, organization):
        try:
            records = self._roster(organization)
        except Exception:
            raise WorkError('directory_unavailable', 503) from None
        if not isinstance(records, (list, tuple)):
            raise WorkError('directory_unavailable', 503)
        people, seen = [], set()
        for record in records:
            if not isinstance(record, dict) or record.get('organization') != organization:
                raise WorkError('directory_inconsistent', 503)
            subject = record.get('subject')
            try:
                _ident(subject)
            except WorkError:
                raise WorkError('directory_inconsistent', 503) from None
            if subject in seen:
                raise WorkError('directory_ambiguous', 503)
            seen.add(subject)
            if type(record.get('active')) is not bool:
                raise WorkError('directory_inconsistent', 503)
            if not record['active']:
                continue
            department = record.get('department')
            people.append({'employeeId': subject,
                           'displayName': str(record.get('displayName') or subject)[:200],
                           'department': str(department)[:DEPT_MAX] if department else None,
                           'startDate': self._start(record.get('startDate'))})
        people.sort(key=lambda p: (p['displayName'], p['employeeId']))
        return people

    # ---- employee -------------------------------------------------------------------------------
    def employee_get(self, ctx, day):
        person, parsed, _, today = self._me(ctx, day)
        key = (ctx.organization, ctx.subject, parsed.isoformat())
        with self.core._txn(False):
            draft = self._draft(*key)
            snap = self._snapshot(*key)
        start = self._start(person['startDate'])
        return {'date': key[2],
                'draft': None if draft is None else {'text': draft[0], 'version': draft[1]},
                'submitted': None if snap is None else _public(snap),
                'status': _status(parsed, today, start, None if snap is None else bool(snap['late'])),
                'startDateKnown': start is not None}

    def employee_prefill(self, ctx, day):
        """Suggested plain text from own completions on that Shanghai day. Never saves or submits.
        Complete or refused, never partial: over TEXT_MAX (or too many completions) -> 409 prefill_too_large."""
        _, parsed, _, _ = self._me(ctx, day, allow_future=False)
        items = self.core.completions_for_day(ctx, parsed.isoformat())  # own txn, not nested
        titles = (_strip_tags(item['title']) for item in items)
        text = '\n'.join('- ' + title for title in titles if title)
        if len(text) > TEXT_MAX:
            raise WorkError('prefill_too_large', 409)
        return {'date': parsed.isoformat(), 'text': text}

    def employee_save(self, ctx, day, data):
        _, parsed, stamp, _ = self._me(ctx, day, allow_future=False)
        _fields(data, {'text', 'expectedVersion'})
        expected, text = _expected(data['expectedVersion'], 0), _report_text(data['text'])
        key = (ctx.organization, ctx.subject, parsed.isoformat())
        with self.core._txn(True):
            if self._snapshot(*key) is not None:
                raise WorkError('report_submitted', 409)
            row = self._draft(*key)
            if expected == 0:
                if row is not None:
                    raise WorkError('version_conflict', 409)
                self.conn.execute('INSERT INTO wc_report_drafts(organization,subject,day,text,version,created_at,'
                                  'updated_at) VALUES(?,?,?,?,1,?,?)', (*key, text, stamp, stamp))
                version = 1
            else:
                if row is None or row[1] != expected:
                    raise WorkError('version_conflict', 409)
                cursor = self.conn.execute('UPDATE wc_report_drafts SET text=?, version=version+1, updated_at=? '
                                           'WHERE organization=? AND subject=? AND day=? AND version=?',
                                           (text, stamp, *key, expected))
                if cursor.rowcount != 1:
                    raise WorkError('version_conflict', 409)
                version = expected + 1
        return {'date': key[2], 'draft': {'text': text, 'version': version}}

    def employee_submit(self, ctx, day, data):
        """Explicit, confirmed, atomic snapshot of the saved draft. Weekends allowed; late if a later day."""
        person, parsed, stamp, today = self._me(ctx, day, allow_future=False)
        _fields(data, {'expectedVersion', 'confirm'})
        if data['confirm'] is not True:
            raise WorkError('confirmation_required')
        expected = _expected(data['expectedVersion'], 1)
        key = (ctx.organization, ctx.subject, parsed.isoformat())
        with self.core._txn(True):
            if self._snapshot(*key) is not None:
                raise WorkError('already_submitted', 409)
            stamp, today = self._clock()
            if parsed > today:
                raise WorkError('future_date')
            row = self._draft(*key)
            if row is None or row[1] != expected:
                raise WorkError('version_conflict', 409)
            text = row[0].strip()
            if not text:
                raise WorkError('empty_report')
            try:
                self.conn.execute('INSERT INTO wc_report_snapshots(id,organization,subject,day,text,display_name,'
                                  'department,submitted_at,late) VALUES(?,?,?,?,?,?,?,?,?)',
                                  (str(uuid.uuid4()), *key, text, person['displayName'], person['department'],
                                   stamp, 1 if today > parsed else 0))
            except sqlite3.IntegrityError:
                raise WorkError('already_submitted', 409) from None
            self.conn.execute('DELETE FROM wc_report_drafts WHERE organization=? AND subject=? AND day=? '
                              'AND version=?', (*key, expected))
            snap = self._snapshot(*key)
        return _public(snap)

    # ---- admin ----------------------------------------------------------------------------------
    def admin_calendar(self, ctx, *, start, end, employee_id=None, department=None, report_status=None):
        self.core._check_admin(ctx)
        first, last = _date(start, 'invalid_range'), _date(end, 'invalid_range')
        if last < first or (last - first).days >= MAX_RANGE_DAYS:
            raise WorkError('invalid_range')
        if employee_id is not None:
            employee_id = _ident(employee_id)
        if department is not None:
            department = _text(department, DEPT_MAX, 'invalid_department')
        if report_status is not None and report_status not in STATUSES:
            raise WorkError('invalid_status')
        _, today = self._clock()
        people = [p for p in self._roster_people(ctx.organization)
                  if (employee_id is None or p['employeeId'] == employee_id)
                  and (department is None or p['department'] == department)]
        sql = ('SELECT subject, day, submitted_at, late FROM wc_report_snapshots '
               'WHERE organization=? AND day>=? AND day<=?')
        args = [ctx.organization, first.isoformat(), last.isoformat()]
        if employee_id is not None:
            sql, args = sql + ' AND subject=?', args + [employee_id]
        with self.core._txn(False):
            self.core._check_admin(ctx)
            rows = self.conn.execute(sql, args).fetchall()
        submitted = {(r[0], r[1]): r for r in rows}
        days = [first + timedelta(days=n) for n in range((last - first).days + 1)]
        employees = []
        for person in people:
            entries = []
            for day in days:
                row = submitted.get((person['employeeId'], day.isoformat()))
                status = _status(day, today, person['startDate'], None if row is None else bool(row[3]))
                if report_status is not None and status != report_status:
                    continue
                entry = {'date': day.isoformat(), 'status': status}
                if row is not None:
                    entry.update(submittedAt=row[2], late=bool(row[3]))
                entries.append(entry)
            if entries or report_status is None:
                employees.append({'employeeId': person['employeeId'], 'displayName': person['displayName'],
                                  'department': person['department'],
                                  'startDateKnown': person['startDate'] is not None, 'days': entries})
        return {'employees': employees,
                'startDateMappingRequired': any(p['startDate'] is None for p in people)}

    def admin_read(self, ctx, employee_id, day):
        """Submitted immutable snapshot only (else 404). Each successful view is audited append-only."""
        self.core._check_admin(ctx)
        key = (ctx.organization, _ident(employee_id), _date(day).isoformat())
        stamp, _ = self._clock()
        with self.core._txn(True):
            self.core._check_admin(ctx)
            stamp, _ = self._clock()
            snap = self._snapshot(*key)
            if snap is None:
                raise WorkError('not_found', 404)
            self.conn.execute('INSERT INTO wc_report_audit(organization,actor,subject,day,action,at) '
                              "VALUES(?,?,?,?,'view',?)", (key[0], ctx.actor, key[1], key[2], stamp))
        return {'employeeId': key[1], **_public(snap)}
