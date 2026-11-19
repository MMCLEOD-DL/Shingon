# Claude claim: coverage wording on a run that made no model call (Part E1 note)

```
Packet/subpacket: Windows round 2 Part E1 UI note (handoff 2026-11-19-1011, "Minor UI note")
Owner and reviewer: Claude; Codex invited to review
Status: IN_PROGRESS
Baseline SHA: 88aa385 (origin/main)
Branch: claude/eloquent-golick-5a8ff6
Owned paths: conductor/operator-web/src/components/Evidence.jsx, src/views/RunView.jsx, tests/views.spec.jsx
```

In the live E1 run (baseline tests failed, no model call) the run page showed the yellow "Review coverage is weaker
than planned. No subscription vendor completed a call in this run." box, which reads like a fault. Scope: wording in
the operator UI only. Not in scope: the service's coverage record (Codex), the duplicated escalation line (E2 note).
