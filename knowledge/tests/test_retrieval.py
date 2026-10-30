"""The 25 labelled questions (tests/fixtures/questions.json) against keyword retrieval with superseded demotion.

The known misses are pinned, so both a regression and an improvement fail loudly and must be acknowledged:
  - q16, q18: 'weak' instead of 'none' (keyword scores cannot separate topical overlap from no evidence; K4's
    calibrated reranker is the fix)
  - q24, q25: paraphrases share no words with their passage (K3 hybrid retrieval is the fix)
Questions about permissions and scope (restricted, scope, cross-tenant) must always all be correct.
"""
import json
import unittest

from support import COLLECTIONS, CORPUS, FIXTURES, ServiceTestCase

QUESTIONS = json.loads((FIXTURES / 'questions.json').read_text(encoding='utf-8'))['questions']
KNOWN_MISSES = {'q16', 'q18', 'q24', 'q25'}
MUST_BE_PERFECT = {'restricted', 'scope', 'cross-tenant'}


def correct(q: dict, res: dict) -> bool:
    keys = [r['documentId'] for r in res['results']]
    if q['expect'] == 'none':
        return res['evidence'] == 'none'
    exp = q['expect']
    if not keys or keys[0] != exp['key'] or res['evidence'] == 'none':
        return False
    top = res['results'][0]
    if 'version' in exp and top['versionId'] != exp['version']:
        return False
    if any(top['locator'].get(k) != v for k, v in exp.get('locator', {}).items()):
        return False
    if 'mustFlagInstructionLike' in q and not top['flags']['instructionLike']:
        return False
    if 'mustFlagSuperseded' in q and not all(r['flags']['supersededBy'] for r in res['results'] if r['documentId'] == q['mustFlagSuperseded']):
        return False
    return True


class Retrieval(ServiceTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.kb.sync('run-1', CORPUS, cls.manifest['sources'], files={'acme/expenses-policy.docx': CORPUS / 'acme/_v1-expenses-policy.docx'}, complete=COLLECTIONS)
        cls.kb.sync('run-2', CORPUS, cls.manifest['sources'], complete=COLLECTIONS)
        cls.outcomes = {q['id']: correct(q, cls.kb.search(cls.creds[q['cred']], q['query'])) for q in QUESTIONS}

    def test_the_labelled_set_matches_the_recorded_baseline(self):
        misses = {qid for qid, ok in self.outcomes.items() if not ok}
        self.assertEqual(misses, KNOWN_MISSES,
                         'Retrieval changed. New misses are regressions; questions leaving KNOWN_MISSES are improvements: '
                         'update the list and conductor/docs/knowledge-base/evaluation.md together.')

    def test_permission_and_scope_questions_are_all_correct(self):
        for q in QUESTIONS:
            if q['category'] in MUST_BE_PERFECT:
                with self.subTest(q=q['id']):
                    self.assertTrue(self.outcomes[q['id']], q['query'])

    def test_citations_name_version_and_locator(self):
        r = self.kb.search(self.creds['alice'], 'Sales travel budget Q3')['results'][0]
        self.assertEqual((r['documentId'], r['versionId'], r['locator']), ('acme/budget-2026.xlsx', 1, {'sheet': 'Budget', 'cellRange': 'A4:E4'}))

    def test_bad_requests_are_refused(self):
        for bad in ({'query': ''}, {'query': 'x' * 1001}, {'query': 'ok', 'limit': 0}, {'query': 'ok', 'limit': 21}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.kb.search(self.creds['alice'], bad['query'], limit=bad.get('limit', 8))


if __name__ == '__main__':
    unittest.main()
