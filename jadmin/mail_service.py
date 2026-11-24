"""QYOS enterprise mail service: owner-only configuration, server-side credentials, unread cache, worker.

Importing has no side effects (no environment, DB, file, thread or network access). server.main() calls
start_worker(host); mail_http calls service(host). Only the unread count of the fixed mailbox is read: no
message content, no provider account changes, and the webmail link is never fetched by the backend.

Configuration is one row in the host DB (enterprise_mail_config) guarded by an optimistic `revision`.
Credentials live in a separate owner-only file in /var/lib/qyos/jadmin. The file records the
revision it belongs to and is treated as absent (fail closed) unless it equals the committed DB revision.
"""
import http.client
import ipaddress
import json
import os
import re
import sqlite3
import ssl
import stat
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import namedtuple
from contextlib import closing

import employee_email

MAILBOX = 'sales@example.invalid'
PROVIDERS = ('tencent', 'google', 'custom')
CREDENTIAL_KEYS = {'tencent': ('tencentPassword',),
                   'google': ('googleClientId', 'googleClientSecret', 'googleRefreshToken')}
SECRET_KEYS = ('tencentPassword', 'googleClientId', 'googleClientSecret', 'googleRefreshToken')
SECRET_LIMITS = {'tencentPassword': 256, 'googleClientId': 256, 'googleClientSecret': 256,
                 'googleRefreshToken': 2048}
CREDENTIAL_FILE = 'enterprise-mail-credentials.json'
STATE_DIRECTORY = '/var/lib/qyos/jadmin'
CREDENTIAL_SCHEMA = 'qyos.enterprise-mail.credentials.v1'
MAX_CREDENTIAL_FILE = 16 * 1024
MAX_DEPARTMENTS = 64
MAX_URL = 2048
FRESH_SECONDS = 120
WORKER_INTERVAL = 120
MAX_COUNT_AGE = 3 * FRESH_SECONDS
TEST_INTERVAL = 10
MAX_UNREAD = 10_000_000
GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
GOOGLE_TIMEOUT = 10
GOOGLE_MAX_RESPONSE = 64 * 1024
CONFIG_FIELDS = frozenset(('revision', 'enabled', 'provider', 'webmailUrl', 'departments'))
INACTIVE_FLAGS = ('isDeleted', 'isForbidden', 'isDisabled', 'pendingApproval')  # same policy as work_http
INVISIBLE = {'visible': False}
_CODE = re.compile(r'[a-z][a-z0-9_-]{1,31}\Z')
_ERROR = re.compile(r'[a-z][a-z0-9_]{1,47}\Z')
_SECRET = re.compile(r'[\x21-\x7e]+\Z')
_LABEL = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z')
_TOKEN = re.compile(r'[A-Za-z0-9._~+/=-]{16,4096}\Z')
_BLOCKED_SUFFIXES = ('.localhost', '.local', '.localdomain', '.internal', '.lan', '.home.arpa')
SCHEMA_SQL = ("create table if not exists enterprise_mail_config(id integer primary key check(id=1), "
              "revision integer not null, enabled integer not null default 0, provider text not null, "
              "webmail_url text not null default '', departments text not null default '[]', updated integer)")
UPSERT_SQL = ("insert into enterprise_mail_config(id,revision,enabled,provider,webmail_url,departments,updated) "
              "values(1,?,?,?,?,?,?) on conflict(id) do update set revision=excluded.revision, "
              "enabled=excluded.enabled, provider=excluded.provider, webmail_url=excluded.webmail_url, "
              "departments=excluded.departments, updated=excluded.updated")

Config = namedtuple('Config', 'revision enabled provider webmail_url departments')
DEFAULT_CONFIG = Config(0, False, 'tencent', 'https://exmail.qq.com/', ())
Entry = namedtuple('Entry', 'revision unread error at checked_at')


class MailError(Exception):
    """Fixed, sanitized error code; never carries provider bodies, secrets or stack details."""

    def __init__(self, code, status=400):
        super().__init__(code)
        self.code, self.status = code, status


