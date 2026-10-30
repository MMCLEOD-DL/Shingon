"""PR47 native Windows cleanup control, using disposable PostgreSQL/synthetic originals.

Exit 0 verifies logical revocation, durable pending state and cleanup after reconnect/retry.
The native open-file case is explicitly skipped off Windows. No model, HTTP or real input.
"""
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parents[7]
sys.path.insert(0, str(ROOT / 'knowledge/tests'))
from support import CORPUS, ServiceTestCase
from shingon_knowledge import KnowledgeService, NotFound
from shingon_knowledge.db import connect


class Scenario(ServiceTestCase):
    pass


def denied(call):
    try:
        call()
    except NotFound:
        return
    raise AssertionError('Unavailable source remained readable')


Scenario.setUpClass()
try:
    kb, creds, manifest = Scenario.kb, Scenario.creds, Scenario.manifest
    kb.sync('initial', CORPUS, manifest['sources'], complete=list(manifest['collections']))
    source = next(s for s in manifest['sources'] if s['key'] == 'birch/staff-handbook.md')
    cred, collection, key = creds['bella'], source['collection'], source['key']
    hit = next(r for r in kb.search(cred, 'mileage pence per mile')['results'] if r['documentId'] == key)
    original = kb.original(cred, collection, key, hit['versionId'])
    assert original.exists()
    unchanged = kb.sync('partial-empty', CORPUS, [], complete=[])
    assert unchanged['deleted'] == 0 and original.exists()
    removed = kb.sync('complete-empty', CORPUS, [], complete=[collection])
    assert removed['deleted'] == 1 and not original.exists()
    denied(lambda: kb.passage(cred, hit['chunkId']))
    denied(lambda: kb.original(cred, collection, key, hit['versionId']))
    assert kb.search(cred, 'mileage pence per mile')['results'] == []
    print('PASS: empty partial preserves; ordinary complete deletion removes bytes and denies all read paths')

    kb.sync('restore-for-refresh', CORPUS, [source], complete=[collection])
    hit = next(r for r in kb.search(cred, 'mileage pence per mile')['results'] if r['documentId'] == key)
    failed = kb.sync('failed-read', CORPUS, [source], files={key: Scenario.work/'missing-source.md'}, complete=[])
    assert failed['failed'] == 1 and failed['deleted'] == 0
    assert kb.search(cred, 'mileage pence per mile')['results'] == []
    denied(lambda: kb.passage(cred, hit['chunkId']))
    denied(lambda: kb.original(cred, collection, key, hit['versionId']))
    print('PASS: explicitly failed source read denies search, passage and original')

    if os.name != 'nt':
        print('SKIPPED: native open-file deletion case requires Windows; no KB-R7 closure from this skip')
        raise SystemExit(0)
    kb.sync('restore-for-lock', CORPUS, [source], complete=[collection])
    hit = next(r for r in kb.search(cred, 'mileage pence per mile')['results'] if r['documentId'] == key)
    original = kb.original(cred, collection, key, hit['versionId'])
    with original.open('rb') as held:
        assert held.read(1)
        result = kb.sync('locked-delete', CORPUS, [], complete=[collection])
        assert result['deleted'] == 1 and original.exists()
        denied(lambda: kb.original(cred, collection, key, hit['versionId']))
        denied(lambda: kb.passage(cred, hit['chunkId']))
        assert kb.search(cred, 'mileage pence per mile')['results'] == []
        events = kb.import_status('locked-delete')
        assert any(event['outcome'] == 'cleanup-pending' for event in events)
        assert not any(event['outcome'] == 'purged' and event['message'].startswith(f"Version {hit['versionId']}:") for event in events)
        [pending] = kb.cleanup_status()
        assert (pending['collection'], pending['key'], pending['version']) == (collection, key, hit['versionId'])
        assert pending['error']
        stored = kb.db.execute('SELECT v.original_path, v.purge_pending, v.purge_error FROM versions v JOIN sources s '
                               'ON s.id = v.source_id WHERE s.collection_id = %s AND s.key = %s AND v.n = %s',
                               (collection, key, hit['versionId'])).fetchone()
        assert stored[0] == str(original) and stored[1] and stored[2]
        kb.db.commit()
    assert original.exists(), 'bytes should still be pending before the retry'

    # Replace both the service and connection: pending work must come from committed DB state.
    u = urlparse(os.environ['TEST_DATABASE_URL'])
    replacement = connect(urlunparse(u._replace(path='/' + Scenario.dbname)))
    Scenario.db.close()
    Scenario.db = replacement
    kb = KnowledgeService(replacement, kb.originals)
    assert kb.cleanup_status() == [pending]
    retried = kb.sync('after-reconnect', CORPUS, [], complete=[collection])
    assert retried['deleted'] == 0 and not original.exists()
    assert kb.cleanup_status() == []
    assert any(event['outcome'] == 'purged' for event in kb.import_status('after-reconnect'))
    denied(lambda: kb.original(cred, collection, key, hit['versionId']))
    assert kb.search(cred, 'mileage pence per mile')['results'] == []
    print(json.dumps({'case': 'Windows held original and fresh-connection retry',
                      'logical_reads_denied_while_pending': True, 'durable_path_and_error_retained': True,
                      'physical_success_not_reported_while_locked': True, 'fresh_connection_finds_pending': True,
                      'retry_removes_bytes_and_pending_state': True, 'result': 'FIX_VERIFIED'}))
finally:
    Scenario.tearDownClass()
