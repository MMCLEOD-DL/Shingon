"""Backups and the restore drill (K9). Host-agnostic: PostgreSQL's own pg_dump and pg_restore, and plain file copies.

A backup is one folder, kb-<UTC time>/, holding:
  - database.dump: pg_dump's custom format, taken from one exported snapshot;
  - originals/: the stored originals of current and past versions, at their paths under the originals folder;
  - manifest.json: hashes of both, the migrations, row counts and the fingerprints a restore must reproduce.

Everything in the manifest is read in the snapshot the dump was taken from, so it describes exactly what was dumped.
Each copied original must match the sha256 the database recorded when it was imported, so a file changed or lost on
disk makes the backup fail instead of saving a wrong copy. Originals of deleted sources awaiting removal are not
copied: a restore leaves them pending and the next sync records them removed. The folder is written as
kb-<time>.partial and renamed only once complete, so a failed backup never looks like a good one.

The fingerprints are each tenant principal's and each active project credential's viewRevision, and the results of
any check questions given with --questions (view revision, evidence and every result field except timing), stored as
hashes. A restore drill restores into a scratch database and must reproduce all of them, so "it restored" means
"every caller sees exactly what they saw", not only "pg_restore exited 0".

A backup holds the documents, the token hashes and the app credentials' assertion keys: protect it like the database
(README "Backups (K9)"). Credentials and addresses reach pg_dump and pg_restore through the environment, never argv.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlparse, urlunparse

from .db import Db, connect
from .service import SUPERSEDED_WEIGHT, Credential, KnowledgeService

FORMAT = 'shingon-kb-backup/1'
DUMP = 'database.dump'
CHUNK = 1 << 20


class BackupError(RuntimeError):
    """The backup, restore or drill cannot be completed. The message says what to fix."""


# ---------- PostgreSQL tools ----------

def _tool(name: str) -> str:
    """pg_dump or pg_restore, from KB_PG_BIN when set (Windows installs rarely put them on PATH), else PATH."""
    found = shutil.which(name, path=os.environ.get('KB_PG_BIN') or None)
    if not found:
        raise BackupError(f'{name} was not found. Install the PostgreSQL client tools, or set KB_PG_BIN to their folder.')
    return found


def _pg_env(url: str) -> dict:
    """The connection for pg_dump and pg_restore as libpq variables, so no password is ever on a command line."""
    u = urlparse(url)
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    env.update(PGHOST=u.hostname or 'localhost', PGPORT=str(u.port or 5432), PGUSER=unquote(u.username or ''),
               PGDATABASE=(u.path or '/postgres')[1:] or 'postgres')
    if u.password:
        env['PGPASSWORD'] = unquote(u.password)
    return env


def _run(args: list[str], env: dict) -> None:
    done = subprocess.run(args, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if done.returncode:
        raise BackupError(f'{Path(args[0]).name} failed (exit {done.returncode}): {done.stderr.strip()[-2000:]}')


def _sha256(path: Path) -> tuple[str, int]:
    h, size = hashlib.sha256(), 0
    with open(path, 'rb') as f:
        while block := f.read(CHUNK):
            h.update(block)
            size += len(block)
    return h.hexdigest(), size


def _copy(src: Path, dst: Path) -> tuple[str, int]:
    """Copies src to dst and returns the hash of the bytes written, read once."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    h, size = hashlib.sha256(), 0
    with open(src, 'rb') as f, open(dst, 'xb') as out:
        while block := f.read(CHUNK):
            h.update(block)
            out.write(block)
            size += len(block)
    return h.hexdigest(), size


# ---------- what a restore must reproduce ----------

def _counts(db: Db) -> dict:
    tables = [r[0] for r in db.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' "
                                       "AND table_type = 'BASE TABLE' ORDER BY table_name").fetchall()]
    return {t: db.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0] for t in tables}


