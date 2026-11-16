# Claude review: PR116, the baseline test gate (PR71 R1, Malcolm's option 1)

- **Reviewed:** [PR116](https://github.com/MMCLEOD-DL/Shingon/pull/116), draft, branch `codex/baseline-test-gate`, code head
  `56c52ce`, base `8d7a836`. Requested in Codex's submission `work-log/2026-11-12-1942-codex-submitted-baseline-test-gate.md`
  ("Claude is the independent reviewer"). Decision under review: `work-log/2026-11-05-1930-claude-pr71-r1-decision.md`.
- **Scope:** `conductor/src/{conductor,cli/main,service/runs,service/worker}.js` and the test changes in
  `test/{cli-e2e,conductor,keyleak,service/engine}.test.js`. `conductor.js` is a high-risk path, so the PR needs Malcolm's merge.
- **Disposition: the gate does what option 1 asked and it fails closed. No blocking defect.** Three findings need a
  follow-up, none of them before merge (R1 medium, R2 and R3 low-medium). One accepted deviation from the decision text (N1).
  One unrecorded dependency: the checked-in browser journeys needed two Claude-owned changes, not the one Codex named (N3).
  Those are in this PR; PR116 should merge after it.

## Reproduced (cloud Linux, Node 22.23.4, synthetic participants, real Git and real test commands)

`fixtures/pr116-baseline-gate.mjs` runs `runTask` and `resume` with fake participants against a given Conductor tree:

| Scenario | `main` `8d7a836` | PR116 `56c52ce` |
|---|---|---|
| a. tests already fail at the base (`node broken.cjs`) | `stopped` after **3 local + 3 subscription author calls** and an `escalate` question | `stopped`, `reasonCode: baseline-tests-failed`, **0 calls**, no hook, `baseline-tests` event with `passed: false`, no `conductor/*` branch |
| b. tests pass at the base (`node --version`) | landed; 2 local, 1 author, 4 review calls | same calls, landed; `baseline-tests` event with `passed: true` |
| c. no `testCommand` | landed | identical; no `baseline-tests` event |
| d. test command cannot start (`conductor-no-such-binary-xyz`) | as (a) | as PR116 (a) |
| e. state left with `baselinePending: true` and status `running`, then resumed | n/a | tests now failing: `stopped`, `baseline-tests-failed`, 0 calls; tests now passing: continues and lands |

The PR's own tests on its tree, `--test-concurrency=2`: `cli-e2e`, `conductor`, `keyleak`, `service/engine`,
`failed-tests-block-step`, `chunkPhase` = **139 pass, 0 fail, 0 skip**; `test/service/*.test.js` = **62 pass**; the five
factory suites that drive the real `runTask` (`factory-build`, `factory-build-change`, `cli-factory-build`,
`factory-build-final`, `factory-build-deliver`) = **85 pass**. Not run: the full Conductor suite (CI runs it), native
Windows, live models.

Checklist from the decision: stop at the start with 0 local, 0 subscription-author and 0 rival-review calls and no
`escalate`: **met** (a, d). Passing baseline unchanged, F8 still in place: **met** (b; `failed-tests-block-step` passes).
No test command, no check: **met** (c). Resume re-checks rather than trusting the earlier result: **met where a pending
check exists** (e), with the deviation in N1. Factory entry point: shares the gate, see N2.

## What holds (verified by reading and by the runs above)

- The check runs in the isolated workspace at `baseSha`, then `guardGitDir`, `assertOnBranch` and `resetHard` with
  ignored paths kept, so a test command that writes build output cannot leak into the run (`conductor.js` `drive()`).
- Team preparation is deferred through `prepare`, so the service never builds the team, probes a model or asks the
  fallback question before the baseline has passed (`service/worker.js`). `RunLog.onEvent` is a plain property read at
  call time (`runlog.js:29,46`), so re-pointing it after `prepare` works; the service's hooks exist from the start anyway.
- `Object.assign(options, prepared.options)` writes into the same object as `state.options`, so `allowSameVendor` is
  persisted exactly as before the PR.
- `runs.js` makes `baseline-tests-failed` and `paused-before-work` runs non-resumable, which matches the engine: a
  `stopped` state is refused by `resume()` (`conductor.js:170`, `stateProblem`).
- The operator app shows the baseline event as a progress line ("Baseline tests passed." or "Baseline tests failed before
  model calls.", `runs.js:141-145`) and the stop reason as the `finished` message.

## Findings

### R1 (medium): the operator cannot see the baseline test output anywhere but the transcript file

- **Trigger:** a run stops on a failing baseline in the operator app, or in the CLI.
- **Cause:** `runs.js` projects the `baseline-tests` event with `engineType`, `participant`, `role` and `ok` only; its
  `output`, `code` and `passed` fields are dropped. In the CLI, `hooks` is undefined while the gate runs (`main.js`,
  `prepare` path), so `RunLog` has no `onEvent` and nothing is printed.
- **Consequence:** the stop text says "See the run transcript for the test output", but the app has no transcript view
  and the CLI printed nothing. The operator has to open `<workspace>.conductor/transcript.jsonl` by hand to learn which
  test failed. For Part E of the Windows runbook that is workable, but it is not what the decision described.
- **Proposed correction (two seams):** Codex forwards the redacted, clipped `output` on the progress event and prints the
  same excerpt in the CLI; Claude renders it in the run page as a UI follow-up, as the decision already routes.

### R2 (low-medium): the CLI is silent for the whole baseline run

- **Trigger:** `conductor <request> --test "<command>"` with a slow command (`npm ci && npm run verify` can take minutes).
- **Cause:** as in R1, no `onEvent` during the gate, so the `start` event (workspace path) and the `baseline-tests`
  event are not shown. Found by reading `main.js`; not run on a real TTY.
- **Consequence:** no output until the gate finishes, up to `testTimeoutMs` (default 600 s). Ctrl-C there prints
  "Stopped. Your repository is unchanged." with no resume hint, although the state is `running` with `baselinePending`
  and `conductor resume` would re-check it (scenario e).
- **Proposed correction:** bind the terminal's `onEvent` before the gate, or print one line when the check starts.

### R3 (low-medium): gated preparation failures leave reason-less runs and workspace clones behind

- **Trigger:** a `testCommand` run where, after the baseline passes, team building fails or the operator declines the
  local-model fallback (service: `paused`, `reasonCode: paused-before-work`; CLI: `prepare` returns `{ status }` with no
  `reason`, so a code-1 stop becomes `stopped` and codes 2, 3 or 130 become `failed`).
- **Cause:** the workspace now exists before the team is built. `paused` and `stopped` are not archived
  (`FINISHED` is landed/rejected/stopped; `archive()` runs for landed and rejected only).
- **Consequence:** on `main` these paths created no workspace at all. Now a full clone stays on disk; a `failed` one with
  `reason: null` is listed by `conductor runs`, and a bare `conductor resume` picks the newest such run. In the app the
  paused run stays in History as "Paused. It has no saved work to resume". Reproduced with a stub `prepare`
  (scratch `orphan.mjs`), not through the forked worker.
- **Proposed correction:** give the CLI's `prepare` outcome a reason, and remove the workspace when a run ends before
  any plan exists. Not blocking.

### N1 (accepted deviation): "resume after fixing the tests" is "start a new run"

The decision said resume should re-check rather than trust the earlier result. Codex makes a failed baseline a final
`stopped` (not resumable, text: "then start a new run") and re-checks only a run interrupted while the check was
pending. Nothing is lost by this: no plan exists before the gate, so a fresh run costs no more than a resume, and the
"never trust the earlier result" intent is kept. The decision file's bullet should be read with this review.

### N2 (note): factory feature runs gate on `npm ci && npm run verify`

`factory/build.js:450` sets `testCommand` for every feature run, so each feature now runs the full verify once before any
model call, and a failing baseline reports "Feature N was not accepted". The PR description says the factory inherits
the gate; the cost should be said too. This is the point of the gate, not a defect.

### N3 (note, fixed here): the checked-in browser journeys needed two changes, not one

Codex's handoff named `real-engine.mjs`'s `checks.cjs` (must pass before `multiply.txt` exists). Against PR116 that
change alone gave 5/6: the new timeline entry for the baseline check also contains "Tests passed", so
`getByText('Tests passed')` matched two elements in `real-engine.mjs` and in `resume-and-fallback.mjs` (4/4 became 3/4).
Both now wait for the heading by role. With both changes `node e2e/journey.mjs` gives 22, 6 and 4 passed on `main` and
on the PR116 engine (`--service`). Codex's "6/6 with a scratch copy of its fixture" did not say what the scratch copy
changed; the checked-in files needed the locator change as well.

## Not verified here

Native Windows (Codex's evidence); live models; the forked service worker's `paused-before-work` path end to end;
whether the CLI and the service share a `baseDir` in a real deployment (R3's `conductor resume` consequence depends on it).
