# Claude review: PR71, failed tests block a step before rival review (F8)

- **Reviewed:** [PR71](https://github.com/MMCLEOD-DL/Shingon/pull/71), merged as `2fac5a3`. Engine change at `3d3d4f1`, CI redaction-fixture correction at `df8ffb3`. Requested in Codex's submissions `work-log/2026-11-01-1353-…` and `…-1407-…` ("independent reviewer Claude pending"). This is a post-merge review.
- **Scope:** `conductor/src/{chunkPhase,review,prompts,deadlock,escalation}.js`, `test/failed-tests-block-step.test.js`, `test/chunkPhase.test.js`, `docs/operator-app/setup.md`.
- **Disposition:** the change does what F8 asked, and it fails closed. One **medium** finding (R1) on behaviour F8 did not consider. F8 was Claude's proposal (task 36), so the gap is partly in the proposal itself. R1 needs a policy decision from Malcolm before Codex changes the engine. Nothing here is a safety regression.

## What holds (verified)

- An executed failing test run is a BLOCK before any rival call. The same producer gets the redacted test output (`runTests` redacts before clipping) and retries within `localRounds`, then the frontier author retries within `frontierRounds`. After that the existing escalation offers a "Reject: the tests do not pass." recommendation, and an approval there is recorded as the operator's override, not as an automatic approval.
- No configured tests (`ran: false`) still go to rival review. Passing attempts still go to rival review.
- The local-fallback consent question is asked only when the local model is down (`localWentDown`), not because tests failed. That is correct: a local model that is up but produces failing code does not need consent to use the frontier author.
- `lastGood` now includes attempts whose tests failed, but `chunkPhase` never reads it (only `planPhase` and `factory/split` do), so this has no effect.
- On main at `4c8b2fb` (unchanged in `conductor/src` since; cloud Linux, Node 22.23.4): `node --test --test-concurrency=4 test/failed-tests-block-step.test.js test/review.test.js test/deadlock.test.js test/prompts.test.js test/escalation.test.js test/keyleak.test.js test/chunkPhase.test.js` gives 120 pass, 0 fail, 0 skip.

## R1 (medium): tests that already fail before the run turn every step into maximum spend plus an escalation

- **Trigger:** a repository whose configured test command already fails before Conductor changes anything (a broken or flaky test unrelated to the request, or a test command that does not work on this host). The same happens after the operator deliberately approves one step over failing tests: the failure is committed, and every later step inherits it.
- **Cause:** the engine never runs the tests on the base commit, so it cannot tell new failures from old ones. After F8, any `tests.ran && !tests.passed` blocks, whoever caused it.
- **Consequence:** every step uses all its local rounds and all its **subscription** author rounds (default 3 + 2). The producers are told to "fix the failing tests" that they did not break. Then the step stops for an operator escalation. An N-step plan asks N such questions and makes up to 2N extra subscription coding calls. Producers pushed to make unrelated tests pass may also edit those tests; rival review only sees the step once its tests pass.
- **Reproduction:** [`fixtures/pr71-baseline-failing-tests.mjs`](fixtures/pr71-baseline-failing-tests.mjs) runs one ordinary step with a real Git workspace and a real failing test command (`node broken.cjs`, which fails whatever the edit). Participants are synthetic, with `localRounds: 2, frontierRounds: 2`, and the reviewer accepts the unrelated failure.

  | Conductor tree | status | local calls | subscription author calls | rival review calls | operator questions |
  |---|---|---|---|---|---|
  | `2fac5a3^1` (before F8) | `done` | 1 | 0 | 1 | none |
  | `main` (after F8) | `stopped` | 2 | 2 | 0 | `escalate` |

  Before F8 the step finished only because the reviewer accepted the failure. That is the loophole F8 rightly closed for new failures. The finding is about pre-existing failures, which F8 cannot tell apart.
- **Proposed correction (needs Malcolm's decision; Codex owns the engine):** run the test command once on the base commit when the run starts, and record the result. If it already fails, ask the operator before any work starts:
  1. **stop**: fix the tests first (recommended);
  2. **continue**: in that case the step gate compares against the baseline rather than requiring a pass. Matching on the exit code alone is weak; a per-test comparison needs a test-output format.

  Option 1 alone is small and closes the spend problem. Either way, an override at one step should not make every later step burn its full budget.
- **Malcolm's decision (5 November 2026): option 1, stop.** The run checks the tests once on the base commit and stops before any work if they already fail; option 2 is not taken. Recorded in `work-log/2026-11-05-1930-claude-pr71-r1-decision.md`, with what Codex's change should show.
- **Not a defect in the code as written.** The PR implements F8 exactly as proposed. This is a policy gap; recording it here rather than as a bug in Codex's work.

## Notes (low)

- **N1:** the producer's retry prompt says "Your previous attempt's tests failed before review", even when its edit did not cause the failure. That text is accurate once R1's baseline check exists.
- **N2:** a test command that cannot start (for example `npm` not on PATH on native Windows) is `ran: true, passed: false`. Under F8 it is handled like R1, and producers are asked to fix an environment problem. The baseline check in R1 would catch this at start too.

## Not verified here

Native Windows (Codex's evidence: 66 + 54 native checks). Live models. The full Conductor suite was not re-run for this review; CI runs it on each PR.
