"""The HTTP layer (K6) beyond what the contract fixtures replay: path decoding, delivery-time re-authorisation of
originals, refusing to send a body that breaks the contract, outages, transport limits, the bind rule and the CLI.
The fixtures themselves are produced over HTTP in test_contract_fixtures.py."""
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlparse, urlunparse

from shingon_knowledge import contract
from shingon_knowledge.db import connect
from shingon_knowledge.http import REQUEST_SECONDS, RateLimiter, check_bind_address
from shingon_knowledge.service import KnowledgeService, NotFound

from support import COLLECTIONS, CORPUS, ApiClient, ServiceTestCase, admin_url, issue_http_callers, start_api

SRC = Path(__file__).resolve().parents[1] / 'src'


class Http(ServiceTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.kb.sync('run-1', CORPUS, cls.manifest['sources'], complete=COLLECTIONS)
        cls.server, port = start_api(cls)
        cls.api = ApiClient(port, issue_http_callers(cls.db))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        super().tearDownClass()

    def call(self, who, method, path, **kw):
        status, headers, data = self.api.request(who, method, path, **kw)
        return status, headers, data

    def error(self, who, method, path, **kw):
        status, headers, data = self.call(who, method, path, **kw)
        body = json.loads(data)
        contract.check_error_body(status, body)
        return status, body['error']['code'], headers

    def test_health_needs_no_credential_and_says_nothing_else(self):
        status, headers, data = self.call(None, 'GET', '/health')
        self.assertEqual((status, json.loads(data)), (200, {'status': 'ok'}))
        self.assertEqual(headers['server'], 'shingon-kb', 'no Python or library version is advertised')

    def test_every_other_route_needs_a_credential(self):
        for method, path in (('GET', '/collections'), ('GET', '/passages/' + 'a' * 64),
                             ('GET', contract.original_path('acme-policies', 'acme/budget-2026.xlsx', 1)), ('GET', '/nowhere')):
            with self.subTest(path=path):
                self.assertEqual(self.error(None, method, path)[:2], (401, 'unauthenticated'))

    def test_json_responses_are_marked_and_never_cached(self):
        status, headers, _ = self.call('alice', 'GET', '/collections', request_id='trace-7')
        self.assertEqual(status, 200)
        self.assertEqual((headers['content-type'], headers['x-content-type-options'], headers['cache-control'], headers['x-request-id']),
                         ('application/json; charset=utf-8', 'nosniff', 'no-store', 'trace-7'))
        self.assertTrue(self.call('alice', 'GET', '/collections', request_id='has space')[1]['x-request-id'].startswith('kb-'))

    def test_each_identifier_is_one_segment_decoded_once(self):
        good = contract.original_path('acme-policies', 'acme/budget-2026.xlsx', 1)
        self.assertEqual(self.call('alice', 'GET', good)[0], 200)
        for name, path in {
            'double-encoded slash': good.replace('%2F', '%252F'),
            'the slash left raw': '/collections/acme-policies/documents/acme/budget-2026.xlsx/versions/1/original',
            'version 01': good.replace('/versions/1/', '/versions/01/'),
            'version -1': good.replace('/versions/1/', '/versions/-1/'),
            'empty segment': '/collections//documents/x/versions/1/original',
            'another tenant\'s collection': contract.original_path('birch-handbook', 'birch/staff-handbook.md', 1),
            'unknown route': '/documents/acme%2Fbudget-2026.xlsx',
            'POST to a GET route': '/collections',
        }.items():
            with self.subTest(name):
                method = 'POST' if name.startswith('POST') else 'GET'
                self.assertEqual(self.error('alice', method, path, body={} if method == 'POST' else None)[:2], (404, 'not-found'))
        for method in ('PUT', 'DELETE', 'PATCH', 'OPTIONS'):
            with self.subTest(method=method):
                self.assertEqual(self.error('alice', method, '/collections')[:2], (404, 'not-found'))
                self.assertEqual(self.error(None, method, '/collections')[:2], (401, 'unauthenticated'))
        for path in (good.replace('%2F', '%zz'), good.replace('%2F', '%FF')):
            with self.subTest(path=path):
                self.assertEqual(self.error('alice', 'GET', path)[:2], (400, 'bad-request'))

    def test_an_original_is_re_authorised_after_it_is_opened(self):
        path = contract.original_path('acme-policies', 'acme/budget-2026.xlsx', 1)
        real, calls = KnowledgeService.original, []

        def revoked_meanwhile(self_, *a, **k):
            calls.append(k.get('audit', True))
            if len(calls) == 2:
                raise NotFound('not-found')  # access withdrawn between the first check and delivery
            return real(self_, *a, **k)
        with mock.patch.object(KnowledgeService, 'original', revoked_meanwhile):
            status, code, _ = self.error('andy', 'GET', path)
        self.assertEqual((status, code, calls), (404, 'not-found', [True, False]), 'second check unaudited, and it refuses')
        status, headers, data = self.call('andy', 'GET', path)
        self.assertEqual((status, headers['content-disposition'], len(data)), (200, "attachment; filename*=UTF-8''budget-2026.xlsx",
                                                                            (CORPUS / 'acme/budget-2026.xlsx').stat().st_size))

    def test_a_body_that_breaks_the_contract_is_never_sent(self):
        broken = lambda raw: {**contract.search_body(raw), 'viewRevision': 7}  # noqa: E731
        with mock.patch('shingon_knowledge.http.contract.search_body', broken), self.assertLogs('shingon_knowledge.http', 'ERROR'):
            status, code, _ = self.error('alice', 'POST', '/search', body={'query': 'mileage'})
        self.assertEqual((status, code), (503, 'index-unavailable'))

    def test_a_fault_is_an_outage_and_its_detail_stays_in_the_log(self):
        with mock.patch.object(KnowledgeService, 'search', side_effect=RuntimeError('pg: relation chunks secret detail')), \
                self.assertLogs('shingon_knowledge.http', 'ERROR') as logged:
            status, _headers, data = self.call('alice', 'POST', '/search', body={'query': 'mileage'})
        self.assertEqual(status, 503)
        self.assertNotIn(b'secret detail', data)
        self.assertIn('secret detail', '\n'.join(logged.output))

    def test_request_bodies_are_bounded_and_strict(self):
        for name, kw in {
            'not JSON': {'raw': b'{query'},
            'NaN': {'raw': b'{"query": "q", "limit": NaN}'},
            'not UTF-8': {'raw': b'{"query": "\xff"}'},
            'chunked': {'raw': b'{}', 'headers': {'Transfer-Encoding': 'chunked'}},
        }.items():
            with self.subTest(name):
                self.assertEqual(self.error('alice', 'POST', '/search', **kw)[:2], (400, 'bad-request'))
        self.assertEqual(self.error('alice', 'POST', '/search', raw=b'{"query": "%s"}' % (b'x' * contract.MAX_REQUEST_BYTES))[:2],
                         (413, 'too-large'))

    def test_content_length_is_checked_as_ascii_digits_before_conversion(self):
        # Codex review K6-H1: these used to drop the connection instead of answering.
        for name, length, expected in (('non-ASCII digit', '\u00b2', (400, 'bad-request')),
                                       ('5,000 digits', '9' * 5000, (413, 'too-large')),
                                       ('sign', '+17', (400, 'bad-request'))):
            with self.subTest(name):
                self.assertEqual(self.error('alice', 'POST', '/search', raw=b'{}', headers={'Content-Length': length})[:2], expected)
        body = b'{"query": "mileage"}'
        self.assertEqual(self.call('alice', 'POST', '/search', raw=body, headers={'Content-Length': f'000{len(body)}'})[0], 200,
                         'leading zeros are the same number')
        with socket.create_connection(('127.0.0.1', self.api.port), timeout=10) as s:  # two lengths: which one is the body?
            s.sendall(b'POST /kb/v1/search HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nContent-Length: 20\r\n\r\n{}')
            self.assertTrue(s.recv(100).startswith(b'HTTP/1.1 400 '))
        self.assertEqual(self.call(None, 'GET', '/health')[0], 200)

    def test_one_time_budget_covers_the_whole_request(self):
        # Codex review K6-H2: a wait in authentication and another in retrieval used to get 5 seconds each.
        url = urlunparse(urlparse(admin_url())._replace(path='/' + self.dbname))
        creds, chunks = connect(url), connect(url)
        self.addCleanup(chunks.close)
        self.addCleanup(creds.close)
        creds.execute('LOCK TABLE credentials IN ACCESS EXCLUSIVE MODE')
        chunks.execute('LOCK TABLE chunks IN ACCESS EXCLUSIVE MODE')
        threading.Timer(1.25, creds.rollback).start()
        started = time.monotonic()
        with self.assertLogs('shingon_knowledge.http', 'ERROR'):
            status, code, _ = self.error('alice', 'POST', '/search', body={'query': 'mileage'})
        elapsed = time.monotonic() - started
        chunks.rollback()
        self.assertEqual((status, code), (503, 'index-unavailable'))
        self.assertLess(elapsed, REQUEST_SECONDS + 0.5, 'one budget for the request, plus a little scheduling')
        self.assertEqual(self.call('alice', 'POST', '/search', body={'query': 'mileage'})[0], 200, 'and it recovers')

    def test_the_rate_limit_is_per_credential_and_user_and_refills(self):
        now = [0.0]
        limiter = RateLimiter(rate=2, per=60, clock=lambda: now[0])
        self.assertEqual([limiter.take(('app:acme', 'alice')) for _ in range(3)], [0, 0, 30])
        self.assertEqual(limiter.take(('app:acme', 'andy')), 0, 'another user has their own allowance')
        now[0] = 30.0
        self.assertEqual(limiter.take(('app:acme', 'alice')), 0)

    def test_it_listens_on_loopback_or_a_private_network_only(self):
        for host in ('127.0.0.1', '::1', 'localhost', '10.1.2.3', '192.168.0.10', '172.16.0.1'):
            check_bind_address(host)
        for host in ('0.0.0.0', '::', '8.8.8.8', '169.254.0.1', 'kb.example.com'):
            with self.subTest(host=host), self.assertRaises(ValueError):
                check_bind_address(host)

    def test_the_command_line_issues_and_revokes_credentials(self):
        u = urlparse(admin_url())
        env = {**os.environ, 'KB_DATABASE_URL': urlunparse(u._replace(path='/' + self.dbname)),
               'PYTHONPATH': os.pathsep.join([str(SRC), os.environ.get('PYTHONPATH', '')])}
        run = lambda *a: subprocess.run([sys.executable, '-m', 'shingon_knowledge', *a], env=env,  # noqa: E731
                                        capture_output=True, text=True, timeout=60)
        out = run('credentials', 'issue-project', 'conductor:cli', 'standards')
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertRegex(out.stdout.strip(), r'^kb1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$')
        app = run('credentials', 'issue-app', 'app:cli', 'acme')
        self.assertRegex(app.stdout, r'token: kb1\..*\nassertion key: [A-Za-z0-9_-]{43}\n')
        self.assertEqual(run('credentials', 'revoke', 'conductor:cli').returncode, 0)
        self.assertEqual(run('credentials', 'revoke', 'conductor:cli').returncode, 1)
        refused = run('serve', '--originals', '/tmp', '--host', '0.0.0.0', '--port', '0')
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('never listens publicly', refused.stderr)
        no_db = subprocess.run([sys.executable, '-m', 'shingon_knowledge', 'credentials', 'revoke', 'x'],
                               env={k: v for k, v in env.items() if k != 'KB_DATABASE_URL'}, capture_output=True, text=True, timeout=60)
        self.assertIn('KB_DATABASE_URL', no_db.stderr)


if __name__ == '__main__':
    unittest.main()
