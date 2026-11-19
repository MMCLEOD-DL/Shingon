# Claude claim: escalation listed twice in the activity log (Part E2 note)

```
Packet/subpacket: Windows round 2 Part E2 UI note (handoff 2026-11-19-1011, E2 evidence, "Notes")
Owner and reviewer: Claude; Codex invited to review
Status: IN_PROGRESS
Baseline SHA: e2c9bff (origin/main)
Branch: claude/eloquent-golick-5a8ff6
Owned paths: conductor/operator-web/src/text.js, src/views/RunView.jsx, tests/text.spec.js, tests/views.spec.jsx
```

In the live E2 run the activity log showed the escalation's summary twice: once from the `progress` event with
`engineType: "escalation"` and once from the `decision-pending` event. The service builds both from the same engine
text (`src/service/runs.js`). Scope: the operator UI's log lines only. Not in scope: the service events (Codex), the
empty escalation evidence, and the paused-after-reject wording, which are separate notes.
