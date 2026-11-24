"""Read-only unread-count lookups for the single QYOS shared mailbox.

Batch-1 scope:
* Tencent Enterprise Mail: IMAPS LOGIN, then ``STATUS INBOX (UNSEEN)``, then LOGOUT.
  No SELECT/SEARCH/FETCH, no message access, no SMTP, no writes.
* Google Workspace: ``users.labels.get`` for the fixed mailbox and the INBOX label.
  It reads ``messagesUnread`` only. No message APIs.
* Custom HTTPS webmail: link validation only. The backend never fetches it.

The mailbox is a module constant and is never a parameter. Secrets are injected
by the server-side caller and are never logged, stored or echoed. Every failure
surfaces as ``ProviderError`` carrying one fixed public code. Failures never
carry a cause or context chain.
"""

from __future__ import annotations

import http.client
import imaplib
import json
import math
import re
import ssl
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any, Callable, Optional, Tuple

__all__ = [
    "SHARED_MAILBOX",
    "PROVIDER_TENCENT_EXMAIL",
    "PROVIDER_GOOGLE_WORKSPACE",
    "MAX_UNREAD_COUNT",
    "UnreadCount",
    "ProviderError",
    "tencent_unread_count",
    "gmail_unread_count",
    "validate_webmail_link",
]

SHARED_MAILBOX = "sales@example.invalid"

TENCENT_IMAP_HOST = "imap.exmail.qq.com"
TENCENT_IMAP_PORT = 993

GMAIL_API_HOST = "gmail.googleapis.com"
GMAIL_API_PORT = 443
GMAIL_INBOX_LABEL_PATH = "/gmail/v1/users/sales%40example.invalid/labels/INBOX"

PROVIDER_TENCENT_EXMAIL = "tencent_exmail"
PROVIDER_GOOGLE_WORKSPACE = "google_workspace"

DEFAULT_TIMEOUT_SECONDS = 10.0
MAX_TIMEOUT_SECONDS = 30.0
MAX_UNREAD_COUNT = 10_000_000
MAX_GMAIL_BODY_BYTES = 64 * 1024

_READ_CHUNK = 8192
_MAX_TOKEN_LEN = 4096
_MAX_WEBMAIL_URL_LEN = 2048
_PASSWORD_RE = re.compile(r"[\x20-\x7e]{1,1024}")
_TOKEN_RE = re.compile(r"[A-Za-z0-9\-._~+/]+=*")  # RFC 6750 b64token
_IMAP_STATUS_RE = re.compile(
    rb'(?:INBOX|"INBOX") \(UNSEEN ([0-9]{1,20})\)', re.IGNORECASE
)
_CONTENT_LENGTH_RE = re.compile(r"[0-9]{1,12}")

ImapFactory = Callable[..., Any]
HttpsFactory = Callable[..., Any]


class ProviderError(Exception):
    """Sanitized provider failure. ``code`` is the only public information."""

    INVALID_CONFIG = "invalid_config"
    AUTH_FAILED = "auth_failed"
    CONNECT_FAILED = "connect_failed"
    TIMEOUT = "timeout"
    TLS_FAILED = "tls_failed"
    PROTOCOL_ERROR = "protocol_error"
    HTTP_ERROR = "http_error"
    RATE_LIMITED = "rate_limited"
    REDIRECT_REJECTED = "redirect_rejected"
    RESPONSE_TOO_LARGE = "response_too_large"
    MALFORMED_RESPONSE = "malformed_response"
    COUNT_OUT_OF_RANGE = "count_out_of_range"
    INTERNAL_ERROR = "internal_error"

    CODES = frozenset({
        INVALID_CONFIG, AUTH_FAILED, CONNECT_FAILED, TIMEOUT, TLS_FAILED,
        PROTOCOL_ERROR, HTTP_ERROR, RATE_LIMITED, REDIRECT_REJECTED,
        RESPONSE_TOO_LARGE, MALFORMED_RESPONSE, COUNT_OUT_OF_RANGE,
        INTERNAL_ERROR,
    })

    def __init__(self, code: str) -> None:
        if not isinstance(code, str) or code not in self.CODES:
            code = self.INTERNAL_ERROR
        super().__init__(code)
        self.code = code

    def __str__(self) -> str:
        return self.code

    def __repr__(self) -> str:
        return f"ProviderError({self.code!r})"


