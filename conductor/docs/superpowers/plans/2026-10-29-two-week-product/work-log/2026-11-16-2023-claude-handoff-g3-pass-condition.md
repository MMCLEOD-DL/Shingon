# Claude handoff: G3, a pass condition for each plan step

```
Packet/subpacket: P09 next-phase item 6, task G3 (GD4). Follows work-log/2026-11-16-20*-claude-claim-g3-pass-condition.md.
Owner and reviewer: Claude; Codex reviews the four seam files.
Status: IN_REVIEW. Packet rows in 04-work-log.md unchanged; next.md G3 carries a "Done" note with the recorded deviation.
Baseline SHA: 57b623c (PR122 merge). Branch: claude/brave-ride-tz7f25. Code commit: f59b8cf.
Shared seams changed: conductor/src/plan.js (+28/-1: optional `check`/`files`, validation), conductor/src/planPhase.js (+15:
  exported `passConditionError`, applied after parsing before the reviewer), conductor/src/prompts.js (+18/-2: author shape and
  sentence, reviewer rule, `stepCondition` shown to worker and reviewer), conductor/src/chunkPhase.js (+19/-2: `runStepTests`;
  `chunk-tests-failed` gains `stage`). conductor.js, options.js, workspace.js, service: untouched.
Tests: test/step-check.test.js (new), test/plan.test.js, test/planPhase.test.js, test/prompts.test.js; fixture-only one-line changes
  (`check: 'none'` on fixture chunks) in test/conductor.test.js, test/cli-e2e.test.js, test/council-drive.test.js, test/knowledge-run.test.js.
Contract version: none. Plan JSON gained two optional fields; old plans parse and run exactly as before.
```

## What now works

- A plan step may carry `check` (a shell command; or `existing-suite`; or `none` for a step that changes no code) and
  `files` (1–50 relative paths). Malformed values are parse errors in the existing style.
- After parsing and before the reviewer, the plan is refused when a step has no `check` and the run has no test command:
  "step N has no pass condition: give it a check command, or mark it none if it changes no code". `existing-suite` with no
  test command is refused too. The refusal uses the existing "could not be used as a plan" retry path: no reviewer call,
  and the author gets the exact reason. `firstChunk` is exempt and authored steps keep the author's numbering.
- The gate runs a step's `check` command first. A failure blocks the attempt with "Step check `cmd` failed:" and the
  output, and the suite is not run; a pass runs the suite as today, or stands as the step's evidence when there is no suite.
  Results keep `{ ran, passed, code, output }` plus `stage: 'check' | 'tests'`.
- Worker and reviewer prompts show "This chunk must pass: `cmd`" and "Files you are expected to touch: …" when present.

**Behaviour change to note:** a run with no test command now needs every planned step to carry a `check` (or `none`),
so the plan author must emit the field. The author prompt says so and the retry feedback is exact; a plan that never
complies fails after `planRounds`. Runs with a configured test command are unaffected unless the author writes a check.

**Deviation from next.md's wording, for Codex and Malcolm:** the run-wide `testCommand` is taken as the explicit
"existing suite passes" condition for every step that gives no `check`. Requiring `"check": "existing-suite"` on every
step would add boilerplate for the planner and churn every fixture while telling the engine nothing it does not know.

## Checks (cloud Linux, Node 22.23.4, from `conductor/`)

- Test-first: new tests in plan (3), planPhase (3), prompts (3) and step-check (6, one added after review) shown failing
  before the source change; after the rule, 11 existing planPhase tests failed on fixtures until `check: 'none'` was
  added to the fixture plan.
- Focused: 14 files, **260 pass, 0 fail**.
- **Full Conductor suite** `node --test --test-concurrency=4`: 1704 tests, 1699 pass, 4 skipped, 1 fail. The one failure,
  `test/localAgent.test.js` "runs codex with a private CODEX_HOME holding generated config", was the orchestrator's
  environment (`XDG_CACHE_HOME` placed under /tmp, which that test forbids; 05-validation.md warns of this). It fails
  identically on main with that setting and passes 14/14 with the cache outside /tmp. Not related to G3.
- Acceptance "G3, plan check": chunk 3 without `check`, no test command: refused, author's second call carries "step 3 has
  no pass condition", reviewer calls 0. "G3, old plans": chunks with neither field, test command configured: parse and run
  as before (existing suites).

## Live / fake / skipped / unrun

Fake participants and stubbed test runs. Not run: a live planning run (to see whether real authors emit `check` first
time), native Windows.

## Open defects or unknowns

- Whether the local or frontier planners emit `check` reliably on the first round is untested live; the retry path covers
  a miss. Worth watching in Malcolm's next live run with `conductor report`.

## External blocker and exact owner/action

None. Not a high-risk path; needs Malcolm's merge (auto-merge is off). Codex review invited at f59b8cf.

## Next packet unblocked

G4 (staged gate commands and the scope flag), per GD4.