def _callers(db: Db) -> dict[str, Credential]:
    """Every principal of every tenant (as an app credential's user sees the tenant) and every active project token."""
    callers = {f'principal {t}/{p}': Credential('backup-check', t, p)
               for t, p in db.execute('SELECT tenant_id, id FROM principals ORDER BY tenant_id, id').fetchall()}
    for name, tenant, colls in db.execute("SELECT name, tenant_id, collections FROM credentials WHERE kind = 'project' "
                                          'AND revoked_at IS NULL ORDER BY name').fetchall():
        callers[f'credential {name}'] = Credential(name, tenant, None, tuple(colls))
    return callers


def _caller(callers: dict[str, Credential], who: dict) -> Credential:
    key = f"credential {who['credential']}" if 'credential' in who else f"principal {who.get('tenant')}/{who.get('principal')}"
    if key not in callers:
        raise BackupError(f'Check question caller {key} does not exist (or is revoked) in the database.')
    return callers[key]


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def fingerprints(db: Db, questions: list[dict]) -> dict:
    """Read inside the caller's transaction (the backup's snapshot, or the restored database). Never writes."""
    kb = KnowledgeService(db, Path('.'))  # reads only: no original is opened
    callers = _callers(db)
    views = {key: kb._revision(*kb._scope(cred), cred) for key, cred in callers.items()}
    answers = {}
    for q in questions:
        res = kb._search(_caller(callers, q['as']), q['query'], q.get('limit', 8), None, SUPERSEDED_WEIGHT, audit=False)
        res.pop('ms')
        answers[q['id']] = _digest(res)
    return {'views': views, 'questions': answers}


def _load_questions(path: Path | None) -> list[dict]:
    if path is None:
        return []
    qs = json.loads(path.read_text(encoding='utf-8'))['questions']
    ids = [q.get('id') for q in qs]
    if len(set(ids)) != len(ids) or not all(isinstance(q.get('query'), str) and isinstance(q.get('as'), dict) for q in qs):
        raise BackupError('Each check question needs a unique id, a query and an "as" ({"tenant", "principal"} or {"credential"}).')
    if not all(1 <= len(q['query']) <= 1000 and q.get('limit', 8) in range(1, 21) for q in qs):
        raise BackupError('A check question is outside the search limits (query 1 to 1000 characters, limit 1 to 20).')
    return [{'id': q['id'], 'as': q['as'], 'query': q['query'], **({'limit': q['limit']} if 'limit' in q else {})} for q in qs]


# ---------- backup ----------

