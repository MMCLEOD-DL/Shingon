"""The retrieval contract's fixture set (retrieval-contract.md §10), kept honest against the service.

knowledge/contract/kb-contract-v1.json holds two kinds of fixture:
  - generated: produced here by the real service on the synthetic corpus, through contract.py. This test produces
    them again in a fresh database and fails on any difference, so the file cannot drift from the service.
  - authored: hand-written for behaviour that later layers own (OCR in K5, rate limits and outages in K6, the
    destination report in Conductor, stale sources). They are checked against the wire shape only, and each names
    the task it waits for. They are not evidence that anything implements them.

To regenerate after an intended change:
  KB_WRITE_FIXTURES=1 TEST_DATABASE_URL=... python -m unittest discover -s tests -p test_contract_fixtures.py
then review the diff and update retrieval-contract.md if the contract itself changed.
"""
import json
import os
import unittest
from pathlib import Path

from shingon_knowledge import contract

from support import CORPUS, ServiceTestCase

FILE = Path(__file__).resolve().parents[1] / 'contract' / 'kb-contract-v1.json'
INGESTED_AT = '2026-10-29T12:00:00Z'  # generated fixtures replace the real ingestion time with this
CALLERS = {
    'alice': 'Acme app server, asserted user alice (member of finance)',
    'andy': 'Acme app server, asserted user andy (not in finance)',
    'bella': 'Birch app server, asserted user bella',
    'conductor': 'Conductor project token over the standards collection',
}
# Every §10 item, and the fixtures that cover it.
SECTION_10 = {
    'a normal hit for each format': ['hit-markdown', 'hit-docx', 'hit-pdf', 'hit-xlsx'],
    'evidence: none': ['evidence-none'],
    'a scope violation': ['scope-violation'],
    'a hidden document (404)': ['hidden-document', 'missing-document'],
    'revoked-after-sync': ['revoked-after-sync', 'revoked-original'],
    'stale source': ['stale-source'],
    'conflicting versions': ['superseded-version'],
    'an instruction-like passage': ['instruction-like'],
    'an XLSX cell-range hit': ['hit-xlsx'],
    'a scanned PDF with OCR confidence': ['scanned-pdf-ocr'],
    'index unavailable': ['index-unavailable'],
    'a rate limit': ['rate-limit'],
    'a destination-withheld report from Conductor': ['destination-withheld'],
}


def _search(kb, creds, fid, covers, who, query, *, limit=3, collections=None):
    body = {'query': query, 'mode': 'keyword', 'limit': limit, 'clientRequestId': f'req-{fid}'}
    if collections is not None:
        body['collections'] = collections
    try:
        raw = kb.search(creds[who], query, limit=limit, collections=collections)
        status, out = 200, contract.search_body(raw)
        for r in out['results']:
            r['source']['ingestedAt'] = INGESTED_AT
    except Exception as e:  # noqa: BLE001 - contract.error_code re-raises anything that is not a contract error
        status, out = contract.error_body(contract.error_code(e), f'req-{fid}')
    return {'id': fid, 'covers': covers, 'origin': 'generated', 'caller': CALLERS[who],
            'request': {'method': 'POST', 'path': '/search', 'body': body}, 'response': {'status': status, 'body': out}}


def _original(kb, creds, fid, covers, who, collection, key, version):
    try:
        kb.original(creds[who], collection, key)
        status, out = 200, None  # served as an attachment; no JSON body
    except Exception as e:  # noqa: BLE001
        status, out = contract.error_body(contract.error_code(e), f'req-{fid}')
    path = f"/documents/{key.replace('/', '%2F')}/versions/{version}/original"
    return {'id': fid, 'covers': covers, 'origin': 'generated', 'caller': CALLERS[who],
            'request': {'method': 'GET', 'path': path}, 'response': {'status': status, 'body': out}}


