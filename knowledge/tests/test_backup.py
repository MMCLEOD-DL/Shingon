"""Backups and the restore drill (K9): a backup restores to the same database, the same files and the same answers
for every caller, and every way it could silently be wrong is refused instead."""
import io
import json
import os
import shutil
import tempfile
import unittest
import uuid
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock
from urllib.parse import urlparse, urlunparse

from shingon_knowledge import KnowledgeService, NotFound, auth
from shingon_knowledge import backup as kb_backup
from shingon_knowledge.__main__ import main
from shingon_knowledge.backup import BackupError, backup, drill, restore, verify
from shingon_knowledge.db import connect

from support import COLLECTIONS, CORPUS, FIXTURES, ServiceTestCase, admin_url

CALLERS = {'alice': {'tenant': 'acme', 'principal': 'alice'}, 'andy': {'tenant': 'acme', 'principal': 'andy'},
           'bella': {'tenant': 'birch', 'principal': 'bella'}, 'conductor': {'credential': 'conductor:test'}}


class Backups(ServiceTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        kb = cls.kb
        kb.sync('run-1', CORPUS, cls.manifest['sources'], files={'acme/expenses-policy.docx': CORPUS / 'acme/_v1-expenses-policy.docx'},
                complete=COLLECTIONS)
        kb.sync('run-2', CORPUS, cls.manifest['sources'], complete=COLLECTIONS)
        # A deleted source whose stored original could not be removed yet: still on disk, pending removal.
        held = PermissionError(13, 'The process cannot access the file because it is being used by another process')
        with mock.patch('shingon_knowledge.service.os.remove', side_effect=held):
            kb.sync('run-held', CORPUS, [], complete=['birch-handbook'])
        cls.pending = Path(kb.db.execute('SELECT original_path FROM versions WHERE purge_pending').fetchone()[0])
        cls.token = auth.issue_project_credential(kb.db, 'conductor:test', ['standards'])
        questions = json.loads((FIXTURES / 'questions.json').read_text(encoding='utf-8'))['questions']
        cls.questions = cls.work / 'questions.json'
        cls.questions.write_text(json.dumps({'questions': [{'id': q['id'], 'as': CALLERS[q['cred']], 'query': q['query']}
                                                           for q in questions]}), encoding='utf-8')
        cls.url = urlunparse(urlparse(admin_url())._replace(path='/' + cls.dbname))
        cls.backup = backup(cls.url, kb.originals, cls.work / 'backups', cls.questions)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='kb-backup-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def copy_of_backup(self) -> Path:
        return Path(shutil.copytree(self.backup, self.tmp / self.backup.name))

    def scratch_database(self) -> str:
        name = f'kbrestore_{uuid.uuid4().hex[:12]}'
        self._admin.execute(f'CREATE DATABASE {name}')
        self.addCleanup(self._admin.execute, f'DROP DATABASE IF EXISTS {name} WITH (FORCE)')
        return urlunparse(urlparse(admin_url())._replace(path='/' + name))

    def test_the_drill_restores_the_same_database_files_and_answers(self):
        report = drill(self.backup, admin_url())
        self.assertEqual(report['result'], 'pass', report)
        self.assertEqual([c['check'] for c in report['checks']],
                         ['restore', 'migrations', 'row counts', 'originals match their import hashes', 'view revisions',
                          'check questions'])
        principals = self.kb.db.execute('SELECT count(*) FROM principals').fetchone()[0]
        self.kb.db.commit()
        self.assertEqual((report['callers'], report['questions']), (principals + 1, 25), 'every principal, the project token, every question')
        self.assertEqual(self._admin.execute("SELECT count(*) FROM pg_database WHERE datname LIKE 'kb_drill_%'").fetchone()[0], 0,
                         'the scratch database is dropped')

    def test_the_manifest_describes_what_was_saved(self):
        m = verify(self.backup)
        self.assertEqual(sorted(p.name for p in self.backup.iterdir()), ['database.dump', 'manifest.json', 'originals'])
        if os.name == 'posix':
            self.assertEqual(self.backup.stat().st_mode & 0o777, 0o700, 'owner only')
        saved = [f for f in m['originals'] if not f['pending']]
        self.assertEqual(len(saved), self.kb.db.execute('SELECT count(*) FROM versions WHERE original_path IS NOT NULL AND NOT purge_pending').fetchone()[0])
        self.assertEqual(len(saved), sum(1 for p in (self.backup / 'originals').rglob('*') if p.is_file()))
        [pending] = [f for f in m['originals'] if f['pending']]
        self.assertNotIn('sha256', pending, 'an original awaiting removal is listed, not copied')
        self.assertFalse((self.backup / 'originals' / pending['path']).exists())
        self.assertEqual(m['rowCounts']['chunks'], self.kb.db.execute('SELECT count(*) FROM chunks').fetchone()[0])
        self.assertNotIn('query', json.dumps(m['fingerprints']), 'fingerprints are hashes')

    def test_a_restore_serves_the_same_originals_from_the_new_folder_only(self):
        url, folder = self.scratch_database(), self.tmp / 'restored'
        restore(self.backup, url, folder)
        db = connect(url)
        self.addCleanup(db.close)
        restored = KnowledgeService(db, folder)
        alice = self.creds['alice']
        path = restored.original(alice, 'acme-policies', 'acme/expenses-policy.docx', 2)
        self.assertTrue(path.is_relative_to(folder))
        self.assertEqual(path.read_bytes(), self.kb.original(alice, 'acme-policies', 'acme/expenses-policy.docx', 2).read_bytes())
        self.assertEqual(restored.search(alice, 'mileage pence per mile')['results'][0]['documentId'], 'acme/expenses-policy.docx')
        self.assertEqual(auth.authenticate(db, f'Bearer {self.token}', None).name, 'conductor:test', 'tokens keep working')
        # The pending original now points into the new folder, so its removal never reaches the old deployment's files.
        self.assertEqual(restored.purge_originals('after-restore'), [])
        self.assertTrue(self.pending.exists(), "the source deployment's file is untouched")
        self.assertEqual([e['outcome'] for e in restored.import_status('after-restore')], ['purged'])

    def test_a_restore_refuses_a_database_or_folder_in_use(self):
        with self.assertRaisesRegex(BackupError, 'database is not empty'):
            restore(self.backup, self.url, self.tmp / 'new')
        self.assertFalse((self.tmp / 'new').exists(), 'nothing copied')
        used = self.tmp / 'used'
        used.mkdir()
        (used / 'something').write_text('x')
        with self.assertRaisesRegex(BackupError, 'not empty'):
            restore(self.backup, self.scratch_database(), used)

    def test_a_failed_restore_leaves_an_empty_database_and_folder(self):
        url, folder = self.scratch_database(), self.tmp / 'failed'
        with mock.patch.object(kb_backup, '_run', side_effect=BackupError('pg_restore failed (exit 1): simulated')), \
                self.assertRaisesRegex(BackupError, 'simulated'):
            restore(self.backup, url, folder)
        self.assertEqual(list(folder.iterdir()), [], 'the copied originals are removed, so a retry is not refused')
        restore(self.backup, url, folder)  # and the retry works

    def test_a_changed_backup_restores_nothing(self):
        for part in ('database.dump', 'originals'):
            with self.subTest(part=part):
                copy = self.copy_of_backup()
                target = copy / part if part == 'database.dump' else next(p for p in (copy / part).rglob('*') if p.is_file())
                target.write_bytes(target.read_bytes()[:-1] + b'!')
                url = self.scratch_database()
                with self.assertRaisesRegex(BackupError, 'does not match its manifest'):
                    restore(copy, url, self.tmp / f'r-{part}')
                db = connect(url)
                self.assertEqual(db.execute("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'").fetchone()[0], 0)
                db.close()
                report = drill(copy, admin_url())
                self.assertEqual((report['result'], report['checks'][0]['check'], report['checks'][0]['ok']), ('fail', 'restore', False))
                shutil.rmtree(copy)

    def test_the_drill_fails_when_a_caller_would_see_something_else(self):
        copy = self.copy_of_backup()
        m = json.loads((copy / 'manifest.json').read_text(encoding='utf-8'))
        m['fingerprints']['views']['principal acme/andy'] = '0' * 64
        m['fingerprints']['questions']['q07'] = '0' * 64
        (copy / 'manifest.json').write_text(json.dumps(m), encoding='utf-8')
        report = drill(copy, admin_url())
        failed = {c['check']: c['detail'] for c in report['checks'] if not c['ok']}
        self.assertEqual(report['result'], 'fail')
        self.assertEqual(failed, {'view revisions': '1 differ: principal acme/andy', 'check questions': '1 differ: q07'})

    def test_a_missing_or_altered_original_fails_the_backup(self):
        for how in ('missing', 'altered'):
            with self.subTest(how=how):
                path = Path(self.kb.db.execute("SELECT v.original_path FROM versions v JOIN sources s ON s.id = v.source_id "
                                               "WHERE s.key = 'standards/logging.md'").fetchone()[0])
                self.kb.db.commit()
                kept = path.read_bytes()
                self.addCleanup(path.write_bytes, kept)
                if how == 'missing':
                    path.unlink()
                else:
                    path.write_bytes(kept + b'\nchanged on disk')
                out = self.tmp / how
                with self.assertRaisesRegex(BackupError, r'incomplete; 1 original\(s\)'):
                    backup(self.url, self.kb.originals, out)
                [left] = out.iterdir()
                self.assertTrue(left.name.endswith('.partial'), 'a failed backup never looks complete')
                path.write_bytes(kept)

    def test_a_backup_writes_nothing_and_keeps_the_password_off_the_command_line(self):
        audit = self.kb.db.execute('SELECT count(*) FROM audit').fetchone()[0]
        self.kb.db.commit()
        real, calls = kb_backup.subprocess.run, []

        def spy(args, **kw):
            calls.append((args, kw['env']))
            return real(args, **kw)
        with mock.patch.object(kb_backup.subprocess, 'run', side_effect=spy):
            backup(self.url, self.kb.originals, self.tmp / 'b', self.questions)
        self.assertEqual(self.kb.db.execute('SELECT count(*) FROM audit').fetchone()[0], audit, 'check questions are not audited reads')
        self.kb.db.commit()
        [(args, env)] = calls
        password = urlparse(self.url).password
        if password:
            self.assertFalse(any(password in a for a in args))
            self.assertEqual(env['PGPASSWORD'], password)

    def test_the_command_line_backs_up_and_drills(self):
        out = self.tmp / 'cli'
        env = {'KB_DATABASE_URL': self.url, 'KB_DRILL_DATABASE_URL': admin_url()}
        with mock.patch.dict(os.environ, env), redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(main(['backup', '--originals', str(self.kb.originals), '--out', str(out)]), 0)
        folder = Path(printed.getvalue().strip())
        self.assertEqual(folder.parent, out)
        with mock.patch.dict(os.environ, env), redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(main(['drill', str(folder)]), 0)
        self.assertEqual(json.loads(printed.getvalue())['result'], 'pass')
        with mock.patch.dict(os.environ, env), redirect_stderr(io.StringIO()) as said:
            self.assertEqual(main(['restore', str(folder), '--originals', str(self.tmp / 'x')]), 1, 'the live database is not empty')
        self.assertIn('not empty', said.getvalue())


if __name__ == '__main__':
    unittest.main()
