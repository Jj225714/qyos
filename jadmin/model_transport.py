"""Bounded Jadmin model-list transport; binding/persistence belong to the caller.

DNS workers can outlive a caller's wait. Pinning validates the immediate socket
destination, not host routing, arbitrary NAT64 prefixes, or LibreChat traffic.
"""

import concurrent.futures
from dataclasses import dataclass, field
import http.client
import ipaddress
import json
import re
import socket
import ssl
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit


LOOPBACK_HOSTS = ('127.0.0.1', 'localhost', '::1')
_DEADLINE_SECONDS = 15.0
_DNS_WAIT_SECONDS = 5.0
_MAX_BODY = 4 * 1024 * 1024
_CHUNK_SIZE = 64 * 1024
_DNS_ERROR = '无法解析 API 地址的域名，请检查拼写或服务器网络'
_ADDRESS_ERROR = 'API 地址解析到内网、本机或保留地址，已拒绝（服务器预先配置的内部网关除外）'
_BODY_ERROR = '模型列表过大或格式无效'
_HOST_RE = re.compile(
    r'(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+'
    r'[a-z]([a-z0-9-]{0,61}[a-z0-9])?\Z'
)
_RESERVED_SUFFIXES = ('.localhost', '.local', '.internal', '.home.arpa', '.arpa', '.onion')
_V4_DENY = tuple(ipaddress.ip_network(n) for n in (
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
    '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
    '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
    '224.0.0.0/4', '240.0.0.0/4',
))
_V6_DENY = tuple(ipaddress.ip_network(n) for n in (
    '::/127', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8',
    '2001:db8::/32', '100::/64', '2001::/32', '2002::/16', '64:ff9b:1::/48',
))
_NAT64 = ipaddress.ip_network('64:ff9b::/96')
_RESOLVER_POOL = concurrent.futures.ThreadPoolExecutor(
    max_workers=4, thread_name_prefix='model-dns'
)


@dataclass
class Target:
    base: str
    origin: str
    scheme: str
    host: str
    port: int
    path: str
    trusted: bool = False
    addrs: list = field(default_factory=list)


def _parse_url(url):
    if not isinstance(url, str):
        raise ValueError('API 地址格式无效')
    url = url.strip()
    if not url or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url) or '\\' in url:
        raise ValueError('API 地址格式无效')
    if '?' in url or '#' in url:
        raise ValueError('API 地址不能包含查询参数或 # 片段')
    try:
        u = urlsplit(url)
        host = u.hostname
    except ValueError:
        raise ValueError('API 地址格式无效') from None
    if '@' in u.netloc:
        raise ValueError('API 地址不能包含账号或密码')
    if u.scheme not in ('http', 'https') or not host:
        raise ValueError('API 地址格式无效')
    try:
        port = u.port
    except ValueError:
        raise ValueError('API 地址的端口无效') from None
    # urlsplit accepts empty ports and junk after a closing IPv6 bracket.
    if u.netloc.startswith('['):
        end = u.netloc.find(']')
        tail = u.netloc[end + 1:]
        try:
            ipaddress.IPv6Address(host)
        except ValueError:
            raise ValueError('API 地址格式无效') from None
    else:
        tail = u.netloc[len(host):]
    if tail and not re.fullmatch(r':[0-9]+', tail):
        raise ValueError('API 地址的端口无效')
    if port == 0:
        raise ValueError('API 地址的端口无效')
    if host.endswith('.') or '%' in host:
        raise ValueError('API 地址的域名无效或属于内部保留名称')
    port = port if port is not None else (443 if u.scheme == 'https' else 80)
    path = u.path.rstrip('/')
    if ('//' in path or any(p in ('.', '..') for p in path.split('/'))
            or re.search(r'%(2e|2f|5c)', path, re.I)):
        raise ValueError('API 地址的路径无效')
    authority = '[' + host + ']' if ':' in host else host
    if port != (443 if u.scheme == 'https' else 80):
        authority += ':' + str(port)
    origin = u.scheme + '://' + authority
    return Target(origin + path, origin, u.scheme, host, port, path)


def url_origin(url):
    """Pure syntax normalization, independent of trust/DNS; None if invalid."""
    try:
        return _parse_url(url).origin
    except (ValueError, TypeError):
        return None


