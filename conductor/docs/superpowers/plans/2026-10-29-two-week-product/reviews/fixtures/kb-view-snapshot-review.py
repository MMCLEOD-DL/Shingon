"""Deterministic real-PostgreSQL review probe for search/viewRevision snapshot coherence.

Run with the installed knowledge package and disposable TEST_DATABASE_URL. Exit 1 means
pre-revocation evidence is labelled with the post-revocation revision. No model/HTTP/cache
implementation is involved; a second connection commits exactly between service statements.
"""
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parents[7]
sys.path.insert(0, str(ROOT / 'knowledge/tests'))
from support import CORPUS, ServiceTestCase
from shingon_knowledge import KnowledgeService, contract
from shingon_knowledge.db import connect


class Scenario(ServiceTestCase):
    pass


Scenario.setUpClass()
other = None
try:
    scenario = Scenario
    kb, cred = scenario.kb, scenario.creds['alice']
    kb.sync('revision-review', CORPUS, scenario.manifest['sources'], complete=list(scenario.manifest['collections']))
    protected = 'acme/salary-bands.docx'
    query = 'salary band Senior Analyst'
    isolation = kb.db.execute('SHOW transaction_isolation').fetchone()[0]
    control = kb.search(cred, query, limit=20)
    assert any(row['documentId'] == protected for row in control['results'])
    before = control['viewRevision']
    u = urlparse(os.environ['TEST_DATABASE_URL'])
    other = connect(urlunparse(u._replace(path='/' + scenario.dbname)))
    counterpart = KnowledgeService(other, kb.originals)

    class BetweenStatements:
        fired = False

        def execute(self, sql, params=None):
            if sql.startswith('INSERT INTO audit') and not self.fired:
                self.fired = True
                # The search rows have already been fetched. Commit a real directory revocation
                # before this request asks for its revision, without changing either query/result.
                counterpart.set_group_members('acme', 'finance', [])
            return kb.db.execute(sql, params)

        def __getattr__(self, name):
            return getattr(kb.db, name)

        def commit(self):
            return kb.db.commit()

    consistent_control = '--repeatable-read-control' in sys.argv
    if consistent_control:
        kb.db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    bridge = BetweenStatements()
    raced = KnowledgeService(bridge, kb.originals).search(cred, query, limit=20)
    assert bridge.fired
    fresh = kb.search(cred, query, limit=20)
    contract.check_search_body(contract.search_body(raced))
    assert fresh['viewRevision'] != before
    assert not any(row['documentId'] == protected for row in fresh['results'])
    retained = any(row['documentId'] == protected for row in raced['results'])
    mislabeled = retained and raced['viewRevision'] == fresh['viewRevision']
    if consistent_control:
        assert raced['viewRevision'] == before, 'consistent snapshot must retain the pre-revocation revision'
        assert not mislabeled
    print(json.dumps({'case': 'revocation between candidates and revision', 'isolation': 'repeatable read' if consistent_control else isolation,
                      'positive_control_contains_document': True, 'fresh_search_contains_document': False,
                      'raced_search_contains_document': retained,
                      'raced_revision_matches_current_revoked_view': raced['viewRevision'] == fresh['viewRevision'],
                      'wire_checker_accepts': True, 'result': 'REPRODUCED' if mislabeled else 'NOT_REPRODUCED'}))
    raise SystemExit(1 if mislabeled else 0)
finally:
    if other is not None:
        other.close()
    Scenario.tearDownClass()
