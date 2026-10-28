# Removes what an earlier crashed smoke may have left. Touches only the smoke's own named things (foundation v0.1.0 and v0.2.0):
# its alert catcher (the process "node deploy/smoke/catcher.mjs" started with HF_SMOKE_ALERT_LOG set, which listens
# on :8099), the Compose project hfsmoke, the containers hf-smoke-rest and hfsmoke-rest (v0.2.0 names it
# $PROJECT-rest, by default hfsmoke-rest), and under /tmp: hf-smoke, hf-smoke-cookies,
# hf-smoke-images-*.tar, hf-smoke-alerts.log and hf-smoke-catcher.out. Best effort.
# HF_SMOKE_TMP (never set on a machine, so /tmp) only lets the tests point the clean-up at a private folder.
SMOKE_TMP="${HF_SMOKE_TMP:-/tmp}"
if command -v pgrep >/dev/null 2>&1; then
  for pid in $(pgrep -x -f 'node deploy/smoke/catcher\.mjs' 2>/dev/null); do
    if tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -q '^HF_SMOKE_ALERT_LOG='; then kill "$pid" 2>/dev/null || true; fi
  done
fi
docker ps -aq --filter label=com.docker.compose.project=hfsmoke 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
docker volume ls -q --filter label=com.docker.compose.project=hfsmoke 2>/dev/null | xargs -r docker volume rm -f >/dev/null 2>&1 || true
docker network ls -q --filter label=com.docker.compose.project=hfsmoke 2>/dev/null | xargs -r docker network rm >/dev/null 2>&1 || true
docker rm -f hf-smoke-rest </dev/null >/dev/null 2>&1 || true
docker rm -f hfsmoke-rest </dev/null >/dev/null 2>&1 || true
rm -rf "$SMOKE_TMP/hf-smoke" "$SMOKE_TMP/hf-smoke-cookies" "$SMOKE_TMP"/hf-smoke-images-*.tar \
  "$SMOKE_TMP/hf-smoke-alerts.log" "$SMOKE_TMP/hf-smoke-catcher.out" || true
