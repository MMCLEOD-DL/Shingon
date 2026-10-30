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