@dataclass(frozen=True, slots=True)
class UnreadCount:
    provider: str
    unread: int


# --------------------------------------------------------------------------- helpers

def _check_timeout(timeout: Any) -> float:
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        raise ProviderError(ProviderError.INVALID_CONFIG)
    value = float(timeout)
    if not math.isfinite(value) or value <= 0 or value > MAX_TIMEOUT_SECONDS:
        raise ProviderError(ProviderError.INVALID_CONFIG)
    return value


def _verified_tls_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context(ssl.Purpose.SERVER_AUTH)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    if ctx.verify_mode != ssl.CERT_REQUIRED or not ctx.check_hostname:
        raise ProviderError(ProviderError.TLS_FAILED)
    return ctx


def _check_count(value: Any) -> int:
    if type(value) is not int:  # rejects bool, float, str, None, containers
        raise ProviderError(ProviderError.MALFORMED_RESPONSE)
    if value < 0 or value > MAX_UNREAD_COUNT:
        raise ProviderError(ProviderError.COUNT_OUT_OF_RANGE)
    return value


# --------------------------------------------------------------------------- Tencent

def _default_imap_factory(host: str, port: int, *, ssl_context: ssl.SSLContext,
                          timeout: float) -> Any:
    return imaplib.IMAP4_SSL(host, port, ssl_context=ssl_context, timeout=timeout)


def _parse_imap_status(typ: Any, data: Any) -> int:
    if typ != "OK":
        raise ProviderError(ProviderError.PROTOCOL_ERROR)
    if not isinstance(data, list) or len(data) != 1:
        raise ProviderError(ProviderError.MALFORMED_RESPONSE)
    item = data[0]
    if not isinstance(item, bytes):
        raise ProviderError(ProviderError.MALFORMED_RESPONSE)
    match = _IMAP_STATUS_RE.fullmatch(item)
    if match is None:
        raise ProviderError(ProviderError.MALFORMED_RESPONSE)
    return _check_count(int(match.group(1)))


def _quiet_logout(conn: Any) -> None:
    try:
        conn.logout()
    except Exception:
        pass


def _tencent_query(password: Any, timeout: Any,
                   factory: Optional[ImapFactory]) -> Tuple[Optional[str], Optional[int]]:
    code: Optional[str] = None
    count: Optional[int] = None
    conn = None
    stage = "validate"
    try:
        t = _check_timeout(timeout)
        if not isinstance(password, str) or _PASSWORD_RE.fullmatch(password) is None:
            raise ProviderError(ProviderError.INVALID_CONFIG)
        if factory is None:
            factory = _default_imap_factory
        elif not callable(factory):
            raise ProviderError(ProviderError.INVALID_CONFIG)
        ctx = _verified_tls_context()
        stage = "connect"
        conn = factory(TENCENT_IMAP_HOST, TENCENT_IMAP_PORT, ssl_context=ctx, timeout=t)
        stage = "login"
        typ, _ = conn.login(SHARED_MAILBOX, password)
        if typ != "OK":
            raise ProviderError(ProviderError.AUTH_FAILED)
        stage = "status"
        typ, data = conn.status("INBOX", "(UNSEEN)")
        count = _parse_imap_status(typ, data)
    except ProviderError as exc:
        code = exc.code
    except imaplib.IMAP4.abort:
        code = ProviderError.PROTOCOL_ERROR
    except imaplib.IMAP4.error:
        code = ProviderError.AUTH_FAILED if stage == "login" else ProviderError.PROTOCOL_ERROR
    except TimeoutError:
        code = ProviderError.TIMEOUT
    except ssl.SSLError:
        code = ProviderError.TLS_FAILED
    except OSError:
        code = ProviderError.CONNECT_FAILED
    except Exception:
        code = ProviderError.INTERNAL_ERROR
    finally:
        password = None
        if conn is not None:
            _quiet_logout(conn)
    if code is None and count is None:
        code = ProviderError.INTERNAL_ERROR
    return code, count