def generate(kb, creds, manifest) -> list[dict]:
    """The generated fixtures, in order. The corpus must be synced as run-1 (expenses v1) then run-2."""
    s = lambda *a, **k: _search(kb, creds, *a, **k)  # noqa: E731
    out = [
        s('hit-markdown', 'Normal hit, Markdown: section path locator', 'conductor', 'what must never be written to logs'),
        s('hit-docx', 'Normal hit, DOCX: section path locator, version 2 after an update', 'alice', 'mileage rate pence per mile own car'),
        s('hit-pdf', 'Normal hit, PDF: page locator', 'alice', 'hotel cap London per night'),
        s('hit-xlsx', 'Normal hit, XLSX: sheet and cell range, stored cell text only', 'alice', 'Sales travel budget Q3'),
        s('evidence-none', 'No support: the caller must abstain', 'alice', 'parental leave entitlement'),
        s('instruction-like', 'Passage that reads like instructions: flagged, still only data', 'conductor', 'release checklist before tagging'),
        s('superseded-version', 'Two documents disagree; the replaced one is flagged and ranked lower', 'alice', 'mileage 45 pence per mile'),
        s('scope-violation', 'A collection outside the credential is refused, never silently dropped', 'alice', 'mileage', collections=['birch-handbook']),
        s('bad-request', 'An empty query is refused', 'alice', ''),
        _original(kb, creds, 'hidden-document', 'A document the caller may not see', 'andy', 'acme-policies', 'acme/salary-bands.docx', 1),
        _original(kb, creds, 'missing-document', 'A document that does not exist: identical to hidden', 'andy', 'acme-policies', 'acme/no-such-file.docx', 1),
    ]
    # Revocation: the next sync no longer lists the 2025 travel policy.
    kb.sync('run-3', CORPUS, [x for x in manifest['sources'] if x['key'] != 'acme/travel-policy-2025.pdf'])
    out += [
        s('revoked-after-sync', 'After the source removed it, the next sync drops its passages and bumps indexGeneration', 'alice', 'hotel cap London per night'),
        _original(kb, creds, 'revoked-original', 'The stored original of a revoked document is gone', 'alice', 'acme-policies', 'acme/travel-policy-2025.pdf', 1),
    ]
    return out


