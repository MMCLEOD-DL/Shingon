"""The read-only retrieval contract on the wire (conductor/docs/knowledge-base/retrieval-contract.md, draft for v1).

The service core returns Python values; these functions turn them into the exact JSON bodies callers receive, and
check bodies against the contract's shapes. The committed fixtures (knowledge/contract/kb-contract-v1.json) are
produced through them, and K6's HTTP layer should serialise with them and check its own output before sending.

Fields K2 cannot know yet are null or empty, never guessed: no vectors or reranker (K3, K4), no source-system
modification time, no OCR (scans are refused, K5), no conflict detection (`conflictsWith` is empty, and the contract
says its absence proves nothing). `stale` is false for everything K2 serves: a source whose last sync failed is
removed from search rather than served stale, and manual imports have no source system reporting newer versions.
"""
from __future__ import annotations

import json
import re

from .service import NotFound, ScopeError

LOCATOR_KEYS = ('page', 'sectionPath', 'sheet', 'cellRange', 'slide')
EVIDENCE = ('strong', 'weak', 'none')
MAX_BODY_BYTES = 64 * 1024
MAX_RESULTS = 20
MAX_EXCERPT = 1200
CONTROL = re.compile(r'[\x00-\x08\x0b-\x1f\x7f]')
TIMESTAMP = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$')

# Fixed wording per error: exception text never reaches the caller.
ERRORS = {
    'bad-request': (400, False, 'The query must be 1 to 1,000 characters and the limit 1 to 20.'),
    'scope': (403, False, 'This credential cannot search one of the requested collections.'),
    'not-found': (404, False, 'No such document, or it is not visible to this credential.'),
    'rate-limit': (429, True, 'Too many searches for this credential. Try again after the stated delay.'),
    'index-unavailable': (503, True, 'The knowledge index is unavailable. This is an outage, not an empty result.'),
}


class ContractError(ValueError):
    """A body that does not match the contract. The message names the offending path."""


def search_body(raw: dict) -> dict:
    """The `POST /search` response body for a KnowledgeService.search() result."""
    results = []
    for r in raw['results']:
        results.append({
            'chunkId': str(r['chunkId']), 'documentId': r['documentId'], 'versionId': r['versionId'],
            'collectionId': r['collectionId'], 'title': r['title'], 'excerpt': r['excerpt'],
            'locator': {k: r['locator'].get(k) for k in LOCATOR_KEYS},
            'source': {'display': f"{r['collectionId']} › {r['documentId']}", 'versionLabel': f"v{r['versionId']}",
                       'modifiedAt': None, 'ingestedAt': r['ingestedAt']},
            'scores': {'rank': r['scores']['rank'], 'keyword': r['scores']['keyword'], 'vector': None, 'rerank': None},
            'flags': {'stale': False, 'supersededBy': r['flags']['supersededBy'], 'conflictsWith': [],
                      'ocr': False, 'ocrConfidence': None, 'instructionLike': r['flags']['instructionLike']},
        })
    return {'indexGeneration': raw['indexGeneration'], 'evidence': raw['evidence'], 'results': results}


def error_code(exc: Exception) -> str:
    if isinstance(exc, ScopeError):
        return 'scope'
    if isinstance(exc, NotFound):
        return 'not-found'
    if isinstance(exc, ValueError):
        return 'bad-request'
    raise exc  # anything else is a fault, not a contract answer


def error_body(code: str, request_id: str, *, retry_after: int | None = None) -> tuple[int, dict]:
    """(HTTP status, body) for a contract error. `retry_after` (seconds) is required for rate-limit and only there."""
    status, retryable, message = ERRORS[code]
    if (code == 'rate-limit') != (retry_after is not None):
        raise ValueError('retryAfter belongs to rate-limit errors only, and they must carry it.')
    err = {'code': code, 'message': message, 'retryable': retryable, 'requestId': request_id}
    if retry_after is not None:
        err['retryAfter'] = retry_after
    return status, {'error': err}


# ---------- shape checks ----------

def _fail(path: str, why: str):
    raise ContractError(f'{path}: {why}')


def _keys(obj, path: str, required: tuple, optional: tuple = ()):
    if not isinstance(obj, dict):
        _fail(path, 'must be an object')
    missing = [k for k in required if k not in obj]
    extra = [k for k in obj if k not in required and k not in optional]
    if missing or extra:
        _fail(path, f'missing {missing} / unexpected {extra}')


def _type(value, path: str, *types, nullable: bool = False):
    if value is None and nullable:
        return
    if isinstance(value, bool) and bool not in types:  # bool is an int in Python; never accept it as a number
        _fail(path, f'must be {"/".join(t.__name__ for t in types)}')
    if not isinstance(value, types):
        _fail(path, f'must be {"/".join(t.__name__ for t in types)}{" or null" if nullable else ""}')


def _text(value, path: str, *, nullable: bool = False, max_len: int | None = None):
    _type(value, path, str, nullable=nullable)
    if value is None:
        return
    if CONTROL.search(value):
        _fail(path, 'contains control characters')
    if max_len is not None and len(value) > max_len:
        _fail(path, f'longer than {max_len} characters')


