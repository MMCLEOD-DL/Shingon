#!/usr/bin/env bash
# Plan 11 change smoke (operator-run in a real terminal). It makes a small change and takes a foundation fix, each
# through the real council and gate, and ships both as updates to a throwaway deployment (for example on CT 111).
# Never run by the test suite or by an agent.
#
# Usage: SOURCE_PROJECTS_ROOT=/var/tmp/hf-ship-smoke.XXXXXX bash spikes/change-smoke/run-change-smoke.sh <project> <deployment> [--break]
#
# SOURCE_PROJECTS_ROOT is required: it is the throwaway folder Plan 10's ship smoke left behind (it holds the project
# and the deployment record of the test box). The script refuses your real projects folder. Once this smoke has
# updated the box, that source record is stale (it still shows the old version); use a fresh ship smoke next time.
#
# Needs, running first:
#   - Plan 10's smoke project and its deployment, already shipped (spikes/ship-smoke/), reachable over ssh
#   - both model subscriptions signed in (claude, codex) and the local model awake (conductor doctor shows this)
#   - you at the terminal: you answer the brief questions and approve each gate
#
# Safety:
#   - It works on a COPY of the project in a throwaway projects folder under /var/tmp, so your real projects folder
#     is never written to. Only the named deployment's record is copied (an update needs it), after you read the
#     box's address and type its HOST to confirm it is a disposable test box. The rest of deployments/ is NOT copied.
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
[[ "$DEP" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Use a plain deployment name (letters, digits, . _ -)."; exit 64; }
[ -t 0 ] && [ -t 1 ] || { echo "Run this in a real terminal (it asks you questions and needs your approval)."; exit 2; }

for tool in node ssh git; do command -v "$tool" >/dev/null || { echo "$tool is not on PATH"; exit 2; }; done
C --help >/dev/null 2>&1 || { echo "conductor does not run here (node bin/conductor.js --help failed)"; exit 2; }
C --help 2>&1 | grep -q 'foundation-upgrade' || { echo "This conductor has no 'foundation-upgrade' command."; exit 2; }

[ -n "${SOURCE_PROJECTS_ROOT:-}" ] || { echo "Set SOURCE_PROJECTS_ROOT to the throwaway folder Plan 10's ship smoke left (/var/tmp/hf-ship-smoke.XXXXXX). Refusing to guess: a real client's record must never be picked up."; exit 2; }
SOURCE_ROOT="$(cd "$SOURCE_PROJECTS_ROOT" 2>/dev/null && pwd -P)" || { echo "SOURCE_PROJECTS_ROOT is not a folder."; exit 2; }
# Refuse the real projects root: the environment's, the default, and the one the config file names.
REAL_ROOTS=("$HOME/highland-projects")
[ -n "${CONDUCTOR_PROJECTS_ROOT:-}" ] && REAL_ROOTS+=("$CONDUCTOR_PROJECTS_ROOT")
CFG_ROOT="$(node --input-type=module -e "
const { loadConfig } = await import(process.argv[1] + '/src/config.js');
const { factoryConfig } = await import(process.argv[1] + '/src/factory/config.js');
try { console.log(factoryConfig(loadConfig(process.argv[2]), { env: {} }).projectsRoot); } catch { }
" "$ROOT" "${CONDUCTOR_CONFIG:-$HOME/.config/conductor/config.json}" 2>/dev/null || true)"
[ -n "$CFG_ROOT" ] && REAL_ROOTS+=("$CFG_ROOT")
for r in "${REAL_ROOTS[@]}"; do
  R="$(cd "$r" 2>/dev/null && pwd -P || true)"
  [ -z "$R" ] || [ "$R" != "$SOURCE_ROOT" ] || { echo "SOURCE_PROJECTS_ROOT is your real projects folder ($R). Refusing."; exit 2; }
done
case "$SOURCE_ROOT" in
  /var/tmp/hf-ship-smoke.*) ;;
  *) [ "${CHANGE_SMOKE_ALLOW_ANY_SOURCE:-}" = yes ] || { echo "SOURCE_PROJECTS_ROOT is not a Plan 10 ship-smoke folder (/var/tmp/hf-ship-smoke.*). Set CHANGE_SMOKE_ALLOW_ANY_SOURCE=yes only if you are sure it holds a disposable test box."; exit 2; };;
esac
FOUNDATION_SRC="${FOUNDATION_REPO:-/root/highland-foundation}"
[ -d "$SOURCE_ROOT/$PROJECT/app/.git" ] || { echo "No built project at $SOURCE_ROOT/$PROJECT (set SOURCE_PROJECTS_ROOT if yours is elsewhere)."; exit 2; }
[ -f "$SOURCE_ROOT/$PROJECT/deployments/$DEP.json" ] || { echo "No deployment record $DEP for $PROJECT in $SOURCE_ROOT. Run Plan 10's ship smoke first."; exit 2; }
[ -d "$FOUNDATION_SRC/.git" ] || { echo "No foundation repository at $FOUNDATION_SRC (set FOUNDATION_REPO if yours is elsewhere)."; exit 2; }

