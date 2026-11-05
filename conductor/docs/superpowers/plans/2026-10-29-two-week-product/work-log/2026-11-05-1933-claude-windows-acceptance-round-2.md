# Claude: Windows acceptance round 2, the runbook for what is still open

```
Packet/subpacket: P07/P08 (Codex coordinates; Claude reviews). Proposal requested by Malcolm on 5 November 2026
  ("yes, start the runbook").
Owner and reviewer: Claude wrote it; Codex coordinates the session and records the results.
Status: IN_REVIEW (proposal). Nothing in it has been run.
Baseline SHA: 6f636ac.
Files: conductor/docs/operator-app/windows-acceptance-round-2.md (new); one pointer line in real-run-checklist.md.
  No code, test, service or workflow change.
```

## What it covers

Only the items left open by the 31 October run, the 5 November native retest and the UAC follow-up, each with its
source:

- **A.** The browser journeys and the native engine checks on Windows, with no models.
- **C.** One task in the browser with real models: the review page with test output, reload, two tabs, and an
  offline answer then a retry.
- **D.** An abrupt service kill (`taskkill /F` without `/T`) while a model works and while a question is pending. The
  main thing to observe is which processes survive their service. Optionally, a Windows restart mid-task.
- **E.** Live failing tests: a failing baseline and a step that breaks a test.
- **F.** UAC prompts and console flashes in a new folder, after a service restart and after a reboot.

## Dependencies and limits

- Part E waits for Codex's start-of-run test check (PR71 R1, `work-log/2026-11-05-1930-claude-pr71-r1-decision.md`).
- It caps spend with `"localRounds": 1, "frontierRounds": 1` in the config's `options`. The worker passes the config's
  options to the engine (`src/service/worker.js:69`), but this has not been tried through the app. The runbook says to
  remove them and note the message if the app refuses them.
- The case where the service acted but its reply was lost cannot be produced by hand. Part A's journeys cover it with
  stand-ins, so it is not claimed as live.
- A real power cut is not tested. A Windows restart is gentler.

## Checks

None run: the change is documentation only. The commands come from `05-validation.md`, `.github/workflows/ci.yml`
(Playwright 1.63.0) and the first-run checklist. These were checked against the code at `6f636ac`:
- the launcher's port-in-use message (`bin/conductor-app.js`);
- the run page address `/runs/<id>` (`operator-web/src/App.jsx`);
- the escalation title "The models disagree: your call" (`RunView.jsx`).

None of it has been run on Windows.

## Next

Codex reviews the runbook and adjusts it for anything it knows about the host. Malcolm schedules the session. Results
go into a dated report beside `windows-retest-2026-11-05.md`, with live, synthetic and not-run results kept apart.
