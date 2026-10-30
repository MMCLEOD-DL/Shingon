"""What a result says about other documents never reveals what the caller cannot see.

- References (Codex review KB-R3): a real two-principal database regression, where the successor of a public,
  superseded policy is restricted.
- Chunk ids (Codex review decision 1): opaque random ids, not the internal serial, whose gaps would show how much was
  ingested under ACLs the caller does not hold.
- The view revision (Codex review decision 1): it moves only when the caller's own view changes."""
import copy
import unittest

from shingon_knowledge import contract

from support import CORPUS, ServiceTestCase

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
        cls.kb.sync('run-1', CORPUS, sources)

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
        cls.kb.sync('run-1', CORPUS, cls.manifest['sources'])

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
        self.kb.sync('run-2', CORPUS, self.manifest['sources'], files={doc: CORPUS / 'standards/api-errors.md'})
        after = ids()
        self.assertTrue(before and after)
        self.assertFalse(before & after)



class ViewRevision(ServiceTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.kb.sync('run-1', CORPUS, cls.manifest['sources'])

    def rev(self, who):
        return self.kb.search(self.creds[who], 'policy')['viewRevision']

    def test_it_moves_only_for_callers_who_can_see_the_change(self):
        andy, alice, bella = self.rev('andy'), self.rev('alice'), self.rev('bella')
        self.assertNotEqual(andy, alice, 'different views, different revisions')
        # A new version of a finance-only document: alice sees it, andy and another tenant do not.
        self.kb.sync('run-2', CORPUS, self.manifest['sources'], files={'acme/salary-bands.docx': CORPUS / 'acme/expenses-policy.docx'})
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


if __name__ == '__main__':
    unittest.main()
