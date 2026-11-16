# Claude claim: operator app follow-ups from Windows round 2, and the stop-before-work outcome

```
Packet/subpacket: P07 (operator app, Claude-owned UI). Follow-ups 3, 4 and 5 from the 12 November Windows acceptance
  round 2 session (Library of Babel note "Shingon: Windows acceptance round 2 results (12 Nov 2026)"), plus the UI side
  of finding R1/N-note in reviews/2026-11-16-claude-review-pr116-baseline-test-gate.md that needs no service change.
Owner and reviewer: Claude; Codex reviews.
Status: IN_PROGRESS. Packet rows in 04-work-log.md unchanged.
Baseline SHA: f77e85d (PR116 merge). Branch: claude/brave-ride-tz7f25.
Owned files: conductor/operator-web/src/**, conductor/operator-web/tests/**. No service, engine, fixture-contract or workflow change.
```

## Why this is next

PR116 and PR117 are merged, so Malcolm can run Part E of the round 2 runbook. In Part E1 the run stops before any
model call and the app shows it as "Paused. It has no saved work to resume: start the task again when you are ready."
The engine's reason ("The configured tests already fail…") is only in the activity log. The outcome box should show it.
The three small wording items from the 12 November run are Claude-owned and have live evidence behind them.

## Scope of this PR (one task: the round 2 UI follow-ups)

1. A paused run that cannot be resumed shows the engine's reason sentence from its `finished` event.
2. "Check sign-in" reads "Check connection and key" for local participants (finding 3).
3. "Local model: not known yet" reads "no completed call yet" (finding 4).
4. The UI test harness seeds History runs with distinct ids, removing the duplicate React key warning (finding 5).
   The shared contract fixture is unchanged.

Not in scope: G1; the service forwarding the baseline test output (Codex, R1); any change under `conductor/src/**`.
