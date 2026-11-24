"""Bounded media control-plane routes; no provider calls or secret distribution.

MEDIA_REGISTRY is installed by trusted application code, never by an HTTP caller.
This release's catalog is only for draft editing; no operation can be activated.
"""
import hmac
import os
from pathlib import Path
import stat
from urllib.parse import urlsplit

import media_config_service as media
import capability_grants
import module_grants

MAX_BODY = 256 * 1024
TARGETS = ('text_edit', 'video.t2v', 'video.i2v.first_frame')
CONSUMERS = ('config-vault', 'gateway')
# Draft-only catalog. These entries validate configuration; they are not installed runtime adapters.
_PREVIEW_PROFILES = (
    ('image.text_edit.ocr', 'qyos.gateway.text-edit-protocol', 'qwen3.5-ocr', {}),
    ('image.text_edit.erase', 'qyos.gateway.text-edit-protocol', 'wanx2.1-imageedit', {}),
    ('video.t2v', 'dashscope.native.video.t2v.wan2.7', 'wan2.7-t2v-2026-06-12',
     {'resolution': ['720P'], 'duration': [5], 'ratio': ['16:9', '9:16']}),
    ('video.i2v.first_frame', 'dashscope.native.video.i2v.first_frame.wan2.7', 'wan2.7-i2v-2026-04-25',
     {'resolution': ['720P'], 'duration': [5]}),
)
MEDIA_REGISTRY = {'trustedOrigins': ['https://dashscope.aliyuncs.com'], 'adapters': {}}
for _operation, _adapter, _model, _parameters in _PREVIEW_PROFILES:
    _key = _adapter + '@0.2.0'
    _spec = MEDIA_REGISTRY['adapters'].setdefault(_key, {'operations': [], 'models': [], 'parameters': _parameters})
    _spec['operations'].append(_operation)
    _spec['models'].append(_model)
    MEDIA_REGISTRY['adapters']['qyos.web.' + _operation.replace('_', '-') + '@0.1.0'] = {
        'operations': [_operation], 'models': [_model], 'parameters': _parameters,
    }
PREFIXES = ('/api/admin/media/', '/api/internal/media-config', '/api/internal/media-ack',
            '/api/admin/capability-grants', '/api/internal/capability-grants')


def matches(path):
    return urlsplit(path).path.startswith(PREFIXES)


def _consumer(handler):
    names = handler.headers.get_all('X-Media-Consumer', [])
    tokens = handler.headers.get_all('X-Internal-Token', [])
    if len(names) != 1 or names[0] not in CONSUMERS or len(tokens) != 1:
        return None
    directory = os.environ.get('QYOS_MEDIA_CONSUMER_AUTH_DIR')
    if not directory:
        return None
    path = Path(directory) / (names[0] + '.token')
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 512 or info.st_nlink != 1:
            return None
        if os.name == 'posix' and stat.S_IMODE(info.st_mode) & 0o077:
            return None
        value = path.read_text(encoding='ascii').strip()
        if len(value) < 32 or not hmac.compare_digest(value, tokens[0]):
            return None
    except (OSError, UnicodeError, TypeError):
        return None
    return names[0]


