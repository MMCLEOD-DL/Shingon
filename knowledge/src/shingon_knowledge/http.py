"""The HTTP API (K6): retrieval-contract.md v1 over HTTP, under /kb/v1, on loopback or a private network only.

Api.handle() is the whole behaviour and has no socket in it; serve() puts it behind Python's threading HTTP server.
Every request gets its own database connection, a 5-second statement timeout and the service's one-snapshot reads.
Every JSON body is built and checked by contract.py before it is sent; a body that fails its check is never sent (the
caller gets 503 and the server log the reason). Nothing from an exception reaches a caller.

Routes (paths relative to /kb/v1; each identifier one percent-encoded segment, decoded once):
  GET  /health                                            no credential
  GET  /collections
  POST /search                                            body at most 16 KB; rate limited per credential and user
  GET  /passages/<chunkId>?neighbours=N
  GET  /collections/<c>/documents/<d>/versions/<v>/original   re-authorised after the file is opened, before sending
"""
from __future__ import annotations

import ipaddress
import json
import logging
import math
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import BinaryIO, Callable
from urllib.parse import parse_qs, unquote

from . import auth, contract
from .db import Db
from .service import KnowledgeService, NotFound

log = logging.getLogger('shingon_knowledge.http')

BASE = '/kb/v1'
STATEMENT_TIMEOUT_MS = 5000
BAD_ESCAPE = re.compile(r'%(?![0-9A-Fa-f]{2})')
JSON_HEADERS = {'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store'}


@dataclass
class Response:
    status: int
    headers: dict = field(default_factory=dict)
    body: bytes = b''
    file: BinaryIO | None = None  # an original, streamed after the headers


class RateLimiter:
    """A token bucket per (credential, user): `rate` searches per `per` seconds (retrieval-contract.md §4: 60 a minute).
    In memory, so per server process; a restart forgets it."""

    def __init__(self, rate: int = 60, per: float = 60.0, clock: Callable[[], float] = time.monotonic):
        self.rate, self.per, self.clock, self.lock, self.buckets = rate, per, clock, threading.Lock(), {}

    def take(self, key: tuple) -> int:
        """0 if this search may run now, else the whole seconds until it may."""
        with self.lock:
            now = self.clock()
            tokens, last = self.buckets.get(key, (float(self.rate), now))
            tokens = min(float(self.rate), tokens + (now - last) * self.rate / self.per)
            if tokens >= 1:
                self.buckets[key] = (tokens - 1, now)
                return 0
            self.buckets[key] = (tokens, now)
            return min(contract.MAX_RETRY_AFTER, max(1, math.ceil((1 - tokens) * self.per / self.rate)))


