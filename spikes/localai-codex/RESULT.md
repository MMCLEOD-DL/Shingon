# Build-spike #1 — Codex-on-LocalAI agentic execution

- **Date:** (pending run)
- **Model:** shingon-qwen3.8-27b-q4
- **Serving path:** LocalAI (fallback: ollama/lmstudio if LocalAI fails)
- **Result:** PENDING — operator to run `run-spike.sh` with the worker up.

## Working invocation (fill after run)
```
codex exec -c model_provider=localai -c model=<model> --sandbox workspace-write --skip-git-repo-check "<prompt>"
```

## Observations
(record FILE_CREATED, contents, diff lines, codex exit, and any tool-protocol quirks)
