"""What a result says about other documents never reveals what the caller cannot see.

- References (Codex review KB-R3): a real two-principal database regression, where the successor of a public,
  superseded policy is restricted.
- Chunk ids (Codex review decision 1): opaque random ids, not the internal serial, whose gaps would show how much was
  ingested under ACLs the caller does not hold."""
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


if __name__ == '__main__':
    unittest.main()
