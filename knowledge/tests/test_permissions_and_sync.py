"""The spike's 21 permission, sync and deletion checks, as one ordered scenario (each step depends on the last),
plus credential refusal and migrations. Run: TEST_DATABASE_URL=... python -m unittest discover -s tests"""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from shingon_knowledge import NotFound, ScopeError, find_secret, parse, ImportProblem
from shingon_knowledge.db import migrate

from support import COLLECTIONS, CORPUS, FIXTURES, Oracle, ServiceTestCase

QUESTIONS = json.loads((FIXTURES / 'questions.json').read_text(encoding='utf-8'))['questions']


class PermissionsSyncDeletion(ServiceTestCase):
    def sweep(self, oracle: Oracle) -> int:
        bad = 0
        for q in QUESTIONS:
            for cred in self.creds.values():
                bad += sum(1 for r in self.kb.search(cred, q['query'], limit=20)['results'] if not oracle.visible(cred, r['documentId']))
        return bad

    def can_fetch(self, who, collection, key, version=1) -> bool:
        try:
            self.kb.original(self.creds[who], collection, key, version)
            return True
        except NotFound:
            return False

    def test_scenario(self):
        kb, c, m = self.kb, self.creds, self.manifest
        oracle = Oracle(m)
        v1 = {'acme/expenses-policy.docx': CORPUS / 'acme/_v1-expenses-policy.docx'}

        first = kb.sync('run-1', CORPUS, m['sources'], files=v1, complete=COLLECTIONS)
        self.assertEqual(first, {'added': 8, 'updated': 0, 'unchanged': 0, 'deleted': 0, 'failed': 3, 'acl': 0})
        r = kb.search(c['alice'], 'mileage rate pence per mile own car')
        exp = [x for x in r['results'] if x['documentId'] == 'acme/expenses-policy.docx']
        self.assertTrue(exp and exp[0]['versionId'] == 1 and '45 pence' in exp[0]['excerpt'], 'version 1 indexed first')

        second = kb.sync('run-2', CORPUS, m['sources'], complete=COLLECTIONS)
        self.assertEqual(second['updated'], 1)
        sid = kb.db.execute("SELECT id FROM sources WHERE key = 'acme/expenses-policy.docx'").fetchone()[0]
        self.assertEqual(kb.db.execute('SELECT count(*) FROM chunks WHERE source_id = %s AND version = 1', (sid,)).fetchone()[0], 0,
                         'version 1 passages are gone once version 2 is indexed')

        count = "SELECT (SELECT count(*) FROM sources), (SELECT count(*) FROM chunks), (SELECT count(*) FROM versions)"
        before = kb.db.execute(count).fetchone()
        third = kb.sync('run-3', CORPUS, m['sources'], complete=COLLECTIONS)
        self.assertEqual(kb.db.execute(count).fetchone(), before, 'repeat import changes nothing')
        self.assertEqual((third['added'], third['updated'], third['deleted']), (0, 0, 0))

        failed = {e['key']: e['message'] for e in kb.import_status('run-3') if e['outcome'] == 'failed'}
        self.assertIn('password', failed['acme/board-minutes-locked.pdf'])
        self.assertIn('OCR', failed['acme/receipts-guidance-scan.pdf'])
        self.assertIn('not supported', failed['acme/installer.bin'])
        notes = kb.db.execute("SELECT text FROM chunks WHERE text LIKE '[import note]' || chr(37)").fetchall()
        self.assertEqual(len(notes), 1, 'formulas without saved results are reported, not dropped')

        self.assertEqual(self.sweep(oracle), 0, 'no unauthorised result (initial state)')

        self.assertTrue(self.can_fetch('alice', 'acme-policies', 'acme/salary-bands.docx'))
        self.assertFalse(self.can_fetch('andy', 'acme-policies', 'acme/salary-bands.docx'))
        self.assertFalse(self.can_fetch('bella', 'acme-policies', 'acme/expenses-policy.docx', 2))
        self.assertFalse(self.can_fetch('conductor', 'acme-policies', 'acme/expenses-policy.docx', 2))
        # Only the current version's original is served: never the latest bytes in place of a replaced version.
        self.assertTrue(self.can_fetch('alice', 'acme-policies', 'acme/expenses-policy.docx', 2))
        self.assertFalse(self.can_fetch('alice', 'acme-policies', 'acme/expenses-policy.docx', 1))
        self.assertFalse(self.can_fetch('alice', 'acme-policies', 'acme/expenses-policy.docx', 3))

        with self.assertRaises(ScopeError):
            kb.issue_project_token('conductor:bad', ['standards', 'acme-policies'])
        with self.assertRaises(ScopeError):
            kb.search(c['alice'], 'mileage', collections=['birch-handbook'])

        rev = kb.search(c['alice'], 'salary band Senior Analyst')['viewRevision']
        kb.set_group_members('acme', 'finance', [])
        oracle.m['tenants']['acme']['groups']['finance'] = []
        r = kb.search(c['alice'], 'salary band Senior Analyst')
        self.assertEqual(r['evidence'], 'none', 'group revocation takes effect on the next search')
        self.assertNotEqual(r['viewRevision'], rev, 'her view changed, so her revision did')
        self.assertFalse(self.can_fetch('alice', 'acme-policies', 'acme/salary-bands.docx'))

        m2 = copy.deepcopy(m)
        next(s for s in m2['sources'] if s['key'] == 'acme/salary-bands.docx')['acl'] = {'principals': ['andy']}
        s4 = kb.sync('run-4', CORPUS, m2['sources'], complete=COLLECTIONS)
        oracle.m = m2 | {'tenants': oracle.m['tenants']}
        self.assertEqual((s4['acl'], s4['updated']), (1, 0), 'source ACL change applied without re-parsing')
        self.assertNotEqual(kb.search(c['andy'], 'salary band Senior Analyst')['evidence'], 'none')
        self.assertEqual(self.sweep(oracle), 0, 'no unauthorised result (after permission changes)')

        m3 = copy.deepcopy(m2)
        m3['sources'] = [s for s in m3['sources'] if s['key'] != 'acme/travel-policy-2025.pdf']
        s5 = kb.sync('run-5', CORPUS, m3['sources'], complete=COLLECTIONS)
        oracle.deleted.add('acme/travel-policy-2025.pdf')
        sid = kb.db.execute("SELECT id FROM sources WHERE key = 'acme/travel-policy-2025.pdf'").fetchone()[0]
        self.assertEqual(s5['deleted'], 1)
        self.assertEqual(kb.db.execute('SELECT count(*) FROM chunks WHERE source_id = %s', (sid,)).fetchone()[0], 0)
        kb.db.commit()
        self.assertTrue(all(x['documentId'] != 'acme/travel-policy-2025.pdf' for x in kb.search(c['alice'], 'hotel cap London per night')['results']))
        self.assertFalse((self.work / 'originals' / 'acme-policies' / str(sid)).exists())
        self.assertFalse(self.can_fetch('alice', 'acme-policies', 'acme/travel-policy-2025.pdf'))
        self.assertEqual(self.sweep(oracle), 0, 'no unauthorised result (after deletion)')

        audited = kb.db.execute('SELECT count(*) FROM audit').fetchone()[0]
        kb.db.commit()
        self.assertGreater(audited, 0)
        stored = kb.db.execute("SELECT count(*) FROM audit WHERE query_sha256 LIKE 'salary' || chr(37)").fetchone()[0]
        kb.db.commit()
        self.assertEqual(stored, 0, 'query text is never stored in the audit, only its hash')

    def test_migrations_are_idempotent(self):
        self.assertEqual(migrate(self.db), [])


