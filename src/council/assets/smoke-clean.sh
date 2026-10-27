# Removes what an earlier crashed smoke may have left. Touches only the smoke's own named things (foundation v0.1.0):
# the Compose project hfsmoke, the container hf-smoke-rest, /tmp/hf-smoke and /tmp/hf-smoke-cookies. Best effort.
# HF_SMOKE_TMP (never set on a machine, so /tmp) only lets the tests point the clean-up at a private folder.
SMOKE_TMP="${HF_SMOKE_TMP:-/tmp}"
docker ps -aq --filter label=com.docker.compose.project=hfsmoke 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
docker volume ls -q --filter label=com.docker.compose.project=hfsmoke 2>/dev/null | xargs -r docker volume rm -f >/dev/null 2>&1 || true
docker network ls -q --filter label=com.docker.compose.project=hfsmoke 2>/dev/null | xargs -r docker network rm >/dev/null 2>&1 || true
docker rm -f hf-smoke-rest </dev/null >/dev/null 2>&1 || true
rm -rf "$SMOKE_TMP/hf-smoke" "$SMOKE_TMP/hf-smoke-cookies" || true
