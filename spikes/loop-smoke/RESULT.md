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

## Follow-ups for Plan 3
1. **Fix the local backend first.** Find out why LocalAI sends `response.failed` (check the LocalAI logs on CT110 and the worker status on .109), then re-run the smoke. That rerun is the one that actually proves local execution.
2. **The retry prompt nests the whole previous error recursively.** The "Your previous attempt did not finish (...)" text embeds the full Codex stdout: banner, echoed prompt and the previous retry note. That made the prompt grow from about 2k to 6.7k chars after three attempts. Pass only a short failure reason, such as the last `ERROR:` line, capped at a few hundred chars.
3. **Adapter failure text is the raw Codex stdout.** When `ok:false`, `error` should be the stderr tail or the `ERROR:` lines, not the banner plus the prompt echo. The event log and the `chunk-fallback` reason are currently unreadable.
4. **Classify provider/stream failures as infrastructure.** Skip the remaining local retries and go straight to the frontier fallback. Retrying a dead backend just wastes about 20s and three Codex starts.
5. Carried over from spike #1: register model metadata for `shingon-qwen3.8-27b-q4` in the Codex provider config (it currently warns about fallback metadata), and install bubblewrap (the bundled copy is used for now).
