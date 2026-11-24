"""Managed LibreChat YAML and recoverable, inode-preserving two-file saves.

Snapshots contain secrets: keep them in memory, never log or serialize them.
The caller owns both file locks, authorization, DNS policy and revision CAS.
persist/recover require a connection with no outstanding transaction. The commit
callback may update that connection but must not commit, roll back or close it.
Only private backup files contain configuration bytes; SQLite stores metadata.
Paths are trusted application configuration, never values from an HTTP request.
"""

import copy
import hashlib
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import sys
import secrets
import time
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent / 'vendor'))
from ruamel.yaml import YAML
from ruamel.yaml.events import AliasEvent
from ruamel.yaml.scalarstring import DoubleQuotedScalarString as Quoted


MAX_YAML = 256 * 1024
MAX_ENV = 64 * 1024
MANAGED_KEY = '${ZHITOUZHUAN_API_KEY}'
MANAGED_NAME = 'qyos-models'
PILOT_NAME = 'qyos-chat-pilot'
PILOT_KEY = '${QYOS_CHAT_PILOT_BRIDGE_SECRET}'
PILOT_BASE = 'http://host.docker.internal:3290/pilot-chat/v1'
PILOT_HEADERS = {'X-OS-Access-Token': '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}'}
KEY_NAME = 'ZHITOUZHUAN_API_KEY'
MODEL_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,127}\Z')
PILOT_MODEL_RE = MODEL_RE
KEY_RE = re.compile(r'[A-Za-z0-9._~+/=:\-]{8,512}\Z')
_MARKER = '# qyos-jadmin-config-revision:'
_POSIX = os.name == 'posix'


class ConfigError(ValueError):
    def __init__(self, code, status=400):
        self.code = code
        self.status = status
        super().__init__(code)


def _yaml(kind='safe'):
    parser = YAML(typ=kind, pure=True)
    parser.allow_duplicate_keys = False
    parser.preserve_quotes = True
    parser.width = 4096
    return parser


def _decode(raw, limit, code):
    if not isinstance(raw, bytes) or len(raw) > limit:
        raise ConfigError(code)
    try:
        text = raw.decode('utf-8')
    except UnicodeError:
        raise ConfigError(code) from None
    if '\x00' in text or text.startswith('\ufeff'):
        raise ConfigError(code)
    return text


def _document(raw, kind='safe'):
    text = _decode(raw, MAX_YAML, 'yaml_malformed')
    lines = text.splitlines(keepends=True)
    markers = [i for i, line in enumerate(lines)
               if re.match(r'\s*#\s*qyos-jadmin-config-revision\b', line)]
    marker = None
    if markers:
        if markers != [0] or not re.fullmatch(
                r'# qyos-jadmin-config-revision: (0|[1-9][0-9]{0,18})\r?\n?', lines[0]):
            raise ConfigError('yaml_malformed')
        marker = int(lines.pop(0).split(':', 1)[1].strip())
        if marker > 2**63 - 1:
            raise ConfigError('yaml_malformed')
    text = ''.join(lines)
    try:
        depth = count = 0
        for event in _yaml().parse(text):
            count += 1
            if isinstance(event, AliasEvent) or getattr(event, 'anchor', None):
                raise ConfigError('yaml_malformed')
            if event.__class__.__name__ in ('MappingStartEvent', 'SequenceStartEvent'):
                depth += 1
            elif event.__class__.__name__ in ('MappingEndEvent', 'SequenceEndEvent'):
                depth -= 1
            if depth > 64 or count > 65536:
                raise ConfigError('yaml_malformed')
        # Always run the safe loader, including when a round-trip tree is wanted.
        doc = _yaml().load(text)
        _structure(doc)
        if kind == 'rt':
            doc = _yaml('rt').load(text)
        return doc, marker
    except ConfigError:
        raise
    except Exception:
        # Parser errors may quote a line containing an unrelated literal secret.
        raise ConfigError('yaml_malformed') from None


