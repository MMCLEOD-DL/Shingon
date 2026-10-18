#!/usr/bin/env bash
# Build-spike #1 runner (operator-run via `!`).
# Tunnels CT102:8091 -> CT110 loopback 8081, sources the LocalAI frontend key
# from CT110's .env into an env var (never printed), runs codex against the
# local model, reports PASS/FAIL, tears the tunnel down. No key touches the log.
set -u
MODEL="${LOCALAI_MODEL:-shingon-qwen3.8-27b-q4}"
LPORT=8091

cleanup() { pkill -f "${LPORT}:127.0.0.1:8081" 2>/dev/null; }
cleanup; sleep 1

echo "== tunnel =="
ssh -f -N -o ExitOnForwardFailure=yes -o ConnectTimeout=6 \
    -L 127.0.0.1:${LPORT}:127.0.0.1:8081 root@192.168.1.110 \
    && echo "tunnel up (127.0.0.1:${LPORT} -> CT110:8081)" || { echo "TUNNEL FAILED"; exit 1; }

export LOCALAI_API_KEY="$(ssh -o ConnectTimeout=6 root@192.168.1.110 \
    'grep -E "^LOCALAI_API_KEY=" /opt/shingon-localai/.env | cut -d= -f2-')"
[ -n "${LOCALAI_API_KEY:-}" ] && echo "key loaded (len=${#LOCALAI_API_KEY})" || { echo "NO KEY"; cleanup; exit 1; }

echo "models via tunnel: $(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $LOCALAI_API_KEY" http://127.0.0.1:${LPORT}/v1/models)"

WORK="$(mktemp -d)"; cd "$WORK" || { cleanup; exit 2; }
git init -q && git config user.email spike@local && git config user.name spike
git commit -q --allow-empty -m init

echo "== codex exec (local model via tunnel; may take a minute) =="
codex exec -c model_provider=localai -c "model=$MODEL" \
    -c "model_providers.localai.base_url=http://127.0.0.1:${LPORT}/v1" \
    --sandbox workspace-write --skip-git-repo-check \
    "Create a file named hello.txt whose only contents are the word: online. Then stop." 2>codex.err
rc=$?

echo "== RESULT =="
echo "codex exit: $rc"
[ -f hello.txt ] && { echo "FILE_CREATED: yes"; echo "contents: $(cat hello.txt)"; } || echo "FILE_CREATED: no"
echo "diff lines: $(git status --porcelain | wc -l)"
echo "--- codex.err tail ---"; tail -25 codex.err
echo "workdir: $WORK"
cleanup && echo "tunnel closed"