def parse_model_url(url, trusted_origins):
    """Normalize a base and apply origin policy without accessing the network."""
    target = _parse_url(url)
    target.trusted = target.origin in trusted_origins
    if target.scheme != 'https' and not (target.trusted and target.host in LOOPBACK_HOSTS):
        raise ValueError('API 地址必须使用 HTTPS（服务器预置的本机网关除外）')
    if not target.trusted:
        try:
            ipaddress.ip_address(target.host)
        except ValueError:
            pass
        else:
            raise ValueError('API 地址请填写域名，不支持直接填写 IP')
        if (not _HOST_RE.fullmatch(target.host) or target.host == 'localhost'
                or target.host.endswith(_RESERVED_SUFFIXES)):
            raise ValueError('API 地址的域名无效或属于内部保留名称')
    return target


def _public_ip(address):
    ip = ipaddress.ip_address(address)
    if ip.version == 6:
        if ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        elif ip in _NAT64:
            ip = ipaddress.IPv4Address(int(ip) & 0xffffffff)
    deny = _V4_DENY if ip.version == 4 else _V6_DENY
    return ip.is_global and not any(ip in network for network in deny)


def _MODEL_RESOLVE(host, port):
    return [(family, sockaddr) for family, _, _, _, sockaddr in socket.getaddrinfo(
        host, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
    )]


def _MODEL_CONNECT(family, sockaddr, timeout):
    sock = socket.socket(family, socket.SOCK_STREAM, socket.IPPROTO_TCP)
    try:
        sock.settimeout(timeout)
        sock.connect(sockaddr)
        return sock
    except BaseException:
        sock.close()
        raise


def _MODEL_SSL_CONTEXT():
    return ssl.create_default_context()


def _remaining(deadline):
    left = deadline - time.monotonic()
    if left <= 0:
        raise TimeoutError('模型接口请求超时')
    return max(left, 0.001)


def resolve_model_target(url, trusted_origins, *, deadline=None):
    """Resolve once, keep numeric sockaddrs, and reject the entire mixed answer."""
    if deadline is None:
        deadline = time.monotonic() + _DEADLINE_SECONDS
    target = parse_model_url(url, trusted_origins)
    future = _RESOLVER_POOL.submit(_MODEL_RESOLVE, target.host, target.port)
    try:
        answers = future.result(timeout=min(_remaining(deadline), _DNS_WAIT_SECONDS))
    except (OSError, concurrent.futures.TimeoutError):
        # Cancellation removes queued jobs, but cannot interrupt an active resolver.
        future.cancel()
        raise ValueError(_DNS_ERROR) from None
    seen = set()
    for family, sockaddr in answers:
        if family not in (socket.AF_INET, socket.AF_INET6):
            raise ValueError(_ADDRESS_ERROR)
        if (len(sockaddr) != (4 if family == socket.AF_INET6 else 2)
                or '%' in sockaddr[0] or (family == socket.AF_INET6 and sockaddr[3] != 0)):
            raise ValueError(_ADDRESS_ERROR)
        try:
            ip = ipaddress.ip_address(sockaddr[0])
        except ValueError:
            raise ValueError(_ADDRESS_ERROR) from None
        if ip.version != (6 if family == socket.AF_INET6 else 4) or sockaddr[1] != target.port:
            raise ValueError(_ADDRESS_ERROR)
        if ((not target.trusted and not _public_ip(sockaddr[0]))
                or (target.scheme == 'http' and not ip.is_loopback)):
            raise ValueError(_ADDRESS_ERROR)
        pair = (family, sockaddr)
        if pair not in seen:
            seen.add(pair)
            target.addrs.append(pair)
    if not target.addrs:
        raise ValueError(_DNS_ERROR)
    return target


class _PinnedHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = self._pinned_socket


class _PinnedHTTPS(http.client.HTTPSConnection):
    def connect(self):
        self.sock = self._pinned_socket


class _Watchdog:
    """Keep ownership even when HTTPResponse detaches a connection-close socket."""

    def __init__(self, deadline, sock):
        self.lock = threading.Lock()
        self.sockets = [sock]
        self.expired = False
        self.timer = threading.Timer(_remaining(deadline), self.expire)
        self.timer.daemon = True
        self.timer.start()

    @staticmethod
    def close_socket(sock):
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        finally:
            sock.close()

    def watch(self, sock):
        with self.lock:
            if self.expired:
                self.close_socket(sock)
                raise TimeoutError('模型接口请求超时')
            self.sockets.append(sock)

    def expire(self):
        with self.lock:
            self.expired = True
            for sock in self.sockets:
                self.close_socket(sock)

    def close(self):
        self.timer.cancel()
        with self.lock:
            for sock in self.sockets:
                sock.close()