def _structure(doc):
    if not isinstance(doc, dict) or 'version' not in doc:
        raise ConfigError('yaml_malformed')
    if not isinstance(doc['version'], (str, int, float)) or isinstance(doc['version'], bool):
        raise ConfigError('yaml_malformed')
    if 'endpoints' not in doc:
        return
    endpoints = doc['endpoints']
    if not isinstance(endpoints, dict):
        raise ConfigError('yaml_malformed')
    if 'custom' not in endpoints:
        return
    if not isinstance(endpoints['custom'], list):
        raise ConfigError('yaml_malformed')
    for entry in endpoints['custom']:
        if not isinstance(entry, dict):
            raise ConfigError('yaml_malformed')
        for field in ('name', 'apiKey', 'baseURL'):
            if field in entry and not isinstance(entry[field], str):
                raise ConfigError('yaml_malformed')
        if 'headers' in entry and not isinstance(entry['headers'], dict):
            raise ConfigError('yaml_malformed')
        if 'models' in entry:
            models = entry['models']
            if not isinstance(models, dict):
                raise ConfigError('yaml_malformed')
            if 'fetch' in models and type(models['fetch']) is not bool:
                raise ConfigError('yaml_malformed')
            if 'default' in models and (not isinstance(models['default'], list)
                    or any(not isinstance(x, str) for x in models['default'])):
                raise ConfigError('yaml_malformed')


def _bridge(url):
    try:
        host = (urlsplit(url).hostname or '').lower().rstrip('.')
        if host in ('host.docker.internal', 'gateway.docker.internal', 'localhost',
                    'os-bridge', 'bridge') or host.endswith(('.internal', '.localhost')):
            return True
        if host and '.' not in host and ':' not in host:
            return True
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            return False
        return not address.is_global
    except ValueError:
        raise ConfigError('yaml_malformed') from None


def _token_header(value):
    if isinstance(value, str):
        return '{{LIBRECHAT_' in value
    if isinstance(value, dict):
        return any(str(k).lower() == 'x-os-access-token' or _token_header(v)
                   for k, v in value.items())
    if isinstance(value, list):
        return any(_token_header(v) for v in value)
    return False


def _managed(doc):
    entries = doc.get('endpoints', {}).get('custom', [])
    matches = [entry for entry in entries if entry.get('apiKey') == MANAGED_KEY]
    if len(matches) > 1:
        raise ConfigError('managed_endpoint_ambiguous')
    managed = matches[0] if matches else None
    if any(e.get('name') == MANAGED_NAME and e is not managed for e in entries):
        raise ConfigError('endpoint_name_conflict')
    if managed is not None:
        if not managed.get('name'):
            raise ConfigError('yaml_malformed')
        if any(e is not managed and e.get('name') == managed['name'] for e in entries):
            raise ConfigError('endpoint_name_conflict')
        if _bridge(managed.get('baseURL', '')) or _token_header(managed.get('headers')):
            raise ConfigError('legacy_endpoint_requires_maintenance')
    return managed


def _env(raw):
    text = _decode(raw, MAX_ENV, 'env_malformed')
    if (re.search(r'\r(?!\n)', text) or any(
            (ord(c) < 32 and c not in '\t\r\n') or c in '\x7f\x85\u2028\u2029' for c in text)):
        raise ConfigError('env_malformed')
    values = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        if not match:
            raise ConfigError('env_malformed')
        name, value = match.groups()
        if name == KEY_NAME and name in values:
            raise ConfigError('env_duplicate_key')
        values[name] = value
    return text, values


def _pilot(doc):
    entries = doc.get('endpoints', {}).get('custom', [])
    matches = [entry for entry in entries if entry.get('name') == PILOT_NAME
               or entry.get('apiKey') == PILOT_KEY]
    if len(matches) > 1:
        raise ConfigError('pilot_endpoint_ambiguous', 409)
    if not matches:
        raise ConfigError('pilot_endpoint_absent', 409)
    entry = matches[0]
    models = entry.get('models', {})
    default = models.get('default', [])
    if (set(entry) - {'name', 'apiKey', 'baseURL', 'headers', 'models', 'titleConvo', 'modelDisplayLabel'}
            or entry.get('name') != PILOT_NAME or entry.get('apiKey') != PILOT_KEY
            or entry.get('baseURL') != PILOT_BASE or entry.get('headers') != PILOT_HEADERS
            or entry.get('titleConvo') is not False
            or set(models) != {'default', 'fetch'} or models.get('fetch') is not False
            or len(default) != 1 or not PILOT_MODEL_RE.fullmatch(default[0])):
        raise ConfigError('pilot_endpoint_unexpected', 409)
    return entry