class CredentialsAreNeverIndexed(unittest.TestCase):
    def test_secrets_are_refused_with_an_action(self):
        key = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END ' + 'OPENSSH PRIVATE KEY-----'
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'deploy-notes.md'
            p.write_text(f'# Deploy notes\n\n## Access\n\n{key}\n', encoding='utf-8')
            with self.assertRaises(ImportProblem) as e:
                parse(p)
            self.assertIn('appears to contain a private key', str(e.exception))
            self.assertIn('Remove the secret at the source', str(e.exception))

    def test_ordinary_security_advice_is_not_mistaken_for_a_secret(self):
        self.assertIsNone(find_secret('Never log passwords, API keys, session tokens or the text of a receipt.'))
        self.assertIsNone(find_secret('Set the password in the vault, not here.'))
        self.assertEqual(find_secret('api_key = ' + 'x' * 24), 'a password or secret assignment')


if __name__ == '__main__':
    unittest.main()


class AuthoritativeListings(ServiceTestCase):
    """Codex review decision 2: only a listing read in full deletes, and then even the last document goes."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.kb.sync('run-1', CORPUS, cls.manifest['sources'], complete=COLLECTIONS)

    def counts(self):
        return {c['collectionId']: c['documents'] for who in ('alice', 'bella', 'conductor')
                for c in self.kb.collections(self.creds[who])['collections']}

    def test_a_complete_empty_listing_removes_the_last_document(self):
        before = self.kb.search(self.creds['bella'], 'mileage pence per mile')
        self.assertEqual(before['results'][0]['documentId'], 'birch/staff-handbook.md')
        out = self.kb.sync('run-2', CORPUS, [], complete=['birch-handbook'])
        self.assertEqual(out['deleted'], 1)
        after = self.kb.search(self.creds['bella'], 'mileage pence per mile')
        self.assertEqual((after['results'], after['evidence']), ([], 'none'))
        self.assertNotEqual(after['viewRevision'], before['viewRevision'])
        self.assertEqual(self.kb.collections(self.creds['bella'])['collections'][0]['documents'], 0)
        with self.assertRaises(NotFound):
            self.kb.original(self.creds['bella'], 'birch-handbook', 'birch/staff-handbook.md', 1)
        self.assertIn('deleted', [e['outcome'] for e in self.kb.import_status('run-2')])

    def test_a_listing_not_named_complete_deletes_nothing(self):
        before = self.counts()
        one = [s for s in self.manifest['sources'] if s['key'] == 'acme/budget-2026.xlsx']
        self.assertEqual(self.kb.sync('run-3', CORPUS, one, complete=[])['deleted'], 0)
        # A failed read upstream must reach sync as "nothing complete", never as an empty complete listing.
        self.assertEqual(self.kb.sync('run-4', CORPUS, [], complete=[])['deleted'], 0)
        self.assertEqual(self.counts(), before)

    def test_complete_must_name_declared_collections_once(self):
        before = self.counts()
        for bad in (['no-such-collection'], ['standards', 'standards']):
            with self.subTest(complete=bad), self.assertRaises(ValueError):
                self.kb.sync('run-5', CORPUS, [], complete=bad)
        with self.assertRaises(TypeError):
            self.kb.sync('run-6', CORPUS, [])  # pylint: disable=missing-kwoa
        self.assertEqual(self.counts(), before)
