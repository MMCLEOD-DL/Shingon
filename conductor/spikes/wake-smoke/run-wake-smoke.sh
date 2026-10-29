#!/usr/bin/env bash
# Plan 4 smoke (operator-run via ! in a REAL terminal): the .109 desktop worker is OFF, CT110 LocalAI is up. Conductor must say so plainly and ASK before Claude/Codex do the local work.
# Key handling as in spikes/cli-smoke/run-cli-smoke.sh: the LocalAI key lives only in an env var
# for this process. It is never printed and never written to the temp config.
# Optional: WAKE_MAC=<mac> [WAKE_BROADCAST=192.168.1.255] to try Wake-on-LAN instead of warn-only.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)" || exit 2
LPORT=8091

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
  const [src, dst, url, mac, broadcast] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(src, "utf8"));
  for (const p of c.participants) if (p.adapter === "local-agent") p.baseUrl = url;
  if (mac) for (const p of c.participants) if (p.adapter === "local-agent") {
    p.wake = { method: "wol", mac, broadcast, hint: "Turn on the desktop PC and start its LocalAI worker." };
  }
  fs.writeFileSync(dst, JSON.stringify(c, null, 2));
' "$ROOT/config.example.json" "$CFG" "http://127.0.0.1:${LPORT}/v1" \
  "${WAKE_MAC:-}" "${WAKE_BROADCAST:-192.168.1.255}" || { echo "CONFIG BUILD FAILED"; exit 1; }

REPO="$(mktemp -d -t wake-smoke-repo-XXXXXX)" || exit 1
cd "$REPO" || exit 1
printf '{ "name": "smoke", "private": true, "type": "module" }\n' > package.json
printf 'export function add(a, b) { return a + b; }\n' > math.js
printf "import assert from 'node:assert/strict';\nimport { add } from './math.js';\nassert.equal(add(2, 3), 5);\nconsole.log('tests ok');\n" > test.js
git init -q -b main && git add -A && git -c user.name=smoke -c user.email=smoke@local commit -qm init

export CONDUCTOR_BASE_DIR="$HOME/.conductor/smoke-workspaces"
echo "== precondition: the .109 desktop LocalAI worker should be STOPPED now (CT110 stays up) =="
read -r -p "Press Enter when the worker is stopped (Ctrl-C to abort) " _
echo "== conductor doctor =="
node "$ROOT/bin/conductor.js" doctor --config "$CFG" || { echo "DOCTOR FAILED"; exit 1; }

echo "== conductor run: at the local-model question press w AFTER starting the worker (or f to let Claude do it); then v, a at the gate =="
node "$ROOT/bin/conductor.js" "Add a multiply(a, b) function to math.js and a test for it in test.js." \
  --config "$CFG" --test "node test.js"
rc=$?
echo "conductor exit: $rc"
echo "== remembered workers ==" && cat "$CONDUCTOR_BASE_DIR/.workers.json" 2>/dev/null || echo "(nothing remembered yet)"
[ $rc -eq 0 ] && git --no-pager log --oneline --all
exit $rc