def _snapshot(yaml_raw, env_raw):
    doc, marker = _document(yaml_raw)
    entry = _managed(doc)
    _, values = _env(env_raw)
    endpoints = values.get('ENDPOINTS')
    warning = endpoints is not None and 'custom' not in {
        x.strip() for x in endpoints.strip('\"\'').split(',')}
    defaults = entry.get('models', {}).get('default', []) if entry is not None else []
    try:
        pilot = {'pilotModel': _pilot(doc)['models']['default'][0], 'pilotError': None}
    except ConfigError as exc:
        # A drifted or absent pilot does not prevent independent regular edits.
        pilot = {'pilotModel': None, 'pilotError': exc.code}
    return {'yaml': yaml_raw, 'env': env_raw,
            'baseURL': entry.get('baseURL', '') if entry is not None else '',
            'defaultModel': defaults[0] if defaults else '',
            'fallbackModel': defaults[1] if len(defaults) == 2 and defaults[0] != defaults[1]
            and MODEL_RE.fullmatch(defaults[1]) else '',
            'endpointName': entry['name'] if entry is not None else '',
            'key': values.get(KEY_NAME, ''), 'marker': marker,
            'hasManaged': entry is not None, 'endpointsWarning': warning, **pilot}


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))


def _parents(path):
    for parent in Path(path).absolute().parents:
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise ConfigError('config_file_unsafe')
        if getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ConfigError('config_file_unsafe')


def _checked_open(path, flags, mode, owner_uid=None, expected=None):
    _parents(path)
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or getattr(before, 'st_file_attributes', 0) & 0x400:
        raise ConfigError('config_file_unsafe')
    fd = os.open(path, flags | getattr(os, 'O_NOFOLLOW', 0)
                 | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_BINARY', 0))
    try:
        info = os.fstat(fd)
        owner_uid = os.getuid() if owner_uid is None and _POSIX else owner_uid
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or _identity(info) != _identity(before)
                or (_POSIX and (info.st_uid != owner_uid or stat.S_IMODE(info.st_mode) != mode))
                or (expected is not None and _identity(info) != tuple(expected))):
            raise ConfigError('config_file_unsafe')
        return fd, _identity(info)
    except BaseException:
        os.close(fd)
        raise


def _read_file(path, limit, mode, owner_uid=None, expected=None):
    fd, identity = _checked_open(path, os.O_RDONLY, mode, owner_uid, expected)
    try:
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ConfigError('yaml_malformed' if limit == MAX_YAML else 'env_malformed')
        if _identity(os.lstat(path)) != identity:
            raise ConfigError('config_file_unsafe')
        return data, identity
    finally:
        os.close(fd)


def read_config(yaml_path, env_path, owner_uid=None):
    """Read validated files; absent managed entry and absent Key are valid."""
    try:
        y, yi = _read_file(yaml_path, MAX_YAML, 0o644, owner_uid)
        e, ei = _read_file(env_path, MAX_ENV, 0o600, owner_uid)
        if yi[:2] == ei[:2]:
            raise ConfigError('config_file_unsafe')
        result = _snapshot(y, e)
        result.update(_yaml_identity=yi, _env_identity=ei, _owner_uid=owner_uid)
        return result
    except ConfigError:
        raise
    except Exception:
        raise ConfigError('config_read_failed', 500) from None


