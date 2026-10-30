"""The retrieval contract's fixture set (retrieval-contract.md §10), kept honest against the service.

knowledge/contract/kb-contract-v1.json holds two kinds of fixture:
  - generated: produced here by the real service on the synthetic corpus, through contract.py. This test produces
    them again in a fresh database and fails on any difference, so the file cannot drift from the service.
  - authored: hand-written for behaviour that later layers own (OCR in K5, rate limits and outages in K6, the
    destination report in Conductor, stale sources). They are checked against the wire shape only, and each names
    the task it waits for. They are not evidence that anything implements them.

Chunk ids are random, so generated fixtures replace each with a fixed stand-in (sha256 of fixture id and rank), after
checking that the real one has the service's format. Ingestion times are replaced the same way.

To regenerate after an intended change:
  KB_WRITE_FIXTURES=1 TEST_DATABASE_URL=... python -m unittest discover -s tests -p test_contract_fixtures.py
then review the diff and update retrieval-contract.md if the contract itself changed.
"""
import hashlib
import json
import os
import re
import unittest
from urllib.parse import unquote
from pathlib import Path

from shingon_knowledge import contract

from support import COLLECTIONS, CORPUS, ServiceTestCase

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
    # Codex review decision 3 and KB-R1: originals by full identity, current version only.
    'an original, current version only': ['original-current', 'original-replaced-version', 'original-unknown-version'],
    'the same document key in two collections': ['same-key-two-collections', 'same-key-one-visible',
                                                 'same-key-other-collection', 'same-key-own-collection'],
    # Codex review KB-R4: every exposed route and refusal.
    'every route': ['collections-alice', 'collections-andy', 'collections-conductor', 'passage-neighbours',
                    'passage-hidden', 'passage-missing', 'passage-too-wide', 'health'],
    'request validation': ['bad-request', 'bad-request-boolean-limit', 'bad-request-unknown-field',
                           'unsupported-hybrid', 'unsupported-filters', 'too-large'],
    'authentication': ['unauthenticated'],
}
SERVICE_CHUNK_ID = re.compile(r'^[0-9a-f]{64}$')


def _search(kb, creds, fid, covers, who, query, *, limit=3, collections=None):
    body = {'query': query, 'mode': 'keyword', 'limit': limit, 'clientRequestId': f'req-{fid}'}
    if collections is not None:
        body['collections'] = collections
    return _post_search(kb, creds, fid, covers, who, body)


def _post_search(kb, creds, fid, covers, who, body):
    """A `POST /search` exactly as K6 will handle it: the wire parser first, then the service."""
    try:
        args = contract.parse_search_request(body)
        raw = kb.search(creds[who], args['query'], limit=args['limit'], collections=args['collections'])
        status, out = 200, contract.search_body(raw)
        for r in out['results']:
            assert SERVICE_CHUNK_ID.match(r['chunkId']), r['chunkId']
            r['chunkId'] = hashlib.sha256(f"{fid}#{r['scores']['rank']}".encode()).hexdigest()
            r['source']['ingestedAt'] = INGESTED_AT
    except Exception as e:  # noqa: BLE001 - contract.error_code re-raises anything that is not a contract error
        status, out = contract.error_body(contract.error_code(e), f'req-{fid}')
    return {'id': fid, 'covers': covers, 'origin': 'generated', 'caller': CALLERS[who],
            'request': {'method': 'POST', 'path': '/search', 'body': body}, 'response': {'status': status, 'body': out}}


def _original(kb, creds, fid, covers, who, collection, key, version):
    try:
        data = kb.original(creds[who], collection, key, version).read_bytes()
        response = {'status': 200, 'headers': contract.original_headers(key), 'body': None,  # the file, not JSON
                    'file': {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}}
    except Exception as e:  # noqa: BLE001
        status, out = contract.error_body(contract.error_code(e), f'req-{fid}')
        response = {'status': status, 'body': out}
    return {'id': fid, 'covers': covers, 'origin': 'generated', 'caller': CALLERS[who],
            'request': {'method': 'GET', 'path': contract.original_path(collection, key, version)}, 'response': response}


def _stand_in(fid, n) -> str:
    return hashlib.sha256(f'{fid}#{n}'.encode()).hexdigest()


