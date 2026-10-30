"""References from a visible result to another document never name a document the caller cannot see (Codex review
KB-R3). A real two-principal database regression: the successor of a public, superseded policy is restricted."""
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


if __name__ == '__main__':
    unittest.main()
