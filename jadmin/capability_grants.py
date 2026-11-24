"""Adjacent video grants. No changes to module-grants.v1 or login behavior."""

import sqlite3
import time

from media_config_service import MediaError, _authorize, _id, _revision, _tx

SCHEMA = 'qyos.capability-grants.v1'


def init_db(c):
    with _tx(c):
        c.execute('CREATE TABLE IF NOT EXISTS capability_grants ('
                  'organization TEXT NOT NULL, employee_id TEXT NOT NULL, revision INTEGER NOT NULL, '
                  'video_generate INTEGER NOT NULL CHECK(video_generate IN (0,1)), quota_profile TEXT, '
                  'PRIMARY KEY(organization,employee_id))')
        c.execute('CREATE TABLE IF NOT EXISTS capability_grant_audit ('
                  'id INTEGER PRIMARY KEY, organization TEXT NOT NULL, employee_id TEXT NOT NULL, '
                  'revision INTEGER NOT NULL, actor TEXT NOT NULL, allowed INTEGER NOT NULL, at INTEGER NOT NULL)')


def get_grant(c, organization, employee_id):
    _id(organization)
    _id(employee_id)
    try:
        row = c.execute('SELECT revision,video_generate,quota_profile FROM capability_grants '
                        'WHERE organization=? AND employee_id=?', (organization, employee_id)).fetchone()
    except sqlite3.Error:
        raise MediaError('grants_unavailable', 503) from None
    if row and (type(row[0]) is not int or row[0] < 1 or row[1] not in (0, 1)):
        raise MediaError('grants_unavailable', 503)
    if row and row[2] is not None:
        try:
            _id(row[2])
        except MediaError:
            raise MediaError('grants_unavailable', 503) from None
    return {'schema': SCHEMA, 'organization': organization, 'employeeId': employee_id,
            'revision': row[0] if row else 0, 'video_generate': bool(row[1]) if row else False,
            'quotaProfile': row[2] if row else None}


def save_grant(c, organization, employee_id, allowed, quota_profile, expected_revision, actor, *, authorized=None):
    _id(organization)
    _id(employee_id)
    _revision(expected_revision)
    if type(allowed) is not bool:
        raise MediaError('invalid_grant')
    if quota_profile is not None:
        _id(quota_profile)
    if allowed and quota_profile is None:
        raise MediaError('quota_profile_required')
    with _tx(c):
        _authorize(authorized, c, actor, 'save_grant', organization + ':' + employee_id)
        current = get_grant(c, organization, employee_id)
        if current['revision'] != expected_revision:
            raise MediaError('revision_conflict', 409)
        revision = expected_revision + 1
        c.execute('INSERT INTO capability_grants VALUES(?,?,?,?,?) ON CONFLICT(organization,employee_id) '
                  'DO UPDATE SET revision=excluded.revision,video_generate=excluded.video_generate,quota_profile=excluded.quota_profile',
                  (organization, employee_id, revision, int(allowed), quota_profile))
        c.execute('INSERT INTO capability_grant_audit(organization,employee_id,revision,actor,allowed,at) VALUES(?,?,?,?,?,?)',
                  (organization, employee_id, revision, actor, int(allowed), int(time.time())))
        return get_grant(c, organization, employee_id)


def _principal(principal):
    if type(principal) is not dict or any(principal.get(field) is not True
            for field in ('authenticated', 'active', 'sessionValid')):
        return False
    try:
        _id(principal.get('organization'))
        _id(principal.get('employeeId'))
    except MediaError:
        return False
    return True


def can_generate(c, principal):
    if not _principal(principal):
        return False
    try:
        grant = get_grant(c, principal['organization'], principal['employeeId'])
        return grant['video_generate'] and grant['quotaProfile'] is not None
    except (sqlite3.Error, MediaError):
        return False


def can_read(principal, owner):
    if not _principal(principal) or type(owner) is not dict:
        return False
    return (owner.get('organization') == principal['organization'] and
            owner.get('employeeId') == principal['employeeId'])
