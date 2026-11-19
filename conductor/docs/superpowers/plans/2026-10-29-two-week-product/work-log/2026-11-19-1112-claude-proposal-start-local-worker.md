# Claude proposal: start the local worker from the app (next.md item 7)

```
Packet/subpacket: P09 next-phase backlog, item 7 (from Malcolm's request during Windows acceptance Part E, 19 Nov 2026)
Owner and reviewer: Claude wrote the proposal. Codex is invited to review the service and contract parts. Malcolm decides scope.
Status: IN_REVIEW (proposal only; nothing built)
Baseline SHA: ec30725 (origin/main, 19 Nov 2026)
Result commit(s) / patch artifact: branch claude/eloquent-golick-5a8ff6
Owned files and shared seams changed: conductor/docs/operator-app/next.md (Claude-owned) and this entry. No code, no
  contract, no packet rows, no Codex-owned files.
Contract version: unchanged (the proposed interface.md changes are listed in next.md for Codex)
```

## What it proposes

`next.md` item 7. Show the local-model probe's reason (`worker-offline`, `unauthorized`, `model-missing`,
`unavailable`) on the local-down question. For `worker-offline` only, offer **Start the local worker**. That runs a
start command taken only from the on-disk config, after a `readyz` pre-check, then polls `readyz` and re-probes before
the run continues. A failure such as the script's "WSL forwarding configuration needs to be updated" is shown and not
worked around. Nothing ever chooses subscriptions automatically, and no key passes through the browser.

Decisions W1–W7 are listed in `next.md` for Malcolm. Ownership: Codex for the service action, config schema,
`interface.md` and fixtures; Claude for the UI and checklist wording.

## Evidence

- Read at `ec30725`: `src/adapters/localAgent.js` `probe()`, `src/team.js` `localDown`, `src/service/worker.js:61`,
  `src/service/runs.js` (decision construction and fallback choices), `src/chunkPhase.js` `localWentDown` and the
  mid-run `confirmLocalFallback`, `operator-web/src/views/RunView.jsx`, `docs/operator-app/interface.md`, and the
  real-run checklist steps 0 and 11.
- Read only, not run: `E:\SHINGON\desktop_worker\Start-LocalAI-Worker.ps1` on Malcolm's PC (no elevation, hidden WSL
  keeper, address check that throws the forwarding message, `docker compose up -d`).
- Source request: `work-log/2026-11-19-1011-claude-handoff-windows-acceptance-part-e.md` at commit `98cf402` (not yet
  on `main`).

## Live / fake / skipped / unrun

Documentation only. No tests run, no live calls, no `readyz` check, and the start script was not executed.

## Next action

Malcolm decides W1–W7. Then Codex claims the service and contract part, and Claude the UI part.