def backup(url: str, originals: Path, out: Path, questions: Path | None = None) -> Path:
    """Takes one backup into a new folder under `out` and returns it. Raises BackupError, leaving only a .partial
    folder, if the dump fails or any original is missing or differs from the hash recorded at import."""
    qs = _load_questions(questions)
    root = Path(os.path.abspath(originals))
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    final = out / f'kb-{stamp}'
    work = out / f'kb-{stamp}.partial'
    if final.exists() or work.exists():
        raise BackupError(f'{final} already exists. Wait a second and run the backup again.')
    out.mkdir(parents=True, exist_ok=True)
    work.mkdir(mode=0o700)  # it holds documents and credential material: owner only (POSIX)
    db = connect(url)
    try:
        db.commit()
        db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        snapshot = db.execute('SELECT pg_export_snapshot()').fetchone()[0]
        # pg_dump reads the same snapshot while this transaction holds it open.
        _run([_tool('pg_dump'), '--format=custom', f'--snapshot={snapshot}', f'--file={work / DUMP}'], _pg_env(url))
        migrations = [r[0] for r in db.execute('SELECT name FROM schema_migrations ORDER BY name').fetchall()]
        counts = _counts(db)
        rows = db.execute('SELECT v.source_id, v.n, v.sha256, v.original_path, v.purge_pending FROM versions v '
                          'WHERE v.original_path IS NOT NULL ORDER BY v.source_id, v.n').fetchall()
        prints = fingerprints(db, qs)
    finally:
        db.rollback()
        db.close()
    files, problems = [], []
    for sid, n, sha, stored, pending in rows:
        try:
            rel = os.path.relpath(os.path.abspath(stored), root)
        except ValueError:  # another drive, on Windows
            rel = '..'
        if os.path.isabs(rel) or rel == '..' or rel.startswith('..' + os.sep):
            raise BackupError(f'Version {n} of source {sid} is stored outside {root}: pass the folder the service uses.')
        entry = {'source': sid, 'version': n, 'path': PurePosixPath(*Path(rel).parts).as_posix(), 'pending': pending}
        if not pending:
            try:
                got, size = _copy(Path(stored), work / 'originals' / rel)
            except OSError as e:
                problems.append(f"{entry['path']}: {type(e).__name__}: {e.strerror or e}")
                continue
            if got != sha:
                problems.append(f"{entry['path']}: differs from the sha256 recorded when it was imported")
            entry.update(sha256=got, size=size)
        files.append(entry)
    if problems:
        raise BackupError(f'The backup in {work} is incomplete; {len(problems)} original(s) could not be copied as '
                          'imported:\n  ' + '\n  '.join(problems))
    dump_sha, dump_size = _sha256(work / DUMP)
    manifest = {'format': FORMAT, 'createdAt': stamp, 'database': {'file': DUMP, 'sha256': dump_sha, 'size': dump_size},
                'migrations': migrations, 'rowCounts': counts, 'originalsRoot': str(root), 'originals': files,
                'questions': qs, 'fingerprints': prints}
    (work / 'manifest.json').write_text(json.dumps(manifest, indent=1, sort_keys=True) + '\n', encoding='utf-8')
    work.rename(final)
    return final


# ---------- restore ----------

def _manifest(folder: Path) -> dict:
    try:
        m = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        raise BackupError(f'{folder} is not a complete backup (manifest.json unreadable: {e}).')
    if m.get('format') != FORMAT:
        raise BackupError(f'{folder} is not a {FORMAT} backup.')
    return m


def verify(folder: Path) -> dict:
    """Checks the dump and every copied original against the manifest. Returns the manifest; raises on any difference."""
    m = _manifest(folder)
    bad = []
    if _sha256(folder / DUMP) != (m['database']['sha256'], m['database']['size']):
        bad.append(DUMP)
    for f in m['originals']:
        if f['pending']:
            continue
        path = folder / 'originals' / Path(*PurePosixPath(f['path']).parts)
        try:
            if _sha256(path) != (f['sha256'], f['size']):
                bad.append(f['path'])
        except OSError:
            bad.append(f['path'] + ' (missing)')
    if bad:
        raise BackupError(f'{folder} does not match its manifest; nothing was restored. Differs: ' + ', '.join(bad))
    return m


