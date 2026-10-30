"""Independent K6 HTTP controls: disposable PostgreSQL and loopback sockets only.

Exit 1 reproduces malformed-request disconnects or the missing five-second request budget.
No raw credentials, assertion headers or unsanitised server traces are printed.
"""
from concurrent.futures import ThreadPoolExecutor
import json
import logging
from pathlib import Path
import sys
import time
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parents[7]
sys.path.insert(0, str(ROOT / 'knowledge/tests'))
from support import (COLLECTIONS, CORPUS, ApiClient, ServiceTestCase, admin_url,
                     issue_http_callers, start_api)
from shingon_knowledge.db import connect


class Scenario(ServiceTestCase):
    pass


Scenario.setUpClass()
server = None
gaps = []
try:
    Scenario.kb.sync('review-import', CORPUS, Scenario.manifest['sources'], complete=COLLECTIONS)
    server, port = start_api(Scenario)
    # Suppress stock handler tracebacks in this manual probe, not in product code.
    server.handle_error = lambda *_: None
    logging.getLogger('shingon_knowledge.http').disabled = True
    api = ApiClient(port, issue_http_callers(Scenario.db))
    status, _, data = api.request('alice', 'POST', '/search', body={'query': 'mileage'})
    assert status == 200 and json.loads(data)['results']
    print('PASS ordinary authenticated HTTP search')

    for name, raw, headers, expected in [
        ('nested-valid-json-before-auth', b'[' * 1500 + b'0' + b']' * 1500, {}, (401, 'unauthenticated')),
        ('non-ascii-content-length', b'{}', {'Content-Length': '\u00b2'}, (400, 'bad-request')),
        ('huge-content-length', b'{}', {'Content-Length': '9' * 5000}, (413, 'too-large')),
        ('ordinary-invalid-json', b'{query', {}, (400, 'bad-request')),
    ]:
        try:
            status, _, data = api.request(None, 'POST', '/search', raw=raw, headers=headers)
            code = json.loads(data)['error']['code']
            outcome = f'{status} {code}'
            bad = (status, code) != expected
        except Exception as exc:
            outcome = type(exc).__name__
            bad = True
        if bad:
            gaps.append(name)
        print(json.dumps({'case': name, 'result': outcome}))
    assert api.request(None, 'GET', '/health')[0] == 200
    print('PASS listener still answers after malformed requests')

    # Real lock waits in two separate phases. Per-statement timeouts restart their
    # budget, so a 1.25-second auth wait plus a 5-second candidate wait exceed 5 s.
    url = urlunparse(urlparse(admin_url())._replace(path='/' + Scenario.dbname))
    auth_lock, search_lock = connect(url), connect(url)
    try:
        auth_lock.execute('LOCK TABLE credentials IN ACCESS EXCLUSIVE MODE')
        search_lock.execute('LOCK TABLE chunks IN ACCESS EXCLUSIVE MODE')
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=1) as pool:
            request = pool.submit(api.request, 'alice', 'POST', '/search', body={'query': 'mileage'})
            time.sleep(1.25)
            assert not request.done(), 'Request unexpectedly bypassed the held auth lock'
            auth_lock.commit()
            status, _, data = request.result(timeout=12)
        elapsed = time.monotonic() - started
        code = json.loads(data).get('error', {}).get('code')
        over = elapsed > 5.5
        if over:
            gaps.append('search-request-deadline')
        assert status == 503 and code == 'index-unavailable'
        print(json.dumps({'case': 'two-phase-database-waits', 'status': status,
                          'code': code, 'elapsed_seconds': round(elapsed, 3),
                          'over_five_second_budget': over}))
    finally:
        auth_lock.rollback()
        search_lock.rollback()
        auth_lock.close()
        search_lock.close()
    assert api.request('alice', 'POST', '/search', body={'query': 'mileage'})[0] == 200
    print('PASS normal HTTP search recovers after locks release')
finally:
    if server is not None:
        server.shutdown()
        server.server_close()
    Scenario.tearDownClass()

print(json.dumps({'gaps': gaps, 'result': 'REPRODUCED' if gaps else 'PASS'}))
raise SystemExit(1 if gaps else 0)
