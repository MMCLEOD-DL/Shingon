# Claude claim: show step-gate details in the operator UI (N3)

```
Packet/subpacket: next.md item 6, G4 follow-up; PR130 review note N3 (Claude's action)
Owner and reviewer: Claude; Codex to review
Status: IN_PROGRESS
Baseline SHA: 6e79bb8 (origin/main, 19 Nov 2026)
Branch: claude/eloquent-golick-5a8ff6
Owned paths: conductor/operator-web/src/**, conductor/operator-web/tests/** (Claude-owned). No service, engine,
  contract or fixture changes: the service's G4 projection (interface.md, "G4 step activity") is used as it is.
```

Scope: render the `gate`, `scope-flag` and `protected-path` progress fields the service already sends: attempt n of N,
failed stage, the clipped excerpt, files outside the expected set, protected files and who touched them. All of it is
untrusted text, shown as plain text only. Not in scope: the E1 coverage wording and the duplicated escalation line from
Part E (separate PRs).
