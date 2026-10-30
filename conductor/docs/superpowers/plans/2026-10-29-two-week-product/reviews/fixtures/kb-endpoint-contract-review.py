"""Independent PR39 request/response identity review, outside CI discovery.

Exit 1 means a positive passage fixture's requested chunk differs from its focus chunk.
Optional --database also checks real core lookup identity and cross-principal refusal,
using a disposable TEST_DATABASE_URL; no HTTP/model/real data is involved.
"""
from copy import deepcopy
import json
from pathlib import Path
import sys
from urllib.parse import unquote, urlsplit
from shingon_knowledge import contract

ROOT = Path(__file__).resolve().parents[7]
fixtures = json.loads((ROOT / 'knowledge/contract/kb-contract-v1.json').read_text(encoding='utf-8'))['fixtures']
gaps = []
for fixture in fixtures:
    request = fixture.get('request') or {}
    response = fixture['response']
    path = urlsplit(request.get('path', '')).path
    if response['status'] != 200 or not path.startswith('/passages/'):
        continue
    body = response['body']
    contract.check_passage_body(body)
    requested = unquote(path.split('/')[2])
    focused = [passage['chunkId'] for passage in body['passages'] if passage['focus']]
    assert len(focused) == 1
    mismatch = requested != focused[0]
    print(json.dumps({'fixture': fixture['id'], 'shape_checker_accepts': True,
                      'request_matches_focused_chunk': not mismatch,
                      'result': 'MISMATCH' if mismatch else 'MATCH'}))
    if mismatch:
        gaps.append(fixture['id'])

# Exercise the actual parser rather than treating response fixtures as request validation.
valid = contract.parse_search_request({'query': 'policy', 'collections': ['acme-policies'], 'limit': 2})
assert valid['collections'] == ['acme-policies'] and valid['limit'] == 2
for body in ({'query': 'policy', 'limit': True}, {'query': 'policy', 'collections': 'acme-policies'},
             {'query': 'policy', 'principal': 'alice'}, {'query': 'policy', 'limit': 21}):
    try:
        contract.parse_search_request(body)
    except ValueError as error:
        assert not isinstance(error, contract.Unsupported)
    else:
        raise AssertionError(f'Invalid request accepted: {body}')
for body in ({'query': 'policy', 'mode': 'hybrid'}, {'query': 'policy', 'filters': {'sourceTypes': ['pdf']}}):
    try:
        contract.parse_search_request(body)
    except contract.Unsupported:
        pass
    else:
        raise AssertionError('Unsupported narrowing was silently accepted')
print('PASS: ordinary scoped request and invalid/unsupported request controls')

if '--database' in sys.argv:
    sys.path.insert(0, str(ROOT / 'knowledge/tests'))
    from support import CORPUS, ServiceTestCase
    from shingon_knowledge import NotFound

    class Scenario(ServiceTestCase):
        pass

    Scenario.setUpClass()
    try:
        kb, creds = Scenario.kb, Scenario.creds
        kb.sync('endpoint-review', CORPUS, Scenario.manifest['sources'], complete=list(Scenario.manifest['collections']))
        hit = next(row for row in kb.search(creds['alice'], 'mileage rate pence per mile', limit=20)['results']
                   if row['documentId'] == 'acme/expenses-policy.docx')
        expanded = kb.passage(creds['alice'], hit['chunkId'], 1)
        focused = [row['chunkId'] for row in expanded['passages'] if row['focus']]
        assert focused == [hit['chunkId']]
        assert len(expanded['passages']) <= 3
        assert (expanded['collectionId'], expanded['documentId'], expanded['versionId']) == (
            hit['collectionId'], hit['documentId'], hit['versionId'])
        hidden = next(row for row in kb.search(creds['alice'], 'salary band Senior Analyst', limit=20)['results']
                      if row['documentId'] == 'acme/salary-bands.docx')
        for who in ('andy', 'bella', 'conductor'):
            try:
                kb.passage(creds[who], hidden['chunkId'], 2)
            except NotFound:
                pass
            else:
                raise AssertionError(f'Hidden passage reached {who}')
        print('PASS: real core request/focus identity, bounded expansion and three denied-principal controls')
    finally:
        Scenario.tearDownClass()
raise SystemExit(1 if gaps else 0)
