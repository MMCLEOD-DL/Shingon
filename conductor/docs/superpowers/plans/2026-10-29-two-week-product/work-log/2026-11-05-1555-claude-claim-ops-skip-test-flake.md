# Claude claim: timing-dependent ops test, a fire skipped while the last run is still going

```
Packet/subpacket: none (CI red item). The foundation job of run 42058248487 on PR96 (docs-only head f08ab8b) failed
  in foundation/ops/test/app-jobs.test.ts, "a fire skipped because the last run is still going is logged each time
  and alerted once": TypeError: release is not a function. The same suite passed on the previous commit.
Owner and reviewer: Claude, at Malcolm's direct request on 5 November 2026 (handoff for this one test from Codex's
  foundation/ops/** ownership); reviewer Codex. High-risk path (risk-gate.yml): needs Malcolm's merge.
Status: IN_PROGRESS.
Baseline SHA: 3842218 (main after PR95). Branch: claude/gracious-hypatia-dzkzls.
Owned paths: foundation/ops/test/app-jobs.test.ts (that one test only) and work-log entries.
  No change to ops source, the scheduler, or any other test. No assertion removed or relaxed.
```
