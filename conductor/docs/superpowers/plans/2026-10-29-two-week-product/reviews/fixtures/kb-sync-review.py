"""PR41 review: synthetic complete/partial sync, failed refresh and Windows file-lock deletion.

Requires disposable TEST_DATABASE_URL and the installed knowledge package. Exit 1 means
sync reports deletion while a locked original survives and is not retried. No real files,
model, connector or HTTP layer is used. The file-lock case is native Windows only.
"""
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[7]
sys.path.insert(0, str(ROOT / 'knowledge/tests'))
from support import CORPUS, ServiceTestCase
from shingon_knowledge import NotFound


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
    complete = list(manifest['collections'])
    kb.sync('initial', CORPUS, manifest['sources'], complete=complete)
    source = next(s for s in manifest['sources'] if s['key'] == 'birch/staff-handbook.md')
    cred, collection, key = creds['bella'], source['collection'], source['key']
    hit = next(r for r in kb.search(cred, 'mileage pence per mile')['results'] if r['documentId'] == key)
    original = kb.original(cred, collection, key, hit['versionId'])
    assert original.exists()
    unchanged = kb.sync('partial-empty', CORPUS, [], complete=[])
    assert unchanged['deleted'] == 0 and original.exists()
    assert kb.original(cred, collection, key, hit['versionId']) == original
    removed = kb.sync('complete-empty', CORPUS, [], complete=[collection])
    assert removed['deleted'] == 1 and not original.exists()
    denied(lambda: kb.passage(cred, hit['chunkId']))
    denied(lambda: kb.original(cred, collection, key, hit['versionId']))
    assert kb.search(cred, 'mileage pence per mile')['results'] == []
    print('PASS: empty partial preserves; empty complete removes last source and unblocked original; all reads deny')

    # An explicitly listed source whose bytes cannot be refreshed must disappear from reads.
    kb.sync('restore-for-refresh', CORPUS, [source], complete=[collection])
    hit = next(r for r in kb.search(cred, 'mileage pence per mile')['results'] if r['documentId'] == key)
    failed = kb.sync('failed-read', CORPUS, [source], files={key: Scenario.work/'missing-source.md'}, complete=[])
    assert failed['failed'] == 1 and failed['deleted'] == 0
    assert kb.search(cred, 'mileage pence per mile')['results'] == []
    denied(lambda: kb.passage(cred, hit['chunkId']))
    denied(lambda: kb.original(cred, collection, key, hit['versionId']))
    assert any(e['outcome'] == 'failed' for e in kb.import_status('failed-read'))
    print('PASS: failed source read leaves search, passage and original paths, with failed import status')

    if os.name != 'nt':
        print('SKIPPED: Windows open-file deletion case requires native Windows')
        raise SystemExit(0)
    kb.sync('restore-for-lock', CORPUS, [source], complete=[collection])
    hit = next(r for r in kb.search(cred, 'mileage pence per mile')['results'] if r['documentId'] == key)
    original = kb.original(cred, collection, key, hit['versionId'])
    with original.open('rb') as held:
        assert held.read(1)
        result = kb.sync('locked-delete', CORPUS, [], complete=[collection])
        survived = original.exists()
        denied(lambda: kb.original(cred, collection, key, hit['versionId']))
        events = kb.import_status('locked-delete')
        reported_deleted = result['deleted'] == 1 and any(e['outcome'] == 'deleted' for e in events)
    retry = kb.sync('after-handle-close', CORPUS, [], complete=[collection])
    retained_after_retry = original.exists()
    print(json.dumps({'case': 'Windows original open during complete deletion',
                      'reported_deleted': reported_deleted, 'original_survived_delete': survived,
                      'read_api_denies': True, 'retry_deleted': retry['deleted'],
                      'original_survived_retry_after_close': retained_after_retry,
                      'result': 'REPRODUCED' if reported_deleted and survived and retained_after_retry else 'NOT_REPRODUCED'}))
    raise SystemExit(1 if reported_deleted and survived and retained_after_retry else 0)
finally:
    Scenario.tearDownClass()
