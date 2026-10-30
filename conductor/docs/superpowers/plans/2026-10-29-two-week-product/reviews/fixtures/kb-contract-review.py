"""Standalone re-review controls for PR31/34, using installed knowledge package.

Pure wire checks only. SQL privacy, random ID persistence and original-version authorisation
are covered separately by the real database suites; no injected candidate row claims that.
Exit 0 means these corrected controls pass, not that the whole v1 contract is frozen.
"""
from copy import deepcopy
import json
from pathlib import Path
from urllib.parse import unquote
from shingon_knowledge import contract

ROOT = Path(__file__).resolve().parents[7]
fixtures = {f['id']: f for f in json.loads((ROOT / 'knowledge/contract/kb-contract-v1.json').read_text(encoding='utf-8'))['fixtures']}
checked = 0
for fixture in fixtures.values():
    response = fixture['response']
    status, body = response['status'], response['body']
    path = (fixture.get('request') or {}).get('path', '')
    if fixture.get('kind') == 'conductor-report':
        contract.check_withheld_report(body)
    elif status == 200 and path == '/search':
        contract.check_search_body(body)
    elif status == 200 and path.endswith('/original'):
        document_id = unquote(path.split('/')[4])
        contract.check_original_response(status, response['headers'], document_id)
    elif status != 200:
        contract.check_error_body(status, body)
    else:
        raise AssertionError(f'Uncovered fixture: {fixture["id"]}')
    checked += 1
print(json.dumps({'fixture_shape_controls_passed': checked, 'scope': 'shape only; generated fixture replay is a separate DB test'}))
good = fixtures['hit-docx']['response']['body']


def refuse(name, mutate, checker=contract.check_search_body, base=good):
    body = deepcopy(base)
    mutate(body)
    try:
        checker(body)
    except contract.ContractError:
        print(json.dumps({'case': name, 'result': 'REFUSED'}))
    else:
        raise AssertionError(f'Accepted invalid value: {name}')


refuse('NaN score', lambda b: b['results'][0]['scores'].update(keyword=float('nan')))
refuse('Infinity score', lambda b: b['results'][0]['scores'].update(vector=float('inf')))
refuse('impossible timestamp', lambda b: b['results'][0]['source'].update(ingestedAt='2026-99-99T99:99:99Z'))
refuse('version zero', lambda b: b['results'][0].update(versionId=0))
status, rate = contract.error_body('rate-limit', 'review', retry_after=30)
refuse('negative retryAfter on wire', lambda b: b['error'].update(retryAfter=-30),
       checker=lambda b: contract.check_error_body(status, b), base=rate)
try:
    contract.error_body('rate-limit', 'review', retry_after=-30)
except ValueError:
    print(json.dumps({'case': 'negative retryAfter constructor', 'result': 'REFUSED'}))
else:
    raise AssertionError('error_body accepted negative retryAfter')
refuse('unknown destination', lambda b: b.update(allowedDestinations=['unrecognised-provider']),
       checker=contract.check_withheld_report, base=fixtures['destination-withheld']['response']['body'])

# Use the actual canonical route helper; the old hand-built route is obsolete.
a, b = deepcopy(good['results'][0]), deepcopy(good['results'][0])
a.update(documentId='policies/current.md', collectionId='team-a', versionId=1)
b.update(documentId='policies/current.md', collectionId='team-b', versionId=1)
a['scores']['rank'], b['scores']['rank'] = 1, 2
qualified = deepcopy(good)
qualified.update(evidence='strong', results=[a, b])
contract.check_search_body(qualified)
urls = [contract.original_path(r['collectionId'], r['documentId'], r['versionId']) for r in (a, b)]
assert urls[0] != urls[1]
assert all('policies%2Fcurrent.md' in url for url in urls)
print(json.dumps({'case': 'collection-qualified identity', 'result': 'DISTINCT', 'urls': urls}))
print('PASS: corrected pure controls; no SQL authorisation claim made here')
