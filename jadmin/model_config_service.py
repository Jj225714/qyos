"""Model configuration orchestration. File transactions belong to librechat_config.

The host initializes this service under its schema lock before publishing readiness.
No method calls host.db(), init_db(), or model status wrappers.
"""

from contextlib import closing, contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import stat
import threading
import time
from urllib.error import HTTPError

import apply_client
import librechat_config as config


class ServiceError(ValueError):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.code = code
        self.status = status


def _public(method):
    def call(self, *args, **kwargs):
        try:
            return method(self, *args, **kwargs)
        except ServiceError:
            raise
        except config.ConfigError as exc:
            raise ServiceError(exc.code, exc.status) from None
        except apply_client.ConfigBusy:
            raise ServiceError('config_busy', 409) from None
        except apply_client.ApplyClientError:
            raise ServiceError('apply_unavailable', 503) from None
    return call


class Service:
    def __init__(self, server_module):
        self.host = server_module
        self._guard = threading.RLock()
        self._workers = {}
        self._discovery = {}
        self._regular_probe = {}

    @property
    def state_dir(self):
        return os.path.dirname(os.path.abspath(self.host.DB))

    @contextmanager
    def _file_lock(self):
        try:
            with apply_client.config_lock(getattr(self.host, 'CONFIG_LOCK_PATH',
                                                   apply_client.LOCK_PATH), timeout=5):
                yield
        except apply_client.ConfigBusy:
            raise ServiceError('config_busy', 409) from None
        except apply_client.ApplyClientError:
            raise ServiceError('config_lock_unavailable', 503) from None

    def _read(self):
        return config.read_config(self.host.LCYAML, self.host.LCENV)

    @staticmethod
    def _row(c, table):
        cur = c.execute('select * from ' + table + ' where id=1')
        row = cur.fetchone()
        return dict(zip([d[0] for d in cur.description], row)) if row else None

    def _binding(self, c):
        row = self._row(c, 'endpoint_binding')
        if row is None:
            raise ServiceError('model_service_not_initialized', 503)
        return row

    def _state(self, c):
        return self._row(c, 'model_config_state')

    def _needs_recovery(self, c):
        directory = Path(self.state_dir) / 'txn'
        return bool(c.execute('select 1 from config_txn limit 1').fetchone()
                    or directory.is_symlink()
                    or (directory.exists() and (not directory.is_dir() or any(directory.iterdir()))))

    def _recover_before_read(self, c):
        if self._needs_recovery(c):
            with self._file_lock():
                try:
                    config.recover(c, self.host.LCYAML, self.host.LCENV, self.state_dir)
                except config.ConfigError:
                    raise ServiceError('config_recovery_required', 409) from None

    def _audit(self, c, action, **detail):
        # The host audit commits. Never call it inside a file commit callback.
        self.host.audit(c, action, json.dumps(detail, sort_keys=True))

    def _target(self, base, resolve=False):
        try:
            return (self.host.resolve_model_target if resolve else
                    self.host.parse_model_url)(base)
        except (ValueError, TypeError):
            raise ServiceError('invalid_base_url') from None

    @staticmethod
    def _expected(data, row):
        if (type(data.get('expectedRevision')) is not int
                or data['expectedRevision'] != row['revision']):
            raise ServiceError('endpoint_stale', 409)

    @_public
    def init_db(self, c):
        with self.host._LC_FILES_LOCK:
            self._init_db(c)

    def _init_db(self, c):
        c.execute('''create table if not exists endpoint_binding(
            id integer primary key check(id=1), revision integer not null,
            state text not null, committed_origin text, pending_origin text, updated integer)''')
        c.execute('''create table if not exists model_config_state(
            id integer primary key check(id=1), apply_state text not null,
            apply_request_id text, apply_revision integer, apply_yaml_sha text,
            apply_op text, applied_revision integer, applied_yaml_sha text,
            applied_at integer, changed_since_applied text not null default '[]',
            last_error_code text, updated integer)''')
        c.execute('''create table if not exists model_last_good(
            id integer primary key check(id=1), revision integer not null,
            base_url text not null, default_model text not null,
            endpoint_name text not null, key_file text not null, at integer)''')
        c.execute('''create table if not exists model_last_good_standby(
            id integer primary key check(id=1), revision integer not null, model text not null)''')
        config.init_db(c)
        if not self._row(c, 'endpoint_binding'):
            origin = None
            try:
                snapshot = self._read()
                target = self._target(snapshot['baseURL'])
                if target.trusted:
                    origin = target.origin
            except (ServiceError, config.ConfigError):
                pass
            c.execute('insert into endpoint_binding values(1,1,?,?,NULL,?)',
                      ('ok' if origin else 'unbound', origin, int(time.time())))
        c.execute("insert or ignore into model_config_state(id,apply_state,updated) values(1,'none',?)",
                  (int(time.time()),))
        # A completed result is historical evidence after restart, not a fresh
        # check of the running container. Retain only undelivered correlations.
        c.execute("""update model_config_state set apply_state='unknown',
            apply_request_id=NULL,apply_revision=NULL,apply_yaml_sha=NULL,apply_op=NULL
            where apply_state='applied_healthy'""")
        c.execute("update model_config_state set apply_state='unknown' where apply_state in ('queued','applying')")
        c.commit()
        # The component starts before the helper/lock is installed. Only actual
        # journals or orphan files require the recovery lock during migration.
        txn_dir = Path(self.state_dir) / 'txn'
        pending = c.execute('select 1 from config_txn limit 1').fetchone()
        orphans = txn_dir.exists() and (txn_dir.is_symlink() or any(txn_dir.iterdir()))
        if pending or orphans:
            try:
                with self._file_lock():
                    config.recover(c, self.host.LCYAML, self.host.LCENV, self.state_dir)
            except (ServiceError, config.ConfigError):
                c.execute("update endpoint_binding set state='pending' where id=1")
                c.execute("update model_config_state set apply_state='unknown',last_error_code='config_recovery_required' where id=1")
                c.commit()

    def current_base_url(self):
        with self.host._LC_FILES_LOCK:
            try:
                return self._target(self._read()['baseURL']).base
            except (ServiceError, config.ConfigError):
                return ''

    def snapshot(self):
        with self.host._LC_FILES_LOCK, closing(self.host.connect()) as c:
            row = self._binding(c)
            endpoint = {'baseURL': '', 'revision': row['revision'], 'state': row['state'],
                        'keyConfigured': False, 'bindingMatches': False,
                        'firstSetup': False, 'endpointsWarning': False}
            try:
                snapshot = self._read()
                endpoint.update(firstSetup=not snapshot['hasManaged'],
                                endpointsWarning=snapshot['endpointsWarning'],
                                fallbackModel=snapshot['fallbackModel'],
                                keyConfigured=bool(snapshot['key'].strip()))
                try:
                    target = self._target(snapshot['baseURL'])
                    endpoint['baseURL'] = target.base
                    endpoint['bindingMatches'] = (row['state'] == 'ok' and
                                                  target.origin == row['committed_origin'])
                except ServiceError:
                    endpoint['baseURLInvalid'] = True
                error = None
                if row['state'] == 'pending':
                    error = 'key_required_after_failed_save'
                elif not endpoint['bindingMatches']:
                    error = 'key_binding_required'
                elif not snapshot['key'].strip():
                    error = 'key_required'
                return endpoint, snapshot['defaultModel'], snapshot['key'], error
            except config.ConfigError as exc:
                return endpoint, '', '', exc.code

    def _key(self, row, target, existing, supplied, reuse, owner):
        if supplied:
            if not owner:
                raise ServiceError('owner_required', 403)
            return config.validate_key(supplied)
        if row['state'] == 'pending':
            raise ServiceError('key_required_after_failed_save')
        if row['state'] != 'ok' or target.origin != row['committed_origin']:
            if not owner or not reuse:
                raise ServiceError('key_required_for_new_origin')
        return config.validate_key(existing)

    @_public
    def save(self, c, data, actor):
        if not isinstance(data, dict):
            raise ServiceError('config_fields_invalid')
        if (not set(data).intersection({'baseURL', 'apiKey', 'defaultModel', 'fallbackModel'})
                and not (actor == self.host.EMAIL and data.get('reuseKeyForNewOrigin') is True)):
            return {'ok': True, 'revision': self._binding(c)['revision']}
        if data.get('apiKey') is not None and data['apiKey'] != '':
            config.validate_key(data['apiKey'])
        if 'defaultModel' in data and (not isinstance(data['defaultModel'], str)
                                      or not config.MODEL_RE.fullmatch(data['defaultModel'])):
            raise ServiceError('invalid_default_model')
        if 'fallbackModel' in data and (not isinstance(data['fallbackModel'], str)
                                       or (data['fallbackModel'] and not config.MODEL_RE.fullmatch(data['fallbackModel']))):
            raise ServiceError('invalid_fallback_model')
        with self.host._LC_FILES_LOCK:
            self._check_write_guard(c)
            self._recover_before_read(c)
            row = self._binding(c)
            self._expected(data, row)
            before = self._read()
            if not before['hasManaged']:
                if actor != self.host.EMAIL:
                    raise ServiceError('owner_required_first_setup', 403)
                if not data.get('defaultModel') or not data.get('baseURL'):
                    raise ServiceError('first_setup_requires_default_model')
            base = data.get('baseURL') or before['baseURL']
            if actor != self.host.EMAIL and (data.get('apiKey') or
                    self._target(base).base != self._target(before['baseURL']).base):
                raise ServiceError('owner_required', 403)
        # DNS is outside both locks. Revision and file contents are rechecked.
        target = self._target(base, resolve=True)
        self._probe_regular_change(data, actor, row, before, target)
        with self.host._LC_FILES_LOCK, self._file_lock():
            return self._save_locked(c, data, actor, target, before)

    def _probe_regular_change(self, data, actor, row, before, target):
        probe = getattr(self.host, 'probe_chat_model', None)
        if probe is None:
            return
        owner = actor == self.host.EMAIL
        key = self._key(row, target, before['key'], data.get('apiKey'),
                        owner and data.get('reuseKeyForNewOrigin') is True, owner)
        model = data.get('defaultModel', before['defaultModel'])
        standby = data.get('fallbackModel', before['fallbackModel'])
        if standby and standby == model and 'fallbackModel' in data:
            raise ServiceError('fallback_matches_default')
        same_route = (before['hasManaged'] and target.base == self._target(before['baseURL']).base
                      and key == before['key'] and row['state'] == 'ok')
        checks = []
        if not same_route or model != before['defaultModel']:
            checks.append(model)
        if standby and standby != model and (not same_route or standby != before['fallbackModel']):
            checks.append(standby)
        if not checks:
            return
        identity = os.path.abspath(self.host.DB)
        now = time.monotonic()
        with self._guard:
            self._regular_probe = {k: v for k, v in self._regular_probe.items() if now - v < 5}
            if identity in self._regular_probe:
                raise ServiceError('probe_rate_limited', 429)
            self._regular_probe[identity] = now
        try:
            for model_id in checks:
                if probe(target.base, key, model_id, timeout=15) is not True:
                    raise ValueError()
        except TimeoutError:
            raise ServiceError('model_probe_timeout', 504) from None
        except Exception:
            raise ServiceError('model_probe_failed', 502) from None

    def _save_locked(self, c, data, actor, target, before=None):
        self._check_write_guard(c)
        row = self._binding(c)
        self._expected(data, row)
        old = self._read()
        if before and (before['yaml'] != old['yaml'] or before['env'] != old['env']):
            raise ServiceError('endpoint_stale', 409)
        owner = actor == self.host.EMAIL
        if not old['hasManaged']:
            if not owner:
                raise ServiceError('owner_required_first_setup', 403)
            if not data.get('defaultModel') or not data.get('baseURL'):
                raise ServiceError('first_setup_requires_default_model')
        supplied = data.get('apiKey')
        if supplied is not None and not isinstance(supplied, str):
            raise ServiceError('invalid_api_key')
        reuse = owner and data.get('reuseKeyForNewOrigin') is True
        if not owner and (target.base != self._target(old['baseURL']).base or supplied):
            raise ServiceError('owner_required', 403)
        key = self._key(row, target, old['key'], supplied, reuse, owner)
        revision = row['revision'] + 1
        candidate = config.prepare(old, target.base, data.get('defaultModel'), key, revision,
                                   fallback_model=data.get('fallbackModel'))
        fields = {name for name in ('defaultModel', 'fallbackModel') if old[name] != candidate[name]}
        if not old['hasManaged'] or self._target(old['baseURL']).base != target.base:
            fields.add('baseURL')
        if old['key'] != key or row['state'] != 'ok':
            fields.add('apiKey')
        state = self._state(c)
        changed = set(json.loads(state['changed_since_applied'])) | fields
        if not old['hasManaged']:
            changed.update(('baseURL', 'apiKey', 'defaultModel'))

        def commit(db):
            result = db.execute("update endpoint_binding set revision=?,state='ok',committed_origin=?,pending_origin=NULL,updated=? where id=1 and revision=?",
                                (revision, target.origin, int(time.time()), row['revision']))
            if result.rowcount != 1:
                raise ServiceError('endpoint_stale', 409)
            db.execute("update model_config_state set apply_state='persisted_unapplied',changed_since_applied=?,last_error_code=NULL,updated=? where id=1",
                       (json.dumps(sorted(changed)), int(time.time())))
            for name in ('baseURL', 'defaultModel'):
                db.execute('insert into config(k,v,updated) values(?,?,?) on conflict(k) do update set v=excluded.v,updated=excluded.updated',
                           (name, candidate[name], int(time.time())))

        config.persist(c, old, candidate, self.host.LCYAML, self.host.LCENV,
                       self.state_dir, commit)
        self._audit(c, 'model_config_save', actor=actor, revision=revision,
                    fields=sorted(fields), originBefore=row['committed_origin'], originAfter=target.origin)
        return {'ok': True, 'revision': revision}

    @_public
    def discover(self, c, data, actor):
        if not isinstance(data, dict):
            raise ServiceError('config_fields_invalid')
        # Discovery intentionally never reads YAML, even when YAML is malformed.
        # Binding and Key must describe the same save. Release before any DNS
        # or provider work so a later save cannot substitute its Key here.
        with self.host._LC_FILES_LOCK:
            row = self._binding(c)
            cached = c.execute("select v from config where k='baseURL'").fetchone()
            base = data.get('baseURL')
            if not base:
                base = cached[0] if cached else self.host.MODEL_BASE_URL
            target = self._target(base)
            supplied = data.get('apiKey')
            owner = actor == self.host.EMAIL
            reuse = data.get('reuseExistingKey') is True or data.get('reuseKeyForNewOrigin') is True
            if not owner and (supplied or reuse or not cached
                              or target.base != self._target(cached[0]).base
                              or target.origin != row['committed_origin']):
                raise ServiceError('owner_required', 403)
            existing = '' if supplied else config.read_env(self.host.LCENV)['key']
            key = self._key(row, target, existing, supplied, reuse, owner)
        identity = (os.path.abspath(self.host.DB), actor)
        now = time.monotonic()
        with self._guard:
            previous = self._discovery.get(identity)
            if previous is not None and now - previous < 5:
                raise ServiceError('discovery_rate_limited', 429)
            self._discovery = {k: v for k, v in self._discovery.items() if now - v < 5}
            self._discovery[identity] = now
        try:
            return {'models': self.host.fetch_models(target.base, key, timeout=10)}
        except TimeoutError:
            raise ServiceError('model_discovery_timeout', 504) from None
        except HTTPError as exc:
            code = exc.code if type(exc.code) is int and 100 <= exc.code <= 599 else 502
            raise ServiceError('model_discovery_http_' + str(code), 502) from None
        except ssl.SSLError:
            raise ServiceError('model_discovery_tls_failed', 502) from None
        except Exception:
            raise ServiceError('model_discovery_failed', 502) from None

    def _request(self, payload, **kwargs):
        return apply_client.request(payload, socket_path=getattr(
            self.host, 'APPLY_SOCKET_PATH', apply_client.SOCKET_PATH), **kwargs)

    def _apply_allowed(self, c, actor):
        if actor != self.host.EMAIL and not set(json.loads(
                self._state(c)['changed_since_applied'])).issubset({'defaultModel', 'fallbackModel', 'pilotModel'}):
            raise ServiceError('owner_required_for_endpoint_apply', 403)

    def _check_write_guard(self, c, operation_id=None):
        guard = getattr(self.host, 'model_config_write_guard', None)
        if guard is not None:
            guard(c, operation_id)

    def ensure_apply_idle(self, c):
        if self._state(c)['apply_state'] in ('queued', 'applying'):
            raise ServiceError('config_busy', 409)
        with self._guard:
            if os.path.abspath(self.host.DB) in self._workers:
                raise ServiceError('config_busy', 409)

    @_public
    def pilot_status(self, c):
        with self.host._LC_FILES_LOCK:
            self._recover_before_read(c)
            row = self._binding(c)
            snapshot = self._read()
            if snapshot['pilotError']:
                raise ServiceError(snapshot['pilotError'], 409)
            if snapshot['marker'] != row['revision']:
                raise ServiceError('config_revision_mismatch', 409)
            state = self._state(c)
            changed = json.loads(state['changed_since_applied'])
            edit = (not changed and row['state'] == 'ok' and snapshot['hasManaged']
                    and self._target(snapshot['baseURL']).origin == row['committed_origin']
                    and isinstance(snapshot['key'], str) and bool(config.KEY_RE.fullmatch(snapshot['key']))
                    and state['applied_revision'] == row['revision']
                    and state['applied_yaml_sha'] == hashlib.sha256(snapshot['yaml']).hexdigest()
                    and state['apply_state'] not in ('queued', 'applying', 'failed', 'persisted_unapplied'))
            return {'model': snapshot['pilotModel'], 'revision': row['revision'], 'editable': edit}

    @_public
    def save_pilot(self, c, data, actor, *, operation_id):
        if (not isinstance(operation_id, str) or not operation_id
                or not isinstance(data, dict) or set(data) != {'model', 'expectedModel', 'expectedRevision'}
                or any(not isinstance(data[k], str) or not config.PILOT_MODEL_RE.fullmatch(data[k])
                       for k in ('model', 'expectedModel'))):
            raise ServiceError('config_fields_invalid')
        with self.host._LC_FILES_LOCK, self._file_lock():
            self._check_write_guard(c, operation_id)
            self.ensure_apply_idle(c)
            row = self._binding(c)
            self._expected(data, row)
            old = self._read()
            if old['pilotError']:
                raise ServiceError(old['pilotError'], 409)
            if old['marker'] != row['revision'] or old['pilotModel'] != data['expectedModel']:
                raise ServiceError('pilot_model_mismatch', 409)
            if (row['state'] != 'ok' or not old['hasManaged']
                    or self._target(old['baseURL']).origin != row['committed_origin']):
                raise ServiceError('key_binding_required', 409)
            changed = set(json.loads(self._state(c)['changed_since_applied']))
            if changed - {'pilotModel'}:
                raise ServiceError('unapplied_regular_changes', 409)
            if data['model'] == old['pilotModel']:
                return {'ok': True, 'revision': row['revision']}
            revision = row['revision'] + 1
            candidate = config.prepare(old, None, None, None, revision, pilot_model=data['model'])

            def commit(db):
                result = db.execute('update endpoint_binding set revision=?,updated=? where id=1 and revision=?',
                                    (revision, int(time.time()), row['revision']))
                if result.rowcount != 1:
                    raise ServiceError('endpoint_stale', 409)
                db.execute("update model_config_state set apply_state='persisted_unapplied',changed_since_applied='[\"pilotModel\"]',last_error_code=NULL,updated=? where id=1",
                           (int(time.time()),))

            config.persist(c, old, candidate, self.host.LCYAML, self.host.LCENV, self.state_dir, commit)
            self._audit(c, 'pilot_model_config_save', actor=actor, revision=revision)
            return {'ok': True, 'revision': revision}

    @_public
    def apply(self, c, data, actor, op='apply', *, operation_id=None):
        if op not in ('apply', 'verify') or not isinstance(data, dict):
            raise ServiceError('apply_invalid_request')
        with self.host._LC_FILES_LOCK:
            self._check_write_guard(c, operation_id)
            row = self._binding(c)
            self._expected(data, row)
            self._apply_allowed(c, actor)
            snapshot = self._read()
            target = self._target(snapshot['baseURL'])
            if (not snapshot['hasManaged'] or row['state'] != 'ok'
                    or target.origin != row['committed_origin']):
                raise ServiceError('key_binding_required')
            if snapshot['marker'] != row['revision']:
                raise ServiceError('config_revision_mismatch', 409)
            config.validate_key(snapshot['key'])
            return self._queue(c, snapshot, actor, op)

    def _queue(self, c, snapshot, actor, op):
        db_path = os.path.abspath(self.host.DB)
        with self._guard:
            if db_path in self._workers:
                raise ServiceError('config_busy', 409)
            payload = {'v': 1, 'op': op, 'requestId': secrets.token_hex(16),
                       'configRevision': snapshot['marker'],
                       'yamlSha256': hashlib.sha256(snapshot['yaml']).hexdigest()}
            c.execute("update model_config_state set apply_state='queued',apply_request_id=?,apply_revision=?,apply_yaml_sha=?,apply_op=?,last_error_code=NULL,updated=? where id=1",
                      (payload['requestId'], payload['configRevision'], payload['yamlSha256'], op, int(time.time())))
            c.commit()
            self._audit(c, 'model_config_apply_request', actor=actor,
                        revision=payload['configRevision'], requestId=payload['requestId'], operation=op)
            worker = threading.Thread(target=self._run, args=(db_path, payload),
                                      name='model-config-apply', daemon=True)
            self._workers[db_path] = worker
            try:
                worker.start()
            except Exception:
                self._workers.pop(db_path, None)
                c.execute("update model_config_state set apply_state='unknown',last_error_code='apply_unavailable' where id=1")
                c.commit()
                raise ServiceError('apply_unavailable', 503) from None
        return {'ok': True, 'requestId': payload['requestId']}

    def _run(self, db_path, payload):
        def accepted(frame):
            if any(frame.get(k) != payload[k] for k in ('requestId', 'op', 'configRevision', 'yamlSha256')):
                return
            if os.path.abspath(self.host.DB) != db_path:
                return
            with self.host._LC_FILES_LOCK, closing(self.host.connect()) as c:
                c.execute("update model_config_state set apply_state='applying',updated=? where id=1 and apply_request_id=? and apply_state='queued'",
                          (int(time.time()), payload['requestId']))
                c.commit()
        try:
            result = self._request(payload, on_accepted=accepted, timeout=420)
            if os.path.abspath(self.host.DB) == db_path:
                with self.host._LC_FILES_LOCK, closing(self.host.connect()) as c:
                    self._finish(c, result)
                    c.execute("update model_config_state set apply_state='unknown',last_error_code='apply_result_mismatch' where id=1 and apply_request_id=? and apply_state in ('queued','applying')",
                              (payload['requestId'],))
                    c.commit()
        except Exception:
            if os.path.abspath(self.host.DB) == db_path:
                try:
                    with self.host._LC_FILES_LOCK, closing(self.host.connect()) as c:
                        c.execute("update model_config_state set apply_state=case when apply_revision=(select revision from endpoint_binding where id=1) then 'unknown' else 'persisted_unapplied' end,last_error_code='apply_unavailable',updated=? where id=1 and apply_request_id=?",
                                  (int(time.time()), payload['requestId']))
                        c.commit()
                except Exception:
                    pass
        finally:
            with self._guard:
                self._workers.pop(db_path, None)

    @contextmanager
    def _private_dir(self):
        root = Path(self.state_dir)
        for parent in (root,) + tuple(root.parents):
            info = parent.lstat()
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise ServiceError('last_good_unavailable', 503)
        if os.name == 'posix' and root.stat().st_mode & 0o022:
            raise ServiceError('last_good_unavailable', 503)
        directory = root / 'model-last-good'
        directory.mkdir(mode=0o700, exist_ok=True)
        info = directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
                or getattr(info, 'st_file_attributes', 0) & 0x400
                or (os.name == 'posix' and (stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.getuid()))):
            raise ServiceError('last_good_unavailable', 503)
        fd = None
        if os.name == 'posix':
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            if os.fstat(fd).st_ino != info.st_ino:
                os.close(fd)
                raise ServiceError('last_good_unavailable', 503)
        try:
            yield directory, fd
        finally:
            if fd is not None:
                os.close(fd)

    def _key_file(self, name=None, value=None):
        # Immutable names let the DB pointer commit atomically. A crash can leave
        # a private orphan, never a last-good row pointing to the next Key.
        name = name or secrets.token_hex(16) + '.key'
        if re.fullmatch(r'[0-9a-f]{32}\.key', name) is None:
            raise ServiceError('last_good_unavailable', 503)
        with self._private_dir() as (directory, dir_fd):
            flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL) if value is not None else os.O_RDONLY
            flags |= getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_BINARY', 0)
            path = name if dir_fd is not None else directory / name
            if value is None and (directory / name).is_symlink():
                raise ServiceError('last_good_unavailable', 503)
            fd = os.open(path, flags, 0o600, **({'dir_fd': dir_fd} if dir_fd is not None else {}))
            try:
                info = os.fstat(fd)
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                        or (os.name == 'posix' and (stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid()))):
                    raise ServiceError('last_good_unavailable', 503)
                if value is not None:
                    raw = config.validate_key(value).encode('ascii')
                    view = memoryview(raw)
                    while view:
                        written = os.write(fd, view)
                        if written <= 0:
                            raise OSError()
                        view = view[written:]
                    os.fsync(fd)
                    if dir_fd is not None:
                        os.fsync(dir_fd)
                    return name
                return config.validate_key(os.read(fd, 513).decode('ascii'))
            finally:
                os.close(fd)

    def _finish(self, c, result):
        state = self._state(c)
        identity = {'requestId': state['apply_request_id'], 'configRevision': state['apply_revision'],
                    'yamlSha256': state['apply_yaml_sha'], 'op': state['apply_op']}
        if not isinstance(result, dict) or any(result.get(k) != v for k, v in identity.items()):
            return
        # Polling the same completed result must not rewrite private backups.
        if state['apply_state'] not in ('queued', 'applying', 'unknown', 'persisted_unapplied'):
            return
        row = self._binding(c)
        if row['revision'] != state['apply_revision']:
            c.execute("update model_config_state set apply_state='persisted_unapplied' where id=1")
            c.commit()
            return
        success = result.get('result') == ('verified_adopted' if state['apply_op'] == 'verify' else 'applied_healthy')
        error = None
        if success:
            snapshot = self._read()
            if (snapshot['marker'] != row['revision']
                    or hashlib.sha256(snapshot['yaml']).hexdigest() != state['apply_yaml_sha']
                    or row['state'] != 'ok'):
                success = False
                error = 'config_revision_mismatch'
            else:
                key_file = self._key_file(value=snapshot['key'])
                c.execute('''insert into model_last_good values(1,?,?,?,?,?,?)
                    on conflict(id) do update set revision=excluded.revision,base_url=excluded.base_url,
                    default_model=excluded.default_model,endpoint_name=excluded.endpoint_name,
                    key_file=excluded.key_file,at=excluded.at''',
                          (row['revision'], snapshot['baseURL'], snapshot['defaultModel'],
                           snapshot['endpointName'], key_file, int(time.time())))
                c.execute('''insert into model_last_good_standby values(1,?,?)
                    on conflict(id) do update set revision=excluded.revision,model=excluded.model''',
                          (row['revision'], snapshot['fallbackModel']))
                c.execute("update model_config_state set apply_state='applied_healthy',applied_revision=?,applied_yaml_sha=?,applied_at=?,changed_since_applied='[]',last_error_code=NULL,updated=? where id=1",
                          (row['revision'], state['apply_yaml_sha'], int(time.time()), int(time.time())))
        if not success:
            # Never persist arbitrary helper strings, which can contain secrets.
            known = {'compose_timeout', 'config_revision_mismatch', 'env_names_mismatch',
                     'image_baseline_mismatch', 'compose_env_changed', 'compose_env_overrides_key',
                     'busy', 'stale_revision', 'not_adopted', 'interrupted', 'rejected', 'failed'}
            error = error or (result.get('errorCode') if isinstance(result.get('errorCode'), str) and result.get('errorCode') in known else
                              result.get('result') if result.get('result') in known else 'apply_failed')
            c.execute("update model_config_state set apply_state='failed',last_error_code=?,updated=? where id=1",
                      (error, int(time.time())))
        c.commit()
        self._audit(c, 'model_config_apply_result', requestId=state['apply_request_id'],
                    revision=row['revision'], result='applied_healthy' if success else 'failed', errorCode=error)

    @_public
    def apply_status(self, c, actor):
        # Status is never a provider probe, and helper contention cannot turn an
        # active apply into failure. Socket waiting is capped at one second.
        db_path = os.path.abspath(self.host.DB)
        available = False
        try:
            reply = self._request({'v': 1, 'op': 'status'}, timeout=1)
            available = reply.get('available') is True
            if available and reply.get('last'):
                with self.host._LC_FILES_LOCK:
                    self._finish(c, reply['last'])
        except (apply_client.ApplyClientError, ServiceError, config.ConfigError, OSError):
            pass
        with self.host._LC_FILES_LOCK:
            state, row = self._state(c), self._binding(c)
            last = self._row(c, 'model_last_good')
            active = state['apply_state'] in ('queued', 'applying')
            with self._guard:
                active = active or db_path in self._workers
                if state['apply_state'] == 'applying' and db_path in self._workers:
                    available = True
            permitted = actor == self.host.EMAIL or set(json.loads(state['changed_since_applied'])).issubset({'defaultModel', 'fallbackModel', 'pilotModel'})
            result = {'state': state['apply_state'], 'configRevision': row['revision'],
                      'appliedRevision': state['applied_revision'],
                      'lastGoodRevision': last['revision'] if last else None,
                      'lastErrorCode': state['last_error_code'], 'helperAvailable': available,
                      'canApply': available and not active and permitted and row['state'] == 'ok',
                      'canRollback': available and not active and actor == self.host.EMAIL and
                                     bool(last and last['revision'] != row['revision'])}
            if state['apply_request_id']:
                result['operation'] = {'requestId': state['apply_request_id'], 'op': state['apply_op'],
                                       'configRevision': state['apply_revision']}
            return result

    @_public
    def rollback(self, c, data, actor):
        if actor != self.host.EMAIL:
            raise ServiceError('owner_required', 403)
        if not isinstance(data, dict):
            raise ServiceError('config_fields_invalid')
        with self.host._LC_FILES_LOCK:
            self._recover_before_read(c)
            self._expected(data, self._binding(c))
            self._check_write_guard(c)
            good = self._row(c, 'model_last_good')
            if not good or good['revision'] == data['expectedRevision']:
                raise ServiceError('rollback_unavailable', 409)
        target = self._target(good['base_url'], resolve=True)
        with self.host._LC_FILES_LOCK, self._file_lock():
            self._check_write_guard(c)
            self._expected(data, self._binding(c))
            if self._row(c, 'model_last_good') != good:
                raise ServiceError('endpoint_stale', 409)
            with self._guard:
                if os.path.abspath(self.host.DB) in self._workers:
                    raise ServiceError('config_busy', 409)
            try:
                key = self._key_file(name=good['key_file'])
            except (OSError, UnicodeError):
                raise ServiceError('last_good_unavailable', 503) from None
            standby = c.execute('select model from model_last_good_standby where id=1 and revision=?',
                                (good['revision'],)).fetchone()
            saved = self._save_locked(c, {'expectedRevision': data['expectedRevision'],
                                         'baseURL': target.base, 'defaultModel': good['default_model'],
                                         'fallbackModel': standby['model'] if standby else '',
                                         'apiKey': key}, actor, target)
            self._audit(c, 'model_config_rollback', actor=actor, revision=saved['revision'],
                        lastGoodRevision=good['revision'])
            queued = self._queue(c, self._read(), actor, 'apply')
            return dict(queued, revision=saved['revision'])