# ---------------------------------------------------------------- validation
def check_webmail_url(value):
    """Public HTTPS link (no userinfo, port 443 only, no fragment/controls, no local/private hosts)."""
    bad = MailError('invalid_webmail_url')
    if (not isinstance(value, str) or len(value) > MAX_URL or not value.isascii()
            or not value.startswith('https://') or '\\' in value or '#' in value
            or any(ord(ch) <= 32 or ord(ch) == 127 for ch in value)):
        raise bad
    try:
        parts = urllib.parse.urlsplit(value)
        port = parts.port
    except ValueError:
        raise bad from None
    host = parts.hostname or ''
    if ('@' in parts.netloc or '%' in parts.netloc or parts.netloc.endswith(':') or port not in (None, 443)
            or parts.fragment or not host):
        raise bad
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None:
        if not address.is_global or address.is_multicast:
            raise bad
        return value
    labels = host.split('.')
    if (len(host) > 253 or len(labels) < 2 or any(not _LABEL.fullmatch(p) for p in labels)
            or labels[-1].isdigit() or host == 'localhost' or host.endswith(_BLOCKED_SUFFIXES)):
        raise bad
    return value


def _valid_secret(key, value):
    return isinstance(value, str) and 1 <= len(value) <= SECRET_LIMITS[key] and bool(_SECRET.fullmatch(value))


def parse_credentials(value):
    """Optional owner submission. '' preserves the stored value; `clear` removes a provider's secrets."""
    if value is None:
        return {}, ()
    bad = MailError('invalid_credentials')
    if not isinstance(value, dict) or set(value) - set(SECRET_KEYS) - {'clear'}:
        raise bad
    updates = {}
    for key in SECRET_KEYS:
        item = value.get(key, '')
        if not isinstance(item, str):
            raise bad
        if item:
            if not _valid_secret(key, item):
                raise bad
            updates[key] = item
    clear = value.get('clear', [])
    if (not isinstance(clear, list) or len(clear) > len(CREDENTIAL_KEYS) or len(set(map(str, clear))) != len(clear)
            or any(group not in CREDENTIAL_KEYS for group in clear)):
        raise bad
    if any(key in updates for group in clear for key in CREDENTIAL_KEYS[group]):
        raise bad
    return updates, tuple(clear)


def parse_config(data):
    if not isinstance(data, dict) or not CONFIG_FIELDS <= set(data) or set(data) - CONFIG_FIELDS - {'credentials'}:
        raise MailError('invalid_request')
    revision, enabled, provider, url, departments = (data[k] for k in (
        'revision', 'enabled', 'provider', 'webmailUrl', 'departments'))
    if type(revision) is not int or not 0 <= revision < 2 ** 31:
        raise MailError('invalid_revision')
    if type(enabled) is not bool:
        raise MailError('invalid_request')
    if not isinstance(provider, str) or provider not in PROVIDERS:
        raise MailError('invalid_provider')
    if not isinstance(url, str):
        raise MailError('invalid_webmail_url')
    if url:
        check_webmail_url(url)
    if (not isinstance(departments, list) or len(departments) > MAX_DEPARTMENTS
            or not all(isinstance(d, str) and _CODE.fullmatch(d) for d in departments)
            or len(set(departments)) != len(departments)):
        raise MailError('invalid_departments')
    updates, clear = parse_credentials(data.get('credentials'))
    return {'revision': revision, 'enabled': enabled, 'provider': provider, 'webmailUrl': url,
            'departments': list(departments), 'updates': updates, 'clear': clear}


def read_config(c):
    row = c.execute('select revision, enabled, provider, webmail_url, departments from enterprise_mail_config '
                    'where id=1').fetchone()
    if row is None:
        return DEFAULT_CONFIG
    if type(row[0]) is not int:
        raise MailError('storage_unavailable', 503)
    try:
        departments = json.loads(row[4])
        if (row[2] not in PROVIDERS or not isinstance(row[3], str) or not isinstance(departments, list)
                or not all(isinstance(d, str) and _CODE.fullmatch(d) for d in departments)):
            raise ValueError('corrupt')
        return Config(row[0], row[1] == 1, row[2], row[3], tuple(departments))
    except (ValueError, TypeError):
        return Config(row[0], False, 'custom', '', ())  # corrupt row: disabled, revision kept for recovery


def _flags(secrets):
    return {key: key in secrets for key in SECRET_KEYS}


def complete(cfg, flags):
    """Enabling and employee visibility both require a fully valid configuration."""
    if cfg.provider not in PROVIDERS or not cfg.departments:
        return False
    try:
        check_webmail_url(cfg.webmail_url)
    except MailError:
        return False
    return all(flags.get(key) for key in CREDENTIAL_KEYS.get(cfg.provider, ()))


