#!/usr/bin/env bash
# Plan 10 ship smoke (operator-run in a real terminal): a real throwaway box, the real build machine, a Matrix room,
# an Uptime Kuma monitor, and YOU saving the backup password. Never run by the test suite or by an agent.
#
# Usage: bash spikes/ship-smoke/run-ship-smoke.sh <project> <deployment>
#
# Safety: the smoke works on a COPY of the project in a throwaway projects folder (CONDUCTOR_PROJECTS_ROOT under
# /var/tmp), so your real ~/highland-projects is never written to. The copy is kept afterwards as evidence.
# The script deletes nothing. It writes no secrets: the answers you type go straight to conductor, and the
# deployment record Conductor saves holds none (README, "What Conductor keeps").
# Use a box you do not mind wiping: this really installs an app on it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/spikes/ship-smoke"
C() { node "$ROOT/bin/conductor.js" "$@"; }
[ $# -eq 2 ] || { echo "Usage: bash spikes/ship-smoke/run-ship-smoke.sh <project> <deployment>"; exit 64; }
PROJECT="$1"; DEP="$2"
case "$PROJECT$DEP" in *[!A-Za-z0-9._-]*) echo "Use plain project and deployment names (letters, digits, . _ -)."; exit 64;; esac
[ -t 0 ] && [ -t 1 ] || { echo "Run this in a real terminal (it asks you questions)."; exit 2; }

for tool in node ssh git; do command -v "$tool" >/dev/null || { echo "$tool is not on PATH"; exit 2; }; done
C --help >/dev/null 2>&1 || { echo "conductor does not run here (node bin/conductor.js --help failed)"; exit 2; }

