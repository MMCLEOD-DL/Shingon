#!/usr/bin/env bash
# Plan 9 smoke, end to end (operator-run in a real terminal): conductor build on a small approved brief with the
# full council, real models, real CT 111, a local PostgreSQL role, and YOU at the gate. Never run by the test suite.
# Uses a throwaway projects folder (CONDUCTOR_PROJECTS_ROOT, under /var/tmp) that is KEPT afterwards as evidence;
# it never touches the real ~/highland-projects, and it deletes nothing outside its own temp config file.
# Key and tunnel handling as in spikes/council-smoke/run-council-smoke.sh.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)" || exit 2
HERE="$ROOT/spikes/council-full-smoke"
LPORT=8092
CT=192.168.1.111
[ -t 0 ] && [ -t 1 ] || { echo "Run this in a real terminal (it asks you questions)."; exit 2; }

CFG=""
cleanup() { pkill -f "${LPORT}:127.0.0.1:8081" 2>/dev/null; }
cleanup_all() {
  [ -n "$CFG" ] && rm -f "$CFG"
  cleanup && echo "tunnel closed"
  [ -n "${CONDUCTOR_PROJECTS_ROOT:-}" ] && echo "projects folder kept for evidence: $CONDUCTOR_PROJECTS_ROOT"
}
trap cleanup_all EXIT
trap 'exit 130' INT TERM

N=0
step() { N=$((N + 1)); echo; echo "== Step $N: $1 =="; }
ok() { local a; read -r -p "$1 OK? [y/N] " a; [ "$a" = y ] || { echo "SMOKE STOPPED at step $N"; exit 1; }; }

step "0. pre-flight"
[ -n "${TEST_DATABASE_URL:-}" ] || { echo "TEST_DATABASE_URL is not set"; exit 2; }
psql "$TEST_DATABASE_URL" -c 'select 1' >/dev/null || { echo "cannot reach the test database"; exit 2; }
ssh -o BatchMode=yes "root@$CT" 'docker compose version && node --version && mkdir -p /srv/hf-factory && test -w /srv/hf-factory' \
  || { echo "CT 111 is not ready (SSH key, Docker, Node 22, /srv/hf-factory)"; exit 2; }
echo "Images on CT 111 that would make the v0.1.0 smoke refuse (expect none):"
ssh -o BatchMode=yes "root@$CT" 'docker images "highland/*" -q | wc -l'

SRC=""
for f in ./conductor.json "${XDG_CONFIG_HOME:-/nonexistent}/conductor/config.json" "$HOME/.config/conductor/config.json"; do [ -f "$f" ] && { SRC="$f"; break; }; done
[ -n "$SRC" ] && node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.exit(c.factory&&c.factory.machines?0:1)" "$SRC" \
  || { echo "no config with a factory.machines block was found (see config.example.json)"; exit 2; }
AXE="$HOME/.local/share/conductor/axe-core/axe.min.js"
if [ -f "$AXE" ]; then echo "axe-core found: $AXE"; else echo "NOTE: axe-core is not installed ($AXE); accessibility will be reported as not proven. See the README."; fi

echo "== tunnel =="
cleanup; sleep 1
ssh -f -N -o ExitOnForwardFailure=yes -o ConnectTimeout=6 \
    -L 127.0.0.1:${LPORT}:127.0.0.1:8081 root@192.168.1.110 \
    && echo "tunnel up (127.0.0.1:${LPORT} -> CT110:8081)" || { echo "TUNNEL FAILED"; exit 1; }
LOCALAI_API_KEY="$(ssh -o ConnectTimeout=6 root@192.168.1.110 \
    'grep -E "^LOCALAI_API_KEY=" /opt/shingon-localai/.env | cut -d= -f2-')"
export LOCALAI_API_KEY
[ -n "${LOCALAI_API_KEY:-}" ] && echo "key loaded" || { echo "NO KEY"; exit 1; }

CFG="$(mktemp --suffix=.json)" || { echo "CONFIG BUILD FAILED"; exit 1; }
node -e '
  const fs = require("fs");
  const [src, dst, url] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(src, "utf8"));
  for (const p of c.participants) if (p.adapter === "local-agent") p.baseUrl = url;
  fs.writeFileSync(dst, JSON.stringify(c, null, 2));
' "$SRC" "$CFG" "http://127.0.0.1:${LPORT}/v1" || { echo "CONFIG BUILD FAILED"; exit 1; }

