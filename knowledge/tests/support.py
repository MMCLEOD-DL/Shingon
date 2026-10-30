"""Test support: a fresh database per test class (from TEST_DATABASE_URL, a role allowed to CREATE DATABASE),
the committed synthetic corpus, and an independent permission oracle computed from the manifest alone."""
from __future__ import annotations

import copy
import json
import os
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from shingon_knowledge import Credential, KnowledgeService
from shingon_knowledge.db import connect

FIXTURES = Path(__file__).parent / 'fixtures'
CORPUS = FIXTURES / 'corpus'
# Every collection in the committed manifest: a sync of the whole manifest lists each of them in full.
COLLECTIONS = list(json.loads((CORPUS / 'manifest.json').read_text(encoding='utf-8'))['collections'])
FAILING = {'acme/receipts-guidance-scan.pdf', 'acme/board-minutes-locked.pdf', 'acme/installer.bin'}


def admin_url() -> str:
    url = os.environ.get('TEST_DATABASE_URL')
    if not url:
        raise unittest.SkipTest('TEST_DATABASE_URL is not set: point it at a PostgreSQL role that may CREATE DATABASE.')
    return url


class ServiceTestCase(unittest.TestCase):
    """Each test class gets its own database and originals folder, and a service configured from the manifest."""

    @classmethod
    def setUpClass(cls):
        base = admin_url()
        cls.dbname = f'kbtest_{uuid.uuid4().hex[:12]}'
        cls._admin = connect(base)
        cls._admin.conn.autocommit = True
        cls._admin.execute(f'CREATE DATABASE {cls.dbname}')
        u = urlparse(base)
        cls.db = connect(urlunparse(u._replace(path='/' + cls.dbname)))
        cls.work = Path(tempfile.mkdtemp(prefix='kb-test-'))
        cls.manifest = json.loads((CORPUS / 'manifest.json').read_text(encoding='utf-8'))
        cls.kb = KnowledgeService(cls.db, cls.work / 'originals')
        cls.kb.setup(cls.manifest)
        cls.creds = {
            'alice': Credential('app:acme/alice', 'acme', 'alice'),
            'andy': Credential('app:acme/andy', 'acme', 'andy'),
            'bella': Credential('app:birch/bella', 'birch', 'bella'),
            'conductor': cls.kb.issue_project_token('conductor:test', ['standards']),
        }

    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        cls._admin.execute(f'DROP DATABASE IF EXISTS {cls.dbname} WITH (FORCE)')
        cls._admin.close()
        shutil.rmtree(cls.work, ignore_errors=True)


class Oracle:
    """Which sources each credential may see, from the manifest state alone (never from the database)."""

    def __init__(self, manifest: dict):
        self.m = copy.deepcopy(manifest)
        self.deleted: set[str] = set()
        self.failed = set(FAILING)

    def visible(self, cred: Credential, key: str) -> bool:
        src = next(s for s in self.m['sources'] if s['key'] == key)
        coll = self.m['collections'][src['collection']]
        if coll['tenant'] != cred.tenant or (cred.collections and src['collection'] not in cred.collections):
            return False
        if key in self.deleted or key in self.failed:
            return False
        acl = src.get('acl')
        if not acl:
            return True
        groups = {g for g, ms in self.m['tenants'][cred.tenant]['groups'].items() if cred.principal in ms}
        return cred.principal in acl.get('principals', []) or bool(groups & set(acl.get('groups', [])))


class ApiClient:
    """Calls a running K6 server as each test caller would: a project token, or an app token plus a freshly signed
    user assertion on every request. `who=None` sends no credential."""

    def __init__(self, port: int, callers: dict):
        self.port, self.callers = port, callers  # who -> (token, assertion key or None, tenant, user)

    def request(self, who, method, path, *, body=None, raw=None, request_id=None, headers=None):
        import http.client
        import time
        from shingon_knowledge import auth
        h = dict(headers or {})
        if request_id:
            h['X-Request-Id'] = request_id
        if who is not None:
            token, key, tenant, user = self.callers[who]
            h['Authorization'] = f'Bearer {token}'
            if key:
                h['KB-User-Assertion'] = auth.sign_assertion(key, tenant, user, expires_at=int(time.time()) + 60)
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        if data is not None:
            h['Content-Type'] = 'application/json'
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        try:
            conn.request(method, '/kb/v1' + path, body=data, headers=h)
            resp = conn.getresponse()
            return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
        finally:
            conn.close()


def start_api(test: type, *, limiter=None, connect_db=None):
    """Starts a K6 server for a ServiceTestCase class on a free loopback port, with its own connection per request.
    Returns (server, port); stop it with server.shutdown(); server.server_close()."""
    import threading
    from shingon_knowledge.http import Api, make_server
    u = urlparse(admin_url())
    url = urlunparse(u._replace(path='/' + test.dbname))
    api = Api(connect_db or (lambda: connect(url)), test.kb.originals, limiter=limiter)
    server = make_server(api, '127.0.0.1', 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def issue_http_callers(db) -> dict:
    """Real credentials for the four fixture callers: who -> (token, assertion key, tenant, user)."""
    from shingon_knowledge import auth
    acme, acme_key = auth.issue_app_credential(db, 'app:acme', 'acme')
    birch, birch_key = auth.issue_app_credential(db, 'app:birch', 'birch')
    return {'alice': (acme, acme_key, 'acme', 'alice'), 'andy': (acme, acme_key, 'acme', 'andy'),
            'bella': (birch, birch_key, 'birch', 'bella'),
            'conductor': (auth.issue_project_credential(db, 'conductor:test-http', ['standards']), None, 'company', None)}
