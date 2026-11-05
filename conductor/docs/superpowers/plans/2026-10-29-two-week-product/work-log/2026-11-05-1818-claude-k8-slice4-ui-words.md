# Claude: plain words for the K8 evidence events in the activity log

```
Packet/subpacket: next-phase K8, slice 4 (Claude's UI part, first step).
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW.
Baseline SHA: 271ff7e. Result commit: cf2d9f1. Files: conductor/operator-web/{src/text.js, tests/text.spec.js}.
What changed: the five evidence-* engine events, which the service forwards as progress events with no sentence, now
  read as what happened in the run's activity log; none names a document or passage.
Checks (cloud Linux, Node 22.23.4, Chromium; synthetic): npx vitest run 74 passed (the new test fails on the previous
  build); npm run build ok; node e2e/journey.mjs 21 + 6 + 4 passed, exit 0.
Waits for Codex (slice 4, service part): forwarding the withheld reports' collection and allowed destinations as
  operator-only run data. Then the run page can show the note design §6 describes. Until then, the UI shows only the
  generic activity-log line.
```