def _get(fid, covers, who, path, run, shape):
    """A GET fixture: `run()` gives the service's answer, `shape` turns it into the wire body."""
    try:
        status, out = 200, shape(run())
    except Exception as e:  # noqa: BLE001
        status, out = contract.error_body(contract.error_code(e), f'req-{fid}')
    return {'id': fid, 'covers': covers, 'origin': 'generated', 'caller': CALLERS[who],
            'request': {'method': 'GET', 'path': path}, 'response': {'status': status, 'body': out}}


def _collections(kb, creds, fid, covers, who):
    def shape(raw):
        body = contract.collections_body(raw)
        for c in body['collections']:
            if c['lastIngestedAt'] is not None:
                c['lastIngestedAt'] = INGESTED_AT
        return body
    return _get(fid, covers, who, '/collections', lambda: kb.collections(creds[who]), shape)


def _passage(kb, creds, fid, covers, who, chunk_id, neighbours: str | None = '1'):
    # One mapping from real chunk id to stand-in for the request and the response (Codex review KB-R6), so the
    # requested id is the focused passage's id in the fixture exactly as it is in the service.
    stand_ins: dict[str, str] = {}
    stand_in = lambda real: stand_ins.setdefault(real, _stand_in(fid, len(stand_ins)))  # noqa: E731

    def shape(raw):
        body = contract.passage_body(raw)
        assert [q['chunkId'] for q in body['passages'] if q['focus']] == [chunk_id], 'the service focused another chunk'
        for q in body['passages']:
            assert SERVICE_CHUNK_ID.match(q['chunkId']), q['chunkId']
            q['chunkId'] = stand_in(q['chunkId'])
        return body
    query = '' if neighbours is None else f'?neighbours={neighbours}'
    return _get(fid, covers, who, f'/passages/{stand_in(chunk_id)}{query}',
                lambda: kb.passage(creds[who], chunk_id, contract.parse_neighbours(neighbours)), shape)


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
        # Codex review KB-R4: request validation, and explicit refusal of what K2 does not do.
        _post_search(kb, creds, 'bad-request-boolean-limit', 'A boolean limit is refused, not read as 1', 'alice',
                     {'query': 'mileage', 'limit': True}),
        _post_search(kb, creds, 'bad-request-unknown-field', 'A field the contract does not define is refused', 'alice',
                     {'query': 'mileage', 'tenant': 'birch'}),
        _post_search(kb, creds, 'unsupported-hybrid', 'Hybrid mode is refused until K3, never run as keyword search', 'alice',
                     {'query': 'mileage', 'mode': 'hybrid'}),
        _post_search(kb, creds, 'unsupported-filters', 'A document filter is refused until it is implemented, never ignored', 'alice',
                     {'query': 'mileage', 'filters': {'documentIds': ['acme/expenses-policy.docx']}}),
        _collections(kb, creds, 'collections-alice', 'The collections a caller can search, with what she can see of each', 'alice'),
        _collections(kb, creds, 'collections-andy', 'The same collection, counted for a caller who cannot see the finance-only document', 'andy'),
        _collections(kb, creds, 'collections-conductor', 'A project token sees only its reference collection', 'conductor'),
        _passage(kb, creds, 'passage-neighbours', 'A passage and one neighbour either side, in document order', 'alice',
                 kb.search(creds['alice'], 'mileage rate pence per mile own car', limit=1)['results'][0]['chunkId']),
        _passage(kb, creds, 'passage-hidden', 'A passage the caller may not see: 404, as for a missing one', 'andy',
                 kb.search(creds['alice'], 'salary band Senior Analyst', limit=1)['results'][0]['chunkId']),
        _passage(kb, creds, 'passage-missing', 'A chunk id that does not exist: identical to hidden', 'andy', 'f' * 64),
        _passage(kb, creds, 'passage-too-wide', 'More neighbours than the bound is refused', 'alice',
                 kb.search(creds['alice'], 'mileage rate pence per mile own car', limit=1)['results'][0]['chunkId'], '9'),
        _get('health', 'Readiness only: no revision or counts', 'conductor', '/health', kb.health, lambda raw: raw),
        _original(kb, creds, 'hidden-document', 'A document the caller may not see', 'andy', 'acme-policies', 'acme/salary-bands.docx', 1),
        _original(kb, creds, 'missing-document', 'A document that does not exist: identical to hidden', 'andy', 'acme-policies', 'acme/no-such-file.docx', 1),
    ]
    # Revocation: the next sync no longer lists the 2025 travel policy.
    kb.sync('run-3', CORPUS, [x for x in manifest['sources'] if x['key'] != 'acme/travel-policy-2025.pdf'], complete=COLLECTIONS)
    out += [
        s('revoked-after-sync', 'After the source removed it, the next sync drops its passages and the caller\'s viewRevision changes', 'alice', 'hotel cap London per night'),
        _original(kb, creds, 'revoked-original', 'The stored original of a revoked document is gone', 'alice', 'acme-policies', 'acme/travel-policy-2025.pdf', 1),
        # Originals are served for the current version only (Codex review decision 3).
        _original(kb, creds, 'original-current', 'The current version of a visible document, as an attachment', 'alice', 'acme-policies', 'acme/expenses-policy.docx', 2),
        _original(kb, creds, 'original-replaced-version', 'Version 1 after version 2 was indexed: 404, never the newer file', 'alice', 'acme-policies', 'acme/expenses-policy.docx', 1),
        _original(kb, creds, 'original-unknown-version', 'A version that never existed: 404', 'alice', 'acme-policies', 'acme/expenses-policy.docx', 7),
    ]
    # Source keys are unique per collection only (Codex review KB-R1): a finance-only copy of the budget, also v1.
    kb.setup({'collections': {'acme-finance': {'tenant': 'acme', 'kind': 'client-runtime', 'destinations': ['foundation-app:acme']}}})
    kb.sync('run-4', CORPUS, [{'collection': 'acme-finance', 'key': 'acme/budget-2026.xlsx', 'acl': {'groups': ['finance']}}], complete=['acme-finance'])
    out += [
        s('same-key-two-collections', 'Two collections hold acme/budget-2026.xlsx at version 1: collectionId tells them apart', 'alice', 'Sales travel budget Q3', limit=8),
        s('same-key-one-visible', 'A caller outside finance sees only the acme-policies copy', 'andy', 'Sales travel budget Q3', limit=8),
        _original(kb, creds, 'same-key-other-collection', "The finance copy by its full identity, for a caller outside finance: 404", 'andy', 'acme-finance', 'acme/budget-2026.xlsx', 1),
        _original(kb, creds, 'same-key-own-collection', 'The acme-policies copy by its full identity, for the same caller', 'andy', 'acme-policies', 'acme/budget-2026.xlsx', 1),
    ]
    return out


