"""Secret-free SQLite media control plane. No network, dispatch or legacy imports.

The host authenticates actors/consumers and supplies code-owned protocol allowlists.
Activation is opt-in and requires imported live evidence; fixtures never authorize it.
"""

from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
import re
import sqlite3
import time
from urllib.parse import urlsplit

SCHEMA = 'qyos.media-control-config.v1'
TARGETS = {
    'text_edit': ('image.text_edit.ocr', 'image.text_edit.erase'),
    'video.t2v': ('video.t2v',),
    'video.i2v.first_frame': ('video.i2v.first_frame',),
    'video.i2v.first_last': ('video.i2v.first_last',),
}
_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:\-]{0,127}\Z')
_MODEL = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,127}\Z')
_DIGEST = re.compile(r'[a-f0-9]{64}\Z')
_ACTOR = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,253}\Z')

# Example candidates only. These names do not claim a deployed adapter or acceptance.
CANDIDATE_ADAPTERS = {
    name: {'operations': ['video.t2v'], 'models': ['wan2.7-t2v'],
           'parameters': {'resolution': ['720P', '1080P'], 'duration': [2, 3, 4, 5]}}
    for name in ('candidate-video-client@1', 'candidate-video-gateway@1')
}


class MediaError(ValueError):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)


def _id(value):
    if type(value) is not str or not _ID.fullmatch(value):
        raise MediaError('invalid_identifier')
    return value


def _revision(value):
    if type(value) is not int or not 0 <= value < 2**63 - 2:
        raise MediaError('invalid_revision')
    return value


def _fields(value, required):
    if type(value) is not dict or set(value) != set(required):
        raise MediaError('invalid_fields')


def _json(value):
    try:
        encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)
        if len(encoded.encode('utf-8')) > 131072:
            raise MediaError('config_too_large')
        return encoded
    except (TypeError, ValueError, RecursionError):
        raise MediaError('invalid_json') from None


def _digest(value):
    return hashlib.sha256(_json(value).encode('utf-8')).hexdigest()


def _digest_value(value):
    if type(value) is not str or not _DIGEST.fullmatch(value):
        raise MediaError('invalid_digest')
    return value


def _enum(values):
    if type(values) is not list or not 1 <= len(values) <= 256:
        raise MediaError('invalid_enum')
    for value in values:
        if type(value) is str:
            _id(value)
        elif type(value) not in (bool, int) or (type(value) is int and abs(value) > 10**9):
            raise MediaError('invalid_enum')
    if len({_json(x) for x in values}) != len(values):
        raise MediaError('invalid_enum')
    return values


def _contains(values, value):
    return any(type(value) is type(item) and value == item for item in values)


def _parameter_name(value):
    _id(value)
    if re.sub(r'[^a-z]', '', value.lower()) in {
            'apikey', 'apikeyfile', 'password', 'secret', 'token', 'authorization',
            'credential', 'credentialmaterial', 'credentialref', 'credentialgeneration'}:
        raise MediaError('secret_parameter_forbidden')
    return value


def _target(value):
    if type(value) is not str or value not in TARGETS:
        raise MediaError('invalid_target')
    return value


@contextmanager
def _tx(c, *, write=True):
    if c.in_transaction:
        raise MediaError('transaction_already_open', 409)
    try:
        c.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
        yield
        c.commit()
    except sqlite3.Error:
        c.rollback()
        raise MediaError('storage_unavailable', 503) from None
    except BaseException:
        c.rollback()
        raise


def _authorize(callback, c, actor, action, target):
    if type(actor) is not str or not _ACTOR.fullmatch(actor):
        raise MediaError('invalid_actor')
    if callback is not None:
        try:
            accepted = callback(c, actor, action, target) is True
        except Exception:
            raise MediaError('authorization_unavailable', 503) from None
        if not accepted:
            raise MediaError('forbidden', 403)


def init_db(c):
    with _tx(c):
        statements = (
            'CREATE TABLE IF NOT EXISTS media_state (target TEXT PRIMARY KEY, revision INTEGER NOT NULL, draft TEXT, active_id INTEGER)',
            'CREATE TABLE IF NOT EXISTS media_publications (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, config TEXT NOT NULL, digest TEXT NOT NULL, required TEXT NOT NULL, state TEXT NOT NULL, epoch INTEGER, revoked INTEGER NOT NULL DEFAULT 0, was_active INTEGER NOT NULL DEFAULT 0)',
            'CREATE TABLE IF NOT EXISTS media_consumers (publication_id INTEGER NOT NULL, consumer TEXT NOT NULL, prepared TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(publication_id,consumer))',
            'CREATE TABLE IF NOT EXISTS media_acceptance (id INTEGER PRIMARY KEY, target TEXT NOT NULL, digest TEXT NOT NULL, evidence TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL)',
            'CREATE TABLE IF NOT EXISTS media_audit (id INTEGER PRIMARY KEY, target TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, publication_id INTEGER, at INTEGER NOT NULL)',
        )
        for statement in statements:
            c.execute(statement)