def _request_json(base, key, trusted_origins, suffix, *, content=None, timeout=None, max_body=None, image_request_id=None, content_type='application/json'):
    """Use one pinned connection; never retry a request after sending it."""
    max_body = _MAX_BODY if max_body is None else max_body
    limit = 90.0 if image_request_id is not None and suffix in ('/images/generations', '/images/edits') else _DEADLINE_SECONDS
    budget = limit if timeout is None else min(float(timeout), limit)
    if not 0 < budget <= limit:
        raise ValueError('invalid model request timeout')
    deadline = time.monotonic() + budget
    target = resolve_model_target(base, trusted_origins, deadline=deadline)
    sock = None
    conn = response = watchdog = None
    try:
        for family, sockaddr in target.addrs:
            timeout = _remaining(deadline)
            try:
                sock = _MODEL_CONNECT(family, sockaddr, timeout)
                break
            except ssl.SSLError:
                raise
            except OSError:
                if (family, sockaddr) == target.addrs[-1]:
                    raise
        watchdog = _Watchdog(deadline, sock)
        if target.scheme == 'https':
            context = _MODEL_SSL_CONTEXT()
            if not context.check_hostname or context.verify_mode != ssl.CERT_REQUIRED:
                raise ssl.SSLError('TLS certificate and hostname verification are required')
            sock.settimeout(_remaining(deadline))
            wrapped = context.wrap_socket(sock, server_hostname=target.host,
                                          do_handshake_on_connect=False)
            watchdog.watch(wrapped)
            sock = wrapped
            sock.settimeout(_remaining(deadline))
            sock.do_handshake()
            conn = _PinnedHTTPS(target.host, target.port, context=context)
        else:
            conn = _PinnedHTTP(target.host, target.port)
        conn.auto_open = 0
        conn._pinned_socket = sock
        conn.connect()
        sock.settimeout(_remaining(deadline))
        headers = {
            'Authorization': 'Bearer ' + key,
            'Accept': 'application/json',
            'User-Agent': 'Jadmin-model-check',
        }
        if content is not None:
            headers['Content-Type'] = content_type
        if image_request_id is not None:
            if not re.fullmatch(r'[a-f0-9-]{36}', image_request_id):
                raise ValueError('invalid image request ID')
            headers['X-Client-Request-Id'] = image_request_id
        conn.request('GET' if content is None else 'POST', target.path + suffix,
                     body=content, headers=headers)
        sock.settimeout(_remaining(deadline))
        response = conn.getresponse()
        if response.status != 200:
            raise HTTPError(target.base + suffix, response.status,
                            'redirect refused' if 300 <= response.status < 400
                            else (response.reason or 'HTTP error'), response.msg, None)
        body = bytearray()
        while True:
            sock.settimeout(_remaining(deadline))
            chunk = response.read(min(_CHUNK_SIZE, max_body + 1 - len(body)))
            _remaining(deadline)
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > max_body:
                raise RuntimeError(_BODY_ERROR)
        try:
            payload = json.loads(body)
        except ValueError:
            raise RuntimeError('model list is not JSON') from None
        if not isinstance(payload, dict):
            raise RuntimeError('model list is not an object')
        _remaining(deadline)
        return payload
    except Exception:
        if watchdog is not None and watchdog.expired:
            raise TimeoutError('模型接口请求超时') from None
        raise
    finally:
        if response is not None:
            response.close()
        if conn is not None:
            conn.close()
        if watchdog is not None:
            watchdog.close()
        if sock is not None:
            sock.close()


def fetch_models(base, key, trusted_origins, *, timeout=None):
    """Fetch model ids once; only TCP refusal can advance to the next address."""
    payload = _request_json(base, key, trusted_origins, '/models', timeout=timeout)
    return list(dict.fromkeys(m['id'] for m in payload.get('data', [])
                              if isinstance(m, dict) and isinstance(m.get('id'), str)))


def probe_chat_model(base, key, model, trusted_origins, *, timeout=None):
    if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,127}', model):
        raise ValueError('invalid model id')
    content = json.dumps({'model': model, 'messages': [{'role': 'user', 'content': 'Reply OK.'}],
                          'max_tokens': 1, 'stream': False}).encode('ascii')
    payload = _request_json(base, key, trusted_origins, '/chat/completions', content=content,
                            timeout=timeout, max_body=64 * 1024)
    choices = payload.get('choices')
    if 'error' in payload or not isinstance(choices, list) or not any(
            isinstance(choice, dict) and isinstance(choice.get('message'), dict)
            and choice['message'].get('role') == 'assistant'
            and isinstance(choice['message'].get('content'), str)
            and choice['message']['content'].strip()
            for choice in choices):
        raise RuntimeError('invalid chat completion')
    return True
