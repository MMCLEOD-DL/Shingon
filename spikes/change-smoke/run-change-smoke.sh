#!/usr/bin/env bash
# Plan 11 change smoke (operator-run in a real terminal). It makes a small change and takes a foundation fix, each
# through the real council and gate, and ships both as updates to a throwaway deployment (for example on CT 111).
# Never run by the test suite or by an agent.
#
# Usage: bash spikes/change-smoke/run-change-smoke.sh <project> <deployment> [--break]
#
# Needs, running first:
#   - Plan 10's smoke project and its deployment, already shipped (spikes/ship-smoke/), reachable over ssh
#   - both model subscriptions signed in (claude, codex) and the local model awake (conductor doctor shows this)
#   - you at the terminal: you answer the brief questions and approve each gate
#
# Safety:
#   - It works on a COPY of the project in a throwaway projects folder under /var/tmp, so your real projects folder
#     is never written to. Only the named deployment's record is copied (an update needs it), after you type its
#     name to confirm it is a disposable test box. The rest of deployments/ (other records, logs) is NOT copied.
#   - The foundation is only ever READ: a scratch clone is made in a temp folder; your real foundation is not touched.
#   - project.json in the copy is pointed at the scratch clone; the old value is printed and put back on exit.
#   - It deletes nothing. The temp folders are left for you to look at; their paths are printed.
#   - It writes no secrets and never prints environment values. The health token stays on the box: the app's version
#     is read by `conductor deployments status`, which asks inside the box.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/spikes/change-smoke"
C() { node "$ROOT/bin/conductor.js" "$@"; }

BREAK=no
ARGS=()
for a in "$@"; do
  if [ "$a" = "--break" ]; then BREAK=yes; else ARGS+=("$a"); fi