SRC_RECORD="$SOURCE_ROOT/$PROJECT/deployments/$DEP.json"
[ ! -L "$SRC_RECORD" ] || { echo "The deployment record is a symbolic link; refusing."; exit 2; }
rf() { node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const v=process.argv[2].split('.').reduce((o,k)=>o==null?o:o[k],d);console.log(v==null?'':String(v))" "$SRC_RECORD" "$1"; }
SH="$(rf host)"; SU="$(rf ssh.user)"; SP="$(rf ssh.port)"; SD="$(rf bundleDir)"
echo "The record says: $SU@$SH (port ${SP:-default}), bundle folder $SD"
echo "The deployment must be a disposable TEST box, never a client's: the smoke really updates the app on it."
read -r -p "Type the HOST ($SH) to confirm it is a test box: " CONFIRM
[ "$CONFIRM" = "$SH" ] && [ -n "$SH" ] || { echo "Not confirmed."; exit 2; }

TMPROOT="$(mktemp -d /var/tmp/hf-change-smoke.XXXXXX)"
case "$TMPROOT" in /var/tmp/hf-change-smoke.*) ;; *) echo "unexpected temp folder"; exit 2;; esac
export CONDUCTOR_PROJECTS_ROOT="$TMPROOT/projects"
export CONDUCTOR_BASE_DIR="$TMPROOT/runs"
mkdir "$CONDUCTOR_BASE_DIR"
mkdir "$CONDUCTOR_PROJECTS_ROOT" "$CONDUCTOR_PROJECTS_ROOT/$PROJECT" "$CONDUCTOR_PROJECTS_ROOT/$PROJECT/deployments"
# Everything except deployments/ ...
for f in "$SOURCE_ROOT/$PROJECT"/* "$SOURCE_ROOT/$PROJECT"/.[!.]*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  [ "$(basename "$f")" = deployments ] && continue
  [ ! -L "$f" ] || { echo "$f is a symbolic link; refusing to copy it."; exit 2; }
  cp -a "$f" "$CONDUCTOR_PROJECTS_ROOT/$PROJECT/"
done
# ... plus the one record the update needs.
cp -a "$SRC_RECORD" "$CONDUCTOR_PROJECTS_ROOT/$PROJECT/deployments/$DEP.json"
PJ="$CONDUCTOR_PROJECTS_ROOT/$PROJECT/project.json"
RECORD="$CONDUCTOR_PROJECTS_ROOT/$PROJECT/deployments/$DEP.json"
echo "throwaway folder (kept for you to inspect): $TMPROOT"
echo "In any second terminal, run:  export CONDUCTOR_PROJECTS_ROOT=$CONDUCTOR_PROJECTS_ROOT"

# What the deployment record says about reaching the box (not secrets): user, host, port, key path, bundle folder.
read_field() { node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const v=process.argv[2].split('.').reduce((o,k)=>o==null?o:o[k],d);console.log(v==null?'':String(v))" "$RECORD" "$1"; }
BOX_HOST="$(read_field host)"; BOX_USER="$(read_field ssh.user)"; BOX_PORT="$(read_field ssh.port)"
BOX_KEY="$(read_field ssh.keyPath)"; BOX_DIR="$(read_field bundleDir)"; BOX_DELIVERY="$(read_field imageDelivery)"
[[ "$BOX_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { echo "The record's host looks wrong."; exit 2; }
[[ "$BOX_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "The record's ssh user looks wrong."; exit 2; }
[[ "$BOX_PORT" =~ ^[0-9]*$ ]] || { echo "The record's ssh port looks wrong."; exit 2; }
[[ "$BOX_KEY" =~ ^(/[A-Za-z0-9._/-]+)?$ ]] || { echo "The record's ssh key path looks wrong."; exit 2; }
[[ "$BOX_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "The record's bundle folder looks wrong."; exit 2; }
# The same ssh options Conductor itself uses (src/factory/ship/remote.js).
SSHOPTS=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
[ -n "$BOX_PORT" ] && SSHOPTS+=(-p "$BOX_PORT")
[ -n "$BOX_KEY" ] && SSHOPTS+=(-i "$BOX_KEY" -o IdentitiesOnly=yes)
DCFG=""
[ "$BOX_DELIVERY" = registry ] && DCFG='DOCKER_CONFIG="$PWD/.docker" '
box() { ssh "${SSHOPTS[@]}" -l "$BOX_USER" -- "$BOX_HOST" "cd '$BOX_DIR' && $DCFG$1" </dev/null; }

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
    echo "Note: in the throwaway copy, foundation.tag stays at v${NEXT:-?} (the scratch release); the real project is untouched."
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
git clone --quiet --no-hardlinks "$FOUNDATION_SRC" "$FDIR"
CUR="$(node -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log((p.foundation&&p.foundation.tag)||'')" "$PJ")"
[[ "$CUR" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "The project's recorded foundation tag ($CUR) is not a release like v0.1.0."; exit 1; }
IFS=. read -r MAJ MIN PAT <<< "${CUR#v}"
NEXT="$MAJ.$MIN.$((PAT + 1))"
echo "The app is on foundation $CUR; the scratch release will be v$NEXT."
git -C "$FDIR" rev-parse -q --verify "refs/tags/$CUR" >/dev/null || { echo "The foundation has no tag $CUR. Stopping."; exit 1; }
NEWER="$(git -C "$FDIR" tag --list 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -n 1)"
[ "$NEWER" = "$CUR" ] || { echo "The foundation already has a release ($NEWER) newer than the app's $CUR, so a scratch release would be out of order. Stopping."; exit 1; }
# Cut the scratch release from the app's own tag, not from whatever the foundation's main happens to hold.
git -C "$FDIR" checkout -q -b smoke-release "refs/tags/$CUR"
if sed -n '/^## \[Unreleased\]/,/^## \[/p' "$FDIR/CHANGELOG.md" | sed '1d;$d' | grep -q '[^[:space:]]'; then
  echo "The foundation's [Unreleased] section has entries; a scratch release would swallow them. Stopping."; exit 1
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
  echo "The council may block it, and you may need to choose 'ship anyway' to reach the box. If the run stops before the box is touched, that is not a smoke failure: the safety net is only tested when the update reaches the box."
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
