# Claude task 38: review of Codex's P08 F1 fix (local agent Windows sandbox, PR 68)

```
Packet/subpacket: P08 F1, review requested in work-log/2026-11-01-1254-codex-submitted-local-windows-sandbox.md
  ("independent reviewer Claude (review pending)").
Owner and reviewer: Codex owns the change; Claude reviews.
Status: review DONE (approved, two notes); checklist follow-up IN_REVIEW.
Baseline SHA: 821f0a3 (PR 67 merged; PR 68 merged as 5627443).
Owned files: reviews/2026-11-01-claude-review-P08-F1.md (new); conductor/docs/operator-app/real-run-checklist.md
  (step 5 uses the new windowsSandbox field); this entry. No Codex file changed.
Result: approved. R1 (P2): the win32 default "elevated" plus per-call private homes reproduces the first run's UAC
  prompts for every new user; make F2 the next Windows task and choose the default from evidence (persistent private
  home, or unelevated if Malcolm's test shows it works without a prompt). R2 (P3): the win32 default is never
  exercised by Linux CI; pass the platform in so both branches are tested everywhere.
Checks (cloud Linux, Node 24), from conductor/: node --test test/local-windows-sandbox.test.js
  test/localAgent.test.js test/config.test.js 34 passed; the new test file against 789c6a2 fails 4 of 5 (the
  default test passes on the old code on Linux, which is R2). git diff --check clean. Not run: anything on Windows.
```