def read_env(env_path, owner_uid=None):
    """Discovery-only read; does not open or parse YAML. Contains secrets."""
    try:
        raw, _ = _read_file(env_path, MAX_ENV, 0o600, owner_uid)
        _, values = _env(raw)
        endpoints = values.get('ENDPOINTS')
        return {'env': raw, 'key': values.get(KEY_NAME, ''),
                'endpointsWarning': endpoints is not None and 'custom' not in {
                    x.strip() for x in endpoints.strip('\"\'').split(',')}}
    except ConfigError:
        raise
    except Exception:
        raise ConfigError('config_read_failed', 500) from None


def validate_key(key):
    if not isinstance(key, str) or not KEY_RE.fullmatch(key):
        raise ConfigError('invalid_api_key')
    return key


def _base_url(value):
    if (not isinstance(value, str) or not value or len(value) > 4096
            or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value)
            or any(c in value for c in ('\\', '?', '#'))):
        raise ConfigError('invalid_base_url')
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in ('https', 'http') or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.port == 0 or parsed.netloc.endswith(':')):
            raise ValueError()
    except ValueError:
        raise ConfigError('invalid_base_url') from None
    if _bridge(value):
        raise ConfigError('legacy_endpoint_requires_maintenance')
    return value


def prepare(snapshot, base_url, default_model, api_key, revision, *, pilot_model=None, fallback_model=None):
    """Build/validate candidates without IO. None retains the existing value.

    base_url must already have passed the caller's parse/resolve_model_target.
    In particular this pure function performs no DNS queries or origin policy.
    """
    old = _snapshot(snapshot['yaml'], snapshot['env'])
    if type(revision) is not int or not 0 < revision <= 2**63 - 1:
        raise ConfigError('invalid_revision')
    base = _base_url(old['baseURL'] if base_url is None else base_url)
    model = old['defaultModel'] if default_model is None else default_model
    if not old['hasManaged'] and not model:
        raise ConfigError('first_setup_requires_default_model')
    if not isinstance(model, str) or not MODEL_RE.fullmatch(model):
        raise ConfigError('invalid_default_model')
    standby = old['fallbackModel'] if fallback_model is None else fallback_model
    if not isinstance(standby, str) or (standby and not MODEL_RE.fullmatch(standby)):
        raise ConfigError('invalid_fallback_model')
    if standby and standby == model:
        if fallback_model is not None:
            raise ConfigError('fallback_matches_default')
        standby = ''  # Promoting the standby should not duplicate the choice.
    models = [model, standby] if standby else [model]
    key = old['key'] if api_key is None else api_key
    validate_key(key)
    original, _ = _document(old['yaml'])
    doc, _ = _document(old['yaml'], 'rt')
    expected = copy.deepcopy(original)
    entry = _managed(doc)
    expected_entry = _managed(expected)
    if entry is None:
        entry = {'name': Quoted(MANAGED_NAME), 'apiKey': Quoted(MANAGED_KEY),
                 'baseURL': Quoted(base), 'models': {'default': [Quoted(x) for x in models], 'fetch': False},
                 'modelDisplayLabel': Quoted('\u4f01\u4e1a\u6a21\u578b')}
        doc.setdefault('endpoints', {}).setdefault('custom', []).append(entry)
        expected.setdefault('endpoints', {}).setdefault('custom', []).append(copy.deepcopy(entry))
    elif pilot_model is None:
        entry['baseURL'] = Quoted(base)
        entry.setdefault('models', {})['default'] = [Quoted(x) for x in models]
        expected_entry['baseURL'] = base
        expected_entry.setdefault('models', {})['default'] = models
    if pilot_model is not None:
        if (not old['hasManaged'] or base != old['baseURL'] or model != old['defaultModel']
                or key != old['key'] or standby != old['fallbackModel']):
            raise ConfigError('pilot_edit_must_be_independent', 409)
        if not isinstance(pilot_model, str) or not PILOT_MODEL_RE.fullmatch(pilot_model):
            raise ConfigError('invalid_default_model')
        current = _pilot(doc)['models']['default'][0]
        if current == pilot_model:
            raise ConfigError('pilot_model_unchanged', 409)
        _pilot(doc)['models']['default'][0] = pilot_model
        _pilot(expected)['models']['default'][0] = pilot_model
    output = io.StringIO()
    try:
        _yaml('rt').dump(doc, output)
        yaml_raw = (f'{_MARKER} {revision}\n' + output.getvalue()).encode('utf-8')
        actual, _ = _document(yaml_raw)
        if actual != expected:
            raise ConfigError('yaml_semantic_change')
    except ConfigError:
        raise
    except Exception:
        raise ConfigError('yaml_malformed') from None
    env_text, values = _env(old['env'])
    newline = '\r\n' if '\r\n' in env_text else '\n'
    line = KEY_NAME + '=' + key
    if KEY_NAME in values:
        env_text = re.sub(r'^ZHITOUZHUAN_API_KEY=[^\r\n]*', lambda _: line,
                          env_text, flags=re.MULTILINE)
    else:
        if env_text and not env_text.endswith(('\n', '\r')):
            env_text += newline
        env_text += line + newline
    result = _snapshot(yaml_raw, env_text.encode('utf-8'))
    if (result['baseURL'], result['defaultModel'], result['fallbackModel'], result['key'], result['marker']) != (
            base, model, standby, key, revision):
        raise ConfigError('config_candidate_invalid')
    if pilot_model is not None and result['pilotModel'] != pilot_model:
        raise ConfigError('config_candidate_invalid')
    for name in ('_yaml_identity', '_env_identity', '_owner_uid'):
        if name in snapshot:
            result[name] = snapshot[name]
    return result


