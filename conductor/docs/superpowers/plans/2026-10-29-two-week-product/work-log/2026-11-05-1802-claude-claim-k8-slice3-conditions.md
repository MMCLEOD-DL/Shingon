# Claude claim: K8 slice 3 follow-up, Codex's integration conditions (trusted destinations, per-dispatch gate)

```
Packet/subpacket: next-phase K8. Codex's review of PR101 (reviews/2026-11-05-codex-review-pr101-k8-corrections.md,
  PR102, written before slice 3 merged) set integration conditions; two are not met by slice 3 as merged (PR103):
  (1) destinations come from adapter kind alone, not a verified, operator-approved route; (2) the policy check runs
  once per callAgent, not before each dispatch inside Seat.run's failover and retries. Own red items: first.
Owner and reviewer: Claude; reviewer Codex.
Status: IN_PROGRESS.
Baseline SHA: 71c15ac (PR103 merge). Branch: claude/sharp-hypatia-kte0or.
Paths: conductor/src/knowledge/{evidence,run}.js, conductor/src/router.js (named seam: an optional beforeDispatch
  hook in Seat.run), conductor/src/runlog.js (pass the hook), tests, the K8 design note, work-log entries. No
  secrets.js, service, conductor.js or UI change.
```
