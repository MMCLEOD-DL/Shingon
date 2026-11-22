# Claude handoff: the Start-the-local-worker page (next.md item 7, operator UI)

```
Packet/subpacket: P09 next.md item 7, proposals 2–6, operator page
Owner and reviewer: Claude; Codex invited to review
Status: IN_REVIEW
Baseline SHA: 142c002 (origin/main, PR162 merge)
Result commit(s) / patch artifact: branch claude/start-worker-ui
Owned files and shared seams changed:
  operator-web: src/views/RunView.jsx, src/views/Setup.jsx, src/text.js, src/styles.css,
    tests/views.spec.jsx, tests/text.spec.js, tests/fakeService.js, e2e/journey.mjs
  shared seams: none. No change to conductor/src, the service, the contract or its fixtures.
Contract version: v1, as extended by PR162 (unchanged here)
```

## What now works

- **Offering Start:** a pre-run fallback that offers `start-worker` shows "Start the local worker" under the existing
  reason sentence ("…its GPU worker is not connected"). An `unauthorized` reason, or a missing start command, shows
  no Start button. Those come straight from the service's choices.
- **While a start runs** (`workerStart.state` is `starting`, `waiting` or `ready`), the question shows the service's
  sentence and offers no answer. The service refuses one anyway (`worker-start-in-progress`). The page explains:
  "The first load onto the graphics card can take a minute or two. Stopping the run stops the wait. It does not stop
  the worker." Stop run stays available. The "Answer saved" note is not shown, because the question is still open.
- **A failed start** shows the fixed prompt once, and "Last lines from the start command:" with the scrubbed output
  (at most 600 characters, wrapped). It offers Pause and Use subscriptions only. The changed prompt has
  `role="alert"` for a failed or timed-out start, so screen readers announce it. Worker text is shown literally:
  markup does not render, and terminal controls are stripped.
- **A timeout** shows "The worker did not become ready within 3 minutes." and offers Try again. Try again sends
  `start-worker` with the new revision and a new request id.
- **A second answer during a start** shows the service's "The worker start is already in progress."
- **A fix the feature needed:** the page re-read the run only after non-progress events. A failed or timed-out start
  changes the question (prompt, revision and choices) and sends only a `local-worker-failed` progress event. So an
  open page would have kept saying "Starting…". The page now also re-reads after any `local-worker-*` progress event.
- **Activity log:** the service's resolution after a started worker ("Worker started; re-probing the local model.")
  reads "The local worker is ready. Checking the local model again.", instead of "You chose: …". The service sends
  the same line when the worker was already up and no command ran. So the line claims only that the worker is ready,
  and the line before it says which case it was ("The worker is already up but busy; …" or "Worker ready, …").
- **Setup page:** one read-only line says whether a start command is configured, and that it is set in the config
  file (`local.worker`). Saving still sends only `local.baseUrl` and `local.model`.

## Checks (native Windows 11, Node v24.12.0), from `conductor/operator-web`

- **`npm test`:**
  - Before the implementation, with the new tests: **7 fail / 118 pass**. The five that already passed are the
    no-button, Try-again and refusal cases, which the existing generic choice buttons already handled.
  - After: **126/126 pass**, 4 files (113 before this branch). The final count includes the alert, hostile-text
    and Stop-offered checks added after review.
- **`npm run build`:** pass.
- **`NODE_PATH="$(npm root -g)" node e2e/journey.mjs`:** **27/27, 6/6, 4/4**. There are five new journey steps,
  against the real service with synthetic start commands and readiness URLs served by the journey.
  - **Success:** Start runs the command exactly once and waits for readiness. The fixture worker's healthy re-probe
    pauses the run, with no subscription choice. The setup page says a command is configured and never shows its
    path or the readiness URL.
  - **Failure:** the command prints the WSL forwarding line and exits 1. The open page, with no reload, shows the
    failure and the output, and offers no Start or Try again. Pause then pauses the run.
  - **Already up:** readiness answers 200 from the outset. The command never runs, there is no "Waiting" line, and
    the log says the worker was up but busy.
  - **Timeout, then Try again:** `startTimeoutMs` is 3000, and readiness answers only after a second start. The page
    shows "…within 3 seconds." and Try again. The second start runs the command again (2 runs in total). The run
    then carries on, and nothing chose subscriptions.
  - **Re-probe refused:** `synthetic worker reprobe unauthorized`. After a successful start, the question comes back
    saying the key was refused, with no Start button. Pause pauses the run.
- **Mutation:** I removed only the re-read after `local-worker-*` events, rebuilt and reran.
  - Unit: the progress-only test fails (**1 fail / 86 pass** in `views.spec.jsx`).
  - Journey: the failure step fails (**23/24**).
  - The fix was then restored and rebuilt.
- The Conductor suite was not rerun: nothing outside `operator-web` changed.

## Live / fake / skipped / unrun

- Everything here is synthetic: the fake service in unit tests, and the real service with the fixture worker, a
  Node start command and a local readiness server in the journey.
- **Unrun:** the live start on Malcolm's PC. To run it, stop the GPU worker, configure the real
  `Start-LocalAI-Worker.ps1` command, start a run and press Start. The 3-minute default timeout was not waited out;
  the journey uses a 3-second config.
- Linux CI is unrun until the PR's checks report.

## Open defects or unknowns

None found. A live run should also be recorded for Part F's UAC and console table, as `next.md` item 7 says.

## External blocker and exact owner/action

Malcolm: the live check on his PC, when convenient. This change touches no high-risk path.

## Next packet unblocked

None. Item 7 is complete in code, apart from the live check.
