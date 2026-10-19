# Loop smoke — result

**Status:** ✅ LANDED, but only through the frontier fallback. The local model did no work.

## Run
- **Date:** 2026-10-19
- **Outcome:** `landed`, branch `conductor/add-a-multiply-a-b-function-to-math-js-a`, one commit (`8303bef`)
- **Elapsed:** 84s
- **Chunks planned:** 1
- **Done by local / by frontier fallback:** 0 / 1. Claude wrote it, Codex reviewed it.
- **Escalations:** none

## Observations
- **Plan JSON:** parsed on the first try. Codex approved the plan in the first round.
- **Local model in the workspace:** no. All 3 local attempts failed within about 7–10s each. Codex started in the right workdir, with `workspace-write` and the localai provider. It then retried the stream 5 times and stopped with
  `stream disconnected before completion: response.failed event received`.
  - LocalAI is returning a failed Responses event. The tunnel and the key both worked, which rules out a connect or auth failure.
  - Build-spike #1 (2026-10-18) passed on the same path, so the cause is probably on the LocalAI/worker side: model not loaded on .109, a context or prompt-size limit, or a backend error. **Not yet diagnosed.**
- **Reviewer verdict lines:** present every time. There were 3 Codex APPROVEs: plan, chunk and final.
- **Fallback path:** worked as designed. The summary note correctly says that Claude did step 1 because the local model could not finish it.
- **Redaction:** no `[redacted]` markers appear in the transcript, and no key material showed up in the output.
- **Workspace:** kept, because the smoke sets `keepWorkspace: true`. It is at `~/.conductor/smoke-workspaces/conductor-ws-Tvmi5k` (+ `.conductor/`).

## Run 2 (2026-10-19, worker up)
- **Outcome:** `landed` again in 97s, but **through the fallback again** (commit `6ecbd6e`).
- **Cause of run 1:** the desktop worker had not been started.
- **What changed this time:** the local model did respond. On its first turn it made a real tool call: it listed the workspace and read `package.json`, `math.js` and `test.js`.
  - Codex then reported `tokens used 8,040`.
  - The next request, which carried the tool output, came back `response.failed`.
- **Likely cause:** the model is loaded with **n_ctx 8192**. Codex's own system prompt, plus tools, plus our task already fill the context in one turn, so the second turn overflows it. Spike #1 passed only because its whole job fit in roughly 7.6k tokens per turn.
  - Not yet confirmed in the LocalAI logs.
- **New finding:** the local Codex loads the operator's `~/.codex` MCP servers. A Netlify MCP server tried to authenticate on every attempt. Its tool definitions also eat into the 8k context, and an agent that should be sandboxed gets access to extra tools it was never meant to have.

## Follow-ups for Plan 3
1. ~~Raise the local model's context~~ **DONE 2026-10-19 (operator-approved):** CT110 `/models/shingon-qwen3.8-27b-q4.yaml` `context_size` 8192 → 32768. The previous YAML (sha 0f6e5a1a…) is backed up at `/opt/shingon-localai/model-yaml-backups/` (outside the models dir). After unloading and restarting the frontend, the log shows `context=32768` and 4.6 GB VRAM is still free on .109. The new YAML sha is 4a6d2c8e…, which supersedes the frozen OP06-era revision. Re-run the smoke.
1a. ~~Isolate the local Codex~~ **DONE:** each local call gets a private per-call `CODEX_HOME` (removed afterwards). It holds only the provider block (`base_url`, `wire_api`, `env_key`, plus `model_context_window`), configured with the new `baseUrl`/`contextWindow` participant fields. The frontier Codex keeps `~/.codex`.
2. **The retry prompt nests the whole previous error recursively.** The "Your previous attempt did not finish (...)" text embeds the full Codex stdout: banner, echoed prompt and the previous retry note. That made the prompt grow from about 2k to 6.7k chars after three attempts. Pass only a short failure reason, such as the last `ERROR:` line, capped at a few hundred chars.
3. **Adapter failure text is the raw Codex stdout.** When `ok:false`, `error` should be the stderr tail or the `ERROR:` lines, not the banner plus the prompt echo. The event log and the `chunk-fallback` reason are currently unreadable.
4. **Classify provider/stream failures as infrastructure.** Skip the remaining local retries and go straight to the frontier fallback. Retrying a dead backend just wastes about 20s and three Codex starts.
5. Carried over from spike #1: register model metadata for `shingon-qwen3.8-27b-q4` in the Codex provider config (it currently warns about fallback metadata), and install bubblewrap (the bundled copy is used for now).
