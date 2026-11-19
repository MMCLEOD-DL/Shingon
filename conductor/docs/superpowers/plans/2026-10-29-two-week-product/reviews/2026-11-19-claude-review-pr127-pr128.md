# Claude review: PR127 (preparation-failure cleanup) and PR128/PR129 (step gate service events)

- **Reviewed after merge.** All three PRs were merged on 19 November 2026 before this review:
  - [PR127](https://github.com/MMCLEOD-DL/Shingon/pull/127), code head `436e8b9`, branch `codex/preparation-failure-cleanup`.
  - [PR128](https://github.com/MMCLEOD-DL/Shingon/pull/128), code head `80b90be`, branch `codex/step-gate-service-events`.
  - [PR129](https://github.com/MMCLEOD-DL/Shingon/pull/129), documentation only.
  - Reviewed on `main` at `85bfe0f`. Requested in `work-log/2026-11-19-0934-codex-submitted-preparation-failure-cleanup.md` and
    `work-log/2026-11-19-0955-codex-handoff-step-gate-events-validation.md`.
- **Scope:**
  - `conductor/src/{conductor,cli/main,cli/prepareRun,service/runs}.js`;
  - the fake worker fixture;
  - the matching tests;
  - the G4 paragraph in `docs/operator-app/interface.md`.
- **Disposition: no blocking defect in either code change.** One finding is medium (R1). It concerns the evidence, not the
  code. Three notes are low (N1–N3).

## Reproduced (cloud Linux, Node 22, synthetic participants only)

| Check | Result |
|---|---|
| PR127 focused set: `node --test --test-name-pattern='preparation\|baseline\|missing test executable' test/conductor.test.js test/cli-e2e.test.js test/service/engine.test.js` | **15 pass / 0 fail**, matching Codex's native count |
| Control: `conductor.js` reverted to `finish(status, details)` (no unused-preparation cleanup), same command | **9 pass / 6 fail**: tests 3, 4, 7, 8, 9 and 15 fail. The new tests catch the regression. Revert undone. |
| PR128: `node --test test/step-gate.test.js test/service/server.test.js` | **43 pass / 0 fail** |

Not run:
- the full Conductor suite (CI ran it: 1,725 pass, 0 fail, 3 skip at `80b90be`);
- native Windows;
- live models.

## Source review: what holds

### PR127

- The clone is deleted only when `!state.plan`, so there is no model work to lose.
- A resume whose preparation fails after a plan exists keeps the clone.
- `keepWorkspace` is honoured, including the new CLI flag.
- The Ctrl-C path during preparation calls `exit()` directly. It still keeps the workspace, which matches its
  "run conductor resume" message.
- The refusal messages that now become `outcome.reason` say "run the same command again", never "resume". That is
  consistent with the clone being gone.
- `couldNotCheck` passes a reason through `redact`, and the service applies `scrub` to every event message.
- In the service, `workspaceDir === null` is set only by the engine's archive path:
  - for landed or rejected runs, which were never resumable;
  - for unused preparation.

  `recoveryRequired` excludes landed and rejected runs, and a landing cannot be pending before a plan exists. So clearing
  the path cannot hide a needed recovery.

### PR128

- The three event shapes are selected field by field. Unselected worker fields (`raw`, `detail`) are dropped before they
  are saved.
- Strings are redacted before clipping, and the fixture puts a secret across the 3,000-character excerpt boundary.
- List limits: at most 100 entries, 512 characters each, 8,000 in total. Counts and `truncated` are set correctly,
  including when the total budget runs out part-way through.
- The early `return` skips the generic projection. Coverage depends only on `result` events, and `same-vendor-review`
  is a different event type, so no coverage or weakening rule changes.

## Findings

### R1 (medium): the native Windows suite has 201 failures carried as a count, not explained

- **Where:**
  - `work-log/2026-11-19-0955-codex-handoff-step-gate-events-validation.md`: "1,526 pass / 201 fail / 1 skip …
    matches the prior recorded 201 … failures have not all been reclassified";
  - PR127's submission: 1,524 pass / 202 fail.
- **Trigger:** every native full-suite run reported as evidence for P07/P08.
- **Consequence:**
  - Native Windows is the acceptance host Malcolm chose on 29 October. A stable failure count is not a passing suite.
  - With 201 unexplained failures, a new Windows regression in the same files cannot be told apart from the old ones.
    PR127's own fixture fault showed up only as 201 becoming 202.
  - "Matches the prior count" is starting to work as an accepted baseline without anyone having decided that.
- **Ask:**
  1. Classify the failures from the private logs Codex names, by file and cause:
     - tests that assume POSIX (paths, signals, shell quoting, file modes);
     - real Windows defects;
     - environment problems.
  2. Record the list in the repository: names and causes, no private paths.
  3. Then either fix each one, or skip it on Windows with a reason and an owner. Windows-only skips need Malcolm's
     agreement: under the evidence rules a skip is not a pass.

  Until then, P07/P08 should not move towards DONE on native evidence. If Malcolm agrees, Claude can take the
  classification.

### N1 (low): PR128 merged before its own native validation finished

- **Where:** PR129's handoff: "PR128 merged while validation was running".
- **Consequence:**
  - The required Linux checks were green, so the merge was legitimate, and the validation passed afterwards.
  - For a service-path PR, though, the native evidence arrived after approval. Malcolm approved without it.
- **Ask:** for a high-risk PR, put the native result in the submission before asking for Malcolm's merge, or say
  plainly in the PR body that it is still running.

### N2 (low): Resume of a no-plan run whose preparation fails now ends the run

- **Behaviour change (intended):**
  - A run is interrupted after its baseline tests but before planning.
  - It is resumed while the local model is down, and the operator declines the fallback.
  - The run is now archived and loses its Resume option. Before PR127 it kept the clone.
- **Consequence:** small. No model work is lost; only the baseline test run is repeated on the next start. The finished
  message tells the operator to start again.
- **Ask:** none for the code. The interface note says nothing about it, so add one line to `docs/operator-app/interface.md`
  next to the G4 paragraph: unused preparation is archived and `workspaceDir` becomes `null`. Then UI and history
  consumers don't have to read the code to find out.

### N3 (low, Claude's action): G4 fields reach the UI but are not rendered

- The service now sets `run.phase` to `gate`, `scope-flag` or `protected-path`.
- The UI doesn't read `phase` today, so nothing breaks.
- Richer rendering of `attempt`/`of`, `failedStage`, `excerpt` and the file lists is Claude-owned and not started. It
  is the next Claude follow-up on G4.

## Not reviewed

- PR127's and PR128's native runs, which were reported by Codex and not reproduced here.
- The Windows-only behaviour of either change.
