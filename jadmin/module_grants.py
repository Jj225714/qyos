"""Organization-scoped module grants. R1 observes only; it never gates login."""

import hashlib
import json
import re
import sqlite3
import time

SCHEMA = 'qyos.module-grants.v1'
MODULES = ('chat', 'image', 'my_api_usage')
MAX_EMPLOYEES = 10000
MAX_BACKFILL = 1000
MAX_BODY = 256 * 1024
_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z')


class GrantError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)


def identifier(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise GrantError('invalid_identifier')
    return value


def revision(value):
    if type(value) is not int or not 0 <= value < 2**63 - 1:
        raise GrantError('invalid_revision')
    return value


def grants(value):
    if (not isinstance(value, dict) or set(value) != set(MODULES)
            or any(type(value[key]) is not bool for key in MODULES)):
        raise GrantError('invalid_grants')
    return {key: value[key] for key in MODULES}


def init_db(c):
    # Deliberately lazy: unavailable grant storage must not break login startup.
    c.execute('CREATE TABLE IF NOT EXISTS module_grant_state ('
              'organization TEXT PRIMARY KEY, revision INTEGER NOT NULL)')
    c.execute('CREATE TABLE IF NOT EXISTS module_grant_employees ('
              'organization TEXT NOT NULL, employee_id TEXT NOT NULL, revision INTEGER NOT NULL, '
              'source TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(organization,employee_id))')
    c.execute('CREATE TABLE IF NOT EXISTS module_grants ('
              'organization TEXT NOT NULL, employee_id TEXT NOT NULL, module TEXT NOT NULL '
              "CHECK(module IN ('chat','image','my_api_usage')), allowed INTEGER NOT NULL CHECK(allowed IN (0,1)), "
              'PRIMARY KEY(organization,employee_id,module))')
    c.execute('CREATE TABLE IF NOT EXISTS module_grant_backfills ('
              'organization TEXT NOT NULL, snapshot_id TEXT NOT NULL, digest TEXT NOT NULL, '
              'PRIMARY KEY(organization,snapshot_id))')
    c.execute('CREATE TABLE IF NOT EXISTS module_grant_audit ('
              'id INTEGER PRIMARY KEY, organization TEXT NOT NULL, employee_id TEXT, '
              'actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL)')
    c.commit()


def directory(users, organization):
    identifier(organization)
    if not isinstance(users, list) or len(users) > MAX_EMPLOYEES:
        raise GrantError('directory_unavailable', 503)
    result = {}
    for user in users:
        if not isinstance(user, dict) or user.get('owner') != organization:
            raise GrantError('directory_unavailable', 503)
        try:
            employee_id = identifier(user.get('id'))
        except GrantError:
            raise GrantError('directory_unavailable', 503) from None
        if employee_id in result:
            raise GrantError('directory_unavailable', 503)
        result[employee_id] = {
            'employeeId': employee_id,
            'displayName': str(user.get('displayName') or user.get('name') or employee_id)[:255],
            'inactive': bool(user.get('isDeleted') or user.get('isForbidden')
                             or user.get('isDisabled') or user.get('pendingApproval')),
        }
    return result


def _state(c, organization):
    row = c.execute('SELECT revision FROM module_grant_state WHERE organization=?', (organization,)).fetchone()
    return row[0] if row else 0


def _employee(c, organization, employee_id):
    row = c.execute('SELECT revision,source FROM module_grant_employees WHERE organization=? AND employee_id=?',
                    (organization, employee_id)).fetchone()
    if not row:
        return {'employeeId': employee_id, 'revision': 0, 'status': 'unknown', 'grants': None}
    values = dict(c.execute('SELECT module,allowed FROM module_grants WHERE organization=? AND employee_id=?',
                           (organization, employee_id)).fetchall())
    if set(values) != set(MODULES) or any(value not in (0, 1) for value in values.values()):
        raise GrantError('grants_unavailable', 503)
    return {'employeeId': employee_id, 'revision': row[0], 'status': 'configured',
            'source': row[1], 'grants': {key: bool(values[key]) for key in MODULES}}


def feed(c, organization):
    identifier(organization)
    # One snapshot for the global revision and every employee row.
    c.execute('BEGIN')
    try:
        current = _state(c, organization)
        ids = c.execute('SELECT employee_id FROM module_grant_employees WHERE organization=? '
                        'ORDER BY employee_id LIMIT ?', (organization, MAX_EMPLOYEES + 1)).fetchall()
        if len(ids) > MAX_EMPLOYEES:
            raise GrantError('grants_unavailable', 503)
        return {'schema': SCHEMA, 'mode': 'shadow', 'organization': organization, 'revision': current,
                'employees': [_employee(c, organization, row[0]) for row in ids]}
    finally:
        c.rollback()


def listing(c, organization, users):
    people = directory(users, organization)
    result = feed(c, organization)
    saved = {item['employeeId']: item for item in result['employees']}
    result['employees'] = [{**person, **saved.get(key, {
        'employeeId': key, 'revision': 0, 'status': 'unknown', 'grants': None})}
        for key, person in sorted(people.items())]
    result['orphanedCount'] = len(set(saved) - set(people))
    return result


def _audit(c, organization, employee_id, actor, action, detail):
    c.execute('INSERT INTO module_grant_audit(organization,employee_id,actor,action,detail,at) '
              'VALUES(?,?,?,?,?,?)', (organization, employee_id, actor, action,
                                    json.dumps(detail, sort_keys=True), int(time.time())))


def _write(c, organization, employee_id, values, next_revision, source):
    c.execute('INSERT INTO module_grant_employees VALUES(?,?,?,?,?) '
              'ON CONFLICT(organization,employee_id) DO UPDATE SET '
              'revision=excluded.revision,source=excluded.source,updated=excluded.updated',
              (organization, employee_id, next_revision, source, int(time.time())))
    for module, allowed in values.items():
        c.execute('INSERT INTO module_grants VALUES(?,?,?,?) '
                  'ON CONFLICT(organization,employee_id,module) DO UPDATE SET allowed=excluded.allowed',
                  (organization, employee_id, module, int(allowed)))


def _advance(c, organization):
    new = _state(c, organization) + 1
    c.execute('INSERT INTO module_grant_state VALUES(?,?) '
              'ON CONFLICT(organization) DO UPDATE SET revision=excluded.revision', (organization, new))
    return new


def _capacity(c, organization, additional):
    count = c.execute('SELECT COUNT(*) FROM module_grant_employees WHERE organization=?', (organization,)).fetchone()[0]
    if count + additional > MAX_EMPLOYEES:
        raise GrantError('grant_capacity_reached', 409)


def save(c, organization, data, actor, users, authorized):
    people = directory(users, organization)
    if not isinstance(data, dict) or set(data) != {'employeeId', 'expectedRevision', 'grants'}:
        raise GrantError('invalid_request')
    key, expected, values = identifier(data['employeeId']), revision(data['expectedRevision']), grants(data['grants'])
    if key not in people:
        raise GrantError('employee_not_found', 404)
    c.execute('BEGIN IMMEDIATE')
    try:
        if not authorized():
            raise GrantError('admin_required', 403)
        old = _employee(c, organization, key)
        if old['revision'] != expected:
            raise GrantError('revision_conflict', 409)
        _capacity(c, organization, int(old['status'] == 'unknown'))
        _write(c, organization, key, values, expected + 1, 'manual')
        current = _advance(c, organization)
        _audit(c, organization, key, actor, 'save', {'before': old['grants'], 'after': values})
        saved = _employee(c, organization, key)
        c.commit()
        return {'schema': SCHEMA, 'mode': 'shadow', 'organization': organization,
                'revision': current, 'employee': saved}
    except Exception:
        c.rollback()
        raise


def backfill(c, organization, data, actor, users, authorized, *, preview=False):
    people = directory(users, organization)
    if (not isinstance(data, dict) or set(data) != {'snapshotId', 'source', 'expectedRevision', 'employees'}
            or data['source'] != 'reviewed-current-access'):
        raise GrantError('invalid_snapshot')
    snapshot_id = identifier(data['snapshotId'])
    expected = revision(data['expectedRevision'])
    if not isinstance(data['employees'], list) or not 1 <= len(data['employees']) <= MAX_BACKFILL:
        raise GrantError('invalid_snapshot')
    entries = {}
    for item in data['employees']:
        if not isinstance(item, dict) or set(item) != {'employeeId', 'grants'}:
            raise GrantError('invalid_snapshot')
        key = identifier(item['employeeId'])
        if key in entries or key not in people:
            raise GrantError('invalid_snapshot')
        entries[key] = grants(item['grants'])
    digest = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    c.execute('BEGIN IMMEDIATE' if not preview else 'BEGIN')
    try:
        if not authorized():
            raise GrantError('owner_required', 403)
        prior = c.execute('SELECT digest FROM module_grant_backfills WHERE organization=? AND snapshot_id=?',
                          (organization, snapshot_id)).fetchone()
        if prior and prior[0] != digest:
            raise GrantError('snapshot_conflict', 409)
        current = _state(c, organization)
        if not prior and current != expected:
            raise GrantError('revision_conflict', 409)
        changes, preserved = [], []
        for key, values in sorted(entries.items()):
            old = _employee(c, organization, key)
            if old['status'] == 'configured':
                preserved.append(key)
            else:
                changes.append({'employeeId': key, 'before': None, 'after': values})
        _capacity(c, organization, len(changes) if not prior else 0)
        if not preview and not prior:
            for change in changes:
                _write(c, organization, change['employeeId'], change['after'], 1, 'backfill')
            current = _advance(c, organization)
            c.execute('INSERT INTO module_grant_backfills VALUES(?,?,?)', (organization, snapshot_id, digest))
            _audit(c, organization, None, actor, 'backfill', {
                'snapshotId': snapshot_id, 'digest': digest, 'changes': changes, 'preserved': preserved})
            c.commit()
        else:
            c.rollback()
        return {'schema': SCHEMA, 'mode': 'shadow', 'organization': organization, 'revision': current,
                'snapshotId': snapshot_id, 'preview': preview, 'alreadyApplied': bool(prior),
                'changes': [] if prior else changes, 'preserved': preserved}
    except Exception:
        c.rollback()
        raise


def observe(c, organization, data):
    if (not isinstance(data, dict) or set(data) != {'organization', 'employeeId', 'module'}
            or data['organization'] != organization or data['module'] not in MODULES):
        raise GrantError('invalid_request')
    key = identifier(data['employeeId'])
    c.execute('BEGIN IMMEDIATE')
    try:
        employee = _employee(c, organization, key)
        would_deny = employee['grants'] is not None and not employee['grants'][data['module']]
        if would_deny:
            _audit(c, organization, key, 'internal', 'would_deny', {'module': data['module']})
        c.commit()
        return {'schema': SCHEMA, 'mode': 'shadow', 'decision': 'allow', 'organization': organization,
                'employeeId': key, 'module': data['module'], 'status': employee['status'],
                'revision': employee['revision'], 'wouldDeny': would_deny}
    except Exception:
        c.rollback()
        raise
