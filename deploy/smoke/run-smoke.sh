#!/usr/bin/env bash
# The foundation's full-bundle smoke test, run by the operator: bash deploy/smoke/run-smoke.sh
#
# ONLY on a disposable Linux machine with Docker (a throwaway VM). NEVER on a client box: it builds images, starts and
# stops containers, and deletes everything it made at the end.
#
# It builds the images, installs the bundle in /tmp/hf-smoke (demo mode), backs up to a separate restic REST server,
# proves a restore test and a real restore (then an upload), stops the app to check an alert fires and clears, runs one
# good update and one deliberately broken one (which must undo itself), and checks the data survived it all. Nothing
# leaves the machine: alerts go to a local catcher, mail to a local Mailpit, backups to a local REST server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR=/tmp/hf-smoke
PROJECT=hfsmoke
ALERTS=/tmp/hf-smoke-alerts.log
COOKIES=/tmp/hf-smoke-cookies
REST_IMAGE=restic/rest-server:0.14.0      # BSD-2-Clause
MAILPIT_IMAGE=axllent/mailpit:v1.21.8     # MIT
BIND="${HF_SMOKE_BIND:-127.0.0.1}"        # the front door is published on this address only
BASE="http://localhost:8080"
STEP="starting"
PASSED=false
CATCHER_PID=""
START=$SECONDS

say() { echo "== $*"; }
ok() { echo "   ok: $*"; }
fail() { echo "   FAILED: $*" >&2; exit 1; }
dc() { (cd "$DIR" && docker compose "$@"); }
ops_cli() { dc exec -T ops node ops/dist/cli.js "$@"; }
notes_count() { dc exec -T db psql -U app -d app -tAc 'select count(*) from notes' | tr -d '[:space:]'; }
alert_lines() { [ -f "$ALERTS" ] && wc -l < "$ALERTS" | tr -d ' ' || echo 0; }
# Waits up to $2 seconds for text $1 in the alert log, after line $3.
wait_alert() {
  local text="$1" limit="$2" after="$3" t=0
  while [ "$t" -lt "$limit" ]; do
    if [ -f "$ALERTS" ] && tail -n +"$((after + 1))" "$ALERTS" | grep -qF "$text"; then return 0; fi
    sleep 5; t=$((t + 5))
  done
  return 1
}
wait_healthy() {
  local t=0
  until curl -fsS "$BASE/healthz" 2>/dev/null | grep -q '"ok"'; do
    t=$((t + 2)); [ "$t" -ge 180 ] && fail "the app did not answer $BASE/healthz within 3 minutes"
    sleep 2
  done
}
# Sets KEY=VALUE in .env: replaces the line (or its commented-out form) or appends it.
setenv() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" 'BEGIN { done = 0 }
    !done && ($0 ~ "^" k "=" || $0 ~ "^# " k "=") { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$DIR/.env" > "$tmp"
  cat "$tmp" > "$DIR/.env" && rm -f "$tmp"
}

teardown() {
  local code=$?
  set +e
  if [ "$PASSED" != true ]; then echo "SMOKE FAILED during: $STEP (exit $code). Cleaning up." >&2; fi
  say "Step 10: tear down"
  if [ -f "$DIR/compose.yaml" ]; then dc --profile tools --profile tunnel down -v --remove-orphans >/dev/null 2>&1; fi
  docker rm -f hf-smoke-rest >/dev/null 2>&1
  [ -n "$CATCHER_PID" ] && kill "$CATCHER_PID" >/dev/null 2>&1
  for v in "${V:-}" "${V1:-}" "${V2:-}"; do
    [ -n "$v" ] && docker rmi "highland/app:$v" "highland/ops:$v" >/dev/null 2>&1
  done
  rm -rf "$DIR" "$COOKIES" "/tmp/hf-smoke-images-${V1:-x}.tar"
  echo "   Removed the containers, volumes, network and highland images this run made. The alert log is kept at $ALERTS."
  echo "   Pulled third-party images (postgres, caddy, $REST_IMAGE, $MAILPIT_IMAGE) are left; remove them with docker rmi if you like."
  if [ "$PASSED" = true ]; then echo "SMOKE PASSED in $(( (SECONDS - START) / 60 )) min $(( (SECONDS - START) % 60 )) s"; fi
}