class ContractFixtures(ServiceTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.kb.sync('run-1', CORPUS, cls.manifest['sources'], files={'acme/expenses-policy.docx': CORPUS / 'acme/_v1-expenses-policy.docx'})
        cls.kb.sync('run-2', CORPUS, cls.manifest['sources'])
        cls.generated = generate(cls.kb, cls.creds, cls.manifest)
        committed = json.loads(FILE.read_text()) if FILE.exists() else {'fixtures': []}
        if os.environ.get('KB_WRITE_FIXTURES') == '1':
            authored = [f for f in committed['fixtures'] if f['origin'] != 'generated']
            committed['fixtures'] = cls.generated + authored
            FILE.write_text(json.dumps(committed, indent=2, ensure_ascii=False) + '\n')
        cls.file = committed
        cls.by_id = {f['id']: f for f in committed['fixtures']}

    def test_generated_fixtures_match_the_service(self):
        committed = [f for f in self.file['fixtures'] if f['origin'] == 'generated']
        self.assertEqual([f['id'] for f in committed], [f['id'] for f in self.generated])
        for want, got in zip(committed, self.generated):
            with self.subTest(fixture=want['id']):
                self.assertEqual(want, got, 'The service no longer produces this fixture. If the change is intended, '
                                            'regenerate (see this module) and review the contract.')

    def test_every_fixture_matches_the_wire_shape(self):
        for f in self.file['fixtures']:
            with self.subTest(fixture=f['id']):
                status, body = f['response']['status'], f['response']['body']
                if f.get('kind') == 'conductor-report':
                    contract.check_withheld_report(body)
                elif status == 200 and f['request']['path'] == '/search':
                    contract.check_search_body(body)
                elif status != 200:
                    contract.check_error_body(status, body)
                self.assertIn(f['origin'], ('generated', 'authored'))
                if f['origin'] == 'authored':
                    self.assertTrue(f.get('pendingOn'), 'an authored fixture names the task that will implement it')

    def test_section_10_is_covered(self):
        for item, ids in SECTION_10.items():
            for fid in ids:
                with self.subTest(item=item, fixture=fid):
                    self.assertIn(fid, self.by_id)

    def test_generated_results_say_what_the_fixture_claims(self):
        top = lambda fid: self.by_id[fid]['response']['body']['results'][0]  # noqa: E731
        self.assertEqual(top('hit-markdown')['locator']['sectionPath'][0], 'Logging standard')
        self.assertEqual(top('hit-docx')['versionId'], 2)
        self.assertIsNotNone(top('hit-pdf')['locator']['page'])
        self.assertEqual((top('hit-xlsx')['locator']['sheet'], top('hit-xlsx')['locator']['cellRange']), ('Budget', 'A4:E4'))
        self.assertEqual(self.by_id['evidence-none']['response']['body']['evidence'], 'none')
        self.assertTrue(top('instruction-like')['flags']['instructionLike'])
        sup = self.by_id['superseded-version']['response']['body']['results']
        self.assertEqual(sup[0]['documentId'], 'acme/expenses-policy.docx')
        self.assertTrue(any(r['flags']['supersededBy'] == 'acme/expenses-policy.docx' for r in sup))
        self.assertEqual(self.by_id['scope-violation']['response']['status'], 403)

    def test_hidden_and_missing_documents_are_indistinguishable(self):
        hidden, missing = (self.by_id[i]['response'] for i in ('hidden-document', 'missing-document'))
        self.assertEqual(hidden['status'], 404)
        strip = lambda r: {**r['body']['error'], 'requestId': None}  # noqa: E731
        self.assertEqual(strip(hidden), strip(missing))

    def test_revocation_removes_the_document_and_moves_the_generation_on(self):
        before, after = (self.by_id[i]['response']['body'] for i in ('hit-pdf', 'revoked-after-sync'))
        self.assertEqual(before['results'][0]['documentId'], 'acme/travel-policy-2025.pdf')
        self.assertNotIn('acme/travel-policy-2025.pdf', [r['documentId'] for r in after['results']])
        self.assertGreater(after['indexGeneration'], before['indexGeneration'])
        self.assertEqual(self.by_id['revoked-original']['response']['status'], 404)


class ShapeChecksRefuseBadBodies(unittest.TestCase):
    """The checkers are what K6 will run on its own output, so they must reject near-misses."""

    def setUp(self):
        fixtures = {f['id']: f for f in json.loads(FILE.read_text())['fixtures']}
        self.good = fixtures['hit-docx']['response']['body']

    def mutate(self, fn):
        body = json.loads(json.dumps(self.good))
        fn(body)
        return body

    def test_near_misses_are_refused(self):
        r = lambda b: b['results'][0]  # noqa: E731
        bad = {
            'extra field': lambda b: r(b).update(ms=3),
            'missing flag': lambda b: r(b)['flags'].pop('stale'),
            'unknown evidence': lambda b: b.update(evidence='maybe'),
            'excerpt too long': lambda b: r(b).update(excerpt='x' * 1201),
            'control character': lambda b: r(b).update(title='a\x1b[31mb'),
            'boolean as number': lambda b: r(b)['scores'].update(keyword=True),
            'rank out of order': lambda b: r(b)['scores'].update(rank=2),
            'sheet without range': lambda b: r(b)['locator'].update(sheet='Budget'),
            'local timestamp': lambda b: r(b)['source'].update(ingestedAt='2026-10-29T12:00:00'),
            'ocr confidence without ocr': lambda b: r(b)['flags'].update(ocrConfidence=0.9),
            'strong with no results': lambda b: b.update(results=[]),
            'oversized body': lambda b: b.update(results=[{**r(b), 'title': 'x' * 70000}]),
        }
        contract.check_search_body(self.good)
        for name, fn in bad.items():
            with self.subTest(name), self.assertRaises(contract.ContractError):
                contract.check_search_body(self.mutate(fn))

    def test_errors_have_fixed_status_wording_and_retry_rules(self):
        status, body = contract.error_body('scope', 'r1')
        contract.check_error_body(status, body)
        for args in [(404, body), (403, {'error': {**body['error'], 'message': 'collection birch-handbook is private'}}),
                     (403, {'error': {**body['error'], 'retryAfter': 5}})]:
            with self.subTest(args=args), self.assertRaises(contract.ContractError):
                contract.check_error_body(*args)
        with self.assertRaises(ValueError):
            contract.error_body('rate-limit', 'r2')
        contract.check_error_body(*contract.error_body('rate-limit', 'r2', retry_after=30))


if __name__ == '__main__':
    unittest.main()
