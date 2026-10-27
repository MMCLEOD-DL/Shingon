#!/usr/bin/env bash
# Plan 8 smoke (operator-run in a real terminal): real models, real CT 111, a local PostgreSQL role, YOU at the gate.
# Never run by the test suite. Uses the real ~/highland-projects, so it refuses if harbour-cafe already exists.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/spikes/factory-build-smoke"
C="node $ROOT/bin/conductor.js"
PROJ="$HOME/highland-projects/harbour-cafe"
CT=192.168.1.111
[ -t 0 ] && [ -t 1 ] || { echo "Run this in a real terminal (it asks you questions)."; exit 2; }

N=0
step() { N=$((N + 1)); echo; echo "== Step $N: $1 =="; }
ok() { local a; read -r -p "$1 OK? [y/N] " a; [ "$a" = y ] || { echo "SMOKE STOPPED at step $N"; exit 1; }; }

step "0. pre-flight"
[ -n "${TEST_DATABASE_URL:-}" ] || { echo "TEST_DATABASE_URL is not set"; exit 2; }
psql "$TEST_DATABASE_URL" -c 'select 1' >/dev/null || { echo "cannot reach the test database"; exit 2; }
ssh -o BatchMode=yes "root@$CT" 'docker compose version && mkdir -p /srv/hf-factory && test -w /srv/hf-factory' || { echo "CT 111 is not ready"; exit 2; }
$C doctor || { echo "conductor doctor failed"; exit 2; }
CFG=""
for f in ./conductor.json "${XDG_CONFIG_HOME:-/nonexistent}/conductor/config.json" "$HOME/.config/conductor/config.json"; do [ -f "$f" ] && { CFG="$f"; break; }; done
[ -n "$CFG" ] && node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.exit(c.factory&&c.factory.machines?0:1)" "$CFG" \
  || { echo "no config with a factory.machines block was found (see config.example.json)"; exit 2; }
[ ! -e "$PROJ" ] || { echo "$PROJ already exists; move it away first"; exit 2; }
ok "Pre-flight passed."

step "1. conductor project new \"Harbour Café\" (slug harbour-cafe)"
$C project new "Harbour Café"
ok "The slug is harbour-cafe."

step "2. the brief: answer the questions and approve"
$C brief harbour-cafe --notes "$HERE/notes.md"
ok "The brief is approved."

step "3. conductor build; press Ctrl-C ONCE while the first feature's second step is running"
$C build harbour-cafe || echo "(exit $?)"
ok "The message said the build is kept."

step "4. build again; at the approval question, STOP and do step 5 in a second terminal BEFORE answering"
echo "Confirm it says it is carrying on and does not redo the first feature's finished steps."
echo "Step 5 (second terminal):  conductor preview harbour-cafe"
echo "  Open the printed address on a phone on the home Wi-Fi (a private 192.168.x.x address, never 0.0.0.0)."
echo "  Sign in as the printed admin (password demo-password-1): the tips page exists and the demo data shows."
echo "  Sign in as a member: they see only their own entries."
echo "Step 6 (back here, at the approval question): type f, feedback 'Show the weekly totals in bold.';"
echo "  one more feature should run and the question should come back; then approve."
$C build harbour-cafe || echo "(exit $?)"
ok "Steps 4, 5 and 6: it carried on without redoing work; the preview worked on the phone; the feedback feature ran; approved."

step "7. git and project.json"
git -C "$PROJ/app" log --oneline main | head -8
echo "tags on main (expect none):"; git -C "$PROJ/app" tag --points-at main
cat "$PROJ/project.json"
echo "Expect: one commit per feature, 'Name the app: Harbour Café' (with app-profile.json), then the foundation's history;"
echo "status ready, foundation.tag v0.1.0, approved.sha equal to main's tip, builtFromBrief 1."
ok "Git and project.json look right."

step "8. preview again: it should say it replaced the earlier preview (new commit)"
$C preview harbour-cafe
ok "It replaced the earlier preview; the new address opens."

step "9. stop the preview; nothing may be left on CT 111"
$C preview harbour-cafe --stop
$C machines
ssh "root@$CT" 'docker ps -a --format "{{.Names}}" | grep -c "^hf-" || true; ls /srv/hf-factory/runs; docker images "hf-preview/*" -q | wc -l'
ok "No machines in use; container count 0, runs folder empty, image count 0."

step "10. sweep"
$C machines sweep
ok "It said: Nothing was left over."

step "11. evidence"
BUILD_DIR="$(ls -dt "$PROJ"/builds/*/ | head -1)"
echo "Build folder:  $BUILD_DIR"
echo "Reports:       ${BUILD_DIR}reports/"
ls -l "${BUILD_DIR}reports/" || true
for f in vitest.json playwright.json; do
  if [ -s "${BUILD_DIR}reports/$f" ]; then echo "present: $f"; else echo "MISSING: $f  <- the npm/vitest/Playwright reporter forwarding failed; note it in RESULT.md"; fi
done
echo "Crossing:      ${BUILD_DIR}reports/crossing.md"
echo "Screenshots:   ${BUILD_DIR}reports/screenshots/"
echo "Now fill in $HERE/RESULT.md."