def init_db(c):
    """Add the journal schema only; no configuration values belong in SQLite."""
    c.execute('''create table if not exists config_txn(
        txn_id text primary key,
        base_revision integer not null,
        env_included integer not null check(env_included in (0,1)),
        created integer not null,
        phase text not null check(phase in ('active','restore_failed')))''')
    if [row[1] for row in c.execute('pragma table_info(config_txn)')] != [
            'txn_id', 'base_revision', 'env_included', 'created', 'phase']:
        raise ConfigError('config_txn_schema_invalid', 500)


def _hash(data):
    return hashlib.sha256(data).hexdigest()


def _sync_dir(path):
    if _POSIX:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


class _TxnDir:
    """All POSIX snapshot operations are relative to a pinned directory fd.

    Windows lacks dir_fd and directory fsync; tests use checked absolute paths.
    Production always uses the POSIX branch, with no fallback after an error.
    """

    def __init__(self, state_dir):
        self.path = Path(state_dir).absolute() / 'txn'
        self.fd = None

    def __enter__(self):
        try:
            _parents(self.path)
            parent = self.path.parent.lstat()
            if _POSIX and parent.st_mode & 0o022:
                raise ConfigError('config_recovery_blocked', 500)
            try:
                self.path.mkdir(mode=0o700)
                _sync_dir(self.path.parent)
            except FileExistsError:
                pass
            info = self.path.lstat()
            if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
                    or getattr(info, 'st_file_attributes', 0) & 0x400
                    or (_POSIX and (info.st_uid != os.getuid() or info.st_mode & 0o077))):
                raise ConfigError('config_recovery_blocked', 500)
            self.identity = _identity(info)
            if _POSIX:
                self.fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY
                                  | os.O_NOFOLLOW | os.O_CLOEXEC)
                if _identity(os.fstat(self.fd)) != self.identity:
                    raise ConfigError('config_recovery_blocked', 500)
            self.names()  # Validate the entire directory before any mutation.
            return self
        except Exception:
            if self.fd is not None:
                os.close(self.fd)
                self.fd = None
            raise ConfigError('config_recovery_blocked', 500) from None

    def __exit__(self, *args):
        if self.fd is not None:
            os.close(self.fd)

    def _args(self, name):
        if not re.fullmatch(r'[0-9a-f]{32}\.(yaml|env|meta)', name):
            raise ConfigError('config_recovery_blocked', 500)
        if _identity(self.path.lstat()) != self.identity:
            raise ConfigError('config_recovery_blocked', 500)
        return (name, {'dir_fd': self.fd}) if _POSIX else (self.path / name, {})

    @staticmethod
    def _check_file(info):
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or getattr(info, 'st_file_attributes', 0) & 0x400
                or (_POSIX and (info.st_uid != os.getuid()
                               or stat.S_IMODE(info.st_mode) != 0o600))):
            raise ConfigError('config_recovery_blocked', 500)

    def names(self):
        names = os.listdir(self.fd if _POSIX else self.path)
        for name in names:
            path, kwargs = self._args(name)
            self._check_file(os.stat(path, follow_symlinks=False, **kwargs))
        return names

    def read(self, name, limit):
        path, kwargs = self._args(name)
        before = os.stat(path, follow_symlinks=False, **kwargs)
        self._check_file(before)
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                     | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NONBLOCK', 0)
                     | getattr(os, 'O_BINARY', 0), **kwargs)
        try:
            info = os.fstat(fd)
            self._check_file(info)
            if _identity(info) != _identity(before):
                raise ConfigError('config_recovery_blocked', 500)
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                raw = stream.read(limit + 1)
            if len(raw) > limit:
                raise ConfigError('config_recovery_blocked', 500)
            return raw
        finally:
            os.close(fd)

    def write(self, name, raw):
        path, kwargs = self._args(name)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                     | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
                     | getattr(os, 'O_BINARY', 0), 0o600, **kwargs)
        try:
            if _POSIX:
                os.fchmod(fd, 0o600)
            self._check_file(os.fstat(fd))
            _write_all(fd, raw)
            os.fsync(fd)
        finally:
            os.close(fd)
        if self.read(name, max(len(raw), 1)) != raw:
            raise ConfigError('config_backup_failed', 500)

    def sync(self):
        if _POSIX:
            os.fsync(self.fd)

    def unlink(self, names):
        # Check every entry before removing any, including after commit/crash.
        present = self.names()
        for name in names:
            if name in present:
                path, kwargs = self._args(name)
                os.unlink(path, **kwargs)
        self.sync()


