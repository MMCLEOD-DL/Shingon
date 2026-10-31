"""PostgreSQL access through pg8000 (BSD-3-Clause, pure Python): the repository's licence policy allows only
permissive licences, which rules out psycopg (LGPL-3.0).

`Db` is a thin wrapper: execute() returns a DB-API cursor, transaction() commits or rolls back. Parameters use
the pyformat style (%s and %(name)s). SQL text must not contain a literal percent sign: pg8000 does not unescape
%% in this mode. List and JSON parameters need explicit casts (::text[], ::bigint[], ::jsonb), so that an empty
list still has a type.

Migrations are plain SQL files applied once each, in order, one transaction per file, recorded in
schema_migrations.
"""
from __future__ import annotations

from contextlib import contextmanager
from importlib import resources
from urllib.parse import unquote, urlparse

import pg8000.dbapi

pg8000.dbapi.paramstyle = 'pyformat'
MIGRATIONS = 'shingon_knowledge.migrations'


class Db:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, sql: str, params=None):
        cur = self.conn.cursor()
        cur.execute(sql, params if params is not None else ())
        return cur

    def commit(self) -> None:
        self.conn.commit()

    def rollback(self) -> None:
        self.conn.rollback()

    @contextmanager
    def transaction(self):
        try:
            yield self
        except BaseException:
            self.conn.rollback()
            raise
        else:
            self.conn.commit()

    def close(self) -> None:
        self.conn.close()


def connect(url: str, *, timeout: float | None = None) -> Db:
    """Connects from a postgres:// URL (user, password, host, port, database). `timeout` bounds connecting and each
    later wait on the socket, in seconds."""
    u = urlparse(url)
    if u.scheme not in ('postgres', 'postgresql'):
        raise ValueError('Use a postgres:// URL.')
    conn = pg8000.dbapi.connect(user=unquote(u.username or ''), password=unquote(u.password) if u.password else None,
                                host=u.hostname or 'localhost', port=u.port or 5432, database=(u.path or '/postgres')[1:] or 'postgres',
                                timeout=timeout)
    return Db(conn)


def migrate(db: Db) -> list[str]:
    """Applies the migrations not yet recorded; returns their names."""
    with db.transaction():
        db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    done = {r[0] for r in db.execute('SELECT name FROM schema_migrations').fetchall()}
    db.commit()
    applied = []
    for item in sorted(resources.files(MIGRATIONS).iterdir(), key=lambda p: p.name):
        if not item.name.endswith('.sql') or item.name in done:
            continue
        with db.transaction():
            for statement in _statements(item.read_text(encoding='utf-8')):
                db.execute(statement)
            db.execute('INSERT INTO schema_migrations (name) VALUES (%s)', (item.name,))
        applied.append(item.name)
    return applied


def _statements(sql: str) -> list[str]:
    """Splits a migration on semicolons at line ends, ignoring comment lines (the migrations contain no
    function bodies or semicolons inside strings)."""
    lines = [l for l in sql.splitlines() if not l.lstrip().startswith('--')]
    return [s.strip() for s in '\n'.join(lines).split(';') if s.strip()]
