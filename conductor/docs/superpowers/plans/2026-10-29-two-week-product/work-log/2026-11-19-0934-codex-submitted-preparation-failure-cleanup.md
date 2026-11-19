# Codex task submitted — preparation failure cleanup

- Packet/subpacket: P07/P08, PR116 review R3. Owner Codex; Claude cross-review requested through this handoff. Status IN_REVIEW.
- Branch `codex/preparation-failure-cleanup`; baseline `7e5ab5cdee0faf15ab2fc59dc6b9e0316ec82d80`. Last code/test commit `436e8b9c29ba705ecde2038e42d5d4f2ede122d7`; production fix `6a360a2e7c471d4a0c69abe65351c50f7774fbf9`. Previous PR126 submission verified merged before this claim.
- [Draft PR127](https://github.com/MMCLEOD-DL/Shingon/pull/127). Protected engine/service paths require Malcolm's merge or approval; auto-merge remains off. No approval label/gate changes.

## Result

When deferred team preparation returns a refusal before any saved plan exists, the engine archives the diagnostic transcript and removes the unused clone and metadata. CLI preparation failures/stops retain their explanation in the outcome and transcript. The service clears a workspace path when the engine reports cleanup, preventing a false Resume option after a failed preparation.

Saved plans and completed steps survive preparation failure during Resume. Explicit keepWorkspace is honored, including the CLI flag before deferred team construction. Baseline interruption remains resumable and rechecks visibly. This change is confined to returned preparation outcomes; baseline failure and unexpected thrown-error recovery keep their existing behavior.

Owned changes: `src/conductor.js`, `src/cli/main.js`, `src/cli/prepareRun.js`, `src/service/runs.js`, and matching tests. Shared engine lifecycle seam claimed before editing. No UI source changes or new wire fields. P07/P08 remain IN_PROGRESS; this does not close broader acceptance.

## Validation

Native Windows, Node 24.12.0, synthetic participants and local fixture HTTP servers only; no real model/subscription calls or worker operations.

- Before implementation: six new focused controls, **2 pass / 4 fail**, exit 1. Failed/stopped/paused preparation retained clones; CLI had no archived preparation transcript. The real forked service control separately reproduced a stale workspace path after cleanup.
- At final code/test head `436e8b9`, from `conductor/`: `node --test --test-name-pattern='preparation|baseline|missing test executable' test/conductor.test.js test/cli-e2e.test.js test/service/engine.test.js`: **15 pass / 0 fail / 0 skip**, exit 0. Includes missing subscriptions, declined fallback, reason persistence, explicit keepWorkspace, preservation of completed steps, baseline redaction/interruption and forked service cleanup.
- Full native suite started at `6a360a2`, `node --test --test-concurrency=4`: **1,727 total, 1,524 pass / 202 fail / 1 skip**, exit 1; 393 seconds. Private evidence `%TEMP%/shingon-preparation-cleanup-full.log`. One failure was the new missing-subscription test fixture: it disabled only one vendor, correctly allowing same-vendor fallback. Test-only correction `436e8b9` disables both; the final focused run passes. The remaining 201 failures are not newly classified in this task; the previous PR126 submission also recorded 201 native failures. Native suite is not green and was not fully rerun after the fixture-only correction.
- [Linux CI run44496912510](https://github.com/MMCLEOD-DL/Shingon/actions/runs/44496912510), code/test head `436e8b9`: Conductor **1,724 pass / 0 fail / 3 skip**, 1,727 total; operator-web and knowledge jobs PASS. Foundation was still running at this submission; the docs-only submission commit triggers another CI run. Risk gate awaits Malcolm's protected-path approval.
- `git diff --check`: PASS. No assertions, workflows or permissions weakened. Existing untracked Windows acceptance report remains untouched and excluded.

## Review and next action

Claude: review unused-preparation cleanup versus preserving saved plans, CLI reason propagation and the service's handling of an explicit null workspace. Cross-review has not been represented as completed.

Wait for PR127 review and Malcolm's approval/merge; address attributable failures or review findings on this branch. Do not start a new product task before merge. The G4 review/service-event handoff remains separate and available after this gate. Legacy h2/j4 ownership, held native promotion, spent bindings and immutable archives remain unchanged.
