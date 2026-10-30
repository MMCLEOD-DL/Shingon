"""Independent K6 credential boundary controls on disposable PostgreSQL, no HTTP/models.

Exit 1 means a malformed signed user escaped the promised Unauthenticated refusal.
Never print tokens, assertion keys, signed headers or raw database exception messages.
"""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
from threading import Barrier
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parents[7]
sys.path.insert(0, str(ROOT / 'knowledge/tests'))
from support import ServiceTestCase, admin_url
from shingon_knowledge import auth
from shingon_knowledge.db import connect


class Scenario(ServiceTestCase):
    pass


NOW = 1_800_000_000
Scenario.setUpClass()
gaps = []
try:
    db = Scenario.db
    token, key = auth.issue_app_credential(db, 'app:review', 'acme')
    header = 'Bearer ' + token
    url = urlunparse(urlparse(admin_url())._replace(path='/' + Scenario.dbname))
    other, other_key = auth.issue_app_credential(db, 'app:other', 'acme')
    assertion = lambda user, nonce: auth.sign_assertion(key, 'acme', user, expires_at=NOW + 120, nonce=nonce)
    for name, user in [('unknown-user', 'no-such-user'), ('nul-user', 'alice\x00suffix'),
                       ('surrogate-user', 'alice\ud800')]:
        nonce = 'review-' + name + '-0123456789'
        case_db = connect(url)
        try:
            auth.authenticate(case_db, header, assertion(user, nonce), now=NOW)
        except auth.Unauthenticated:
            result = 'UNAUTHENTICATED'
        except Exception as exc:
            result = type(exc).__name__
            gaps.append(name)
            case_db.rollback()
        else:
            result = 'ACCEPTED'
            gaps.append(name)
        try:
            healthy = case_db.execute('SELECT 1').fetchone() == [1]
            case_db.commit()
        except Exception:
            healthy = False
        finally:
            case_db.close()
        if not healthy and name not in gaps:
            gaps.append(name + '-connection')
        count = db.execute('SELECT count(*) FROM assertion_nonces WHERE nonce = %s', (nonce,)).fetchone()[0]
        db.commit()
        assert count == 0, 'A refused user left a nonce behind'
        print(json.dumps({'case': name, 'result': result, 'nonce_persisted': False,
                          'same_connection_query_works': healthy}))

    # Simultaneous requests on separate connections: exactly one nonce winner.
    barrier = Barrier(2)
    shared = assertion('alice', 'review-concurrent-0123456789')

    def login(_):
        fresh = connect(url)
        try:
            barrier.wait(timeout=10)
            try:
                return auth.authenticate(fresh, header, shared, now=NOW).principal
            except auth.Unauthenticated:
                return 'refused'
        finally:
            fresh.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = sorted(pool.map(login, range(2)))
    assert results == ['alice', 'refused'], results
    print('PASS concurrent nonce: one acceptance and one refusal across fresh connections')
    try:
        auth.authenticate(db, 'Bearer ' + other, assertion('alice', 'review-cross-key-0123456789'), now=NOW)
    except auth.Unauthenticated:
        print('PASS assertion signed for another credential is refused')
    else:
        raise AssertionError('Cross-credential assertion accepted')
    assert auth.revoke(db, 'app:review')
    fresh = connect(url)
    try:
        try:
            auth.authenticate(fresh, header, assertion('alice', 'review-revoked-0123456789'), now=NOW)
        except auth.Unauthenticated:
            print('PASS revoked app refused through a fresh connection')
        else:
            raise AssertionError('Revoked app accepted')
    finally:
        fresh.close()
finally:
    Scenario.tearDownClass()

print(json.dumps({'unexpected_refusals': gaps, 'result': 'REPRODUCED' if gaps else 'PASS'}))
raise SystemExit(1 if gaps else 0)