def tencent_unread_count(password: str, *, timeout: float = DEFAULT_TIMEOUT_SECONDS,
                         _imap_factory: Optional[ImapFactory] = None) -> UnreadCount:
    """Return the INBOX unread count for the fixed shared mailbox on Tencent Exmail.

    ``password`` is the server-side mailbox (client-specific) password.
    ``_imap_factory`` is a test seam only. It receives the fixed host, the fixed port
    and a verified TLS context. Parsing and validation still apply.
    """
    code, count = _tencent_query(password, timeout, _imap_factory)
    del password
    if code is not None:
        raise ProviderError(code)
    return UnreadCount(PROVIDER_TENCENT_EXMAIL, count)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- Gmail

def _default_https_factory(host: str, port: int, *, ssl_context: ssl.SSLContext,
                           timeout: float) -> Any:
    # http.client never follows redirects and ignores proxy env vars.
    return http.client.HTTPSConnection(host, port, timeout=timeout, context=ssl_context)


def _quiet_close(conn: Any) -> None:
    try:
        conn.close()
    except Exception:
        pass


def _read_gmail_response(resp: Any, deadline: float) -> bytes:
    status = resp.status
    if type(status) is not int:
        raise ProviderError(ProviderError.MALFORMED_RESPONSE)
    if 300 <= status < 400:
        raise ProviderError(ProviderError.REDIRECT_REJECTED)
    if status in (401, 403):
        raise ProviderError(ProviderError.AUTH_FAILED)
    if status == 429:
        raise ProviderError(ProviderError.RATE_LIMITED)
    if status != 200:
        raise ProviderError(ProviderError.HTTP_ERROR)

    ctype = resp.getheader("Content-Type")
    if not isinstance(ctype, str) or ctype.split(";", 1)[0].strip().lower() != "application/json":
        raise ProviderError(ProviderError.MALFORMED_RESPONSE)
    enc = resp.getheader("Content-Encoding")
    if enc is not None and (not isinstance(enc, str) or enc.strip().lower() != "identity"):
        raise ProviderError(ProviderError.MALFORMED_RESPONSE)
    clen = resp.getheader("Content-Length")
    if clen is not None:
        if not isinstance(clen, str) or _CONTENT_LENGTH_RE.fullmatch(clen.strip()) is None:
            raise ProviderError(ProviderError.MALFORMED_RESPONSE)
        if int(clen.strip()) > MAX_GMAIL_BODY_BYTES:
            raise ProviderError(ProviderError.RESPONSE_TOO_LARGE)

    chunks = []
    total = 0
    while True:
        if time.monotonic() > deadline:
            raise ProviderError(ProviderError.TIMEOUT)
        chunk = resp.read(min(_READ_CHUNK, MAX_GMAIL_BODY_BYTES + 1 - total))
        if type(chunk) is not bytes:
            raise ProviderError(ProviderError.MALFORMED_RESPONSE)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_GMAIL_BODY_BYTES:
            raise ProviderError(ProviderError.RESPONSE_TOO_LARGE)
        chunks.append(chunk)
    return b"".join(chunks)


def _no_duplicate_keys(pairs: list) -> dict:
    out: dict = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate key")
        out[key] = value
    return out


def _reject_constant(_name: str) -> Any:
    raise ValueError("non-finite number")


