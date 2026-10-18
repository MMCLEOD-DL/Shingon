# Conductor — setup (Plan 1 foundation)

Conductor is a zero-dependency Node.js (≥ 20) library. No `npm install` needed for the library itself.

```
npm test        # runs the full node --test suite
```

## Bring-your-own-models config

Copy `config.example.json` to `config.json` and edit it to list your participants
(name, adapter, bin, model, roles). Adapters:

- `claude-code` — drives the `claude` CLI (Claude Code), subscription auth.
- `codex` — drives the `codex` CLI (Codex), ChatGPT-subscription auth.
- `local-agent` — the `codex` CLI pointed at your local model (LocalAI/ollama/LM Studio).

## Local agent: Codex → LocalAI provider

The `local-agent` adapter runs `codex` against a custom provider you declare in
`~/.codex/config.toml`. **It must use `wire_api = "responses"`** — codex 0.163
removed `wire_api = "chat"`, and LocalAI (v4.10.0+) serves `/v1/responses`.
This was proven empirically in build-spike #1 (`spikes/localai-codex/RESULT.md`);
the design spec's older `wire_api = "chat"` note is superseded by that result.

```toml
[model_providers.localai]
name     = "LocalAI"
base_url = "http://<host>:8081/v1"
wire_api = "responses"          # NOT "chat" — codex 0.163 rejects "chat"
env_key  = "LOCALAI_API_KEY"     # key supplied via env at run time, never stored here
```

Supply the key at run time via the `LOCALAI_API_KEY` environment variable; it is
never written to the config file or logged.

## Probe one participant end to end

```
node bin/conductor-probe.js --config config.json --participant claude --role reviewer --task "review this"
# add --json for the raw Result; exit 0 = ok, 1 = not ok, 2 = usage/arg error
```
