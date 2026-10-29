#!/usr/bin/env bash
# Plan 5 smoke (operator-run via `!`): the real `conductor --council`, real CLIs, real local model,
# real council tools, and YOU at the final gate. Key handling as in spikes/cli-smoke/run-cli-smoke.sh.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)" || exit 2
LPORT=8092

CFG=""
REPO=""
cleanup() { pkill -f "${LPORT}:127.0.0.1:8081" 2>/dev/null; }
cleanup_all() {
  [ -n "$CFG" ] && rm -f "$CFG"
  cleanup && echo "tunnel closed"
  [ -n "$REPO" ] && echo "throwaway repo kept for inspection: $REPO"
}
trap cleanup_all EXIT
trap 'exit 130' INT TERM
cleanup; sleep 1

echo "== tunnel =="
ssh -f -N -o ExitOnForwardFailure=yes -o ConnectTimeout=6 \
    -L 127.0.0.1:${LPORT}:127.0.0.1:8081 root@192.168.1.110 \
    && echo "tunnel up (127.0.0.1:${LPORT} -> CT110:8081)" || { echo "TUNNEL FAILED"; exit 1; }

export LOCALAI_API_KEY="$(ssh -o ConnectTimeout=6 root@192.168.1.110 \
    'grep -E "^LOCALAI_API_KEY=" /opt/shingon-localai/.env | cut -d= -f2-')"
[ -n "${LOCALAI_API_KEY:-}" ] && echo "key loaded" || { echo "NO KEY"; exit 1; }

CFG="$(mktemp --suffix=.json)" || { echo "CONFIG BUILD FAILED"; exit 1; }
node -e '
  const fs = require("fs");
  const [src, dst, url] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(src, "utf8"));
  for (const p of c.participants) if (p.adapter === "local-agent") p.baseUrl = url;
  c.options = { ...(c.options || {}), council: true };
  fs.writeFileSync(dst, JSON.stringify(c, null, 2));
' "$ROOT/config.example.json" "$CFG" "http://127.0.0.1:${LPORT}/v1" || { echo "CONFIG BUILD FAILED"; exit 1; }

# Seeded with problems that were ALREADY there: an old eval() and an old GPL dependency.
# Both must show as warnings ("already there before this change") and must not bounce.
REPO="$(mktemp -d -t council-smoke-repo-XXXXXX)" || exit 1
cd "$REPO" || exit 1
printf '{ "name": "smoke", "version": "1.0.0", "private": true, "type": "module", "license": "MIT" }\n' > package.json
printf '%s\n' '{ "name": "smoke", "version": "1.0.0", "lockfileVersion": 3, "requires": true, "packages": {' \
  '  "": { "name": "smoke", "version": "1.0.0", "license": "MIT" },' \
  '  "node_modules/old-gpl-lib": { "version": "1.0.0", "license": "GPL-3.0-only" } } }' > package-lock.json
printf 'export function legacy(s) { return eval(s); }\n' > old.js
printf "import assert from 'node:assert/strict';\nassert.ok(true);\nconsole.log('tests ok');\n" > test.js
git init -q -b main && git add -A && git -c user.name=smoke -c user.email=smoke@local commit -qm init

export CONDUCTOR_BASE_DIR="$HOME/.conductor/smoke-workspaces"
echo "== conductor doctor (look at the council checks section) =="
node "$ROOT/bin/conductor.js" doctor --config "$CFG" || { echo "DOCTOR FAILED"; exit 1; }

echo "== conductor --council (expect: Security blocks the eval, a 'Council fixes, round 1' step, then approval) =="
node "$ROOT/bin/conductor.js" \
  "Add calc.js exporting calculate(expr), which evaluates an arithmetic expression string such as '2+3*4' (the simplest way, with eval, is acceptable), and add tests for it in test.js." \
  --config "$CFG" --test "node test.js" --council
rc=$?
echo "conductor exit: $rc"
[ $rc -eq 0 ] && git --no-pager log --oneline --all
exit $rc
