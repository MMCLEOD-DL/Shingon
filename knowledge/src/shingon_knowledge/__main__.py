"""Command line for the knowledge service (K6). The database URL is read from KB_DATABASE_URL, never from the command
line, so it does not show in process listings or shell history.

  python -m shingon_knowledge serve --originals DIR [--host 127.0.0.1] [--port 8765]
  python -m shingon_knowledge credentials issue-project NAME COLLECTION [COLLECTION ...]
  python -m shingon_knowledge credentials issue-app NAME TENANT
  python -m shingon_knowledge credentials revoke NAME

Issued tokens and assertion keys are printed once, to standard output only. Store them with the caller's secrets.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from . import auth
from .db import connect, migrate
from .http import Api, make_server


def _db():
    url = os.environ.get('KB_DATABASE_URL')
    if not url:
        sys.exit('Set KB_DATABASE_URL to the knowledge database (postgres://...).')
    return connect(url)


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
    a = p.parse_args(argv)

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


if __name__ == '__main__':
    sys.exit(main())
