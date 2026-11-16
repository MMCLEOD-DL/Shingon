# Claude handoff: G2, the frontier fallback inherits the failure history

```
Packet/subpacket: P09 next-phase item 6, task G2. Follows work-log/2026-11-16-19*-claude-claim-g2-fallback-handover.md (GD4 and the seam note).
Owner and reviewer: Claude; Codex reviews the three seam files.
Status: IN_REVIEW. Packet rows in 04-work-log.md unchanged; next.md G2 carries a "Done" note.
Baseline SHA: 580d8da (PR121 merge). Branch: claude/brave-ride-tz7f25. Code commit: 75b2868.
Shared seams changed, exactly as the seam note said:
  conductor/src/review.js (+4/-3): `reviewLoop({ ..., start })`, an optional round-1 seed; identical behaviour without it.
  conductor/src/chunkPhase.js (+17/-2): `localHandover(loop)` builds the hand-over; the fallback `reviewLoop` is seeded with
    it; `chunk-fallback` gains `handover: { attempts, reasons, testExcerpt }`.
  conductor/src/prompts.js (+4/-1): `chunkExec` feedback kind `inherited`.
  Tests: test/fallback-handover.test.js (new), test/review.test.js, test/prompts.test.js. conductor.js, runlog.js, service: untouched.
Contract version: none. The `chunk-fallback` event gained a field; `conductor report` (G1) reads only `to` and `reason` and still passes.
```

## What now works

After the local loop is exhausted and the workspace is reset to the step's base, the frontier author's first prompt
ends with: "A local model tried this step and could not get it approved. What it ran into:", the last reason, the
last failed test output (only when that attempt's tests ran and failed; a passing run is not failure history), the
earlier reasons oldest first, and "The workspace has been reset to the step's base, so start fresh and do not assume
any of its edits exist." Reasons are clipped to 300 characters each and the test excerpt to 2,000 (`clip` adds a short
marker). Only the first frontier attempt inherits; later rounds get the ordinary reviewer or test feedback. The
`chunk-fallback` event carries the same summary, redacted on write like every event. Resume is unchanged.

## Checks (cloud Linux, Node 22.23.4, from `conductor/`)

- Before the source change (`src/` stashed): the 6 new tests that exercise the behaviour fail (39 pass, 6 fail across
  fallback-handover, review and prompts tests); the "no fallback, no handover" control passes before and after.
- After: `node --test --test-concurrency=2 test/chunkPhase.test.js test/review.test.js test/prompts.test.js
  test/failed-tests-block-step.test.js test/conductor.test.js test/report.test.js test/deadlock.test.js
  test/escalation.test.js test/fallback-handover.test.js`: **181 pass, 0 fail, 0 skipped** (agent run and orchestrator re-run).
- Acceptance (next.md G2): three failed local attempts with distinct test outputs, then the frontier: the author's first
  task contains the last reason and exactly the last output, `handover.attempts` 3, `handover.reasons.length` 3, and the
  step lands produced by the author. A reviewer-driven fallback inherits the reviewer's reason with no test section.
  With `frontierRounds: 2`, the author's second attempt gets the ordinary "blocked by the reviewer" wording.

## Live / fake / skipped / unrun

Fake participants and stubbed test runs only. Not run: the full Conductor suite (CI), a live run, native Windows.

## Open defects or unknowns

None known. Design choice to review: the excerpt is omitted when the last local attempt's tests passed (the reviewer's
reason alone is the history then).

## External blocker and exact owner/action

None. Not a high-risk path; needs Malcolm's merge (auto-merge is off). Codex review invited at 75b2868.

## Next packet unblocked

G3 (a pass condition per step), then G4, per GD4.