def restore(folder: Path, url: str, originals: Path) -> dict:
    """Restores a verified backup into the empty database at `url`, with its originals in the new, empty folder
    `originals`. The stored paths are rewritten to that folder. Refuses a database or folder that is not empty."""
    m = verify(folder)
    root = Path(os.path.abspath(originals))
    if root.exists() and any(root.iterdir()):
        raise BackupError(f'{root} is not empty. Restore into a new folder.')
    db = connect(url)
    restored = False
    try:
        used = db.execute("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                          "WHERE n.nspname = 'public'").fetchone()[0]
        db.commit()
        if used:
            raise BackupError('The target database is not empty. Restore into a new, empty database.')
        root.mkdir(parents=True, exist_ok=True)
        for f in m['originals']:
            if not f['pending']:
                rel = Path(*PurePosixPath(f['path']).parts)
                if _copy(folder / 'originals' / rel, root / rel) != (f['sha256'], f['size']):
                    raise BackupError(f"{f['path']} changed while it was being restored.")
        env = _pg_env(url)
        # One transaction: a failed restore leaves the database empty.
        _run([_tool('pg_restore'), '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction',
              f"--dbname={env['PGDATABASE']}", str(folder / DUMP)], env)
        restored = True
        with db.transaction():  # every stored path, pending ones too, now points into the new folder only
            for f in m['originals']:
                db.execute('UPDATE versions SET original_path = %s WHERE source_id = %s AND n = %s',
                           (str(root / Path(*PurePosixPath(f['path']).parts)), f['source'], f['version']))
            left = db.execute('SELECT count(*) FROM versions WHERE original_path IS NOT NULL').fetchone()[0]
            if left != len(m['originals']):
                raise BackupError('The restored database does not list the originals the manifest does.')
    except BaseException as e:
        for child in root.iterdir() if root.exists() else ():  # the folder was empty: remove only what this restore copied
            shutil.rmtree(child) if child.is_dir() else child.unlink()
        if restored:  # its paths still name the old folder, so it must never be served
            raise BackupError(f'The database was restored but not finished ({e}). Drop it, then restore again.') from e
        raise
    finally:
        db.close()
    return m


# ---------- drill ----------

def drill(folder: Path, admin_url: str) -> dict:
    """Restores the backup into a scratch database on the server at `admin_url` (a role that may CREATE DATABASE)
    and a scratch folder, checks that it reproduces the manifest, then drops both. Returns the report."""
    started = time.monotonic()
    checks: list[dict] = []

    def check(name, expected, actual):
        checks.append({'check': name, 'ok': expected == actual,
                       **({} if expected == actual else {'detail': _difference(expected, actual)})})

    name = f'kb_drill_{uuid.uuid4().hex[:12]}'
    admin = connect(admin_url)
    admin.conn.autocommit = True
    work = Path(tempfile.mkdtemp(prefix='kb-drill-'))
    try:
        admin.execute(f'CREATE DATABASE {name}')
        target = urlunparse(urlparse(admin_url)._replace(path='/' + name))
        try:
            m = restore(folder, target, work / 'originals')
        except BackupError as e:
            checks.append({'check': 'restore', 'ok': False, 'detail': str(e)})
            m = None
        if m is not None:
            checks.append({'check': 'restore', 'ok': True})
            db = connect(target)
            try:
                db.commit()
                db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
                check('migrations', m['migrations'], [r[0] for r in db.execute('SELECT name FROM schema_migrations ORDER BY name').fetchall()])
                check('row counts', m['rowCounts'], _counts(db))
                stored = db.execute('SELECT original_path, sha256 FROM versions WHERE original_path IS NOT NULL '
                                    'AND NOT purge_pending ORDER BY source_id, n').fetchall()
                check('originals match their import hashes', [], [p for p, sha in stored if not _matches(Path(p), sha)])
                got = fingerprints(db, m['questions'])
                check('view revisions', m['fingerprints']['views'], got['views'])
                check('check questions', m['fingerprints']['questions'], got['questions'])
            finally:
                db.rollback()
                db.close()
    finally:
        admin.execute(f'DROP DATABASE IF EXISTS {name} WITH (FORCE)')
        admin.close()
        shutil.rmtree(work, ignore_errors=True)
    ok = all(c['ok'] for c in checks)
    return {'result': 'pass' if ok else 'fail', 'backup': str(folder), 'seconds': round(time.monotonic() - started, 1),
            'callers': len(m['fingerprints']['views']) if m else None, 'questions': len(m['questions']) if m else None,
            'checks': checks}


def _matches(path: Path, sha: str) -> bool:
    try:
        return _sha256(path)[0] == sha
    except OSError:
        return False


def _difference(expected, actual) -> str:
    """Names what differs, never the values themselves (a fingerprint is harmless, a file path may not be)."""
    if isinstance(expected, dict) and isinstance(actual, dict):
        keys = sorted(k for k in expected.keys() | actual.keys() if expected.get(k) != actual.get(k))
        return f'{len(keys)} differ: ' + ', '.join(map(str, keys[:20]))
    if isinstance(actual, list) and expected == []:
        return f'{len(actual)} stored original(s) missing or changed'
    return 'differs'
