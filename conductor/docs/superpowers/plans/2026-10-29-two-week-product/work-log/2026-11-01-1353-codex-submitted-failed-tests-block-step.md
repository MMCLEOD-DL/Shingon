# Codex task submitted — P08 F8 failed tests block step approval

Owner Codex; independent reviewer Claude pending. Status IN_REVIEW.
Branch codex/failed-tests-block-step.
Baseline 3950535656038268d59c0f015c0fec0ca062a940 (PR70 merged, five checks green).
Last code/test commit 3d3d4f1eb3d867e802e6d60678ebbb22dbad2d97.
PR: https://github.com/MMCLEOD-DL/Shingon/pull/71

Executed failed tests block the coding round before any rival review call. The
same producer receives bounded, redacted test output and retries within existing
local/frontier limits. Passing/no-test artifacts still require rival review.
Exhausted failures retain explicit operator escalation and reject recommendation;
manual override remains distinct from automatic approval. Retry/escalation wording
does not claim an AI reviewer objected when the runner blocked the attempt.
Shared engine seams: chunkPhase.js, review.js, prompts.js, deadlock.js,
escalation.js. No interface v1 wire/schema or Claude-owned UI changes.

Evidence: native Windows, Node 24.12.0, disposable Git workspaces/fake participants.
- Exact final seven-scenario F8 regression file on archived pre-fix 3950535:
  1 PASS (no-test control), 6 FAIL, 0 SKIP, expected exit 1.
- node --test test/failed-tests-block-step.test.js test/review.test.js
  test/deadlock.test.js test/prompts.test.js test/escalation.test.js:
  65 PASS, 0 FAIL, 0 SKIP, exit 0 (8.051 seconds).
- node --test test/chunkPhase.test.js: 54 PASS, 0 FAIL, 0 SKIP,
  exit 0 (59.467 seconds). Total focused checks 119 PASS.
- Before portable fixture corrections, candidate native chunk suite had 49/54
  passing, baseline 52/54. Existing POSIX 'true' commands are not successful on
  native Windows, and the new gate correctly refused them. Six success fixtures
  now use node --version. The old test expecting failed output to reach review
  now proves a failed round reaches the producer and only passing rounds reach
  review. Assertions retained/strengthened, no behavior bypass or workflow change.
- The real failing-command control invokes native Node at the runner seam, checks
  exit 1 and exact synthetic failure output, then verifies no reviewer/auto-commit.
  Initial shell-inline versions were unsuitable Windows fixtures and were replaced;
  no testShell portability fix or full shell acceptance is claimed.
- git diff --check PASS. Full native suite not rerun because of established
  unrelated shebang fixture limitations. Full Linux CI started, pending on final
  head. Watcher must fix attributable failures on this same branch.

No live model/subscription, credential, worker/policy, deployment or external
message operation. Full engine test work is synthetic. No high-risk path changed.
Manual merge after review/checks: repository auto-merge is disabled. Merging
accepts the approved F8 policy, not F2 live UAC/write acceptance.
Next authorized task after merge: verified frontier auth/settings isolation design
for F3/F4 (do not copy session secrets), or another independent launch/diagnostic
fix if that design needs external acceptance. Native F2 live checks remain with
Malcolm; ownership of Claude U1/U2 and separate KB work is preserved.