def _write_all(fd, data):
    remaining = memoryview(data)
    while remaining:
        written = os.write(fd, remaining)
        if written <= 0:
            raise OSError('short write')
        remaining = remaining[written:]


def _write_in_place(path, raw, identity, mode, limit):
    fd, _ = _checked_open(path, os.O_WRONLY, mode, identity[2], identity)
    try:
        _write_all(fd, raw)
        os.ftruncate(fd, len(raw))
        os.fsync(fd)
    finally:
        os.close(fd)
    actual, _ = _read_file(path, limit, mode, identity[2], identity)
    if actual != raw:
        raise ConfigError('config_readback_failed', 500)


def _row(c):
    cursor = c.execute('select * from config_txn')
    rows = cursor.fetchmany(2)
    if len(rows) > 1:
        raise ConfigError('config_recovery_blocked', 500)
    return dict(zip([x[0] for x in cursor.description], rows[0])) if rows else None


def _txn_names(txn_id):
    if not isinstance(txn_id, str) or not re.fullmatch(r'[0-9a-f]{32}', txn_id):
        raise ConfigError('config_recovery_blocked', 500)
    return [txn_id + ext for ext in ('.yaml', '.env', '.meta')]


def _orphan_cleanup(directory, row):
    names = directory.names()
    active = set(_txn_names(row['txn_id'])) if row is not None else set()
    directory.unlink([name for name in names if name not in active])


def _cleanup(directory, names):
    # A completed transaction must not be rolled back because cleanup failed.
    try:
        directory.unlink(names)
    except (OSError, ConfigError):
        pass


def _pending(c):
    c.rollback()
    c.execute("update config_txn set phase='restore_failed'")
    c.execute("update endpoint_binding set state='pending' where id=1")
    c.commit()


