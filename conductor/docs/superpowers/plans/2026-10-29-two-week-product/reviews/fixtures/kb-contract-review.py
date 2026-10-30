"""Standalone KB contract review. Run with the installed knowledge package from repository root.
Exit 1 records reproduced contract gaps; no database, network or private corpus is used.
"""
from copy import deepcopy
import json
from pathlib import Path
from shingon_knowledge import contract

ROOT = Path(__file__).resolve().parents[7]
DATA = json.loads((ROOT / 'knowledge/contract/kb-contract-v1.json').read_text(encoding='utf-8'))
fixtures = {f['id']: f for f in DATA['fixtures']}
checked = 0
for f in fixtures.values():
    status, body = f['response']['status'], f['response']['body']
    if f.get('kind') == 'conductor-report':
        contract.check_withheld_report(body)
    elif status == 200 and f['request']['path'] == '/search':
        contract.check_search_body(body)
    elif status != 200:
        contract.check_error_body(status, body)
    checked += 1
print(json.dumps({'committed_fixture_shape_controls': checked,
                  'generated':sum(f['origin']=='generated' for f in fixtures.values()),
                  'authored':sum(f['origin']=='authored' for f in fixtures.values())}))

gaps = []
good = fixtures['hit-docx']['response']['body']

def probe(name, mutate, checker=contract.check_search_body, base=good):
    body = deepcopy(base)
    mutate(body)
    try:
        checker(body)
    except contract.ContractError:
        print(json.dumps({'case':name, 'result':'REFUSED'}))
    else:
        gaps.append(name)
        print(json.dumps({'case':name, 'result':'ACCEPTED_BY_CHECKER'}))

probe('NaN score is not JSON', lambda b:b['results'][0]['scores'].update(keyword=float('nan')))
probe('Infinity score is not JSON', lambda b:b['results'][0]['scores'].update(vector=float('inf')))
probe('impossible calendar timestamp', lambda b:b['results'][0]['source'].update(ingestedAt='2026-99-99T99:99:99Z'))
probe('zero source version', lambda b:b['results'][0].update(versionId=0))
status, rate = contract.error_body('rate-limit', 'review', retry_after=-30)
probe('negative retryAfter', lambda b:None, checker=lambda b:contract.check_error_body(status,b),base=rate)
report=fixtures['destination-withheld']['response']['body']
probe('unknown destination name in withheld report',lambda b:b.update(allowedDestinations=['unrecognised-provider']),
      checker=contract.check_withheld_report,base=report)

# The retained source key is unique only inside a collection. Show the documented wire mapping collision.
a = deepcopy(good['results'][0]); b = deepcopy(a)
a.update(documentId='policies/current.md', collectionId='team-a', versionId=1)
b.update(documentId='policies/current.md', collectionId='team-b', versionId=1)
a['scores']['rank']=1; b['scores']['rank']=2
collision={'indexGeneration':1,'evidence':'strong','results':[a,b]}
contract.check_search_body(collision)
urls=[f"/documents/{r['documentId'].replace('/', '%2F')}/versions/{r['versionId']}/original" for r in collision['results']]
assert urls[0]==urls[1]
gaps.append('same source key in two collections maps to same original URL')
print(json.dumps({'case':gaps[-1],'result':'COLLISION','urls':urls}))
# Inject one already-authorised candidate row through the actual search projection. This is not a SQL/ACL test.
from shingon_knowledge import Credential, KnowledgeService
class Rows:
    def __init__(self, rows=()): self.rows = list(rows)
    def fetchall(self): return self.rows
    def fetchone(self): return self.rows[0] if self.rows else None
class CandidateDb:
    def execute(self, sql, params=None):
        if sql.startswith('SELECT id FROM collections'): return Rows([('visible',)])
        if 'WITH q AS' in sql:
            return Rows([(1,1,1,'visible','Visible policy','Allowed public policy',
                          {'sectionPath':['Policy']},False,'public.md','private/acquisition-plan.docx',0.3,
                          '2026-10-30T12:00:00Z')])
        if sql.startswith('SELECT index_generation'): return Rows([(7,)])
        return Rows()
    def commit(self): pass
raw = KnowledgeService(CandidateDb(), Path('.')).search(Credential('review','tenant',None,('visible',)), 'policy')
wire = contract.search_body(raw)
contract.check_search_body(wire)
assert wire['results'][0]['flags']['supersededBy'] == 'private/acquisition-plan.docx'
print(json.dumps({'case':'ACL-unchecked supersededBy projection', 'result':'HIDDEN_REFERENCE_RETAINED',
                  'scope':'Actual search and wire projection with an injected authorised candidate; SQL not executed.'}))

gaps.append('ACL-unchecked supersededBy projection')
print(json.dumps({'reproduced_contract_gaps':len(gaps),
                  'scope':'Pure shape checks and documented URL mapping only; no SQL or HTTP behaviour claimed.'}))
raise SystemExit(1 if gaps else 0)
