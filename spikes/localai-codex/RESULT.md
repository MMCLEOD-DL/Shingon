# Build-spike #1 — Codex-on-LocalAI agentic execution

- **Date:** 2026-10-18
- **Model:** shingon-qwen3.8-27b-q4 (LocalAI on CT110, GPU worker .109)
- **Serving path:** LocalAI `/v1/responses` (Responses API)
- **Result:** ✅ **PASS** — the local model drove Codex's agentic protocol end to end.

## What happened
`codex exit: 0`, `FILE_CREATED: yes`, `contents: online`. The model issued a real
tool call — `/bin/bash -lc "printf 'online' > hello.txt && cat ..."` — the
workspace-write sandbox executed it (succeeded in 0ms), and codex returned a clean
final message. Tokens used: ~15,210.

## Working invocation
Run on CT102 (codex is NOT installed on CT110) via an SSH tunnel to CT110 loopback,
sourcing the frontend key from CT110's .env (never printed). Wrapper:
`/root/shingon-op06/run-spike-tunnel.sh` (also copied here as run-spike-tunnel.sh).
```
ssh -f -N -L 127.0.0.1:8091:127.0.0.1:8081 root@192.168.1.110
export LOCALAI_API_KEY=<from CT110 /opt/shingon-localai/.env>
codex exec -c model_provider=localai -c model=shingon-qwen3.8-27b-q4 \
  -c model_providers.localai.base_url=http://127.0.0.1:8091/v1 \
  --sandbox workspace-write --skip-git-repo-check "<prompt>"
```

## Provider config (~/.codex/config.toml on CT102)
```toml
[model_providers.localai]
base_url = "http://192.168.1.110:8081/v1"
wire_api = "responses"   # codex 0.163 DROPPED wire_api="chat"; LocalAI implements /v1/responses
env_key  = "LOCALAI_API_KEY"
```

## Quirks / findings (for Plan 1 Task 9 + Plan 2)
1. **codex 0.163 requires `wire_api = "responses"`** — `"chat"` is rejected outright
   ("no longer supported"). LocalAI v4.10.0 implements `/v1/responses`, so this works.
   LocalAgentAdapter (Task 9) must emit `wire_api=responses`, not `chat` as the spec draft said.
2. **Model metadata warning:** codex has no metadata for `shingon-qwen3.8-27b-q4` →
   fallback metadata ("can degrade performance"). Consider registering model metadata
   (context window etc.) in the provider config for reliability.
3. **bubblewrap not on PATH** → codex used its bundled bubblewrap; sandbox still worked.
4. Reasoning model emits empty text at tiny token budgets (CoT eats them); irrelevant
   under codex's full agentic budget, but relevant if we ever cap local output tightly.
5. **Execution location:** codex absent on CT110; run on CT102 via SSH tunnel (no host install).
   CT102→CT110:8081 is firewall-segmented, hence the tunnel.