SOURCE_ROOT="${SOURCE_PROJECTS_ROOT:-$HOME/highland-projects}"
[ -d "$SOURCE_ROOT/$PROJECT/app/.git" ] || { echo "No built project at $SOURCE_ROOT/$PROJECT (set SOURCE_PROJECTS_ROOT if yours is elsewhere)."; exit 2; }
export CONDUCTOR_PROJECTS_ROOT="$(mktemp -d /var/tmp/hf-ship-smoke.XXXXXX)"
case "$CONDUCTOR_PROJECTS_ROOT" in /var/tmp/hf-ship-smoke.*) ;; *) echo "unexpected temp folder"; exit 2;; esac
# Copy the project WITHOUT its deployments/ folder, so a real client box's record can never be picked up.
mkdir "$CONDUCTOR_PROJECTS_ROOT/$PROJECT"
for f in "$SOURCE_ROOT/$PROJECT"/* "$SOURCE_ROOT/$PROJECT"/.[!.]*; do
  [ -e "$f" ] || continue
  [ "$(basename "$f")" = deployments ] && continue
  cp -a "$f" "$CONDUCTOR_PROJECTS_ROOT/$PROJECT/"
done
[ ! -e "$CONDUCTOR_PROJECTS_ROOT/$PROJECT/deployments/$DEP.json" ] || { echo "The copy already has a deployment record for $DEP; refusing."; exit 2; }
echo "The deployment must be a disposable TEST box, never a client's: the smoke really installs an app on it."
read -r -p "Type the deployment name ($DEP) to confirm it is a test box: " CONFIRM
[ "$CONFIRM" = "$DEP" ] || { echo "Not confirmed."; exit 2; }
echo "throwaway projects folder (kept for evidence): $CONDUCTOR_PROJECTS_ROOT"
echo "In any second terminal, run:  export CONDUCTOR_PROJECTS_ROOT=$CONDUCTOR_PROJECTS_ROOT"

echo "Where will Conductor reach the box? Type its SSH alias or address (the one you will give ship):"
read -r HOST
[ -n "$HOST" ] || { echo "No host given."; exit 2; }
if ! { grep -qs -- "$HOST" "$HOME/.ssh/config" || grep -qs -- "$HOST" "$HOME/.ssh/known_hosts"; }; then
  echo "Neither ~/.ssh/config nor ~/.ssh/known_hosts mentions $HOST."
  echo "Add an alias to ~/.ssh/config, then the box's host key:  ssh-keyscan -t ed25519 $HOST >> ~/.ssh/known_hosts"
  echo "and compare the fingerprint (ssh-keygen -lf) with the one the box shows before you trust it. See the README, 'Before the first ship'."
  exit 2
fi

RESULTS=()
VERSIONS=()
N=0
step() { N=$((N + 1)); echo; echo "== $1 =="; }
ok() { local a; read -r -p "$1 OK? [y/N] " a; [ "$a" = y ]; }
# expect <exit-code> <phase> <command...>: runs it, keeps its exit code, never stops the script on a non-zero code.
expect() {
  local want="$1"; shift
  local label="$1"; shift
  local got=0
  set +e; "$@"; got=$?; set -e
  if [ "$got" -eq "$want" ]; then echo "[exit $got, as expected] $label"; return 0; fi
  echo "[exit $got, expected $want] $label"; return 1
}
version_now() { node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(d.currentVersion||'none')" \
  "$CONDUCTOR_PROJECTS_ROOT/$PROJECT/deployments/$DEP.json" 2>/dev/null || echo none; }
finish() {
  {
    echo "# Ship smoke result"
    echo
    echo "Date: $(date -u +%Y-%m-%dT%H:%MZ)"
    echo "Project: $PROJECT, deployment: $DEP, throwaway folder: $CONDUCTOR_PROJECTS_ROOT"
    echo
    echo "- Phase 1, first ship: ${RESULTS[0]:-not run} (version ${VERSIONS[0]:-?})"
    echo "- Phase 2, later ship: ${RESULTS[1]:-not run} (version ${VERSIONS[1]:-?})"
    echo "- Phase 3, Ctrl-C while updating: ${RESULTS[2]:-not run} (version ${VERSIONS[2]:-?})"
  } > "$HERE/RESULT.md"
  echo; echo "Result written to $HERE/RESULT.md"
}
trap finish EXIT

# ---------------- Phase 1: first ship ----------------
step "Phase 1: first ship (conductor ship $PROJECT --to $DEP)"
echo "You will be asked the setup questions. The backup password is shown ONCE: save it in your password manager, then type saved."
P1=pass
expect 0 "ship" C ship "$PROJECT" --to "$DEP" || P1=FAIL
expect 0 "deployments status" C deployments status "$PROJECT" || P1=FAIL
echo "Check by hand on the box (cd to the deployment's folder):"
echo "  docker compose ps                      every service Up / healthy"
echo "  docker compose run --rm ops check      every line a tick"
echo "  the Matrix alerts room                 nothing alarming"
echo "  Uptime Kuma                            the push monitor shows heartbeats arriving"
ok "All four checks" || P1=FAIL
RESULTS[0]=$P1; VERSIONS[0]="$(version_now)"
[ "$P1" = pass ] || { echo "Phase 1 failed; stopping."; exit 1; }

# ---------------- Phase 2: a later ship ----------------
# Needs Plan 11's 'conductor change'. Until Plan 11 is merged, stop here.
step "Phase 2: a later ship (after Plan 11)"
if ! C --help 2>&1 | grep -q 'conductor change'; then
  echo "This conductor has no 'change' command yet (Plan 11). Phases 2 and 3 are skipped."
  RESULTS[1]="skipped (after Plan 11)"; RESULTS[2]="skipped (after Plan 11)"
  exit 0
fi
P2=pass
echo "Make a change and let it ship:  conductor change $PROJECT --notes <file>"
echo "(it releases the change and updates this box through the same safe update conductor ship uses)."
read -r -p "Press Enter when it has finished " _
expect 0 "deployments status" C deployments status "$PROJECT" || P2=FAIL
echo "The version above should be the new one."
expect 1 "ship again (nothing new)" C ship "$PROJECT" --to "$DEP" || P2=FAIL
echo "That last ship should have said: There is nothing new to ship"
ok "The new version is shown and the second ship said there is nothing new" || P2=FAIL
RESULTS[1]=$P2; VERSIONS[1]="$(version_now)"

# ---------------- Phase 3: Ctrl-C while updating ----------------
step "Phase 3: Ctrl-C while an update is running (after Plan 11)"
P3=pass
echo "Make another change:  conductor change $PROJECT --notes <file>"
echo "Press Ctrl-C when the line 'box: Taking a backup' appears. Expect exit 130 and the message:"
echo "  The update carries on by itself on the box"
ok "You saw that message (and the shell showed exit 130 if you checked with echo \$?)" || P3=FAIL
echo "Wait for the update to finish on the box (docker compose logs --tail 20 updater, or a minute or two), then press Enter."
read -r -p "Press Enter when the box has finished " _
expect 0 "deployments status" C deployments status "$PROJECT" || P3=FAIL
ok "Status said: The last update's result is now known" || P3=FAIL
RESULTS[2]=$P3; VERSIONS[2]="$(version_now)"
[ "$P1$P2$P3" = passpasspass ] || exit 1
echo "SMOKE PASSED"