# ---- Refuse anything that does not look like a disposable machine.
command -v docker >/dev/null || { echo "Docker is not installed. Run this on a throwaway VM with Docker." >&2; exit 2; }
docker compose version >/dev/null 2>&1 || { echo "The Docker Compose plugin is missing." >&2; exit 2; }
command -v node >/dev/null || { echo "Node.js 22 is needed (for the bundle and the alert catcher)." >&2; exit 2; }
if [ -n "$(docker ps -aq --filter label=com.docker.compose.project=highland)" ]; then
  echo "This machine runs a Highland deployment (Compose project \"highland\"). The smoke test must never run on a client box. Stopping." >&2; exit 2
fi
if [ -e "$DIR" ] || [ -n "$(docker ps -aq --filter name='^hf-smoke-rest$')" ] || [ -n "$(docker ps -aq --filter label=com.docker.compose.project=$PROJECT)" ]; then
  echo "A previous smoke run was left behind ($DIR, the hf-smoke-rest container or the $PROJECT project). Remove it first." >&2; exit 2
fi
trap teardown EXIT

cd "$ROOT"
V="$(node -p 'require("./package.json").version')"
V1="$(node -p 'const [a,b,c]=require("./package.json").version.split(/[.-]/).map(Number); `${a}.${b}.${c+1}`')"
V2="$(node -p 'const [a,b,c]=require("./package.json").version.split(/[.-]/).map(Number); `${a}.${b}.${c+2}`')"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo smoke)"

# ---- 1. Images: V, V1 (a plain retag, delivered as a docker save file), V2 (deliberately broken).
STEP="step 1 (images)"
say "Step 1: build the images for $V, retag $V1, build a broken $V2"
docker build -q -f deploy/Dockerfile -t "highland/app:$V" --build-arg "APP_VERSION=$V" --build-arg "GIT_COMMIT=$COMMIT" . >/dev/null
docker build -q -f deploy/ops.Dockerfile -t "highland/ops:$V" --build-arg "APP_VERSION=$V" --build-arg "GIT_COMMIT=$COMMIT" . >/dev/null
docker tag "highland/app:$V" "highland/app:$V1"
docker tag "highland/ops:$V" "highland/ops:$V1"
docker save "highland/app:$V1" "highland/ops:$V1" -o "/tmp/hf-smoke-images-$V1.tar"
docker rmi "highland/app:$V1" "highland/ops:$V1" >/dev/null   # so the update has to load them from the file
docker build -q -f deploy/test/broken-image.Dockerfile --build-arg "BASE=highland/app:$V" -t "highland/app:$V2" deploy/test >/dev/null
docker tag "highland/ops:$V" "highland/ops:$V2"
ok "highland/app and highland/ops $V built; $V1 saved to a file; broken $V2 built"

# ---- 2. The off-box backup destination and the alert catcher, on Docker's bridge address (not the LAN).
STEP="step 2 (backup server and alert catcher)"
GW="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
say "Step 2: start the restic REST server and the alert catcher on $GW"
docker run -d --quiet --name hf-smoke-rest -p "$GW:8000:8000" -e DISABLE_AUTHENTICATION=1 "$REST_IMAGE" >/dev/null
rm -f "$ALERTS"
HF_SMOKE_ALERT_LOG="$ALERTS" HF_SMOKE_CATCHER_HOST="$GW" node deploy/smoke/catcher.mjs >/tmp/hf-smoke-catcher.out 2>&1 &
CATCHER_PID=$!
t=0; until curl -s -o /dev/null "http://$GW:8000/" && curl -s -o /dev/null "http://$GW:8099/"; do
  t=$((t + 1)); [ "$t" -ge 30 ] && fail "the REST server or the catcher did not start"; sleep 1
done
ok "REST server at http://$GW:8000, catcher at http://$GW:8099"