class ContractFixtures(ServiceTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.kb.sync('run-1', CORPUS, cls.manifest['sources'], files={'acme/expenses-policy.docx': CORPUS / 'acme/_v1-expenses-policy.docx'}, complete=COLLECTIONS)
        cls.kb.sync('run-2', CORPUS, cls.manifest['sources'], complete=COLLECTIONS)
        cls.generated = generate(cls.kb, cls.creds, cls.manifest)
        committed = json.loads(FILE.read_text(encoding='utf-8')) if FILE.exists() else {'fixtures': []}
        if os.environ.get('KB_WRITE_FIXTURES') == '1':
            authored = [f for f in committed['fixtures'] if f['origin'] != 'generated']
            committed['fixtures'] = cls.generated + authored
            FILE.write_text(json.dumps(committed, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
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
                elif status == 200 and f['request']['path'] == '/collections':
                    contract.check_collections_body(body)
                elif status == 200 and f['request']['path'].startswith('/passages/'):
                    contract.check_passage_body(body)
                elif status == 200 and f['request']['path'] == '/health':
                    contract.check_health_body(status, body)
                elif status == 200:
                    contract.check_original_response(status, f['response']['headers'], unquote(f['request']['path'].split('/')[4]))
                    self.assertIsNone(body)
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
        # Hidden, missing, revoked, replaced, unknown and other-collection versions all get the same 404.
        refused = ('hidden-document', 'missing-document', 'revoked-original', 'original-replaced-version',
                   'original-unknown-version', 'same-key-other-collection', 'passage-hidden', 'passage-missing')
        strip = lambda r: {**r['body']['error'], 'requestId': None}  # noqa: E731
        first = self.by_id[refused[0]]['response']
        self.assertEqual(first['status'], 404)
        for fid in refused[1:]:
            with self.subTest(fixture=fid):
                self.assertEqual(self.by_id[fid]['response']['status'], 404)
                self.assertEqual(strip(self.by_id[fid]['response']), strip(first))

    def test_the_same_key_in_two_collections_stays_two_documents(self):
        hits = lambda fid: [r for r in self.by_id[fid]['response']['body']['results']  # noqa: E731
                            if r['documentId'] == 'acme/budget-2026.xlsx']
        both = {(r['collectionId'], r['documentId'], r['versionId']) for r in hits('same-key-two-collections')}
        self.assertEqual(both, {('acme-policies', 'acme/budget-2026.xlsx', 1), ('acme-finance', 'acme/budget-2026.xlsx', 1)})
        self.assertEqual({r['collectionId'] for r in hits('same-key-one-visible')}, {'acme-policies'})
        paths = {self.by_id[f]['request']['path'] for f in ('same-key-other-collection', 'same-key-own-collection')}
        self.assertEqual(len(paths), 2, 'each identity has its own original route')
        self.assertEqual(self.by_id['same-key-own-collection']['response']['status'], 200)

    def test_a_passage_fixture_focuses_the_chunk_it_asked_for(self):
        # Codex review KB-R6: shape checks alone let the request and the focused passage name different chunks.
        served = [f for f in self.file['fixtures'] if f['request'] and f['request']['path'].startswith('/passages/')
                  and f['response']['status'] == 200]
        self.assertTrue(served)
        for f in served:
            with self.subTest(fixture=f['id']):
                asked = unquote(f['request']['path'].split('/')[2].split('?')[0])
                focus = [q['chunkId'] for q in f['response']['body']['passages'] if q['focus']]
                self.assertEqual(focus, [asked])

    def test_served_originals_are_the_stored_files(self):
        got = self.by_id['original-current']['response']
        data = (CORPUS / 'acme/expenses-policy.docx').read_bytes()
        self.assertEqual(got['file'], {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})

    def test_revocation_removes_the_document_and_changes_the_view_revision(self):
        before, after = (self.by_id[i]['response']['body'] for i in ('hit-pdf', 'revoked-after-sync'))
        self.assertEqual(before['results'][0]['documentId'], 'acme/travel-policy-2025.pdf')
        self.assertNotIn('acme/travel-policy-2025.pdf', [r['documentId'] for r in after['results']])
        self.assertNotEqual(after['viewRevision'], before['viewRevision'])
        self.assertEqual(self.by_id['revoked-original']['response']['status'], 404)


class ShapeChecksRefuseBadBodies(unittest.TestCase):
    """The checkers are what K6 will run on its own output, so they must reject near-misses."""

    def setUp(self):
        fixtures = {f['id']: f for f in json.loads(FILE.read_text(encoding='utf-8'))['fixtures']}
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

    def test_values_the_wire_cannot_carry_are_refused(self):
        # Codex review KB-R2: each of these passed the checker before.
        r = lambda b: b['results'][0]  # noqa: E731
        bad = {
            'NaN score': lambda b: r(b)['scores'].update(keyword=float('nan')),
            'infinite score': lambda b: r(b)['scores'].update(keyword=float('inf')),
            'impossible date': lambda b: r(b)['source'].update(ingestedAt='2026-99-99T99:99:99Z'),
            'thirty-first of February': lambda b: r(b)['source'].update(modifiedAt='2026-02-31T10:00:00Z'),
            'version zero': lambda b: r(b).update(versionId=0),
            'page zero': lambda b: r(b)['locator'].update(page=0),
            'negative slide': lambda b: r(b)['locator'].update(slide=-1),
            # Codex review decision 1: a view revision, never a number shared across ACLs.
            'a counter for a revision': lambda b: b.update(viewRevision=1842),
            'short revision': lambda b: b.update(viewRevision='abc'),
            'results not a list': lambda b: b.update(results={'0': r(b)}),
            'result not an object': lambda b: b.update(results=['hit']),
            'flags not an object': lambda b: r(b).update(flags=[]),
            'body not an object': lambda b: b.clear() or b.update({'x': None}),
            'non-JSON value': lambda b: r(b).update(title=b'bytes'),
            # Codex review decision 1: chunk ids are opaque, not serial numbers.
            'serial chunk id': lambda b: r(b).update(chunkId='25'),
            'chunk id with a slash': lambda b: r(b).update(chunkId='a' * 30 + '/x'),
        }
        for name, fn in bad.items():
            with self.subTest(name), self.assertRaises(contract.ContractError):
                contract.check_search_body(self.mutate_raw(fn))
        for body in (None, [], 'text'):
            with self.subTest(body=body), self.assertRaises(contract.ContractError):
                contract.check_search_body(body)

    def mutate_raw(self, fn):
        body = json.loads(json.dumps(self.good))
        fn(body)
        return body  # no JSON round trip: the bad value must reach the checker as it is

    def test_error_retry_and_withheld_destinations_are_bounded(self):
        status, body = contract.error_body('rate-limit', 'r3', retry_after=30)
        for retry in (0, -5, 3601, 2.5, True, float('nan')):
            with self.subTest(retry=retry), self.assertRaises(contract.ContractError):
                contract.check_error_body(status, {'error': {**body['error'], 'retryAfter': retry}})
            with self.subTest(make=retry), self.assertRaises(ValueError):
                contract.error_body('rate-limit', 'r3', retry_after=retry)
        for bad in (None, [], {'error': []}, {'error': None}):
            with self.subTest(error=bad), self.assertRaises(contract.ContractError):
                contract.check_error_body(status, bad)
        fixtures = {f['id']: f for f in json.loads(FILE.read_text(encoding='utf-8'))['fixtures']}
        report = fixtures['destination-withheld']['response']['body']
        with_dests = lambda dests: contract.withheld_report(report['participant'], report['collectionId'], report['documentIds'], dests)  # noqa: E731
        contract.check_withheld_report(with_dests(['local-model', 'foundation-app:acme']))
        for dest in ('openai', 'foundation-app:', 'foundation-app:../x', 'LOCAL-MODEL'):
            with self.subTest(dest=dest), self.assertRaises(contract.ContractError):
                contract.check_withheld_report(with_dests([dest]))
        for bad in (None, {**report, 'documentIds': 'notes/a.md'}):
            with self.subTest(report=bad), self.assertRaises(contract.ContractError):
                contract.check_withheld_report(bad)

    def test_the_withheld_report_is_exact_and_operator_only(self):
        # Codex review decision 4: fixed wording, a participant name, exact ids, nothing of the content.
        good = contract.withheld_report('claude', 'company-private-notes', ['notes/a.md', 'notes/b.md'], ['local-model'])
        contract.check_withheld_report(good)
        self.assertIn('2 documents from company-private-notes kept from claude', good['message'])
        for name, bad in {
            'free-text message': {**good, 'message': 'withheld: notes/a.md says the price is £4m'},
            'participant with spaces': {**good, 'participant': 'Claude Code'},
            'no documents': {**good, 'documentIds': []},
            'repeated document': {**good, 'documentIds': ['notes/a.md', 'notes/a.md']},
            'no allowed destination': {**good, 'allowedDestinations': []},
            'extra excerpt field': {**good, 'excerpt': 'the price is £4m'},
        }.items():
            with self.subTest(name), self.assertRaises(contract.ContractError):
                contract.check_withheld_report(bad)
        for word in ('notes', 'company-private-notes', 'claude', 'document'):
            self.assertNotIn(word, contract.PARTICIPANT_NOTICE)

    def test_originals_are_attachments_at_their_full_identity(self):
        doc = 'acme/expenses-policy.docx'
        self.assertEqual(contract.original_path('acme-policies', doc, 2),
                         '/collections/acme-policies/documents/acme%2Fexpenses-policy.docx/versions/2/original')
        self.assertNotEqual(contract.original_path('team-a', 'policies/current.md', 1),
                            contract.original_path('team-b', 'policies/current.md', 1))
        self.assertEqual(contract.original_path('c', '../x?y#z', 1).count('/'), 7, 'a document id stays one segment')
        good = contract.original_headers(doc)
        contract.check_original_response(200, good, doc)
        self.assertEqual(contract.original_headers('notes/page.html')['Content-Type'], 'application/octet-stream')
        for name, (status, headers) in {
            'inline': (200, {**good, 'Content-Disposition': 'inline'}),
            'sniffable': (200, {k: v for k, v in good.items() if k != 'X-Content-Type-Options'}),
            'cacheable': (200, {**good, 'Cache-Control': 'max-age=3600'}),
            'html type': (200, {**good, 'Content-Type': 'text/html'}),
            'not 200': (206, good),
            'not an object': (200, None),
        }.items():
            with self.subTest(name), self.assertRaises(contract.ContractError):
                contract.check_original_response(status, headers, doc)



class RequestsAndRoutes(unittest.TestCase):
    """Codex review KB-R4: what a request may say, and the shapes of the routes besides search."""

    def setUp(self):
        self.fixtures = {f['id']: f for f in json.loads(FILE.read_text(encoding='utf-8'))['fixtures']}

    def test_search_requests_are_parsed_strictly(self):
        ok = contract.parse_search_request
        self.assertEqual(ok({'query': 'q', 'limit': 20, 'mode': 'keyword', 'filters': {}, 'collections': ['a'], 'clientRequestId': 'run-7:step.2'}),
                         {'query': 'q', 'limit': 20, 'collections': ['a'], 'clientRequestId': 'run-7:step.2'})
        for name, body in {
            'not an object': ['q'], 'no query': {}, 'long query': {'query': 'x' * 1001}, 'limit 0': {'query': 'q', 'limit': 0},
            'limit 21': {'query': 'q', 'limit': 21}, 'float limit': {'query': 'q', 'limit': 8.0}, 'boolean limit': {'query': 'q', 'limit': False},
            'collections as text': {'query': 'q', 'collections': 'a'}, 'empty collections': {'query': 'q', 'collections': []},
            'repeated collection': {'query': 'q', 'collections': ['a', 'a']}, 'unknown mode': {'query': 'q', 'mode': 'vector'},
            'filters as a list': {'query': 'q', 'filters': []}, 'request id with a space': {'query': 'q', 'clientRequestId': 'a b'},
            'long request id': {'query': 'q', 'clientRequestId': 'a' * 65}, 'extra field': {'query': 'q', 'principal': 'alice'},
        }.items():
            with self.subTest(name), self.assertRaises(ValueError) as caught:
                ok(body)
            self.assertNotIsInstance(caught.exception, contract.Unsupported)
        for body in ({'query': 'q', 'mode': 'hybrid'}, {'query': 'q', 'filters': {'sourceTypes': ['pdf']}}):
            with self.subTest(body=body), self.assertRaises(contract.Unsupported):
                ok(body)
        for bad in ('3', '-1', 'one', '1.0', ''):
            with self.subTest(neighbours=bad), self.assertRaises(ValueError):
                contract.parse_neighbours(bad)
        self.assertEqual((contract.parse_neighbours(None), contract.parse_neighbours('0')), (1, 0))

    def test_request_ids_have_one_format(self):
        with self.assertRaises(ValueError):
            contract.error_body('scope', 'has a space')
        for f in self.fixtures.values():
            body = f['response'].get('body')
            if isinstance(body, dict) and 'error' in body:
                with self.subTest(fixture=f['id']):
                    self.assertRegex(body['error']['requestId'], contract.REQUEST_ID)
            sent = ((f.get('request') or {}).get('body') or {}).get('clientRequestId') if isinstance((f.get('request') or {}).get('body'), dict) else None
            if sent is not None:
                self.assertRegex(sent, contract.REQUEST_ID)

    def test_route_bodies_refuse_near_misses(self):
        coll = self.fixtures['collections-alice']['response']['body']
        passage = self.fixtures['passage-neighbours']['response']['body']
        c0 = lambda b: b['collections'][0]  # noqa: E731
        bad_collections = {
            'unknown kind': lambda b: c0(b).update(kind='private'),
            'negative count': lambda b: c0(b).update(documents=-1),
            'time without documents': lambda b: c0(b).update(documents=0),
            'unknown destination': lambda b: c0(b).update(destinations=['openai']),
            'a name field': lambda b: c0(b).update(name='Acme policies'),
            'repeated collection': lambda b: b['collections'].append(dict(c0(b))),
        }
        bad_passages = {
            'two focus passages': lambda b: [q.update(focus=True) for q in b['passages']],
            'no passages': lambda b: b.update(passages=[]),
            'too many passages': lambda b: b.update(passages=b['passages'] * 2),
            'serial chunk id': lambda b: b['passages'][0].update(chunkId='17'),
            'text too long': lambda b: b['passages'][0].update(text='x' * 1201),
            'version zero': lambda b: b.update(versionId=0),
        }
        contract.check_collections_body(coll)
        contract.check_passage_body(passage)
        for name, fn in bad_collections.items():
            body = json.loads(json.dumps(coll))
            fn(body)
            with self.subTest(name), self.assertRaises(contract.ContractError):
                contract.check_collections_body(body)
        for name, fn in bad_passages.items():
            body = json.loads(json.dumps(passage))
            fn(body)
            with self.subTest(name), self.assertRaises(contract.ContractError):
                contract.check_passage_body(body)
        for status, body in ((200, {'status': 'ok', 'viewRevision': 'x'}), (200, {'status': 'ok', 'documents': 11}), (503, {'status': 'ok'})):
            with self.subTest(health=body), self.assertRaises(contract.ContractError):
                contract.check_health_body(status, body)


if __name__ == '__main__':
    unittest.main()
