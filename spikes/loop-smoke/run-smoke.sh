#!/usr/bin/env bash
# Plan 2 loop smoke (operator-run via `!`). Tunnel + key handling as in
# spikes/localai-codex/run-spike-tunnel.sh: the LocalAI key lives only in an
# env var for this process — never printed, never written to the temp config.
set -u
cd "$(dirname "$0")/../.." || exit 2
LPORT=8091

cleanup() { pkill -f "${LPORT}:127.0.0.1:8081" 2>/dev/null; }
cleanup; sleep 1

echo "== tunnel =="
ssh -f -N -o ExitOnForwardFailure=yes -o ConnectTimeout=6 \
    -L 127.0.0.1:${LPORT}:127.0.0.1:8081 root@192.168.1.110 \
    && echo "tunnel up (127.0.0.1:${LPORT} -> CT110:8081)" || { echo "TUNNEL FAILED"; exit 1; }

export LOCALAI_API_KEY="$(ssh -o ConnectTimeout=6 root@192.168.1.110 \
    'grep -E "^LOCALAI_API_KEY=" /opt/shingon-localai/.env | cut -d= -f2-')"
[ -n "${LOCALAI_API_KEY:-}" ] && echo "key loaded" || { echo "NO KEY"; cleanup; exit 1; }

CFG="$(mktemp --suffix=.json)"
node -e '
  const fs = require("fs");
  const [src, dst, url] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(src, "utf8"));
  for (const p of c.participants) {
    if (p.adapter === "local-agent") p.extraConfig = [...(p.extraConfig || []), `model_providers.localai.base_url=${url}`];
  }
  fs.writeFileSync(dst, JSON.stringify(c, null, 2));
' config.example.json "$CFG" "http://127.0.0.1:${LPORT}/v1"

echo "== conductor loop smoke (several minutes) =="
node spikes/loop-smoke/smoke.js "$CFG"
rc=$?

rm -f "$CFG"
cleanup && echo "tunnel closed"
echo "smoke exit: $rc"
exit $rc
