"""What a result says about other documents never reveals what the caller cannot see.

- References (Codex review KB-R3): a real two-principal database regression, where the successor of a public,
  superseded policy is restricted.
- Chunk ids (Codex review decision 1): opaque random ids, not the internal serial, whose gaps would show how much was
  ingested under ACLs the caller does not hold.
- The view revision (Codex review decision 1): it moves only when the caller's own view changes.
- One snapshot per read (Codex review KB-R5): a change committed part-way through a read never pairs the old
  evidence with the new revision. Two real connections; the second commits between the first one's statements."""
import copy
import unittest
from urllib.parse import urlparse, urlunparse

from shingon_knowledge import KnowledgeService, NotFound, contract
from shingon_knowledge.db import connect

from support import COLLECTIONS, CORPUS, ServiceTestCase, admin_url

OLD = 'acme/travel-policy-2025.pdf'
NEW = 'acme/expenses-policy.docx'


class SupersedingDocumentPrivacy(ServiceTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        sources = copy.deepcopy(cls.manifest['sources'])
        for s in sources:
            if s['key'] == NEW:
                s['acl'] = {'groups': ['finance']}  # alice is in finance, andy is not
        cls.kb.sync('run-1', CORPUS, sources, complete=COLLECTIONS)

    def hit(self, who):
        res = self.kb.search(self.creds[who], 'hotel cap London per night', limit=20)
        return next(r for r in res['results'] if r['documentId'] == OLD), res

    def test_a_caller_who_cannot_see_the_successor_is_not_told_its_name(self):
        hit, res = self.hit('andy')
        self.assertIsNone(hit['flags']['supersededBy'])
        self.assertNotIn(NEW, repr(contract.search_body(res)))

    def test_a_caller_who_can_see_the_successor_still_is(self):
        hit, _res = self.hit('alice')
        self.assertEqual(hit['flags']['supersededBy'], NEW)

    def test_the_superseded_document_is_still_ranked_down_for_both(self):
        # Demotion is decided from the stored link, whoever asks, so it is the same for both callers.
        self.assertEqual(self.hit('andy')[0]['scores']['keyword'], self.hit('alice')[0]['scores']['keyword'])



class OpaqueChunkIds(ServiceTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.kb.sync('run-1', CORPUS, cls.manifest['sources'], complete=COLLECTIONS)

    def test_chunk_ids_are_random_not_the_serial(self):
        ids = [r['chunkId'] for r in self.kb.search(self.creds['alice'], 'policy budget travel expenses', limit=20)['results']]
        self.assertGreater(len(ids), 3)
        self.assertEqual(len(set(ids)), len(ids))
        serials = {str(r[0]) for r in self.kb.db.execute('SELECT id FROM chunks').fetchall()}
        for i in ids:
            with self.subTest(chunk=i):
                self.assertRegex(i, r'^[0-9a-f]{64}$')
                self.assertNotIn(i, serials)
        contract.check_search_body(contract.search_body(self.kb.search(self.creds['alice'], 'policy budget')))

    def test_a_new_version_gets_new_ids(self):
        doc = 'standards/logging.md'
        ids = lambda: {r['chunkId'] for r in self.kb.search(self.creds['conductor'], 'standard error logs', limit=20)['results']  # noqa: E731
                       if r['documentId'] == doc}
        before = ids()
        self.kb.sync('run-2', CORPUS, self.manifest['sources'], files={doc: CORPUS / 'standards/api-errors.md'}, complete=COLLECTIONS)
        after = ids()
        self.assertTrue(before and after)
        self.assertFalse(before & after)



class ViewRevision(ServiceTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.kb.sync('run-1', CORPUS, cls.manifest['sources'], complete=COLLECTIONS)

    def rev(self, who):
        return self.kb.search(self.creds[who], 'policy')['viewRevision']

    def test_it_moves_only_for_callers_who_can_see_the_change(self):
        andy, alice, bella = self.rev('andy'), self.rev('alice'), self.rev('bella')
        self.assertNotEqual(andy, alice, 'different views, different revisions')
        # A new version of a finance-only document: alice sees it, andy and another tenant do not.
        self.kb.sync('run-2', CORPUS, self.manifest['sources'], files={'acme/salary-bands.docx': CORPUS / 'acme/expenses-policy.docx'}, complete=COLLECTIONS)
        self.assertEqual(self.rev('andy'), andy)
        self.assertEqual(self.rev('bella'), bella)
        self.assertNotEqual(self.rev('alice'), alice)
        self.assertEqual(self.kb.search(self.creds['andy'], 'policy')['viewRevision'], self.kb.view_revision(self.creds['andy']))

    def test_destination_changes_move_it(self):
        before = self.rev('conductor')
        coll = self.manifest['collections']['standards']
        self.kb.setup({'collections': {'standards': {**coll, 'destinations': ['local-model']}}})
        try:
            self.assertNotEqual(self.rev('conductor'), before)
        finally:
            self.kb.setup({'collections': {'standards': coll}})
        self.assertEqual(self.rev('conductor'), before)

    def test_it_is_a_digest_not_a_counter(self):
        self.assertRegex(self.rev('alice'), r'^[0-9a-f]{64}$')



class Between:
    """A Db that runs `change` once, just before the first statement containing `marker`: a commit from another
    connection landing between this request's own statements."""

    def __init__(self, db, marker, change):
        self.db, self.marker, self.change, self.fired = db, marker, change, False

    def execute(self, sql, params=None):
        if self.marker in sql and not self.fired:
            self.fired = True
            self.change()
        return self.db.execute(sql, params)

    def __getattr__(self, name):
        return getattr(self.db, name)


class SnapshotCoherence(ServiceTestCase):
    SALARY = 'acme/salary-bands.docx'

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.kb.sync('run-1', CORPUS, cls.manifest['sources'], complete=COLLECTIONS)
        u = urlparse(admin_url())
        cls.other = KnowledgeService(connect(urlunparse(u._replace(path='/' + cls.dbname))), cls.kb.originals)

    @classmethod
    def tearDownClass(cls):
        cls.other.db.close()
        super().tearDownClass()

    def setUp(self):
        # Each test starts from the manifest's state: alice in finance, the salary document's own text.
        self.kb.set_group_members('acme', 'finance', ['alice'])
        self.kb.sync('run-reset', CORPUS, [s for s in self.manifest['sources'] if s['key'] == self.SALARY], complete=[])

    def raced(self, marker, change):
        db = Between(self.kb.db, marker, change)
        return KnowledgeService(db, self.kb.originals), db

    def revoke(self):
        self.other.set_group_members('acme', 'finance', [])

    def salary(self, res):
        return [r for r in res['results'] if r['documentId'] == self.SALARY]

    def test_a_revocation_mid_search_keeps_the_old_revision_with_the_old_evidence(self):
        before = self.kb.search(self.creds['alice'], 'salary band Senior Analyst', limit=20)
        kb, db = self.raced('INSERT INTO audit', self.revoke)
        raced = kb.search(self.creds['alice'], 'salary band Senior Analyst', limit=20)
        fresh = self.kb.search(self.creds['alice'], 'salary band Senior Analyst', limit=20)
        self.assertTrue(db.fired and self.salary(before) and self.salary(raced))
        self.assertEqual(raced['viewRevision'], before['viewRevision'], 'old evidence keeps the old revision')
        self.assertFalse(self.salary(fresh))
        self.assertNotEqual(fresh['viewRevision'], raced['viewRevision'], 'so a cache keyed on it cannot reuse it')

    def test_a_replacement_mid_search_keeps_the_old_revision_with_the_old_version(self):
        before = self.kb.search(self.creds['alice'], 'salary band Senior Analyst', limit=20)
        old = self.salary(before)[0]['versionId']
        swap = lambda: self.other.sync('run-swap', CORPUS, [s for s in self.manifest['sources'] if s['key'] == self.SALARY],  # noqa: E731
                                       files={self.SALARY: CORPUS / 'acme/expenses-policy.docx'}, complete=[])
        kb, db = self.raced('INSERT INTO audit', swap)
        raced = kb.search(self.creds['alice'], 'salary band Senior Analyst', limit=20)
        self.assertTrue(db.fired)
        self.assertEqual({r['versionId'] for r in self.salary(raced)}, {old})
        self.assertEqual(raced['viewRevision'], before['viewRevision'])
        self.assertNotEqual(self.kb.view_revision(self.creds['alice']), raced['viewRevision'], 'the new version is a new view')

    def test_collections_and_passages_read_one_snapshot_too(self):
        counts = self.kb.collections(self.creds['alice'])
        kb, db = self.raced('encode(sha256', self.revoke)
        raced = kb.collections(self.creds['alice'])
        self.assertTrue(db.fired)
        self.assertEqual((raced['collections'], raced['viewRevision']), (counts['collections'], counts['viewRevision']))
        self.kb.set_group_members('acme', 'finance', ['alice'])
        hit = self.salary(self.kb.search(self.creds['alice'], 'salary band Senior Analyst', limit=20))[0]
        before = self.kb.view_revision(self.creds['alice'])
        kb, db = self.raced('INSERT INTO audit', self.revoke)
        passage = kb.passage(self.creds['alice'], hit['chunkId'])
        self.assertTrue(db.fired)
        self.assertEqual((passage['documentId'], passage['viewRevision']), (self.SALARY, before))
        with self.assertRaises(NotFound):
            self.kb.passage(self.creds['alice'], hit['chunkId'])


if __name__ == '__main__':
    unittest.main()
