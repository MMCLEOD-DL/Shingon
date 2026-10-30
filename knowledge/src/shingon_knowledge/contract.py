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
import math
import re
from datetime import datetime
from pathlib import PurePosixPath
from urllib.parse import quote

from .service import NotFound, ScopeError

LOCATOR_KEYS = ('page', 'sectionPath', 'sheet', 'cellRange', 'slide')
EVIDENCE = ('strong', 'weak', 'none')
MAX_BODY_BYTES = 64 * 1024
MAX_RESULTS = 20
MAX_EXCERPT = 1200
CONTROL = re.compile(r'[\x00-\x08\x0b-\x1f\x7f]')
TIMESTAMP = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$')
MAX_RETRY_AFTER = 3600  # seconds
# retrieval-contract.md §5: the destinations a collection may allow.
DESTINATIONS = ('local-model', 'claude-subscription', 'codex-subscription')
APP_DESTINATION = re.compile(r'^foundation-app:[a-z0-9][a-z0-9-]{0,63}$')
# Chunk ids are opaque: callers store and send them back, never parse them (§3). The service's are 64 hex characters.
CHUNK_ID = re.compile(r'^[A-Za-z0-9_-]{22,128}$')
# Originals are always downloads. Anything without a known type is octet-stream, never guessed from content.
MEDIA_TYPES = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.md': 'text/markdown; charset=utf-8',
}
ORIGINAL_HEADERS = ('Content-Type', 'Content-Disposition', 'X-Content-Type-Options', 'Cache-Control')

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
    if retry_after is not None and (isinstance(retry_after, bool) or not isinstance(retry_after, int) or not 1 <= retry_after <= MAX_RETRY_AFTER):
        raise ValueError(f'retryAfter is a whole number of seconds from 1 to {MAX_RETRY_AFTER}.')
    err = {'code': code, 'message': message, 'retryable': retryable, 'requestId': request_id}
    if retry_after is not None:
        err['retryAfter'] = retry_after
    return status, {'error': err}


def original_path(collection_id: str, document_id: str, version_id: int) -> str:
    """The canonical original route (retrieval-contract.md §3). Each identifier is one encoded path segment, so a
    path-like documentId cannot add segments; the service decodes it once and looks it up, never joining it to a path."""
    enc = lambda v: quote(str(v), safe='')  # noqa: E731
    return f'/collections/{enc(collection_id)}/documents/{enc(document_id)}/versions/{enc(version_id)}/original'


def original_headers(document_id: str) -> dict:
    """The headers of a served original: always an attachment, never sniffed, never cached."""
    name = PurePosixPath(document_id).name
    return {'Content-Type': MEDIA_TYPES.get(PurePosixPath(name).suffix.lower(), 'application/octet-stream'),
            'Content-Disposition': f"attachment; filename*=UTF-8''{quote(name, safe='')}",
            'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store'}


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
    if isinstance(value, float) and not math.isfinite(value):
        _fail(path, 'must be a finite number')


def _positive(value, path: str, *, nullable: bool = False):
    _type(value, path, int, nullable=nullable)
    if value is not None and value < 1:
        _fail(path, 'must be 1 or more')


def _timestamp(value, path: str, *, nullable: bool = False):
    _text(value, path, nullable=nullable)
    if value is None:
        return
    if not TIMESTAMP.match(value):
        _fail(path, 'must be a UTC timestamp ending in Z')
    try:
        datetime.strptime(value[:19], '%Y-%m-%dT%H:%M:%S')
    except ValueError:
        _fail(path, 'is not a real date and time')


def _strict_json(body, limit: int | None = None):
    try:
        encoded = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
    except (TypeError, ValueError) as e:
        _fail('$', f'is not strict JSON ({e})')
    if limit is not None and len(encoded) > limit:
        _fail('$', f'larger than {limit} bytes')


def _checked(check):
    """Malformed input of any shape is a ContractError at the wire boundary, never a crash from inside the check."""
    def run(*args):
        try:
            return check(*args)
        except ContractError:
            raise
        except (TypeError, AttributeError, KeyError, IndexError, ValueError) as e:
            raise ContractError(f'$: malformed ({type(e).__name__})') from e
    run.__name__, run.__doc__ = check.__name__, check.__doc__
    return run


def _text(value, path: str, *, nullable: bool = False, max_len: int | None = None):
    _type(value, path, str, nullable=nullable)
    if value is None:
        return
    if CONTROL.search(value):
        _fail(path, 'contains control characters')
    if max_len is not None and len(value) > max_len:
        _fail(path, f'longer than {max_len} characters')


@_checked
def check_search_body(body: dict) -> None:
    """Raises ContractError unless `body` is a valid `POST /search` response."""
    _strict_json(body, MAX_BODY_BYTES)
    _keys(body, '$', ('indexGeneration', 'evidence', 'results'))
    _type(body['indexGeneration'], '$.indexGeneration', int)
    if body['indexGeneration'] < 0:
        _fail('$.indexGeneration', 'must not be negative')
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
        if not CHUNK_ID.match(r['chunkId']):
            _fail(f'{p}.chunkId', 'must be an opaque id of 22-128 URL-safe characters')
        _positive(r['versionId'], f'{p}.versionId')
        _text(r['excerpt'], f'{p}.excerpt', max_len=MAX_EXCERPT)
        loc = r['locator']
        _keys(loc, f'{p}.locator', LOCATOR_KEYS)
        _positive(loc['page'], f'{p}.locator.page', nullable=True)
        _positive(loc['slide'], f'{p}.locator.slide', nullable=True)
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
            _timestamp(src[k], f'{p}.source.{k}', nullable=k == 'modifiedAt')
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


@_checked
def check_error_body(status: int, body: dict) -> None:
    """Raises ContractError unless (status, body) is a contract error."""
    _strict_json(body)
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
        _positive(e['retryAfter'], '$.error.retryAfter')
        if e['retryAfter'] > MAX_RETRY_AFTER:
            _fail('$.error.retryAfter', f'at most {MAX_RETRY_AFTER} seconds')


@_checked
def check_withheld_report(report: dict) -> None:
    """Conductor's report when a passage may not go to a participant (retrieval-contract.md §5). Proposed shape."""
    _strict_json(report)
    _keys(report, '$', ('type', 'participant', 'collectionId', 'documentIds', 'allowedDestinations', 'message'))
    if report['type'] != 'evidence-withheld':
        _fail('$.type', "must be 'evidence-withheld'")
    for k in ('participant', 'collectionId', 'message'):
        _text(report[k], f'$.{k}')
    for k in ('documentIds', 'allowedDestinations'):
        _type(report[k], f'$.{k}', list)
        for j, v in enumerate(report[k]):
            _text(v, f'$.{k}[{j}]')
    for j, v in enumerate(report['allowedDestinations']):
        if v not in DESTINATIONS and not APP_DESTINATION.match(v):
            _fail(f'$.allowedDestinations[{j}]', f'unknown destination {v!r}')


@_checked
def check_original_response(status: int, headers: dict, document_id: str) -> None:
    """Raises ContractError unless (status, headers) is how a permitted original is served."""
    if status != 200:
        _fail('status', 'a served original is HTTP 200; refusals use check_error_body')
    _keys(headers, '$headers', ORIGINAL_HEADERS)
    if headers != original_headers(document_id):
        _fail('$headers', 'an original is an attachment with a fixed type, nosniff and no-store')
