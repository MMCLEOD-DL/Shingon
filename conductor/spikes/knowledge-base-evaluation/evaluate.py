"""Runs the P06 evaluation against a throwaway PostgreSQL database (run.sh starts one) and writes results/results.json.

Usage: python3 evaluate.py <dsn> <work-dir>

Retrieval quality is scored against questions.json. Permission checks use an oracle computed here from the manifest,
independently of the database, so a bug in the service's own filter cannot hide itself.
"""
import copy
import json
import platform
import statistics
import sys
import time
from pathlib import Path

import psycopg

import corpus
from kb import KB, Credential

HERE = Path(__file__).parent


def creds(kb: KB) -> dict[str, Credential]:
    return {'alice': Credential('app:acme/alice', 'acme', 'alice'),
            'andy': Credential('app:acme/andy', 'acme', 'andy'),
            'bella': Credential('app:birch/bella', 'birch', 'bella'),
            'conductor': kb.issue_project_token('conductor:demo-project', ['standards'])}


class Oracle:
    """Which sources each credential may see, from the manifest state alone."""

    def __init__(self, manifest: dict):
        self.m = copy.deepcopy(manifest)
        self.deleted: set[str] = set()
        self.failed = {'acme/receipts-guidance-scan.pdf', 'acme/board-minutes-locked.pdf', 'acme/installer.bin'}

    def visible(self, cred: Credential, key: str) -> bool:
        src = next(s for s in self.m['sources'] if s['key'] == key)
        coll = self.m['collections'][src['collection']]
        if coll['tenant'] != cred.tenant or (cred.collections and src['collection'] not in cred.collections):
            return False
        if key in self.deleted or key in self.failed:
            return False
        acl = src.get('acl')
        if not acl:
            return True
        groups = {g for g, ms in self.m['tenants'][cred.tenant]['groups'].items() if cred.principal in ms}
        return cred.principal in acl.get('principals', []) or bool(groups & set(acl.get('groups', [])))


def score(q: dict, res: dict) -> dict:
    keys = [r['documentId'] for r in res['results']]
    out = {'id': q['id'], 'category': q['category'], 'evidence': res['evidence'], 'top': keys[:3],
           'ms': round(res['ms'], 2)}
    if q['expect'] == 'none':
        out['correct'] = res['evidence'] == 'none'
        out['kind'] = 'abstain'
        return out
    exp = q['expect']
    hit_rank = next((i + 1 for i, k in enumerate(keys) if k == exp['key']), None)
    out['kind'] = 'answerable'
    out['hitRank'] = hit_rank
    cited = next((r for r in res['results'][:3] if r['documentId'] == exp['key']), None)
    loc_ok = cited is not None and all(cited['locator'].get(k) == v for k, v in exp.get('locator', {}).items())
    ver_ok = cited is not None and ('version' not in exp or cited['versionId'] == exp['version'])
    out['citationCorrect'] = bool(loc_ok and ver_ok)
    out['correct'] = hit_rank == 1 and out['citationCorrect'] and res['evidence'] != 'none'
    if 'mustFlagInstructionLike' in q:
        out['instructionFlagged'] = any(r['flags']['instructionLike'] for r in res['results']
                                        if r['documentId'] == q['mustFlagInstructionLike'])
        out['correct'] = out['correct'] and out['instructionFlagged']
    if 'mustFlagSuperseded' in q:
        olds = [r for r in res['results'] if r['documentId'] == q['mustFlagSuperseded']]
        out['supersededFlagged'] = all(r['flags']['supersededBy'] for r in olds)
    return out


