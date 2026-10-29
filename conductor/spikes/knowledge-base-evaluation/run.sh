#!/usr/bin/env bash
# Runs the P06 evaluation against a throwaway PostgreSQL cluster in a temporary directory (Unix socket only, no TCP).
# Needs: PostgreSQL 16 server binaries, LibreOffice (soffice) for the PDF fixtures, and `pip install -r requirements.txt`.
# Writes results/results.json; removes the cluster and the generated corpus afterwards.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pgbin="${PG_BIN:-/usr/lib/postgresql/16/bin}"
work="$(mktemp -d)"
# PostgreSQL refuses to run as root: in a root shell (a cloud container) the cluster runs as the postgres user.
as_pg=()
if [ "$(id -u)" = 0 ]; then chown postgres "$work"; as_pg=(runuser -u postgres --); fi
cleanup() { "${as_pg[@]}" "$pgbin/pg_ctl" -D "$work/pg" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
"${as_pg[@]}" "$pgbin/initdb" -D "$work/pg" -U kb --auth=trust -E UTF8 --no-locale >/dev/null
"${as_pg[@]}" "$pgbin/pg_ctl" -D "$work/pg" -o "-c listen_addresses='' -c unix_socket_directories='$work'" -l "$work/pg.log" -w start >/dev/null
"${as_pg[@]}" "$pgbin/createdb" -h "$work" -U kb kbeval
python3 "$here/evaluate.py" "host=$work user=kb dbname=kbeval" "$work/data"
