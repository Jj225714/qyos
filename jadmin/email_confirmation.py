"""Admin confirmation of an assigned work email, scoped to DingTalk login."""
import json
import os
import time

import employee_email
from employee_email import EmailError, normalize_email, valid_id


def init_db(c):
    c.execute('''create table if not exists employee_email_confirmations(
        organization text not null, employee_id text not null, email text not null,
        dingtalk text not null, actor text not null, confirmed_at integer not null,
        primary key(organization, employee_id))''')


def valid_binding(value):
    return isinstance(value, str) and 0 < len(value) <= 512 and value.strip() == value


def matching_binding(users, employee_id, email):
    user = next((u for u in users if u['id'] == employee_id), None)
    if user is None:
        raise EmailError('employee_not_found', 404)
    if user['isForbidden'] or user['isDisabled'] or user['isDeleted']:
        raise EmailError('employee_inactive')
    if user['email'] != email:
        raise EmailError('employee_changed')
    if any(u['id'] != employee_id and u['email'].strip().lower() == email for u in users):
        raise EmailError('email_conflict')
    binding = user['bindings']['dingtalk']
    if not valid_binding(binding):
        raise EmailError('dingtalk_required')
    if any(u['id'] != employee_id and u['bindings']['dingtalk'] == binding for u in users):
        raise EmailError('employee_changed')
    return binding


def record(c, employee_id, email, actor, authorized, *, client=None, expected_binding=None):
    org = os.environ.get('CASDOOR_ORG', '')
    if not valid_id(org):
        raise EmailError('organization_unconfigured', 503)
    if not authorized():
        raise EmailError('admin_required', 403)
    client = client or employee_email.AtomicEmailClient()
    client.require_capability()
    binding = matching_binding(client.snapshot(org), employee_id, email)
    if expected_binding is not None and binding != expected_binding:
        raise EmailError('employee_changed')
    now = int(time.time())
    with c:
        c.execute('begin immediate')
        if not authorized():
            raise EmailError('admin_required', 403)
        c.execute('''insert into employee_email_confirmations values(?,?,?,?,?,?)
            on conflict(organization,employee_id) do update set email=excluded.email,
            dingtalk=excluded.dingtalk,actor=excluded.actor,confirmed_at=excluded.confirmed_at''',
            (org, employee_id, email, binding, actor, now))
        c.execute('insert into audit(action,detail,at) values(?,?,?)',
                  ('employee_work_email_confirmed', json.dumps({'actor': actor, 'employeeId': employee_id,
                                                                'organization': org}), now))


def stored(c, org, employee_id, email, binding):
    return bool(c.execute('''select 1 from employee_email_confirmations where organization=?
        and employee_id=? and email=? and dingtalk=?''', (org, employee_id, email, binding)).fetchone())


def lookup(c, body, *, client=None):
    if not isinstance(body, dict) or set(body) != {'organization', 'employeeId', 'email', 'dingtalk'}:
        raise EmailError('invalid_request', 400)
    org, employee_id, email, binding = (body[k] for k in ('organization', 'employeeId', 'email', 'dingtalk'))
    if not valid_id(org) or not valid_id(employee_id) or not valid_binding(binding) or normalize_email(email) != email:
        raise EmailError('invalid_request', 400)
    if org != os.environ.get('CASDOOR_ORG', '') or not stored(c, org, employee_id, email, binding):
        return False
    try:
        return matching_binding((client or employee_email.AtomicEmailClient()).snapshot(org), employee_id, email) == binding
    except EmailError:
        return False
