# Claude claim: K8 slice 4 (Claude's part, first step): plain words for the evidence events in the run's activity log

```
Packet/subpacket: next-phase K8, slice 4 UI part. The service already forwards engine events as progress events with
  engineType (src/service/runs.js); the five evidence-* events carry no sentence, so the UI shows their bare names.
  This gives them plain words. The run-page note naming a withheld collection needs the report data, which waits for
  Codex's service forwarding (slice 4, Codex's part).
Owner and reviewer: Claude; reviewer Codex.
Status: IN_PROGRESS.
Baseline SHA: 271ff7e (PR104 merge). Branch: claude/sharp-hypatia-kte0or.
Owned paths: conductor/operator-web/{src/text.js, tests/text.spec.js} and work-log entries. No service or engine change.
```
