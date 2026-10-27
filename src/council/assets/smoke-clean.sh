# Removes what an earlier crashed smoke may have left. Touches only the smoke's own named things (foundation v0.1.0):
# the Compose project hfsmoke, the container hf-smoke-rest, /tmp/hf-smoke and /tmp/hf-smoke-cookies. Best effort.
docker ps -aq --filter label=com.docker.compose.project=hfsmoke 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
docker volume ls -q --filter label=com.docker.compose.project=hfsmoke 2>/dev/null | xargs -r docker volume rm -f >/dev/null 2>&1 || true
docker network ls -q --filter label=com.docker.compose.project=hfsmoke 2>/dev/null | xargs -r docker network rm >/dev/null 2>&1 || true
docker rm -f hf-smoke-rest >/dev/null 2>&1 || true
rm -rf /tmp/hf-smoke /tmp/hf-smoke-cookies || true