class Api:
    def __init__(self, connect: Callable[[], Db], originals: Path, *, limiter: RateLimiter | None = None,
                 wall: Callable[[], float] = time.time):
        self.connect, self.originals, self.limiter, self.wall = connect, originals, limiter or RateLimiter(), wall

    def handle(self, method: str, target: str, headers, body: Callable[[int], bytes]) -> Response:
        """One request. `headers` is case-insensitive (an http.client.HTTPMessage or similar); `body(n)` reads n bytes."""
        sent_id = headers.get('X-Request-Id')
        request_id = sent_id if sent_id and contract.REQUEST_ID.match(sent_id) else f'kb-{secrets.token_hex(8)}'
        try:
            return self._route(method, target, headers, body, request_id)
        except _Refusal as r:
            return self._error(r.code, r.request_id or request_id, r.retry_after)

    def _route(self, method, target, headers, body, request_id) -> Response:
        path, _, query = target.partition('?')
        if not path.startswith(BASE + '/') or BAD_ESCAPE.search(path):
            raise _Refusal('not-found' if not BAD_ESCAPE.search(path) else 'bad-request')
        try:
            parts = [unquote(p, errors='strict') for p in path[len(BASE) + 1:].split('/')]
        except UnicodeDecodeError:
            raise _Refusal('bad-request') from None
        if any(not p for p in parts):
            raise _Refusal('not-found')
        if (method, parts) == ('GET', ['health']):
            return self._with_db(lambda kb: self._json(contract.check_health_body, kb.health(), request_id, status=200))
        payload = None
        if method == 'POST':
            payload = self._read_json(headers, body)
            request_id = payload.get('clientRequestId', request_id) if isinstance(payload, dict) and \
                isinstance(payload.get('clientRequestId'), str) and contract.REQUEST_ID.match(payload['clientRequestId']) else request_id
        return self._with_db(lambda kb: self._authorised(kb, method, parts, query, headers, payload, request_id), request_id)

    def _authorised(self, kb, method, parts, query, headers, payload, request_id) -> Response:
        try:
            cred = auth.authenticate(kb.db, headers.get('Authorization'), headers.get('KB-User-Assertion'), now=self.wall())
        except auth.Unauthenticated as e:
            log.info('401 %s: %s', request_id, e)
            raise _Refusal('unauthenticated', request_id) from None
        try:
            if (method, parts) == ('GET', ['collections']):
                return self._json(contract.check_collections_body, contract.collections_body(kb.collections(cred)), request_id)
            if (method, parts) == ('POST', ['search']):
                args = contract.parse_search_request(payload)
                wait = self.limiter.take((cred.name, cred.principal))
                if wait:
                    raise _Refusal('rate-limit', request_id, wait)
                raw = kb.search(cred, args['query'], limit=args['limit'], collections=args['collections'])
                return self._json(contract.check_search_body, contract.search_body(raw), request_id)
            if method == 'GET' and len(parts) == 2 and parts[0] == 'passages':
                neighbours = parse_qs(query, keep_blank_values=True).get('neighbours', [None])
                if len(neighbours) != 1:
                    raise ValueError('bad-request')
                raw = kb.passage(cred, parts[1], contract.parse_neighbours(neighbours[0]))
                return self._json(contract.check_passage_body, contract.passage_body(raw), request_id)
            if method == 'GET' and len(parts) == 7 and (parts[0], parts[2], parts[4], parts[6]) == \
                    ('collections', 'documents', 'versions', 'original'):
                return self._original(kb, cred, parts[1], parts[3], parts[5], request_id)
        except _Refusal:
            raise
        except (ValueError, NotFound, PermissionError) as e:
            raise _Refusal(contract.error_code(e), request_id) from None
        raise _Refusal('not-found', request_id)

    def _original(self, kb, cred, collection, key, version, request_id) -> Response:
        if not version.isdigit() or version.startswith('0'):
            raise NotFound('not-found')
        path = kb.original(cred, collection, key, int(version))
        try:
            f = open(path, 'rb')
        except FileNotFoundError:
            raise NotFound('not-found') from None
        try:
            # Re-authorise now the file is open: a revocation that landed since the first check stops the delivery.
            if kb.original(cred, collection, key, int(version), audit=False) != path:
                raise NotFound('not-found')
            size = Path(path).stat().st_size
        except BaseException:
            f.close()
            raise
        headers = {**contract.original_headers(key), 'Content-Length': str(size), 'X-Request-Id': request_id}
        contract.check_original_response(200, {k: headers[k] for k in contract.ORIGINAL_HEADERS}, key)
        return Response(200, headers, file=f)

    def _read_json(self, headers, body):
        if headers.get('Transfer-Encoding'):
            raise _Refusal('bad-request')
        length = headers.get('Content-Length')
        if length is None or not length.isdigit():
            raise _Refusal('bad-request')
        if int(length) > contract.MAX_REQUEST_BYTES:
            raise _Refusal('too-large')
        try:
            return json.loads(body(int(length)).decode('utf-8'), parse_constant=_no_constant)
        except (UnicodeDecodeError, ValueError):
            raise _Refusal('bad-request') from None

    def _with_db(self, work, request_id=None) -> Response:
        try:
            db = self.connect()
        except Exception:  # noqa: BLE001 - any failure to reach the index is the same outage to the caller
            log.exception('503 %s: no database connection', request_id)
            raise _Refusal('index-unavailable', request_id) from None
        try:
            db.execute(f'SET statement_timeout = {STATEMENT_TIMEOUT_MS}')
            db.commit()
            return work(KnowledgeService(db, self.originals))
        except _Refusal:
            raise
        except Exception:  # noqa: BLE001 - a fault or timeout is an outage, never a guess at an answer
            log.exception('503 %s', request_id)
            raise _Refusal('index-unavailable', request_id) from None
        finally:
            try:
                db.close()
            except Exception:  # noqa: BLE001
                pass

    def _json(self, check, body, request_id, status=200) -> Response:
        try:
            check(status, body) if check is contract.check_health_body else check(body)
        except contract.ContractError as e:
            log.error('503 %s: refusing to send a body that breaks the contract: %s', request_id, e)
            raise _Refusal('index-unavailable', request_id) from None
        return Response(status, {**JSON_HEADERS, 'X-Request-Id': request_id}, json.dumps(body, ensure_ascii=False).encode())

    def _error(self, code, request_id, retry_after=None) -> Response:
        status, body = contract.error_body(code, request_id, retry_after=retry_after)
        headers = {**JSON_HEADERS, 'X-Request-Id': request_id}
        if retry_after is not None:
            headers['Retry-After'] = str(retry_after)
        return Response(status, headers, json.dumps(body, ensure_ascii=False).encode())


class _Refusal(Exception):
    def __init__(self, code: str, request_id: str | None = None, retry_after: int | None = None):
        super().__init__(code)
        self.code, self.request_id, self.retry_after = code, request_id, retry_after


def _no_constant(name):
    raise ValueError(f'{name} is not JSON')


def check_bind_address(host: str) -> None:
    """Loopback or a private network only (migration-plan K6). A hostname other than localhost is refused, because
    what it resolves to can change."""
    if host == 'localhost':
        return
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        raise ValueError(f'Bind to an IP address, not {host!r}.') from None
    if not (ip.is_loopback or (ip.is_private and not ip.is_unspecified and not ip.is_link_local)):
        raise ValueError(f'{host} is not a loopback or private address; the knowledge API never listens publicly.')


def make_server(api: Api, host: str = '127.0.0.1', port: int = 8765) -> ThreadingHTTPServer:
    check_bind_address(host)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        timeout = 15

        def version_string(self):  # no Python or library version in the Server header
            return 'shingon-kb'

        def _serve(self):
            reply = api.handle(self.command, self.path, self.headers, self.rfile.read)
            self.send_response(reply.status)
            for k, v in reply.headers.items():
                self.send_header(k, v)
            if reply.file is None:
                self.send_header('Content-Length', str(len(reply.body)))
            self.send_header('Connection', 'close')
            self.end_headers()
            if reply.file is None:
                self.wfile.write(reply.body)
                return
            with reply.file as f:
                while chunk := f.read(64 * 1024):
                    self.wfile.write(chunk)

        # Every method gets the contract's JSON answer (an unknown one is a 401 or 404), never the stock HTML page.
        do_GET = do_POST = do_HEAD = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _serve

        def log_message(self, fmt, *args):  # never logs headers, so never a token or assertion
            log.info('%s %s', self.address_string(), fmt % args)

    return ThreadingHTTPServer((host, port), Handler)