def _restore(c, row, yaml_path, env_path, directory):
    """Keep the durable journal until both originals have been verified."""
    verified = False
    try:
        c.execute('BEGIN IMMEDIATE')
        binding = c.execute('select revision,state from endpoint_binding where id=1').fetchone()
        if binding is None or binding[0] != row['base_revision']:
            raise ConfigError('config_recovery_blocked', 500)
        names = _txn_names(row['txn_id'])
        meta = json.loads(directory.read(names[2], 8192))
        if (type(meta) is not dict or meta.get('v') != 1
                or any(meta.get(k) != row[k] for k in ('txn_id', 'base_revision', 'env_included'))
                or type(meta.get('yaml_size')) is not int
                or type(meta.get('env_size')) is not int
                or meta.get('binding_state') not in ('ok', 'pending', 'unbound')
                or not 0 <= meta['yaml_size'] <= MAX_YAML
                or not 0 <= meta['env_size'] <= MAX_ENV):
            raise ConfigError('config_recovery_blocked', 500)
        y = directory.read(names[0], MAX_YAML)
        e = directory.read(names[1], MAX_ENV) if row['env_included'] else None
        if len(y) != meta['yaml_size'] or (e is not None and len(e) != meta['env_size']):
            raise ConfigError('config_recovery_blocked', 500)
        for kind in ('yaml', 'env'):
            identity = meta.get(kind + '_identity')
            if not isinstance(identity, list) or len(identity) != 5 or any(type(x) is not int for x in identity):
                raise ConfigError('config_recovery_blocked', 500)
        failures = []
        for path, raw, kind, mode, limit in ((yaml_path, y, 'yaml', 0o644, MAX_YAML),
                                            (env_path, e, 'env', 0o600, MAX_ENV)):
            try:
                identity = meta[kind + '_identity']
                current, _ = _read_file(path, limit, mode, identity[2], identity)
                if raw is not None and current != raw:
                    _write_in_place(path, raw, identity, mode, limit)
            except Exception:
                failures.append(kind)
        if failures:
            raise ConfigError('save_config_failed_pending', 500)
        for path, raw, kind, mode, limit in ((yaml_path, y, 'yaml', 0o644, MAX_YAML),
                                            (env_path, e, 'env', 0o600, MAX_ENV)):
            identity = meta[kind + '_identity']
            actual, _ = _read_file(path, limit, mode, identity[2], identity)
            if raw is not None and actual != raw:
                raise ConfigError('save_config_failed_pending', 500)
        verified = True
        c.execute('update endpoint_binding set state=? where id=1 and revision=?',
                  (meta['binding_state'], row['base_revision']))
        c.execute('delete from config_txn where txn_id=?', (row['txn_id'],))
        c.commit()
    except Exception:
        try:
            c.rollback()
            if verified and _row(c) is None:
                _cleanup(directory, names)
                return
            _pending(c)
        except Exception:
            # Journal remains durable even if the database itself is unavailable.
            raise ConfigError('config_recovery_failed', 500) from None
        raise ConfigError('save_config_failed_pending', 500) from None
    _cleanup(directory, names)


def _idle(c):
    if c.in_transaction:
        raise ConfigError('config_db_transaction_active', 500)