def handle(handler, host):
    path = urlsplit(handler.path).path
    c = None
    actor = None
    internal = path.startswith('/api/internal/')
    consumer = None

    def authorized():
        values = handler.headers.get_all('Authorization', [])
        identity = host.who(values[0][7:]) if len(values) == 1 and values[0].startswith('Bearer ') else None
        return bool(identity and identity == actor and host.is_admin_actor(c, identity)
                    and (handler.command == 'GET' or identity == host.EMAIL))

    try:
        if internal:
            consumer = _consumer(handler)
            if not consumer:
                return handler.out({'error': 'unauthorized'}, 401)
            actor = consumer
        else:
            values = handler.headers.get_all('Authorization', [])
            actor = host.who(values[0][7:]) if len(values) == 1 and values[0].startswith('Bearer ') else None
            if not actor:
                return handler.out({'error': 'unauthorized'}, 401)
            c = handler.conn()
            if not authorized():
                return handler.out({'error': 'owner_required' if handler.command != 'GET' else 'admin_required'}, 403)
        routes = {
            '/api/admin/media/config': ('GET', 'POST'),
            '/api/admin/media/prepare': ('POST',),
            '/api/admin/media/activate': ('POST',),
            '/api/admin/media/revoke': ('POST',),
            '/api/admin/media/rollback': ('POST',),
            '/api/internal/media-config': ('GET',),
            '/api/internal/media-ack': ('POST',),
            '/api/admin/capability-grants': ('GET', 'POST'),
            '/api/internal/capability-grants': ('GET',),
        }
        if path not in routes or handler.path != path:
            return handler.out({'error': 'invalid_request'}, 400)
        if handler.command not in routes[path]:
            return handler.out({'error': 'method_not_allowed'}, 405,
                               extra=[('Allow', ', '.join(routes[path]))])
        c = c or handler.conn()
        if path.endswith('/capability-grants'):
            organization = os.environ.get('CASDOOR_ORG', '')
            if not host.employee_email.valid_id(organization):
                return handler.out({'error': 'organization_unconfigured'}, 503)
            capability_grants.init_db(c)
            if internal:
                rows = c.execute('SELECT employee_id FROM capability_grants WHERE organization=? ORDER BY employee_id LIMIT 10001', (organization,)).fetchall()
                if len(rows) > 10000:
                    return handler.out({'error': 'grant_capacity_reached'}, 503)
                return handler.out({'schema': capability_grants.SCHEMA, 'organization': organization,
                                    'employees': [capability_grants.get_grant(c, organization, row[0]) for row in rows]})
            try:
                people = module_grants.directory(host.enterprise.casdoor_users(), organization)
            except (host.enterprise.EnterpriseError, module_grants.GrantError):
                return handler.out({'error': 'directory_unavailable'}, 503)
            if handler.command == 'GET':
                return handler.out({'schema': capability_grants.SCHEMA, 'organization': organization,
                                    'canEdit': actor == host.EMAIL,
                                    'employees': [{**person, **capability_grants.get_grant(c, organization, key)} for key, person in people.items()]})
            data = handler.read_email_json(MAX_BODY)
            if not isinstance(data, dict) or set(data) != {'employeeId', 'expectedRevision', 'video_generate', 'quotaProfile'}:
                return handler.out({'error': 'invalid_request'}, 400)
            if not isinstance(data['employeeId'], str) or data['employeeId'] not in people:
                return handler.out({'error': 'employee_not_found'}, 404)
            if people[data['employeeId']]['inactive'] and data['video_generate'] is True:
                return handler.out({'error': 'employee_inactive'}, 409)
            return handler.out(capability_grants.save_grant(c, organization, data['employeeId'],
                               data['video_generate'], data['quotaProfile'], data['expectedRevision'], actor,
                               authorized=lambda *_: authorized()))
        media.init_db(c)
        service = media.Service(trusted_origins=MEDIA_REGISTRY['trustedOrigins'],
                                adapters=MEDIA_REGISTRY['adapters'], activation_enabled=False,
                                authorized=(lambda *_: _consumer(handler) == consumer) if internal else (lambda *_: authorized()))
        if handler.command == 'GET':
            return handler.out({'schema': 'qyos.media-control.v1',
                                'configurationPreview': True,
                                'activationEnabled': False,
                                'targets': {target: service.status(c, target) for target in TARGETS},
                                'registry': MEDIA_REGISTRY, 'canEdit': actor == host.EMAIL})
        data = handler.read_email_json(MAX_BODY)
        if not isinstance(data, dict):
            return handler.out({'error': 'invalid_request'}, 400)
        action = path.rsplit('/', 1)[-1]
        fields = {
            'config': {'target', 'config', 'expectedRevision'},
            'prepare': {'target', 'expectedRevision'},
            'activate': {'publicationId', 'expectedRevision'},
            'revoke': {'publicationId', 'expectedRevision'},
            'rollback': {'target', 'publicationId', 'expectedRevision'},
            'media-ack': {'publicationId', 'expectedRevision', 'digest', 'stage', 'epoch', 'accepted'},
        }
        if set(data) != fields[action] or ('target' in data and data['target'] not in TARGETS):
            return handler.out({'error': 'invalid_request'}, 400)
        expected = data['expectedRevision']
        if action in ('prepare', 'activate'):
            return handler.out({'error': 'configuration_preview_only'}, 503)
        if action == 'config':
            if any(b.get('enabled') is True for b in (data['config'].get('bindings', []) if isinstance(data['config'], dict) and isinstance(data['config'].get('bindings'), list) else []) if isinstance(b, dict)):
                return handler.out({'error': 'configuration_preview_only'}, 409)
            result = service.save_draft(c, data['target'], data['config'], expected, actor)
        elif action == 'prepare':
            result = service.prepare(c, data['target'], list(CONSUMERS), expected, actor)
        elif action == 'activate':
            result = service.activate(c, data['publicationId'], expected, actor)
        elif action == 'revoke':
            result = service.revoke(c, data['publicationId'], expected, actor)
        elif action == 'rollback':
            result = service.rollback(c, data['target'], data['publicationId'], list(CONSUMERS), expected, actor)
        elif data['stage'] == 'prepared' and data['epoch'] is None and type(data['accepted']) is bool:
            result = service.consumer_prepared(c, data['publicationId'], consumer,
                                              data['digest'], data['accepted'], expected, actor)
        elif data['stage'] == 'active' and data['accepted'] is True:
            result = service.ack(c, data['publicationId'], consumer, data['digest'], data['epoch'], expected, actor)
        else:
            return handler.out({'error': 'invalid_request'}, 400)
        return handler.out(result)
    except (media.MediaError, host.employee_email.EmailError) as error:
        return handler.out({'error': error.code, 'code': error.code}, error.status)
    except host.sqlite3.Error:
        return handler.out({'error': 'media_store_unavailable'}, 503)
    finally:
        handler.close_connection = True