def main(dsn: str, work: Path) -> int:
    work.mkdir(parents=True, exist_ok=True)
    src = work / 'corpus'
    t0 = time.perf_counter()
    corpus.build(src)
    build_s = time.perf_counter() - t0
    manifest = json.loads((src / 'manifest.json').read_text())
    kb = KB(dsn, work / 'originals')
    kb.setup(manifest)
    oracle = Oracle(manifest)
    c = creds(kb)
    checks: list[dict] = []

    def check(name: str, ok: bool, detail: str = '') -> None:
        checks.append({'check': name, 'ok': bool(ok), 'detail': detail})

    v1 = {'acme/expenses-policy.docx': src / 'acme/_v1-expenses-policy.docx'}
    t0 = time.perf_counter()
    first = kb.sync('run-1', src, manifest['sources'], files=v1)
    ingest_s = time.perf_counter() - t0
    r = kb.search(c['alice'], 'mileage rate pence per mile own car')
    check('version 1 indexed first', r['results'] and r['results'][0]['versionId'] == 1 and '45 pence' in r['results'][0]['excerpt'],
          json.dumps(r['results'][:1])[:300])

    second = kb.sync('run-2', src, manifest['sources'])
    exp_sid = kb.db.execute("SELECT id FROM sources WHERE key = 'acme/expenses-policy.docx'").fetchone()[0]
    stale = kb.db.execute('SELECT count(*) FROM chunks WHERE source_id = %s AND version = 1', (exp_sid,)).fetchone()[0]
    check('changed file becomes version 2 and version 1 passages are gone', second['updated'] == 1 and stale == 0,
          f'sync={second} v1-chunks={stale}')

    before = kb.db.execute('SELECT (SELECT count(*) FROM sources), (SELECT count(*) FROM chunks), (SELECT count(*) FROM versions)').fetchone()
    third = kb.sync('run-3', src, manifest['sources'])
    after = kb.db.execute('SELECT (SELECT count(*) FROM sources), (SELECT count(*) FROM chunks), (SELECT count(*) FROM versions)').fetchone()
    check('repeat import changes nothing', before == after and third['added'] == third['updated'] == third['deleted'] == 0,
          f'sync={third} counts {before} -> {after}')

    events = kb.db.execute("SELECT key, message FROM import_events WHERE run_id = 'run-3' AND outcome = 'failed' ORDER BY key").fetchall()
    msgs = dict(events)
    check('import status names each failure with an action',
          'password' in msgs.get('acme/board-minutes-locked.pdf', '') and 'OCR' in msgs.get('acme/receipts-guidance-scan.pdf', '')
          and 'not supported' in msgs.get('acme/installer.bin', ''), json.dumps(msgs))
    note = kb.db.execute("SELECT text FROM chunks WHERE text LIKE '[import note]%%'").fetchall()
    check('formulas without saved results are reported, not silently dropped', len(note) == 1, note[0][0] if note else '')

    # --- labelled questions ---
    qs = json.loads((HERE / 'questions.json').read_text())['questions']
    latencies = []

    def run_questions(superseded_weight: float) -> list[dict]:
        out = []
        for q in qs:
            res = kb.search(c[q['cred']], q['query'], superseded_weight=superseded_weight)
            latencies.append(res['ms'])
            s = score(q, res)
            s['note'] = q.get('note')
            out.append(s)
        return out

    variants = {'keyword': run_questions(1.0), 'keyword+supersession-demotion': run_questions(0.5)}
    scored = variants['keyword']

    # --- disclosure sweep: every question as every credential, judged by the oracle ---
    def sweep(label: str) -> int:
        bad = 0
        for q in qs:
            for name, cred in c.items():
                res = kb.search(cred, q['query'], limit=20)
                latencies.append(res['ms'])
                bad += sum(1 for r in res['results'] if not oracle.visible(cred, r['documentId']))
        check(f'no unauthorised result ({label})', bad == 0, f'{bad} unauthorised results in {len(qs) * len(c)} searches')
        return bad

    sweep('initial state')

    # --- originals follow the same rule ---
    def can_fetch(cred, key, coll):
        try:
            kb.original(cred, key, coll)
            return True
        except FileNotFoundError:
            return False
    check('restricted original: finance member may download', can_fetch(c['alice'], 'acme/salary-bands.docx', 'acme-policies'))
    check('restricted original: non-member gets not-found', not can_fetch(c['andy'], 'acme/salary-bands.docx', 'acme-policies'))
    check('other tenant original: not-found', not can_fetch(c['bella'], 'acme/expenses-policy.docx', 'acme-policies'))
    check('project token cannot fetch client originals', not can_fetch(c['conductor'], 'acme/expenses-policy.docx', 'acme-policies'))

    # --- scope rules ---
    try:
        kb.issue_project_token('conductor:bad', ['standards', 'acme-policies'])
        check('project token over client-runtime data is refused', False)
    except PermissionError:
        check('project token over client-runtime data is refused', True)
    try:
        kb.search(c['alice'], 'mileage', collections=['birch-handbook'])
        check('widening scope in the request is refused', False)
    except PermissionError:
        check('widening scope in the request is refused', True)

    # --- permission change: alice leaves finance ---
    gen = kb.search(c['alice'], 'salary band Senior Analyst')['indexGeneration']
    kb.set_group_members('acme', 'finance', [])
    oracle.m['tenants']['acme']['groups']['finance'] = []
    r = kb.search(c['alice'], 'salary band Senior Analyst')
    check('group revocation takes effect on the next search', r['evidence'] == 'none' and r['indexGeneration'] > gen,
          f"evidence={r['evidence']} generation {gen} -> {r['indexGeneration']}")
    check('revoked member can no longer download the original', not can_fetch(c['alice'], 'acme/salary-bands.docx', 'acme-policies'))

    # --- ACL change at the source: the document is now shared with andy only ---
    m2 = copy.deepcopy(manifest)
    next(s for s in m2['sources'] if s['key'] == 'acme/salary-bands.docx')['acl'] = {'principals': ['andy']}
    s4 = kb.sync('run-4', src, m2['sources'])
    oracle.m = m2 | {'tenants': oracle.m['tenants']}
    check('source ACL change is applied without re-parsing', s4['acl'] == 1 and s4['updated'] == 0, json.dumps(s4))
    check('newly granted user sees it', kb.search(c['andy'], 'salary band Senior Analyst')['evidence'] != 'none')
    sweep('after permission changes')

    # --- deletion at the source ---
    m3 = copy.deepcopy(m2)
    m3['sources'] = [s for s in m3['sources'] if s['key'] != 'acme/travel-policy-2025.pdf']
    s5 = kb.sync('run-5', src, m3['sources'])
    oracle.deleted.add('acme/travel-policy-2025.pdf')
    sid = kb.db.execute("SELECT id FROM sources WHERE key = 'acme/travel-policy-2025.pdf'").fetchone()[0]
    left = kb.db.execute('SELECT count(*) FROM chunks WHERE source_id = %s', (sid,)).fetchone()[0]
    kb.db.commit()
    hotel = kb.search(c['alice'], 'hotel cap London per night')
    check('deleted source: passages removed', s5['deleted'] == 1 and left == 0, json.dumps(s5))
    check('deleted source: no longer retrievable', all(r['documentId'] != 'acme/travel-policy-2025.pdf' for r in hotel['results']))
    check('deleted source: stored original removed',
          not (work / 'originals' / 'acme-policies' / str(sid)).exists() and not can_fetch(c['alice'], 'acme/travel-policy-2025.pdf', 'acme-policies'))
    sweep('after deletion')

    db_bytes = kb.db.execute('SELECT pg_database_size(current_database())').fetchone()[0]
    counts = kb.db.execute("SELECT (SELECT count(*) FROM sources WHERE status = 'active'), (SELECT count(*) FROM chunks)").fetchone()
    pg_version = kb.db.execute('SHOW server_version').fetchone()[0]

    def metrics(rows: list[dict]) -> dict:
        answerable = [s for s in rows if s['kind'] == 'answerable']
        abstain = [s for s in rows if s['kind'] == 'abstain']
        return {'questions': len(rows), 'answerable': len(answerable),
                'hitAt1': sum(1 for s in answerable if s.get('hitRank') == 1),
                'hitAt3': sum(1 for s in answerable if s.get('hitRank') and s['hitRank'] <= 3),
                'citationCorrect': sum(1 for s in answerable if s.get('citationCorrect')),
                'abstainQuestions': len(abstain), 'abstainCorrect': sum(1 for s in abstain if s['correct']),
                'allCorrect': sum(1 for s in rows if s['correct']),
                'byCategory': {cat: f"{sum(1 for s in rows if s['category'] == cat and s['correct'])}/"
                                    f"{sum(1 for s in rows if s['category'] == cat)}"
                               for cat in sorted({s['category'] for s in rows})}}

    summary = {
        'variants': {name: metrics(rows) for name, rows in variants.items()},
        'checksPassed': sum(1 for ch in checks if ch['ok']),
        'checks': len(checks),
        'latencyMs': {'searches': len(latencies), 'p50': round(statistics.median(latencies), 2),
                      'p95': round(statistics.quantiles(latencies, n=20)[18], 2), 'max': round(max(latencies), 2)},
        'corpusBuildSeconds': round(build_s, 1), 'firstIngestSeconds': round(ingest_s, 2),
        'firstSync': first, 'activeSources': counts[0], 'chunks': counts[1], 'databaseBytes': db_bytes,
        'host': {'python': platform.python_version(), 'postgres': pg_version, 'machine': platform.machine(),
                 'psycopg': psycopg.__version__},
        'mode': 'keyword (PostgreSQL full-text, OR of lexemes, ts_rank_cd normalised); thresholds strong>=0.25 weak>=0.08',
    }
    out = {'summary': summary, 'questions': variants, 'checks': checks}
    (HERE / 'results').mkdir(exist_ok=True)
    (HERE / 'results' / 'results.json').write_text(json.dumps(out, indent=2) + '\n')

    print(json.dumps(summary, indent=2))
    for name, rows in variants.items():
        print(f'--- {name}')
        for s in rows:
            mark = 'ok ' if s['correct'] else 'MISS'
            print(f"{mark} {s['id']} {s['category']:<14} evidence={s['evidence']:<6} top={s['top'][:2]}")
    for ch in checks:
        print(f"{'pass' if ch['ok'] else 'FAIL'} {ch['check']}" + ('' if ch['ok'] else f" — {ch['detail']}"))
    return 0 if all(ch['ok'] for ch in checks) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], Path(sys.argv[2])))
