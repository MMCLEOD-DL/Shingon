# Claude handoff: say what rejecting a step does (Part E2 note)

```
Packet/subpacket: Windows round 2 Part E2 note ("You stopped the run" after Reject, handoff 2026-11-19-1011)
Owner and reviewer: Claude; Codex invited to review (one service line is Codex-owned)
Status: IN_REVIEW
Baseline SHA: 3bf16c6 (origin/main, PR141 merge)
Result commit(s) / patch artifact: branch claude/reject-paused-wording
Owned files and shared seams changed:
  shared engine seam: src/chunkPhase.js (the reason returned when a step's escalation is rejected)
  Codex-owned service, named handoff below: src/service/runs.js (choices: the Reject consequence for a step escalation)
  tests: test/chunkPhase.test.js, test/service/server.test.js, test/fixtures/operator-app/fake-worker.cjs
Contract version: unchanged (same fields; one choice's consequence text differs by escalation kind)
```

## Decision

Malcolm chose this on 21 November 2026 ("Reword, keep pause"). The behaviour stays the same: rejecting a step's
escalation undoes that step, keeps earlier steps, and pauses the run so it can be resumed. Only the wording changes.
That choice is the recorded handoff for the one `runs.js` change; `conductor/src/service/` is on the risk-gate list,
so the PR waits for Malcolm.

## What now works

- **Finished line:** after Reject on a step escalation, the run's finished line says "You rejected step 2 (title).
  Its changes were undone and earlier steps are kept. Resume to try this step again." It used to say "You stopped
  the run at step 2 (title).". The CLI shows the same sentence.
- **Button note:** an `escalation` decision whose engine payload has `kind: 'chunk'` gets the Reject note "Undo this
  step and pause; you can resume later.". Other escalations (plan, council and others) keep "Do not proceed.".

## Checks (native Windows 11, Node v24.12.0)

- `node --test test/chunkPhase.test.js test/service/server.test.js` with the new assertions and the old code:
  **91 pass / 2 fail** (the new finished-line assertion and the step-escalation note).
- After the change, adding `test/service/engine.test.js`: **104/104 pass**.
- `conductor/operator-web`:
  - `npm test`: **113/113**.
  - `npm run build`: pass.
  - `node e2e/journey.mjs`: **22/22, 6/6, 4/4**.
- Full native suite: see the PR description. It is compared by test name with the item 7.1 run on `85c7154`.

## Live / fake / skipped / unrun

All synthetic. Not rechecked against a live E2 run.

## Open defects or unknowns

- The question's own text, built by `buildEscalation` in `src/escalation.js`, still ends "…or reject to stop the
  run.". That sentence covers every escalation kind and is left unchanged here.
- For a step escalation, the Approve note is still "Continue this step.". For a plan escalation it reads the same,
  which predates this change.