done
[ "${#ARGS[@]}" -eq 2 ] || { echo "Usage: bash spikes/change-smoke/run-change-smoke.sh <project> <deployment> [--break]"; exit 64; }
PROJECT="${ARGS[0]}"; DEP="${ARGS[1]}"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || { echo "The project name must be lower-case letters, digits and hyphens."; exit 64; }
[[ "$DEP" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || { echo "The deployment name must be lower-case letters, digits and hyphens."; exit 64; }
[ -t 0 ] && [ -t 1 ] || { echo "Run this in a real terminal (it asks you questions and needs your approval)."; exit 2; }

for tool in node ssh git; do command -v "$tool" >/dev/null || { echo "$tool is not on PATH"; exit 2; }; done
C --help >/dev/null 2>&1 || { echo "conductor does not run here (node bin/conductor.js --help failed)"; exit 2; }
C --help 2>&1 | grep -q 'foundation-upgrade' || { echo "This conductor has no 'foundation-upgrade' command."; exit 2; }

SOURCE_ROOT="${SOURCE_PROJECTS_ROOT:-$HOME/highland-projects}"
FOUNDATION_SRC="${FOUNDATION_REPO:-/root/highland-foundation}"
[ -d "$SOURCE_ROOT/$PROJECT/app/.git" ] || { echo "No built project at $SOURCE_ROOT/$PROJECT (set SOURCE_PROJECTS_ROOT if yours is elsewhere)."; exit 2; }
[ -f "$SOURCE_ROOT/$PROJECT/deployments/$DEP.json" ] || { echo "No deployment record $DEP for $PROJECT in $SOURCE_ROOT. Run Plan 10's ship smoke first."; exit 2; }
[ -d "$FOUNDATION_SRC/.git" ] || { echo "No foundation repository at $FOUNDATION_SRC (set FOUNDATION_REPO if yours is elsewhere)."; exit 2; }

echo "The deployment must be a disposable TEST box, never a client's: the smoke really updates the app on it."
read -r -p "Type the deployment name ($DEP) to confirm it is a test box: " CONFIRM
[ "$CONFIRM" = "$DEP" ] || { echo "Not confirmed."; exit 2; }

TMPROOT="$(mktemp -d /var/tmp/hf-change-smoke.XXXXXX)"
case "$TMPROOT" in /var/tmp/hf-change-smoke.*) ;; *) echo "unexpected temp folder"; exit 2;; esac
export CONDUCTOR_PROJECTS_ROOT="$TMPROOT/projects"
mkdir "$CONDUCTOR_PROJECTS_ROOT" "$CONDUCTOR_PROJECTS_ROOT/$PROJECT" "$CONDUCTOR_PROJECTS_ROOT/$PROJECT/deployments"
# Everything except deployments/ ...
for f in "$SOURCE_ROOT/$PROJECT"/* "$SOURCE_ROOT/$PROJECT"/.[!.]*; do
  [ -e "$f" ] || continue
  [ "$(basename "$f")" = deployments ] && continue
  cp -a "$f" "$CONDUCTOR_PROJECTS_ROOT/$PROJECT/"
done
# ... plus the one record the update needs.
cp -a "$SOURCE_ROOT/$PROJECT/deployments/$DEP.json" "$CONDUCTOR_PROJECTS_ROOT/$PROJECT/deployments/$DEP.json"
PJ="$CONDUCTOR_PROJECTS_ROOT/$PROJECT/project.json"
RECORD="$CONDUCTOR_PROJECTS_ROOT/$PROJECT/deployments/$DEP.json"
echo "throwaway folder (kept for you to inspect): $TMPROOT"
echo "In any second terminal, run:  export CONDUCTOR_PROJECTS_ROOT=$CONDUCTOR_PROJECTS_ROOT"

# What the deployment record says about reaching the box (not secrets): user, host, port, key path, bundle folder.
read_field() { node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const v=process.argv[2].split('.').reduce((o,k)=>o==null?o:o[k],d);console.log(v==null?'':String(v))" "$RECORD" "$1"; }
BOX_HOST="$(read_field host)"; BOX_USER="$(read_field ssh.user)"; BOX_PORT="$(read_field ssh.port)"
BOX_KEY="$(read_field ssh.keyPath)"; BOX_DIR="$(read_field bundleDir)"
[[ "$BOX_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { echo "The record's host looks wrong."; exit 2; }
[[ "$BOX_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "The record's ssh user looks wrong."; exit 2; }
[[ "$BOX_PORT" =~ ^[0-9]*$ ]] || { echo "The record's ssh port looks wrong."; exit 2; }
[[ "$BOX_KEY" =~ ^(/[A-Za-z0-9._/-]+)?$ ]] || { echo "The record's ssh key path looks wrong."; exit 2; }
[[ "$BOX_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "The record's bundle folder looks wrong."; exit 2; }
SSHOPTS=(-o BatchMode=yes)
[ -n "$BOX_PORT" ] && SSHOPTS+=(-p "$BOX_PORT")
[ -n "$BOX_KEY" ] && SSHOPTS+=(-i "$BOX_KEY")
box() { ssh "${SSHOPTS[@]}" "$BOX_USER@$BOX_HOST" "cd '$BOX_DIR' && $1" </dev/null; }

step() { echo; echo "== $1 =="; }
ok() { local a; read -r -p "$1 OK? [y/N] " a; [ "$a" = y ]; }
version_now() { read_field currentVersion; }
UPDATER_STATUS() { box "docker compose run --rm updater update --status"; }

ORIG_FOUNDATION_REPO="$(node -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log((p.foundation&&p.foundation.repo)||'')" "$PJ")"
REPO_SWAPPED=no
restore_repo() {
  if [ "$REPO_SWAPPED" = yes ]; then
    node -e "const fs=require('fs');const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,'utf8'));p.foundation.repo=process.argv[2];fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')" "$PJ" "$ORIG_FOUNDATION_REPO"
    echo "project.json foundation.repo put back to: $ORIG_FOUNDATION_REPO"
    REPO_SWAPPED=no
  fi
}
trap restore_repo EXIT

# ---------------- Step 1: health and starting version ----------------
step "Step 1: is everything reachable, and which version is the deployment on?"
C doctor
C deployments status "$PROJECT"
V0="$(version_now)"
echo "Deployment $DEP is recorded on version: $V0"
ok "Doctor shows the models you need, and the deployment is healthy" || { echo "Stopping."; exit 1; }

# ---------------- Step 2: a small change ----------------
step "Step 2: a small change through the council and the gate"
echo "Answer the brief questions, then read the gate. It should name the new version and the deployment $DEP."
echo "Approve it at the gate. This uses your subscriptions and the local model, and takes a while."
C change "$PROJECT" --notes "$HERE/notes-change.md"
V1="$(version_now)"
echo "Version before: $V0   version now recorded: $V1"
[ "$V1" != "$V0" ] && [ -n "$V1" ] && [ "$V1" != none ] || { echo "The recorded version did not change. Look at the report above."; exit 1; }

# ---------------- Step 3: check the box ----------------
step "Step 3: check the box after the change"
echo "Newest line of the updater's log should be: Updated from $V0 to $V1. A backup (...) was taken first."
UPDATER_STATUS
C deployments status "$PROJECT"
ok "The newest updater line says it updated from $V0 to $V1 with a backup, and deployments status shows the app on $V1" || { echo "Stopping."; exit 1; }

# ---------------- Step 4: a scratch foundation release ----------------
step "Step 4: make a scratch foundation release (your real foundation is only read)"
FDIR="$TMPROOT/foundation"
git clone --quiet "$FOUNDATION_SRC" "$FDIR"
CUR="$(node -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log((p.foundation&&p.foundation.tag)||'')" "$PJ")"
[[ "$CUR" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "The project's recorded foundation tag ($CUR) is not a release like v0.1.0."; exit 1; }
IFS=. read -r MAJ MIN PAT <<< "${CUR#v}"
NEXT="$MAJ.$MIN.$((PAT + 1))"
echo "The app is on foundation $CUR; the scratch release will be v$NEXT."
if git -C "$FDIR" rev-parse -q --verify "refs/tags/v$NEXT" >/dev/null; then
  echo "The foundation already has a tag v$NEXT, so a scratch release would clash. Stopping."; exit 1
fi
TODAY="$(date -u +%Y-%m-%d)"
(
  cd "$FDIR"
  node - "$NEXT" "$TODAY" <<'JS'
const fs = require('fs');
const [next, today] = process.argv.slice(2);
let cl = fs.readFileSync('CHANGELOG.md', 'utf8');
const marker = '## [Unreleased]';
if (!cl.includes(marker)) { console.error('The foundation CHANGELOG.md has no [Unreleased] heading.'); process.exit(1); }
cl = cl.replace(marker, `${marker}\n\n## [${next}] - ${today}\n\n- **[security]** Smoke: no real change.`);
fs.writeFileSync('CHANGELOG.md', cl);
const bump = (f, fn) => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); fn(j); fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n'); };
bump('package.json', (j) => { j.version = next; });
bump('package-lock.json', (j) => { j.version = next; if (j.packages && j.packages['']) j.packages[''].version = next; });
bump('foundation.json', (j) => { j.version = next; j.commit = `v${next}`; });
JS
  git add CHANGELOG.md package.json package-lock.json foundation.json
  git -c user.name="Conductor smoke" -c user.email="smoke@localhost" commit --quiet -m "release: v$NEXT"
  git -c user.name="Conductor smoke" -c user.email="smoke@localhost" tag -a "v$NEXT" -m "v$NEXT"
)
echo "Scratch foundation release v$NEXT made in $FDIR"
echo "project.json foundation.repo is currently: $ORIG_FOUNDATION_REPO (it is put back when this script ends)"
node -e "const fs=require('fs');const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,'utf8'));p.foundation.repo=process.argv[2];fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')" "$PJ" "$FDIR"
REPO_SWAPPED=yes

# ---------------- Step 5: the check sees it ----------------
step "Step 5: foundation-upgrade --check should show the code and the deployment missing 1 security fix"
C foundation-upgrade --check || true
ok "Both the code and $DEP are listed as missing 1 security fix" || { echo "Stopping."; exit 1; }

# ---------------- Step 6: take the fix ----------------
step "Step 6: take the foundation fix (v$NEXT) through the council and the gate"
echo "Approve it at the gate. The app's own foundation.json keeps its old version by design (Ruling C1); the recorded tag in project.json is what counts."
C foundation-upgrade "$PROJECT" --to "v$NEXT"
V2="$(version_now)"
echo "Version before: $V1   version now recorded: $V2"
[ "$V2" != "$V1" ] && [ -n "$V2" ] && [ "$V2" != none ] || { echo "The recorded version did not change. Look at the report above."; exit 1; }
UPDATER_STATUS
C deployments status "$PROJECT"
echo "Now --check should say both lines are up to date:"
C foundation-upgrade --check || true
ok "The updater says it updated from $V1 to $V2 with a backup, the app is on $V2, and --check says up to date" || { echo "Stopping."; exit 1; }

# ---------------- Step 7 (optional): the stop rule ----------------
if [ "$BREAK" = yes ]; then
  step "Step 7: deliberately break one update, to see the box undo it"
  echo "The change asks for an app that fails on start-up. Answer the questions, approve at the gate."
  echo "Expect the report line: the new version failed its health check, so the box undid the update by itself"
  set +e; C change "$PROJECT" --notes "$HERE/notes-break.md"; BROKE=$?; set -e
  echo "conductor exit code: $BROKE (non-zero expected)"
  C deployments status "$PROJECT"
  echo "The deployment should still be on $V2 (recorded: $(version_now))."
  ok "The report said the box undid the update by itself, and $DEP is still on $V2" || { echo "Stopping."; exit 1; }
  echo "A change is now left unfinished in the throwaway folder; that is expected. Drop it with: conductor change $PROJECT --abandon (with CONDUCTOR_PROJECTS_ROOT=$CONDUCTOR_PROJECTS_ROOT)."
else
  echo; echo "Step 7 skipped (add --break to try the deliberate failure)."
fi

echo
echo "SMOKE PASSED. Fill in spikes/change-smoke/RESULT.md. Throwaway folder kept: $TMPROOT"
