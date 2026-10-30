"""Credentials for the HTTP layer (K6; retrieval-contract.md §2).

Two kinds, each bound to one tenant:
  - project: a Conductor project's read token, over named reference collections only (§7). No user.
  - app: a Foundation app server's credential. Every request also carries a user assertion the app server signs with
    its assertion key: the user's id and tenant, an expiry at most 5 minutes ahead and a nonce used once. The user
    must exist in that tenant's principals. The audit records both the credential and the user.

Tokens are `kb1.<id>.<secret>`; only sha256(secret) is stored. Every refusal raises the same Unauthenticated, whose
reason is for the server's log only: a caller learns nothing about which part failed.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import time

from .db import Db
from .service import Credential, ScopeError

TOKEN = re.compile(r'^Bearer kb1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$')
NONCE = re.compile(r'^[A-Za-z0-9_-]{16,64}$')
NAME = re.compile(r'^[a-z0-9][a-z0-9:._-]{0,63}$')
MAX_ASSERTION_SECONDS = 300
MAX_ASSERTION_BYTES = 1024


class Unauthenticated(Exception):
    """The request did not prove who it is. Always the same 401; str(exc) is the reason, for the server log only."""


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def _issue(db: Db, name: str, kind: str, tenant: str, collections: list[str], assertion_key: str | None) -> str:
    if not NAME.match(name):
        raise ValueError('A credential name is 1-64 lower-case letters, digits and : . _ -')
    cid, secret = secrets.token_hex(16), secrets.token_urlsafe(32)
    with db.transaction():
        db.execute('INSERT INTO credentials (id, name, kind, tenant_id, collections, secret_sha256, assertion_key) '
                   'VALUES (%s, %s, %s, %s, %s::text[], %s, %s)',
                   (cid, name, kind, tenant, collections, hashlib.sha256(secret.encode()).hexdigest(), assertion_key))
    return f'kb1.{cid}.{secret}'


def issue_project_credential(db: Db, name: str, collections: list[str]) -> str:
    """A Conductor project token over reference collections of one tenant. Returns the token, shown once."""
    rows = db.execute('SELECT id, tenant_id, kind FROM collections WHERE id = ANY(%s::text[])', (list(collections),)).fetchall()
    db.commit()
    if not collections or len(rows) != len(set(collections)) or any(k != 'reference' for _i, _t, k in rows) \
            or len({t for _i, t, _k in rows}) != 1:
        raise ScopeError('A project token may cover reference collections of one tenant only.')
    return _issue(db, name, 'project', rows[0][1], sorted(set(collections)), None)


def issue_app_credential(db: Db, name: str, tenant: str) -> tuple[str, str]:
    """A Foundation app server's credential for one tenant. Returns (token, assertion key), each shown once."""
    if db.execute('SELECT 1 FROM tenants WHERE id = %s', (tenant,)).fetchone() is None:
        db.commit()
        raise ValueError(f'Unknown tenant {tenant}.')
    db.commit()
    key = _b64(secrets.token_bytes(32))
    return _issue(db, name, 'app', tenant, [], key), key


def revoke(db: Db, name: str) -> bool:
    """Revokes a credential at once; its token and assertions are refused from the next request."""
    with db.transaction():
        return db.execute('UPDATE credentials SET revoked_at = now() WHERE name = %s AND revoked_at IS NULL', (name,)).rowcount == 1


def sign_assertion(assertion_key: str, tenant: str, user: str, *, expires_at: int, nonce: str | None = None) -> str:
    """What a Foundation app server sends as the KB-User-Assertion header (here for apps and tests)."""
    payload = _b64(json.dumps({'v': 1, 'tenant': tenant, 'sub': user, 'exp': expires_at,
                               'nonce': nonce or secrets.token_urlsafe(16)}, separators=(',', ':')).encode())
    return f'{payload}.{_b64(hmac.new(_unb64(assertion_key), payload.encode(), hashlib.sha256).digest())}'


def authenticate(db: Db, authorization: str | None, assertion: str | None, *, now: float | None = None) -> Credential:
    """The Credential for a request's Authorization and KB-User-Assertion headers, or Unauthenticated."""
    now = time.time() if now is None else now
    m = TOKEN.match(authorization or '')
    if not m:
        raise Unauthenticated('no well-formed bearer token')
    row = db.execute('SELECT name, kind, tenant_id, collections, secret_sha256, assertion_key, revoked_at IS NOT NULL '
                     'FROM credentials WHERE id = %s', (m.group(1),)).fetchone()
    db.commit()
    if row is None or not hmac.compare_digest(row[4], hashlib.sha256(m.group(2).encode()).hexdigest()):
        raise Unauthenticated('unknown credential or wrong secret')
    name, kind, tenant, collections, _h, key, revoked = row
    if revoked:
        raise Unauthenticated(f'{name} is revoked')
    if kind == 'project':
        if assertion is not None:
            raise Unauthenticated(f'{name} is a project token; it cannot assert a user')
        return Credential(name, tenant, None, tuple(collections))
    return Credential(name, tenant, _user(db, m.group(1), name, tenant, key, assertion, now), tuple(collections))


def _user(db: Db, cid: str, name: str, tenant: str, key: str, assertion: str | None, now: float) -> str:
    if not assertion or len(assertion) > MAX_ASSERTION_BYTES or assertion.count('.') != 1:
        raise Unauthenticated(f'{name} sent no well-formed user assertion')
    payload, signature = assertion.split('.')
    try:
        good = hmac.compare_digest(_unb64(signature), hmac.new(_unb64(key), payload.encode(), hashlib.sha256).digest())
        claims = json.loads(_unb64(payload)) if good else None
    except ValueError as e:
        raise Unauthenticated(f'{name} sent an undecodable assertion') from e
    if claims is None:
        raise Unauthenticated(f'{name} sent an assertion with a bad signature')
    if not isinstance(claims, dict) or set(claims) != {'v', 'tenant', 'sub', 'exp', 'nonce'} or claims['v'] != 1:
        raise Unauthenticated(f'{name} sent an assertion with the wrong fields')
    exp, user, nonce = claims['exp'], claims['sub'], claims['nonce']
    if isinstance(exp, bool) or not isinstance(exp, int) or not now < exp <= now + MAX_ASSERTION_SECONDS:
        raise Unauthenticated(f'{name} sent an expired assertion, or one valid for over {MAX_ASSERTION_SECONDS} s')
    if claims['tenant'] != tenant or not isinstance(user, str) or not isinstance(nonce, str) or not NONCE.match(nonce):
        raise Unauthenticated(f'{name} asserted another tenant, or a malformed user or nonce')
    with db.transaction():
        if db.execute('SELECT 1 FROM principals WHERE tenant_id = %s AND id = %s', (tenant, user)).fetchone() is None:
            raise Unauthenticated(f'{name} asserted a user unknown to {tenant}')
        db.execute('DELETE FROM assertion_nonces WHERE expires_at < to_timestamp(%s)', (now,))
        fresh = db.execute('INSERT INTO assertion_nonces VALUES (%s, %s, to_timestamp(%s)) ON CONFLICT DO NOTHING',
                           (cid, nonce, exp)).rowcount == 1
    if not fresh:
        raise Unauthenticated(f'{name} replayed an assertion nonce')
    return user