def _error_code(error):
    code = getattr(error, 'code', None)
    return code if isinstance(code, str) and _ERROR.fullmatch(code) else 'provider_unavailable'


# ---------------------------------------------------------------- credential store
class CredentialStore:
    """Owner-only secret file in the trusted state directory; atomic replace; never client-chosen."""

    def __init__(self, directory):
        self.directory = directory
        self.path = os.path.join(directory, CREDENTIAL_FILE)

    def _check_directory(self):
        try:
            st = os.lstat(self.directory)
        except OSError:
            raise MailError('credentials_store_unsafe', 503) from None
        if not stat.S_ISDIR(st.st_mode) or st.st_uid not in (0, os.geteuid()) or st.st_mode & 0o022:
            raise MailError('credentials_store_unsafe', 503)

    def read_raw(self):
        self._check_directory()
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        except FileNotFoundError:
            return None
        except OSError:
            raise MailError('credentials_store_unsafe', 503) from None
        try:
            st = os.fstat(fd)
            if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077
                    or st.st_size > MAX_CREDENTIAL_FILE):
                raise MailError('credentials_store_unsafe', 503)
            chunks, size = [], 0
            while True:
                chunk = os.read(fd, 4096)
                if not chunk:
                    return b''.join(chunks)
                size += len(chunk)
                if size > MAX_CREDENTIAL_FILE:
                    raise MailError('credentials_store_unsafe', 503)
                chunks.append(chunk)
        except OSError:
            raise MailError('credentials_store_unsafe', 503) from None
        finally:
            os.close(fd)

    def load(self, revision):
        raw = self.read_raw()
        if raw is None:
            return {}
        try:
            value = employee_email.strict_json(raw.decode('utf-8'))
        except (ValueError, UnicodeError, RecursionError):
            raise MailError('credentials_corrupt', 503) from None
        if (not isinstance(value, dict) or set(value) != {'schema', 'revision', 'secrets'}
                or value['schema'] != CREDENTIAL_SCHEMA or type(value['revision']) is not int
                or not isinstance(value['secrets'], dict)
                or any(k not in SECRET_LIMITS or not _valid_secret(k, v) for k, v in value['secrets'].items())):
            raise MailError('credentials_corrupt', 503)
        if value['revision'] != revision:
            raise MailError('credentials_inconsistent', 503)
        return dict(value['secrets'])

    def write(self, revision, secrets):
        data = json.dumps({'schema': CREDENTIAL_SCHEMA, 'revision': revision, 'secrets': secrets},
                          separators=(',', ':'), sort_keys=True).encode('utf-8')
        self._replace(data)

    def restore(self, raw):
        if raw is not None:
            return self._replace(raw)
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass
        except OSError:
            raise MailError('credentials_store_unavailable', 503) from None

    def _replace(self, data):
        self._check_directory()
        try:
            fd, tmp = tempfile.mkstemp(prefix='.' + CREDENTIAL_FILE + '.', dir=self.directory)
            try:
                try:
                    os.fchmod(fd, 0o600)
                    view = memoryview(data)
                    while view:
                        view = view[os.write(fd, view):]
                    os.fsync(fd)
                finally:
                    os.close(fd)
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            dfd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:
            raise MailError('credentials_store_unavailable', 503) from None


# ---------------------------------------------------------------- Google token refresh
def _google_opener():
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}), employee_email.NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()))


def google_access_token(client_id, client_secret, refresh_token, opener=None):
    """Refresh-token grant at the fixed Google endpoint (TLS verified, no redirects, bounded reply)."""
    invalid = MailError('google_response_invalid', 502)
    body = urllib.parse.urlencode({'grant_type': 'refresh_token', 'client_id': client_id,
                                   'client_secret': client_secret, 'refresh_token': refresh_token}).encode('ascii')
    request = urllib.request.Request(GOOGLE_TOKEN_URL, data=body, method='POST', headers={
        'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json'})
    try:
        with (opener or _google_opener()).open(request, timeout=GOOGLE_TIMEOUT) as response:
            if response.status != 200 or response.headers.get_content_type() != 'application/json':
                raise invalid
            raw = response.read(GOOGLE_MAX_RESPONSE + 1)
    except MailError:
        raise
    except urllib.error.HTTPError as error:
        error.close()  # body never read or logged
        if 300 <= error.code < 400:
            code = 'google_redirect_refused'
        elif error.code in (400, 401):
            code = 'google_auth_rejected'
        else:
            code = 'google_unavailable'
        raise MailError(code, 502) from None
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException):
        raise MailError('google_unavailable', 502) from None
    if len(raw) > GOOGLE_MAX_RESPONSE:
        raise invalid
    try:
        value = employee_email.strict_json(raw.decode('utf-8'))
    except (ValueError, UnicodeError, RecursionError):
        raise invalid from None
    if not isinstance(value, dict):
        raise invalid
    token, token_type = value.get('access_token'), value.get('token_type', 'Bearer')
    if (not isinstance(token, str) or not _TOKEN.fullmatch(token)
            or not isinstance(token_type, str) or token_type.lower() != 'bearer'):
        raise invalid
    return token