def check_search_body(body: dict) -> None:
    """Raises ContractError unless `body` is a valid `POST /search` response."""
    if len(json.dumps(body, ensure_ascii=False).encode()) > MAX_BODY_BYTES:
        _fail('$', f'larger than {MAX_BODY_BYTES} bytes')
    _keys(body, '$', ('indexGeneration', 'evidence', 'results'))
    _type(body['indexGeneration'], '$.indexGeneration', int)
    if body['evidence'] not in EVIDENCE:
        _fail('$.evidence', f'must be one of {EVIDENCE}')
    _type(body['results'], '$.results', list)
    if len(body['results']) > MAX_RESULTS:
        _fail('$.results', f'more than {MAX_RESULTS} results')
    if body['evidence'] != 'none' and not body['results']:
        _fail('$.evidence', 'strong or weak evidence needs at least one result')
    for i, r in enumerate(body['results']):
        p = f'$.results[{i}]'
        _keys(r, p, ('chunkId', 'documentId', 'versionId', 'collectionId', 'title', 'excerpt', 'locator', 'source', 'scores', 'flags'))
        for k in ('chunkId', 'documentId', 'collectionId', 'title'):
            _text(r[k], f'{p}.{k}')
        _type(r['versionId'], f'{p}.versionId', int)
        _text(r['excerpt'], f'{p}.excerpt', max_len=MAX_EXCERPT)
        loc = r['locator']
        _keys(loc, f'{p}.locator', LOCATOR_KEYS)
        _type(loc['page'], f'{p}.locator.page', int, nullable=True)
        _type(loc['slide'], f'{p}.locator.slide', int, nullable=True)
        _text(loc['sheet'], f'{p}.locator.sheet', nullable=True)
        _text(loc['cellRange'], f'{p}.locator.cellRange', nullable=True)
        _type(loc['sectionPath'], f'{p}.locator.sectionPath', list, nullable=True)
        for j, s in enumerate(loc['sectionPath'] or []):
            _text(s, f'{p}.locator.sectionPath[{j}]')
        if (loc['sheet'] is None) != (loc['cellRange'] is None):
            _fail(f'{p}.locator', 'sheet and cellRange come together')
        src = r['source']
        _keys(src, f'{p}.source', ('display', 'versionLabel', 'modifiedAt', 'ingestedAt'))
        _text(src['display'], f'{p}.source.display')
        _text(src['versionLabel'], f'{p}.source.versionLabel')
        for k in ('modifiedAt', 'ingestedAt'):
            _text(src[k], f'{p}.source.{k}', nullable=k == 'modifiedAt')
            if src[k] is not None and not TIMESTAMP.match(src[k]):
                _fail(f'{p}.source.{k}', 'must be a UTC timestamp ending in Z')
        sc = r['scores']
        _keys(sc, f'{p}.scores', ('rank', 'keyword', 'vector', 'rerank'))
        _type(sc['rank'], f'{p}.scores.rank', int)
        if sc['rank'] != i + 1:
            _fail(f'{p}.scores.rank', 'ranks run 1, 2, 3… in result order')
        for k in ('keyword', 'vector', 'rerank'):
            _type(sc[k], f'{p}.scores.{k}', int, float, nullable=True)
        fl = r['flags']
        _keys(fl, f'{p}.flags', ('stale', 'supersededBy', 'conflictsWith', 'ocr', 'ocrConfidence', 'instructionLike'))
        for k in ('stale', 'ocr', 'instructionLike'):
            _type(fl[k], f'{p}.flags.{k}', bool)
        _text(fl['supersededBy'], f'{p}.flags.supersededBy', nullable=True)
        _type(fl['conflictsWith'], f'{p}.flags.conflictsWith', list)
        for j, d in enumerate(fl['conflictsWith']):
            _text(d, f'{p}.flags.conflictsWith[{j}]')
        _type(fl['ocrConfidence'], f'{p}.flags.ocrConfidence', int, float, nullable=True)
        if (fl['ocrConfidence'] is not None) and not (fl['ocr'] and 0 <= fl['ocrConfidence'] <= 1):
            _fail(f'{p}.flags.ocrConfidence', 'only for OCR text, between 0 and 1')


def check_error_body(status: int, body: dict) -> None:
    """Raises ContractError unless (status, body) is a contract error."""
    _keys(body, '$', ('error',))
    e = body['error']
    _keys(e, '$.error', ('code', 'message', 'retryable', 'requestId'), ('retryAfter',))
    if e['code'] not in ERRORS:
        _fail('$.error.code', f'unknown code {e["code"]!r}')
    expected_status, retryable, message = ERRORS[e['code']]
    if status != expected_status:
        _fail('status', f'{e["code"]} is HTTP {expected_status}, not {status}')
    if e['retryable'] is not retryable or e['message'] != message:
        _fail('$.error', 'retryable and message are fixed per code')
    _text(e['requestId'], '$.error.requestId')
    if (e['code'] == 'rate-limit') != ('retryAfter' in e):
        _fail('$.error.retryAfter', 'present on rate-limit errors only')
    if 'retryAfter' in e:
        _type(e['retryAfter'], '$.error.retryAfter', int)


def check_withheld_report(report: dict) -> None:
    """Conductor's report when a passage may not go to a participant (retrieval-contract.md §5). Proposed shape."""
    _keys(report, '$', ('type', 'participant', 'collectionId', 'documentIds', 'allowedDestinations', 'message'))
    if report['type'] != 'evidence-withheld':
        _fail('$.type', "must be 'evidence-withheld'")
    for k in ('participant', 'collectionId', 'message'):
        _text(report[k], f'$.{k}')
    for k in ('documentIds', 'allowedDestinations'):
        _type(report[k], f'$.{k}', list)
        for j, v in enumerate(report[k]):
            _text(v, f'$.{k}[{j}]')
