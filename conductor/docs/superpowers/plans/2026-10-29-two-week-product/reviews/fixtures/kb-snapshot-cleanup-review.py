"""PR44 rollback/reuse control on disposable PostgreSQL, without models or HTTP."""
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[7]
sys.path.insert(0, str(ROOT / 'knowledge/tests'))
from support import CORPUS, ServiceTestCase
from shingon_knowledge import KnowledgeService


class Scenario(ServiceTestCase):
    pass


class InjectedFailure(RuntimeError):
    pass


Scenario.setUpClass()
try:
    kb, cred = Scenario.kb, Scenario.creds['alice']
    kb.sync('rollback-review', CORPUS, Scenario.manifest['sources'], complete=list(Scenario.manifest['collections']))
    before = kb.db.execute('SELECT count(*) FROM audit').fetchone()[0]
    kb.db.commit()

    class FailAfterRevision:
        fired = False

        def execute(self, sql, params=None):
            cursor = kb.db.execute(sql, params)
            if 'SELECT encode(sha256' in sql and not self.fired:
                self.fired = True
                raise InjectedFailure('synthetic failure after audit insert')
            return cursor

        def __getattr__(self, name):
            return getattr(kb.db, name)

    bridge = FailAfterRevision()
    try:
        KnowledgeService(bridge, kb.originals).search(cred, 'salary band Senior Analyst')
    except InjectedFailure:
        pass
    else:
        raise AssertionError('Fault did not reach the read boundary')
    assert bridge.fired
    after = kb.db.execute('SELECT count(*) FROM audit').fetchone()[0]
    assert after == before, 'failed read left its audit insert pending'
    isolation = kb.db.execute('SHOW transaction_isolation').fetchone()[0]
    assert isolation == 'read committed', 'per-request isolation leaked past rollback'
    kb.db.commit()
    assert kb.search(cred, 'salary band Senior Analyst')['results']
    print('PASS: failed read rolls back audit; default isolation restored; same connection accepts the next read')
finally:
    Scenario.tearDownClass()