class Service:
    def __init__(self, *, trusted_origins, adapters, activation_enabled=False, authorized=None):
        if type(activation_enabled) is not bool or (authorized is not None and not callable(authorized)):
            raise MediaError('invalid_service_options')
        if not isinstance(trusted_origins, (list, tuple, set, frozenset)):
            raise MediaError('invalid_origins')
        self.trusted_origins = frozenset(self._origin(x) for x in trusted_origins)
        if type(adapters) is not dict:
            raise MediaError('invalid_adapters')
        self.adapters = deepcopy(adapters)
        for key, spec in self.adapters.items():
            if type(key) is not str or key.count('@') != 1:
                raise MediaError('invalid_adapter')
            for part in key.split('@'):
                _id(part)
            _fields(spec, ('operations', 'models', 'parameters'))
            if type(spec['operations']) is not list or not spec['operations'] or any(
                    x not in sum(TARGETS.values(), ()) for x in spec['operations']):
                raise MediaError('invalid_adapter')
            self._models(spec['models'])
            if type(spec['parameters']) is not dict:
                raise MediaError('invalid_adapter')
            for name, values in spec['parameters'].items():
                _parameter_name(name)
                _enum(values)
        self.activation_enabled = activation_enabled
        self.authorized = authorized

    @staticmethod
    def _origin(value):
        if type(value) is not str or len(value) > 253:
            raise MediaError('invalid_origin')
        try:
            parsed = urlsplit(value)
            if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                    or parsed.path or parsed.query or parsed.fragment or '\\' in value
                    or any(ord(ch) <= 32 or ord(ch) >= 127 for ch in value)
                    or parsed.port == 0):
                raise ValueError()
        except ValueError:
            raise MediaError('invalid_origin') from None
        return value

    @staticmethod
    def _models(values):
        if (type(values) is not list or not 1 <= len(values) <= 32
                or any(type(x) is not str or not _MODEL.fullmatch(x) for x in values)
                or len(set(values)) != len(values)):
            raise MediaError('invalid_models')

    def validate_config(self, target, config):
        _target(target)
        _fields(config, ('connections', 'bindings'))
        _json(config)
        connections, bindings = config['connections'], config['bindings']
        if type(connections) is not list or not 1 <= len(connections) <= 16:
            raise MediaError('invalid_connections')
        by_id = {}
        for entry in connections:
            _fields(entry, ('connectionId', 'providerFamily', 'origin', 'region', 'workspace',
                            'credentialRef', 'credentialGeneration'))
            for field in ('connectionId', 'providerFamily', 'region', 'workspace', 'credentialRef'):
                _id(entry[field])
            if not entry['credentialRef'].startswith('cred:') or len(entry['credentialRef']) <= 5:
                raise MediaError('invalid_credential_reference')
            if _revision(entry['credentialGeneration']) < 1:
                raise MediaError('invalid_credential_generation')
            if self._origin(entry['origin']) not in self.trusted_origins:
                raise MediaError('origin_not_trusted')
            if entry['connectionId'] in by_id:
                raise MediaError('duplicate_connection')
            by_id[entry['connectionId']] = entry
        if type(bindings) is not list or len(bindings) != len(TARGETS[target]):
            raise MediaError('incomplete_bundle')
        operations, used, enabled = set(), set(), set()
        for binding in bindings:
            _fields(binding, ('operation', 'connectionId', 'clientAdapter', 'serverAdapter',
                              'allowedModels', 'defaultModel', 'enabled', 'parameters'))
            operation = _id(binding['operation'])
            if operation not in TARGETS[target] or operation in operations:
                raise MediaError('incomplete_bundle')
            operations.add(operation)
            if _id(binding['connectionId']) not in by_id:
                raise MediaError('connection_missing')
            used.add(binding['connectionId'])
            if type(binding['enabled']) is not bool:
                raise MediaError('invalid_enabled')
            enabled.add(binding['enabled'])
            self._models(binding['allowedModels'])
            if binding['defaultModel'] not in binding['allowedModels']:
                raise MediaError('invalid_default_model')
            specs = []
            for field in ('clientAdapter', 'serverAdapter'):
                descriptor = binding[field]
                _fields(descriptor, ('id', 'version'))
                key = _id(descriptor['id']) + '@' + _id(descriptor['version'])
                spec = self.adapters.get(key)
                if (spec is None or operation not in spec['operations'] or
                        not set(binding['allowedModels']).issubset(spec['models'])):
                    raise MediaError('adapter_incompatible')
                specs.append(spec)
            parameters = binding['parameters']
            _fields(parameters, binding['allowedModels'])
            for policy in parameters.values():
                _fields(policy, ('allowed', 'defaults', 'fixed'))
                allowed, defaults, fixed = policy['allowed'], policy['defaults'], policy['fixed']
                if any(type(x) is not dict for x in (allowed, defaults, fixed)):
                    raise MediaError('invalid_parameters')
                if set(defaults) != set(allowed) or set(allowed) & set(fixed):
                    raise MediaError('invalid_parameters')
                for name, values in allowed.items():
                    _parameter_name(name)
                    _enum(values)
                    if not _contains(values, defaults[name]):
                        raise MediaError('invalid_parameter_default')
                for name in set(allowed) | set(fixed):
                    _parameter_name(name)
                    values = allowed[name] if name in allowed else _enum([fixed[name]])
                    if any(name not in spec['parameters'] or any(
                            not _contains(spec['parameters'][name], v) for v in values) for spec in specs):
                        raise MediaError('parameter_not_supported')
        if len(enabled) != 1:
            raise MediaError('incomplete_bundle')
        if used != set(by_id):
            raise MediaError('unused_connection')
        return deepcopy(config)

    @staticmethod
    def _state(c, target):
        row = c.execute('SELECT revision,draft,active_id FROM media_state WHERE target=?', (target,)).fetchone()
        return row or (0, None, None)

    def _check(self, c, target, expected_revision, actor, action):
        _target(target)
        _revision(expected_revision)
        _authorize(self.authorized, c, actor, action, target)
        if self._state(c, target)[0] != expected_revision:
            raise MediaError('revision_conflict', 409)

    @staticmethod
    def _advance(c, target, actor, action, publication_id=None):
        c.execute('INSERT INTO media_state(target,revision) VALUES(?,0) ON CONFLICT(target) DO NOTHING', (target,))
        c.execute('UPDATE media_state SET revision=revision+1 WHERE target=?', (target,))
        revision = Service._state(c, target)[0]
        c.execute('INSERT INTO media_audit(target,revision,actor,action,publication_id,at) VALUES(?,?,?,?,?,?)',
                  (target, revision, actor, action, publication_id, int(time.time())))
        return revision

    @staticmethod
    def _publication(c, publication_id):
        if _revision(publication_id) < 1:
            raise MediaError('invalid_publication')
        row = c.execute('SELECT id,target,config,digest,required,state,epoch,revoked,was_active FROM media_publications WHERE id=?',
                        (publication_id,)).fetchone()
        if row is None:
            raise MediaError('publication_missing', 404)
        return {'publicationId': row[0], 'target': row[1], 'config': json.loads(row[2]),
                'digest': row[3], 'requiredConsumers': json.loads(row[4]), 'state': row[5],
                'epoch': row[6], 'revoked': bool(row[7]), 'wasActive': bool(row[8]),
                'consumers': [{'consumer': r[0], 'prepared': r[1], 'acked': bool(r[2])}
                              for r in c.execute('SELECT consumer,prepared,acked FROM media_consumers WHERE publication_id=? ORDER BY consumer', (publication_id,))]}

    def _result(self, c, target, publication_id=None):
        revision, raw, active_id = self._state(c, target)
        draft = json.loads(raw) if raw else None
        if publication_id is None:
            row = c.execute('SELECT MAX(id) FROM media_publications WHERE target=?', (target,)).fetchone()
            publication_id = row[0]
        publication = self._publication(c, publication_id) if publication_id else None
        active = self._publication(c, active_id) if active_id else None
        available = bool(active and active['state'] == 'active' and not active['revoked'] and
                         all(x['enabled'] for x in active['config']['bindings']))
        return {'schema': SCHEMA, 'target': target, 'revision': revision, 'draft': draft,
                'draftDigest': _digest(draft) if draft else None, 'publication': publication,
                'activePublicationId': active_id, 'activeEpoch': active['epoch'] if active else None,
                'available': available}

    def status(self, c, target):
        _target(target)
        with _tx(c, write=False):
            return self._result(c, target)

    def save_draft(self, c, target, config, expected_revision, actor):
        checked = self.validate_config(target, config)
        with _tx(c):
            self._check(c, target, expected_revision, actor, 'save_draft')
            self._advance(c, target, actor, 'save_draft')
            c.execute('UPDATE media_state SET draft=? WHERE target=?', (_json(checked), target))
            return self._result(c, target)

    def record_acceptance(self, c, target, evidence, expected_revision, actor):
        _fields(evidence, ('operation', 'model', 'configDigest', 'testCase', 'receiptRef',
                           'environment', 'completed', 'qualityAccepted', 'observedAt'))
        _digest_value(evidence['configDigest'])
        for field in ('operation', 'testCase', 'receiptRef'):
            _id(evidence[field])
        if (evidence['environment'] not in ('fixture', 'live') or
                type(evidence['completed']) is not bool or type(evidence['qualityAccepted']) is not bool):
            raise MediaError('invalid_evidence')
        if not 0 < _revision(evidence['observedAt']) <= int(time.time()):
            raise MediaError('invalid_evidence_time')
        with _tx(c):
            self._check(c, target, expected_revision, actor, 'record_acceptance')
            raw = self._state(c, target)[1]
            if raw is None:
                raise MediaError('draft_missing', 409)
            draft = json.loads(raw)
            if _digest(draft) != evidence['configDigest']:
                raise MediaError('evidence_digest_conflict', 409)
            if not any(b['operation'] == evidence['operation'] and evidence['model'] in b['allowedModels']
                       for b in draft['bindings']):
                raise MediaError('evidence_scope_invalid')
            c.execute('INSERT INTO media_acceptance(target,digest,evidence,actor,at) VALUES(?,?,?,?,?)',
                      (target, evidence['configDigest'], _json(evidence), actor, int(time.time())))
            self._advance(c, target, actor, 'record_acceptance')
            return self._result(c, target)

    def _prepare(self, c, target, config, required_consumers, actor):
        if type(required_consumers) is not list or not 1 <= len(required_consumers) <= 16:
            raise MediaError('invalid_consumers')
        for consumer in required_consumers:
            _id(consumer)
        if len(set(required_consumers)) != len(required_consumers):
            raise MediaError('invalid_consumers')
        checked = self.validate_config(target, config)
        digest = _digest(checked)
        if c.execute('SELECT 1 FROM media_publications WHERE target=? AND digest=? AND revoked=1',
                     (target, digest)).fetchone():
            raise MediaError('publication_revoked', 409)
        pid = c.execute('INSERT INTO media_publications(target,config,digest,required,state) VALUES(?,?,?,?,?)',
                        (target, _json(checked), digest, _json(sorted(required_consumers)), 'prepared')).lastrowid
        c.executemany('INSERT INTO media_consumers(publication_id,consumer,prepared) VALUES(?,?,?)',
                      [(pid, x, 'pending') for x in required_consumers])
        self._advance(c, target, actor, 'prepare', pid)
        return self._result(c, target, pid)

    def prepare(self, c, target, required_consumers, expected_revision, actor):
        with _tx(c):
            self._check(c, target, expected_revision, actor, 'prepare')
            raw = self._state(c, target)[1]
            if raw is None:
                raise MediaError('draft_missing', 409)
            return self._prepare(c, target, json.loads(raw), required_consumers, actor)

    def consumer_prepared(self, c, publication_id, consumer, digest, accepted, expected_revision, actor):
        _id(consumer)
        _digest_value(digest)
        if type(accepted) is not bool:
            raise MediaError('invalid_prepared')
        with _tx(c):
            pub = self._publication(c, publication_id)
            self._check(c, pub['target'], expected_revision, actor, 'consumer_prepared')
            if consumer not in pub['requiredConsumers']:
                raise MediaError('consumer_not_required', 403)
            if pub['state'] != 'prepared' or pub['revoked']:
                raise MediaError('publication_state_conflict', 409)
            verdict = 'prepared' if accepted and digest == pub['digest'] else 'rejected'
            c.execute('UPDATE media_consumers SET prepared=? WHERE publication_id=? AND consumer=?',
                      (verdict, publication_id, consumer))
            if verdict == 'rejected':
                c.execute("UPDATE media_publications SET state='rejected' WHERE id=?", (publication_id,))
            self._advance(c, pub['target'], actor, 'consumer_prepared', publication_id)
            return self._result(c, pub['target'], publication_id)

    @staticmethod
    def _accepted(c, pub):
        evidence = [json.loads(r[0]) for r in c.execute(
            'SELECT evidence FROM media_acceptance WHERE target=? AND digest=? ORDER BY id',
            (pub['target'], pub['digest']))]
        latest = {}
        for item in evidence:
            if item['environment'] == 'live':
                latest[(item['operation'], item['model'], item['testCase'])] = item
        for binding in pub['config']['bindings']:
            if not binding['enabled']:
                continue
            for model in binding['allowedModels']:
                cases = [e for (op, m, _), e in latest.items() if op == binding['operation'] and m == model]
                if not cases or not all(e['completed'] and e['qualityAccepted'] for e in cases):
                    raise MediaError('acceptance_required', 409)

    def activate(self, c, publication_id, expected_revision, actor):
        with _tx(c):
            pub = self._publication(c, publication_id)
            target = pub['target']
            self._check(c, target, expected_revision, actor, 'activate')
            if not self.activation_enabled:
                raise MediaError('runtime_contract_unconfirmed', 503)
            if pub['state'] != 'prepared' or pub['revoked']:
                raise MediaError('publication_state_conflict', 409)
            if not pub['consumers'] or not all(x['prepared'] == 'prepared' for x in pub['consumers']):
                raise MediaError('consumers_not_prepared', 409)
            self.validate_config(target, pub['config'])
            self._accepted(c, pub)
            previous = self._state(c, target)[2]
            epoch = self._advance(c, target, actor, 'activate', publication_id)
            if previous:
                c.execute("UPDATE media_publications SET state='superseded' WHERE id=? AND state IN ('active','activating')", (previous,))
            c.execute("UPDATE media_publications SET state='activating',epoch=? WHERE id=?", (epoch, publication_id))
            c.execute('UPDATE media_state SET active_id=? WHERE target=?', (publication_id, target))
            return self._result(c, target, publication_id)

    def ack(self, c, publication_id, consumer, digest, epoch, expected_revision, actor):
        _id(consumer)
        _digest_value(digest)
        _revision(epoch)
        with _tx(c):
            pub = self._publication(c, publication_id)
            target = pub['target']
            self._check(c, target, expected_revision, actor, 'ack')
            if consumer not in pub['requiredConsumers']:
                raise MediaError('consumer_not_required', 403)
            if self._state(c, target)[2] != publication_id or pub['state'] not in ('activating', 'active') or pub['revoked']:
                raise MediaError('publication_state_conflict', 409)
            if digest != pub['digest'] or epoch != pub['epoch']:
                c.execute("UPDATE media_publications SET state='disabled' WHERE id=?", (publication_id,))
                c.execute('UPDATE media_consumers SET acked=0 WHERE publication_id=?', (publication_id,))
            else:
                c.execute('UPDATE media_consumers SET acked=1 WHERE publication_id=? AND consumer=?', (publication_id, consumer))
                if not c.execute('SELECT 1 FROM media_consumers WHERE publication_id=? AND acked=0', (publication_id,)).fetchone():
                    c.execute("UPDATE media_publications SET state='active',was_active=1 WHERE id=?", (publication_id,))
            self._advance(c, target, actor, 'ack', publication_id)
            return self._result(c, target, publication_id)

    def revoke(self, c, publication_id, expected_revision, actor):
        with _tx(c):
            pub = self._publication(c, publication_id)
            self._check(c, pub['target'], expected_revision, actor, 'revoke')
            # All identical snapshots are unusable, including an already-prepared rollback.
            c.execute("UPDATE media_publications SET revoked=1,state='revoked' WHERE target=? AND digest=?",
                      (pub['target'], pub['digest']))
            self._advance(c, pub['target'], actor, 'revoke', publication_id)
            return self._result(c, pub['target'], publication_id)

    def rollback(self, c, target, publication_id, required_consumers, expected_revision, actor):
        with _tx(c):
            self._check(c, target, expected_revision, actor, 'rollback')
            pub = self._publication(c, publication_id)
            if pub['target'] != target or pub['revoked'] or not pub['wasActive']:
                raise MediaError('rollback_unavailable', 409)
            return self._prepare(c, target, pub['config'], required_consumers, actor)