# ---- 3. The bundle, ops init, and the smoke settings.
STEP="step 3 (bundle and ops init)"
say "Step 3: make $DIR from the bundle and run ops init"
[ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null
npm run -s bundle >/dev/null
mkdir -p "$DIR"
tar -xzf "dist/highland-bundle-$V.tar.gz" -C "$DIR"
mv "/tmp/hf-smoke-images-$V1.tar" "$DIR/images-$V1.tar"
docker run --rm -u "$(id -u):$(id -g)" -v "$DIR:/out" "highland/ops:$V" \
  init --client Smoke --origin http://localhost:8080 --site :80 --dir "$DIR" --demo --out /out/.env 2>/dev/null
[ "$(stat -c %a "$DIR/.env")" = 600 ] || fail ".env is not mode 600"
setenv COMPOSE_PROJECT_NAME "$PROJECT"
setenv APP_TAG "$V"
setenv SMTP_URL smtp://mailpit:1025
setenv EMAIL_FROM smoke@example.test
setenv BACKUP_REPOSITORY rest:http://host.docker.internal:8000/smoke
setenv ALERT_WEBHOOK_URL http://host.docker.internal:8099/
setenv HTTP_PORT "$BIND:8080"
setenv HTTPS_PORT "$BIND:8443"
cat > "$DIR/compose.override.yaml" <<'YAML'
# Smoke test only: ops and the updater reach the REST server and the catcher on the host; Mailpit catches the app's mail.
services:
  ops: { extra_hosts: ["host.docker.internal:host-gateway"] }
  updater: { extra_hosts: ["host.docker.internal:host-gateway"] }
  mailpit: { image: axllent/mailpit:v1.21.8, networks: [backend] }
YAML
ls "$DIR"/RUNBOOK.md >/dev/null || fail "the bundle has no RUNBOOK.md"
ok "bundle unpacked ($(cd "$DIR" && ls | tr '\n' ' ')), .env made by ops init (mode 600)"

# ---- 4. Start, seed, sign-in page.
STEP="step 4 (start)"
say "Step 4: docker compose up -d, wait for /healthz, seed the demo data"
dc up -d >/dev/null 2>&1 || { dc ps; fail "docker compose up -d failed"; }
wait_healthy
SEED="$(dc exec -T app node apps/server/dist/seed/cli.js | head -1)"
echo "   $SEED"
curl -fsS "$BASE/sign-in" | grep -q '<div id="root">' || fail "/sign-in did not serve the app"
ok "/healthz ok, demo data seeded, /sign-in serves the app"

# ---- 5. Backup and restore test.
STEP="step 5 (backup and restore test)"
say "Step 5: ops backup, then ops restore-test"
OUT="$(ops_cli backup 2>&1)"; echo "   $OUT" | tail -1
echo "$OUT" | grep -qF 'saved to rest:http://host.docker.internal:8000/smoke' || fail "backup: $OUT"
OUT="$(ops_cli restore-test 2>&1)"; echo "   $OUT" | tail -1
echo "$OUT" | grep -qF 'Restore test passed' || fail "restore-test: $OUT"
ok "backup saved to the REST server; restore test passed"

# ---- 6. Every check passes.
STEP="step 6 (check)"
say "Step 6: ops check"
OUT="$(ops_cli check 2>&1)" || { echo "$OUT"; fail "ops check reported a problem"; }
echo "$OUT" | sed 's/^/   /'
echo "$OUT" | grep -q '^✗' && fail "ops check has a failing line"
ok "every line ✓"

# ---- 6a. Restore over the live data, then prove the app can still write uploads.
STEP="step 6a (restore, then upload)"
say "Step 6a: stop app and ops, ops restore latest, start, sign in and upload"
NOTES_BEFORE="$(notes_count)"
dc stop app ops >/dev/null 2>&1
OUT="$(dc run --rm -T ops restore latest --yes-replace-live-data 2>&1 | grep -v '^ *Container ')"; echo "$OUT" | sed 's/^/   /'
echo "$OUT" | grep -qF 'Safety backup' || fail "restore did not take a safety backup"
echo "$OUT" | grep -qF 'Done.' || fail "restore did not finish"
dc start app ops >/dev/null 2>&1
wait_healthy
[ "$(notes_count)" = "$NOTES_BEFORE" ] || fail "the notes count changed across the restore"
curl -fsS -c "$COOKIES" -H "origin: $BASE" -H 'content-type: application/json' \
  -d '{"email":"admin@demo.test","password":"demo-password-1"}' "$BASE/api/auth/sign-in" >/dev/null
curl -fsS -b "$COOKIES" -H "origin: $BASE" \
  -F "file=@$ROOT/apps/server/test/fixtures/files/tiny.png" "$BASE/api/files" | grep -q '"contentType":"image/png"' && echo "   UPLOAD-AFTER-RESTORE-OK" \
  || fail "upload after restore failed"
ok "restored ($NOTES_BEFORE notes kept); upload after restore works"

# ---- 7. The app dies: an alert, then Fixed.
STEP="step 7 (alert when the app dies)"
say "Step 7: stop the app and wait for the alert (up to 180 s), then start it and wait for Fixed"
MARK="$(alert_lines)"
dc stop app >/dev/null 2>&1
wait_alert 'Problem: The app is not answering.' 180 "$MARK" || fail "no 'The app is not answering.' alert within 180 s"
ok "alert received: Problem: The app is not answering."
dc start app >/dev/null 2>&1
wait_healthy
wait_alert 'Fixed: The app is not answering.' 240 "$MARK" || fail "no Fixed alert within 240 s"
ok "alert received: Fixed: The app is not answering. (now back to normal)."

# ---- 8. One good update (from a docker save file), one broken one that must undo itself.
STEP="step 8 (updates)"
say "Step 8: update to $V1 (from the image file), then to the broken $V2"
NOTES_BEFORE="$(notes_count)"
DOWN_BEFORE="$(grep -cF 'Problem: The app is not answering.' "$ALERTS" || true)"
set +e
OUT="$(dc run --rm -T updater update --to "$V1" --image-file "images-$V1.tar" 2>&1)"; CODE=$?
set -e
echo "$OUT" | tail -1 | sed 's/^/   /'
[ "$CODE" = 0 ] && echo "$OUT" | grep -qF "Updated from $V to $V1" || fail "update to $V1 (exit $CODE): $OUT"
set +e
OUT="$(dc run --rm -T updater update --to "$V2" 2>&1)"; CODE=$?
set -e
echo "$OUT" | tail -1 | sed 's/^/   /'
[ "$CODE" = 1 ] && echo "$OUT" | grep -qF 'undone automatically' || fail "broken update to $V2 (exit $CODE): $OUT"
grep -qx "APP_TAG=$V1" "$DIR/.env" || fail "APP_TAG is not $V1 after the rollback"
curl -fsS "$BASE/api/version" | grep -qF "\"app\":\"$V1\"" || fail "the app does not report $V1"
[ "$(notes_count)" = "$NOTES_BEFORE" ] || fail "the notes count changed across the updates"
DOWN_AFTER="$(grep -cF 'Problem: The app is not answering.' "$ALERTS" || true)"
[ "$DOWN_AFTER" = "$DOWN_BEFORE" ] || fail "an 'app is not answering' alert was sent during a planned update"
ok "updated to $V1; $V2 undone automatically; APP_TAG=$V1; $NOTES_BEFORE notes unchanged; no 'not answering' alert during the updates"

# ---- 9. The data still backs up and restores after the rollback.
STEP="step 9 (backup and restore test after the rollback)"
say "Step 9: ops backup and ops restore-test again"
OUT="$(ops_cli backup 2>&1)"; echo "$OUT" | tail -1 | sed 's/^/   /'
echo "$OUT" | grep -qF 'saved to rest:' || fail "backup after rollback: $OUT"
OUT="$(ops_cli restore-test 2>&1)"; echo "$OUT" | tail -1 | sed 's/^/   /'
echo "$OUT" | grep -qF 'Restore test passed' || fail "restore-test after rollback: $OUT"
ok "backup and restore test pass after the rollback"

# ---- Secrets never reach alerts or logs.
STEP="secrets check"
say "Secrets: none of the .env secrets appear in the alerts or the container logs"
LOGS="$(dc --profile tools logs --no-color 2>&1)"
for key in DB_PASSWORD HEALTH_TOKEN BACKUP_PASSWORD; do
  val="$(sed -n "s/^$key=//p" "$DIR/.env")"
  [ -n "$val" ] || continue
  if grep -qF "$val" "$ALERTS" || printf '%s' "$LOGS" | grep -qF "$val"; then fail "$key appears in the alerts or logs"; fi
done
ok "no secret found"

say "Alerts received during the run:"
node -e 'for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) console.log("   " + (JSON.parse(l).text ?? l))' "$ALERTS"
PASSED=true
