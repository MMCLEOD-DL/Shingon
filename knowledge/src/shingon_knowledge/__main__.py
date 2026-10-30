"""Command line for the knowledge service (K6, K9). The database URL is read from KB_DATABASE_URL, never from the command
line, so it does not show in process listings or shell history.

  python -m shingon_knowledge serve --originals DIR [--host 127.0.0.1] [--port 8765]
  python -m shingon_knowledge credentials issue-project NAME COLLECTION [COLLECTION ...]
  python -m shingon_knowledge credentials issue-app NAME TENANT
  python -m shingon_knowledge credentials revoke NAME
  python -m shingon_knowledge mcp      (STDIO MCP adapter; KB_API_URL and KB_TOKEN from the environment)
  python -m shingon_knowledge backup --originals DIR --out DIR [--questions FILE]
  python -m shingon_knowledge restore BACKUP --originals NEWDIR   (into the empty database at KB_DATABASE_URL)
  python -m shingon_knowledge drill BACKUP   (scratch restore and check; KB_DRILL_DATABASE_URL may CREATE DATABASE)

Issued tokens and assertion keys are printed once, to standard output only. Store them with the caller's secrets.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from . import auth
from .db import connect, migrate
from .http import Api, make_server


def _db(timeout: float | None = None):
    url = os.environ.get('KB_DATABASE_URL')
    if not url:
        sys.exit('Set KB_DATABASE_URL to the knowledge database (postgres://...).')
    return connect(url, timeout=timeout)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python -m shingon_knowledge')
    sub = p.add_subparsers(dest='command', required=True)
    s = sub.add_parser('serve', help='run the HTTP API on a loopback or private address')
    s.add_argument('--originals', required=True, type=Path, help='the stored originals folder')
    s.add_argument('--host', default='127.0.0.1')
    s.add_argument('--port', type=int, default=8765)
    c = sub.add_parser('credentials').add_subparsers(dest='action', required=True)
    ip = c.add_parser('issue-project', help='a Conductor project token over reference collections')
    ip.add_argument('name')
    ip.add_argument('collections', nargs='+')
    ia = c.add_parser('issue-app', help="a Foundation app server's credential and assertion key")
    ia.add_argument('name')
    ia.add_argument('tenant')
    c.add_parser('revoke').add_argument('name')
    sub.add_parser('mcp', help='the STDIO MCP adapter over the HTTP API (KB_API_URL, KB_TOKEN)')
    b = sub.add_parser('backup', help='dump the database and copy the originals into a new backup folder')
    b.add_argument('--originals', required=True, type=Path, help='the stored originals folder the service uses')
    b.add_argument('--out', required=True, type=Path, help='the folder that receives kb-<time>/')
    b.add_argument('--questions', type=Path, help='check questions whose results a restore must reproduce')
    r = sub.add_parser('restore', help='restore a backup into the empty database at KB_DATABASE_URL')
    r.add_argument('backup', type=Path)
    r.add_argument('--originals', required=True, type=Path, help='a new, empty folder for the restored originals')
    d = sub.add_parser('drill', help='restore into a scratch database, check it reproduces the backup, then drop it')
    d.add_argument('backup', type=Path)
    a = p.parse_args(argv)

    if a.command == 'mcp':
        from .mcp import main as mcp_main
        return mcp_main()

    if a.command in ('backup', 'restore', 'drill'):
        return _backup_command(a)

    if a.command == 'serve':
        logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
        db = _db()
        migrate(db)
        db.close()
        server = make_server(Api(_db, a.originals), a.host, a.port)
        print(f'Knowledge API on http://{a.host}:{server.server_address[1]}/kb/v1', file=sys.stderr)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
        return 0
    db = _db()
    try:
        migrate(db)
        if a.action == 'issue-project':
            print(auth.issue_project_credential(db, a.name, a.collections))
        elif a.action == 'issue-app':
            token, key = auth.issue_app_credential(db, a.name, a.tenant)
            print(f'token: {token}\nassertion key: {key}')
        elif not auth.revoke(db, a.name):
            print(f'No active credential named {a.name}.', file=sys.stderr)
            return 1
    finally:
        db.close()
    return 0


def _backup_command(a) -> int:
    from .backup import BackupError, backup, drill, restore
    var = 'KB_DRILL_DATABASE_URL' if a.command == 'drill' else 'KB_DATABASE_URL'
    url = os.environ.get(var)
    if not url:
        sys.exit(f'Set {var} (postgres://...).')
    try:
        if a.command == 'backup':
            print(backup(url, a.originals, a.out, a.questions))
        elif a.command == 'restore':
            m = restore(a.backup, url, a.originals)
            print(f"Restored {a.backup} ({m['createdAt']}): {len(m['originals'])} originals.")
        else:
            report = drill(a.backup, url)
            print(json.dumps(report, indent=1))
            return 0 if report['result'] == 'pass' else 1
    except BackupError as e:
        print(e, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
