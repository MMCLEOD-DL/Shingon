"""Credentials for the HTTP layer (K6; retrieval-contract.md §2), against a real database: what each kind of token
reaches, and every way a request can fail to prove who it is. Every failure is the same Unauthenticated."""
import time

from shingon_knowledge import auth
from shingon_knowledge.auth import Unauthenticated
from shingon_knowledge.service import ScopeError

from support import COLLECTIONS, CORPUS, ServiceTestCase

NOW = 1_800_000_000  # a fixed clock, so expiry is exact


class Credentials(ServiceTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.kb.sync('run-1', CORPUS, cls.manifest['sources'], complete=COLLECTIONS)
        cls.project = auth.issue_project_credential(cls.db, 'conductor:shingon', ['standards'])
        cls.app, cls.key = auth.issue_app_credential(cls.db, 'app:acme', 'acme')

    def bearer(self, token):
        return f'Bearer {token}'

    def assertion(self, user='alice', *, tenant='acme', exp=NOW + 120, nonce=None, key=None):
        return auth.sign_assertion(key or self.key, tenant, user, expires_at=exp, nonce=nonce)

    def login(self, token, assertion=None, now=NOW):
        return auth.authenticate(self.db, self.bearer(token), assertion, now=now)

    def refused(self, token, assertion=None, now=NOW):
        with self.assertRaises(Unauthenticated):
            self.login(token, assertion, now)

    def test_a_project_token_reaches_its_reference_collections_only(self):
        cred = self.login(self.project)
        self.assertEqual((cred.name, cred.tenant, cred.principal, cred.collections), ('conductor:shingon', 'company', None, ('standards',)))
        hits = self.kb.search(cred, 'what must never be written to logs')['results']
        self.assertTrue(hits and all(h['collectionId'] == 'standards' for h in hits))
        for bad in (['acme-policies'], ['standards', 'acme-policies'], [], ['no-such-collection']):
            with self.subTest(collections=bad), self.assertRaises(ScopeError):
                auth.issue_project_credential(self.db, 'conductor:bad', bad)

    def test_an_app_reaches_what_its_asserted_user_may_see(self):
        alice, andy = self.login(self.app, self.assertion('alice')), self.login(self.app, self.assertion('andy'))
        self.assertEqual((alice.name, alice.tenant, alice.principal), ('app:acme', 'acme', 'alice'))
        salary = lambda c: [h for h in self.kb.search(c, 'salary band Senior Analyst', limit=20)['results']  # noqa: E731
                            if h['documentId'] == 'acme/salary-bands.docx']
        self.assertTrue(salary(alice))
        self.assertFalse(salary(andy))
        audit = self.db.execute("SELECT credential, principal FROM audit WHERE credential = 'app:acme' ORDER BY id").fetchall()
        self.db.commit()
        self.assertEqual([tuple(r) for r in audit[-2:]], [('app:acme', 'alice'), ('app:acme', 'andy')], '§2 (c)')

    def test_bad_tokens_are_refused(self):
        cid, secret = self.project.split('.')[1:]
        for token in ('', 'kb1', f'kb1.{cid}', f'kb1.{cid}.{"A" * 43}', f'kb1.{"0" * 32}.{secret}',
                      f'kb2.{cid}.{secret}', f'kb1.{cid}.{secret}x', self.project.upper()):
            with self.subTest(token=token[:20]):
                self.refused(token)
        with self.assertRaises(Unauthenticated):
            auth.authenticate(self.db, self.project, None, now=NOW)  # no "Bearer"
        with self.assertRaises(Unauthenticated):
            auth.authenticate(self.db, None, None, now=NOW)

    def test_bad_assertions_are_refused(self):
        other_tenant_key = auth.issue_app_credential(self.db, 'app:birch', 'birch')[1]
        good = self.assertion()
        payload, sig = good.split('.')
        for name, assertion in {
            'none': None,
            'expired': self.assertion(exp=NOW),
            'over five minutes': self.assertion(exp=NOW + 301),
            'another tenant': self.assertion(tenant='birch'),
            'unknown user': self.assertion('mallory'),
            'user from another tenant': self.assertion('bella'),
            'signed with another key': self.assertion(key=other_tenant_key),
            'tampered payload': f'{payload[:-2]}AA.{sig}',
            'no signature': payload,
            'short nonce': self.assertion(nonce='short'),
            'garbage': 'not.base64!!',
            'too long': 'a' * 2000 + '.' + sig,
        }.items():
            with self.subTest(name):
                self.refused(self.app, assertion)
        self.refused(self.project, self.assertion(), )  # a project token cannot assert a user

    def test_an_assertion_is_used_once(self):
        a = self.assertion(nonce='replay-me-0123456789')
        self.login(self.app, a)
        self.refused(self.app, a)
        # Not even after it has been tidied away, while it is unexpired.
        self.refused(self.app, a, now=NOW + 60)

    def test_revocation_takes_effect_on_the_next_request(self):
        token = auth.issue_project_credential(self.db, 'conductor:short-lived', ['standards'])
        self.login(token)
        self.assertTrue(auth.revoke(self.db, 'conductor:short-lived'))
        self.refused(token)
        self.assertFalse(auth.revoke(self.db, 'conductor:short-lived'), 'already revoked')

    def test_the_database_never_holds_a_usable_token(self):
        secret = self.project.split('.')[2]
        rows = self.db.execute('SELECT id, secret_sha256 FROM credentials').fetchall()
        self.db.commit()
        self.assertNotIn(secret, repr(rows))
        self.assertTrue(all(len(h) == 64 for _i, h in rows))

    def test_the_clock_defaults_to_now(self):
        self.login(self.app, self.assertion(exp=int(time.time()) + 60), now=None)