def persist(c, old, candidate, yaml_path, env_path, state_dir, commit_callback):
    """Persist both files then atomically commit callback state + journal removal.

    On failure restore originals and leave callback updates/revision uncommitted.
    BaseException intentionally models process death: durable recovery is left to
    recover(). Normal errors are sanitized so configuration data cannot leak.
    """
    _idle(c)
    # Validate before recovery or backup IO; malformed candidates write nothing.
    checked = _snapshot(candidate['yaml'], candidate['env'])
    original = _snapshot(old['yaml'], old['env'])
    pilot_edit = checked['pilotModel'] != original['pilotModel']
    rebuilt = prepare(old, checked['baseURL'], checked['defaultModel'],
                      checked['key'], checked['marker'],
                      pilot_model=checked['pilotModel'] if pilot_edit else None,
                      fallback_model=checked['fallbackModel'] if checked['fallbackModel'] != original['fallbackModel'] else None)
    if (any(candidate.get(k) != value for k, value in checked.items())
            or checked['yaml'] != rebuilt['yaml'] or checked['env'] != rebuilt['env']):
        raise ConfigError('config_candidate_invalid')
    # Retrying recovery never permits a stale request to overwrite the files:
    # its snapshot is compared against disk again below.
    try:
        recover(c, yaml_path, env_path, state_dir)
    except ConfigError as exc:
        if exc.code == 'config_recovery_blocked':
            raise
        raise ConfigError('config_recovery_required', 409) from None
    live = read_config(yaml_path, env_path, old.get('_owner_uid'))
    if (live['yaml'] != old['yaml'] or live['env'] != old['env']
            or any(name in old and old[name] != live[name]
                   for name in ('_yaml_identity', '_env_identity'))):
        raise ConfigError('config_stale', 409)
    binding = c.execute('select revision,state from endpoint_binding where id=1').fetchone()
    if binding is None or binding[1] not in ('ok', 'pending', 'unbound'):
        raise ConfigError('config_binding_missing', 500)
    base_revision = binding[0]
    if candidate['marker'] != base_revision + 1:
        raise ConfigError('config_stale', 409)
    c.execute('PRAGMA synchronous=FULL')
    with _TxnDir(state_dir) as directory:
        row = None
        txn_id = secrets.token_hex(16)
        names = _txn_names(txn_id)
        env_included = int(candidate['env'] != old['env'])
        try:
            meta = {'v': 1, 'txn_id': txn_id, 'base_revision': base_revision,
                    'binding_state': binding[1],
                    'env_included': env_included, 'yaml_size': len(old['yaml']),
                    'env_size': len(old['env']), 'new_yaml_sha': _hash(candidate['yaml']),
                    'yaml_identity': live['_yaml_identity'], 'env_identity': live['_env_identity']}
            directory.write(names[0], old['yaml'])
            if env_included:
                directory.write(names[1], old['env'])
            directory.write(names[2], json.dumps(meta, separators=(',', ':')).encode('ascii'))
            directory.sync()
            c.execute('BEGIN IMMEDIATE')
            c.execute('insert into config_txn values(?,?,?,?,?)',
                      (txn_id, base_revision, env_included, int(time.time()), 'active'))
            c.commit()
            row = _row(c)
            c.execute('BEGIN IMMEDIATE')
            _write_in_place(yaml_path, candidate['yaml'], live['_yaml_identity'], 0o644, MAX_YAML)
            if env_included:
                _write_in_place(env_path, candidate['env'], live['_env_identity'], 0o600, MAX_ENV)
            for path, raw, kind, mode, limit in (
                    (yaml_path, candidate['yaml'], 'yaml', 0o644, MAX_YAML),
                    (env_path, candidate['env'], 'env', 0o600, MAX_ENV)):
                identity = live['_' + kind + '_identity']
                actual, _ = _read_file(path, limit, mode, identity[2], identity)
                if actual != raw:
                    raise ConfigError('config_readback_failed', 500)
            commit_callback(c)
            if not c.in_transaction:
                raise ConfigError('config_callback_committed', 500)
            c.execute('delete from config_txn where txn_id=?', (txn_id,))
            c.commit()
        except Exception:
            c.rollback()
            durable = _row(c)
            if durable is not None:
                _restore(c, durable, yaml_path, env_path, directory)
                raise ConfigError('save_config_failed_restored', 500) from None
            if row is not None:
                # Error reported after a completed SQLite commit: do not undo it.
                _cleanup(directory, names)
                return
            _cleanup(directory, names)
            raise ConfigError('save_config_failed_restored', 500) from None
        _cleanup(directory, names)


def recover(c, yaml_path, env_path, state_dir):
    """Restore an interrupted save under caller-owned locks; return whether found."""
    _idle(c)
    row = _row(c)
    c.execute('PRAGMA synchronous=FULL')
    try:
        with _TxnDir(state_dir) as directory:
            _orphan_cleanup(directory, row)
            if row is not None:
                _restore(c, row, yaml_path, env_path, directory)
    except ConfigError as exc:
        if row is not None:
            _pending(c)
        raise ConfigError(exc.code, exc.status) from None
    except Exception:
        if row is not None:
            _pending(c)
        raise ConfigError('config_recovery_blocked', 500) from None
    return row is not None