def _parse_gmail_label(body: bytes) -> int:
    try:
        obj = json.loads(body.decode("utf-8"), object_pairs_hook=_no_duplicate_keys,
                         parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ProviderError(ProviderError.MALFORMED_RESPONSE) from None
    if not isinstance(obj, dict):
        raise ProviderError(ProviderError.MALFORMED_RESPONSE)
    label_id = obj.get("id")
    if type(label_id) is not str or label_id != "INBOX":
        raise ProviderError(ProviderError.MALFORMED_RESPONSE)
    if "messagesUnread" not in obj:  # threadsUnread is deliberately never used
        raise ProviderError(ProviderError.MALFORMED_RESPONSE)
    return _check_count(obj["messagesUnread"])


def _gmail_query(access_token: Any, timeout: Any,
                 factory: Optional[HttpsFactory]) -> Tuple[Optional[str], Optional[int]]:
    code: Optional[str] = None
    count: Optional[int] = None
    conn = None
    headers: Optional[dict] = None
    try:
        t = _check_timeout(timeout)
        if (not isinstance(access_token, str) or len(access_token) > _MAX_TOKEN_LEN
                or _TOKEN_RE.fullmatch(access_token) is None):
            raise ProviderError(ProviderError.INVALID_CONFIG)
        if factory is None:
            factory = _default_https_factory
        elif not callable(factory):
            raise ProviderError(ProviderError.INVALID_CONFIG)
        ctx = _verified_tls_context()
        headers = {
            "Authorization": "Bearer " + access_token,
            "Accept": "application/json",
            "Accept-Encoding": "identity",
        }
        deadline = time.monotonic() + t
        conn = factory(GMAIL_API_HOST, GMAIL_API_PORT, ssl_context=ctx, timeout=t)
        conn.request("GET", GMAIL_INBOX_LABEL_PATH, headers=headers)
        headers = None
        resp = conn.getresponse()
        body = _read_gmail_response(resp, deadline)
        count = _parse_gmail_label(body)
    except ProviderError as exc:
        code = exc.code
    except http.client.HTTPException:
        code = ProviderError.PROTOCOL_ERROR
    except TimeoutError:
        code = ProviderError.TIMEOUT
    except ssl.SSLError:
        code = ProviderError.TLS_FAILED
    except OSError:
        code = ProviderError.CONNECT_FAILED
    except Exception:
        code = ProviderError.INTERNAL_ERROR
    finally:
        headers = None
        access_token = None
        if conn is not None:
            _quiet_close(conn)
    if code is None and count is None:
        code = ProviderError.INTERNAL_ERROR
    return code, count


def gmail_unread_count(access_token: str, *, timeout: float = DEFAULT_TIMEOUT_SECONDS,
                       _https_factory: Optional[HttpsFactory] = None) -> UnreadCount:
    """Return INBOX ``messagesUnread`` for the fixed shared mailbox via Gmail API.

    ``access_token`` is a server-side OAuth access token (scope gmail.labels or
    gmail.readonly). The caller owns refresh. ``_https_factory`` is a test seam only.
    It receives the fixed host, the fixed port and a verified TLS context.
    """
    code, count = _gmail_query(access_token, timeout, _https_factory)
    del access_token
    if code is not None:
        raise ProviderError(code)
    return UnreadCount(PROVIDER_GOOGLE_WORKSPACE, count)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- webmail

def validate_webmail_link(url: str) -> str:
    """Validate a custom HTTPS webmail link for display. It is never fetched."""
    ok = False
    try:
        if (isinstance(url, str) and 0 < len(url) <= _MAX_WEBMAIL_URL_LEN
                and url.isascii() and all(0x21 <= ord(c) < 0x7f for c in url)
                and "\\" not in url):
            parts = urllib.parse.urlsplit(url)
            host = parts.hostname
            _ = parts.port  # raises ValueError on a bad port
            ok = (parts.scheme == "https" and bool(host)
                  and parts.username is None and parts.password is None)
    except ValueError:
        ok = False
    if not ok:
        raise ProviderError(ProviderError.INVALID_CONFIG)
    return url