# ---------------------------------------------------------------- service
class MailService:
    def __init__(self, host, *, probes=None, store=None, clock=time.monotonic, wall=time.time,
                 google_opener=None):
        self.host = host
        self.store = store if store is not None else CredentialStore(STATE_DIRECTORY)
        self._probes = dict(probes or {})  # provider -> callable(secrets) -> int (fixtures)
        self._google_opener = google_opener
        self.clock, self.wall = clock, wall
        self._lock = threading.Lock()        # cache, generation, test rate limit
        self._probe_lock = threading.Lock()  # one provider probe at a time
        self._save_lock = threading.Lock()
        self._cache, self._generation, self._probes_done, self._last_test = None, 0, 0, None
        self._schema_ready = False
        self._stop, self._wake, self._thread = threading.Event(), threading.Event(), None

    def ensure_schema(self, c):
        if not self._schema_ready:
            c.execute(SCHEMA_SQL)
            if c.in_transaction:
                c.commit()
            self._schema_ready = True

    def _secrets(self, revision):
        try:
            return self.store.load(revision), None
        except MailError as error:
            return {}, error.code

    def _visible(self, cfg):
        if not cfg.enabled:
            return False
        secrets, error = self._secrets(cfg.revision) if CREDENTIAL_KEYS.get(cfg.provider) else ({}, None)
        return error is None and complete(cfg, _flags(secrets))

    def _count_state(self, cfg):
        if cfg.provider == 'custom':
            return 'link_only', None, None, None
        with self._lock:
            entry = self._cache if self._cache is not None and self._cache.revision == cfg.revision else None
        if entry is None:
            return 'pending', None, None, None
        if entry.error:
            return 'error', None, entry.error, entry.checked_at
        if self.clock() - entry.at > MAX_COUNT_AGE:
            return 'pending', None, None, entry.checked_at
        return 'ok', entry.unread, None, entry.checked_at

    def admin_view(self, c):
        self.ensure_schema(c)
        cfg = read_config(c)
        choices = [{'code': d['code'], 'name': d['name']} for d in self.host.enterprise.list_departments(c)]
        flags = _flags(self._secrets(cfg.revision)[0])
        error = self._secrets(cfg.revision)[1]
        state, unread, problem, checked = self._count_state(cfg)
        credentials = dict(flags, tencentConfigured=flags['tencentPassword'],
                           googleConfigured=all(flags[k] for k in CREDENTIAL_KEYS['google']))
        return {'revision': cfg.revision, 'enabled': cfg.enabled, 'provider': cfg.provider,
                'providers': list(PROVIDERS), 'mailbox': MAILBOX, 'webmailUrl': cfg.webmail_url,
                'departments': list(cfg.departments), 'departmentChoices': choices,
                'credentials': credentials, 'credentialsError': error, 'valid': complete(cfg, flags),
                'count': {'status': state, 'unread': unread, 'error': problem, 'checkedAt': checked}}

    def save(self, c, data, actor, authorize):
        """Validate, recheck the owner, then commit config and credentials under one new revision."""
        p = parse_config(data)
        with self._save_lock:
            self.ensure_schema(c)
            if c.in_transaction:
                c.commit()
            c.execute('begin immediate')
            prior, wrote = None, False
            try:
                current = read_config(c)
                if p['revision'] != current.revision:
                    raise MailError('revision_conflict', 409)
                known = {d['code'] for d in self.host.enterprise.list_departments(c)}
                if any(code not in known for code in p['departments']):
                    raise MailError('unknown_department', 400)
                try:
                    old = self.store.load(current.revision)
                except MailError as error:
                    if error.code not in ('credentials_corrupt', 'credentials_inconsistent'):
                        raise
                    old = {}  # unverifiable secrets are dropped (fail closed); the owner re-enters them
                cleared = {k for group in p['clear'] for k in CREDENTIAL_KEYS[group]}
                new = {k: v for k, v in old.items() if k not in cleared}
                new.update(p['updates'])
                cfg = Config(current.revision + 1, p['enabled'], p['provider'], p['webmailUrl'],
                             tuple(p['departments']))
                if cfg.enabled and not complete(cfg, _flags(new)):
                    raise MailError('config_incomplete', 409)
                if not authorize():  # immediately before any persistent change
                    raise MailError('owner_required', 403)
                prior = self.store.read_raw()
                if new or prior is not None:
                    wrote = True
                    self.store.write(cfg.revision, new)
                c.execute(UPSERT_SQL, (cfg.revision, int(cfg.enabled), cfg.provider, cfg.webmail_url,
                                       json.dumps(list(cfg.departments)), int(self.wall())))
                detail = {'actor': actor, 'revision': cfg.revision, 'enabled': cfg.enabled,
                          'provider': cfg.provider, 'departments': list(cfg.departments),
                          'credentialsChanged': new != old}
                audit = getattr(self.host, 'audit', None)
                if audit is None:
                    c.commit()
                else:
                    audit(c, 'enterprise_mail_config', json.dumps(detail, ensure_ascii=False))  # commits
            except BaseException:
                try:
                    c.rollback()
                except sqlite3.Error:
                    pass
                if wrote:
                    try:
                        self.store.restore(prior)
                    except MailError:
                        pass  # revision mismatch keeps the credentials unusable (fail closed)
                raise
        self.invalidate()
        return self.admin_view(c)

    def invalidate(self):
        """Any config change clears the count; in-flight results for older revisions are discarded."""
        with self._lock:
            self._cache = None
            self._generation += 1
        self._wake.set()

    def _default_probe(self, provider, secrets):
        import mail_providers  # authored separately; imported lazily (no import-time coupling)
        if provider == 'tencent':
            return mail_providers.tencent_unread_count(secrets['tencentPassword']).unread
        if provider == 'google':
            token = google_access_token(secrets['googleClientId'], secrets['googleClientSecret'],
                                        secrets['googleRefreshToken'], opener=self._google_opener)
            return mail_providers.gmail_unread_count(token).unread
        raise MailError('provider_unsupported')

    def _probe(self, provider, secrets):
        try:
            probe = self._probes.get(provider)
            unread = probe(secrets) if probe is not None else self._default_probe(provider, secrets)
        except Exception as error:
            return None, _error_code(error)
        if type(unread) is not int or not 0 <= unread <= MAX_UNREAD:
            return None, 'provider_response_invalid'
        return unread, None

    def _record(self, cfg, generation, unread, error):
        entry = Entry(cfg.revision, unread, error, self.clock(), int(self.wall()))
        try:
            with closing(self.host.db()) as c:
                current = read_config(c).revision
        except (sqlite3.Error, MailError):
            current = None
        with self._lock:
            self._probes_done += 1
            stored = generation == self._generation and current == cfg.revision
            if stored:
                self._cache = entry
        return entry, stored

    def refresh(self, cfg, secrets, force=False):
        """Serialized, coalesced probe. Returns (entry, stored)."""
        with self._lock:
            seen = self._probes_done
        with self._probe_lock:
            with self._lock:
                entry, generation = self._cache, self._generation
                if entry is not None and entry.revision == cfg.revision:
                    if force and self._probes_done != seen:
                        return entry, True  # another probe for this revision finished while we waited
                    if not force and self.clock() - entry.at < FRESH_SECONDS:
                        return entry, True
            unread, error = self._probe(cfg.provider, secrets)
            return self._record(cfg, generation, unread, error)

    def poll_once(self):
        with self._lock:
            generation = self._generation
        with closing(self.host.db()) as c:
            self.ensure_schema(c)
            cfg = read_config(c)
        if not cfg.enabled or cfg.provider == 'custom':
            return None
        secrets, error = self._secrets(cfg.revision)
        if error:
            return self._record(cfg, generation, None, error)[0]
        if not complete(cfg, _flags(secrets)):
            return None
        return self.refresh(cfg, secrets)[0]

    def test(self, c, data, authorize):
        """Owner test of the saved configuration (works while disabled); rate limited; never returns secrets."""
        if not isinstance(data, dict) or set(data) != {'revision'} or type(data['revision']) is not int:
            raise MailError('invalid_request')
        with self._lock:
            now = self.clock()
            if self._last_test is not None and now - self._last_test < TEST_INTERVAL:
                raise MailError('test_rate_limited', 429)
            self._last_test = now
        self.ensure_schema(c)
        cfg = read_config(c)
        if cfg.revision != data['revision']:
            raise MailError('revision_conflict', 409)
        result = {'revision': cfg.revision, 'provider': cfg.provider, 'mailbox': MAILBOX, 'unread': None}
        if cfg.provider == 'custom':
            try:
                check_webmail_url(cfg.webmail_url)
            except MailError as error:
                return dict(result, ok=False, status='error', error=error.code)
            return dict(result, ok=True, status='link_only', error=None)
        secrets, error = self._secrets(cfg.revision)
        if not error and not all(k in secrets for k in CREDENTIAL_KEYS[cfg.provider]):
            error = 'credentials_missing'
        if error:
            return dict(result, ok=False, status='error', error=error)
        if not authorize():
            raise MailError('owner_required', 403)
        entry, stored = self.refresh(cfg, secrets, force=True)
        if not stored:
            raise MailError('revision_conflict', 409)
        return dict(result, ok=entry.error is None, status='error' if entry.error else 'ok',
                    unread=entry.unread, error=entry.error)

    def employee_summary(self, subject):
        """Fresh directory + DB read per call; never triggers a provider probe."""
        if not employee_email.valid_id(subject):
            raise MailError('invalid_request')
        enterprise = self.host.enterprise
        try:
            organization = enterprise.settings().get('organization')
        except Exception:
            organization = None
        if not employee_email.valid_id(organization):
            raise MailError('organization_unconfigured', 503)
        with closing(self.host.db()) as c:
            self.ensure_schema(c)
            early = read_config(c)
        if not self._visible(early):  # disabled/invalid feature never reads the directory
            return dict(INVISIBLE)
        try:
            users = enterprise.casdoor_users()
        except Exception:
            raise MailError('directory_unavailable', 503) from None
        if not isinstance(users, list):
            raise MailError('directory_unavailable', 503)
        found = [u for u in users if isinstance(u, dict) and u.get('owner') == organization and u.get('id') == subject]
        if not found:
            raise MailError('employee_unknown', 403)
        if len(found) != 1:
            raise MailError('directory_ambiguous', 503)
        user = found[0]
        if any(user.get(flag) is not None and user.get(flag) is not False for flag in INACTIVE_FLAGS):
            raise MailError('employee_inactive', 403)
        with closing(self.host.db()) as c:
            cfg = read_config(c)
            departments = enterprise.list_departments(c)
            assignments = {r['email']: r['code'] for r in enterprise.list_assignments(c)}
        if not self._visible(cfg):
            return dict(INVISIBLE)
        email = user.get('email') if isinstance(user.get('email'), str) else ''
        raw_groups = user.get('groups')
        groups = [g for g in raw_groups if isinstance(g, str)] if isinstance(raw_groups, list) else []
        department = enterprise.resolve(departments, assignments, email, groups)
        if department not in cfg.departments or department not in {d['code'] for d in departments}:
            return dict(INVISIBLE)
        state, unread, _, _ = self._count_state(cfg)
        return {'visible': True, 'revision': cfg.revision, 'provider': cfg.provider, 'mailbox': MAILBOX,
                'webmailUrl': cfg.webmail_url, 'unread': unread, 'status': state}

    def start_worker(self):
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return self._thread
            self._stop.clear()
            thread = self._thread = threading.Thread(target=self._run, name='qyos-enterprise-mail', daemon=True)
        thread.start()
        return thread

    def stop_worker(self):
        self._stop.set()
        self._wake.set()

    def _run(self):
        while not self._stop.is_set():
            try:
                self.poll_once()
            except Exception:
                pass  # nothing logged; state stays in the sanitized cache
            self._wake.wait(WORKER_INTERVAL)
            self._wake.clear()


_service = None
_service_lock = threading.Lock()


def service(host):
    global _service
    with _service_lock:
        if _service is None:
            _service = MailService(host)
        return _service


def start_worker(host):
    return service(host).start_worker()


def stop_worker():
    with _service_lock:
        current = _service
    if current is not None:
        current.stop_worker()