C="node $ROOT/bin/conductor.js --config $CFG"
export CONDUCTOR_PROJECTS_ROOT="$(mktemp -d /var/tmp/hf-council-full-smoke.XXXXXX)"
PROJ="$CONDUCTOR_PROJECTS_ROOT/council-smoke-ltd"
echo "projects folder (kept for evidence): $CONDUCTOR_PROJECTS_ROOT"
$C doctor || { echo "conductor doctor failed"; exit 2; }
ok "Pre-flight passed (the doctor lists axe-core and the test machine)."

step "1. conductor project new \"Council Smoke Ltd\" (slug council-smoke-ltd)"
$C project new "Council Smoke Ltd" || exit 1
ok "The slug is council-smoke-ltd."

step "2. import the approved brief fixture (Plan 7's saveApprovedBrief; no model, no questions)"
node --input-type=module -e '
  const [root, proj, file] = process.argv.slice(1);
  const { readFileSync } = await import("node:fs");
  const { saveApprovedBrief } = await import(`${root}/src/factory/brief.js`);
  const r = saveApprovedBrief(proj, JSON.parse(readFileSync(file, "utf8")));
  console.log(`Saved approved brief v${r.version}: ${r.jsonPath}`);
' "$ROOT" "$PROJ" "$HERE/brief-fixture.json" || { echo "could not import the brief"; exit 1; }
ls "$PROJ/brief"
ok "brief-v1.json, brief-v1.md and current.json exist."

step "3. conductor build; watch the progress lines, then answer the questions"
echo "Expect, in order, among the build's own lines:"
echo "  Council round 1: Security, Legal and data, Correctness, Design, Reliability"
echo "  Council: using the build's own checks for this version."
echo "  Council: running the checks the build did not cover (axe, or missing reports)…    (when axe is installed)"
echo "  Council: starting a test machine…  then  Council: deploying on test machine ct111: backup, restore, alerts and updates (10–20 minutes)…"
echo "  Council round 1: approved… or: N problem(s) to fix, then a council fix feature and round 2 (at most 3 rounds)."
echo "  Council report saved: .../builds/<run>/council-report.md"
echo "At the approval question, read the council report in the summary, then approve (or give feedback once)."
$C build council-smoke-ltd || echo "(exit $?)"
ok "The build reached the gate with a council report, and you approved."

step "4. the council's files"
BUILD_DIR="$(ls -dt "$PROJ"/builds/*/ | head -1)"
echo "Build folder: $BUILD_DIR"
for f in council-report.md council-report.json; do
  if [ -s "${BUILD_DIR}$f" ]; then echo "present: $f"; else echo "MISSING: $f  <- the hook did not write it; note it in RESULT.md"; fi
done
echo "Council events (reuse of the build's checks; the evidence stages):"
grep -h '"type":"council-evidence"' "${BUILD_DIR}council/transcript.jsonl" 2>/dev/null | sed 's/^/  /' || true
if grep -q '"stage":"reuse","status":"ok"' "${BUILD_DIR}council/transcript.jsonl" 2>/dev/null; then
  echo "OK: the build's own checks were reused (Council: using the build's own checks for this version.)"
else
  echo "NOT SEEN: no reuse event; Plan 8's checks did not reach the council. Note it in RESULT.md."
fi
echo "Screenshots:"; ls "${BUILD_DIR}council/"round-*/screenshots 2>/dev/null | head -20 || true
echo; echo "--- council-report.md ---"; cat "${BUILD_DIR}council-report.md" 2>/dev/null || true
ok "Both report files exist; the report reads clearly; the examples mileage-claims#1 and #2 are listed as proven or missing."

step "5. nothing may be left on CT 111, and the machine must be free"
$C machines
ssh -o BatchMode=yes "root@$CT" 'docker ps -a --format "{{.Names}}" | grep -E "hfsmoke|hf-smoke-rest" | wc -l; ls /srv/hf-factory/runs 2>/dev/null | wc -l; ls /tmp/hf-smoke /tmp/hf-smoke-cookies 2>&1 | head -2'
ok "No machines in use; 0 containers named hfsmoke or hf-smoke-rest; the runs folder is empty; /tmp/hf-smoke is gone."

step "6. sweep"
$C machines sweep
ok "It said: Nothing was left over."

echo
echo "Now fill in $HERE/RESULT.md. Evidence: $PROJ"
