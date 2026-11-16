# Claude claim: G3, a pass condition for each plan step

```
Packet/subpacket: P09 next-phase item 6, task G3 (GD4, 16 November). Owner Claude; Codex reviews.
Status: IN_PROGRESS. Packet rows in 04-work-log.md unchanged.
Baseline SHA: 57b623c (PR122 merge). Branch: claude/brave-ride-tz7f25.
Shared seams, per the seam note in work-log/2026-11-16-19*-claude-claim-g2-fallback-handover.md:
  conductor/src/plan.js (optional per-step `check` and `files`), conductor/src/planPhase.js (the pass-condition rule, before the
  reviewer, no model call), conductor/src/prompts.js (author and reviewer told about the fields; worker and reviewer shown them),
  conductor/src/chunkPhase.js (the gate runs a step's `check` command before `testCommand`). conductor.js untouched.
```

## Design decisions recorded before coding

- `check` is a shell command, or the keyword `existing-suite` (the run's `testCommand` is the condition), or `none` (the step
  changes no code). `files` is a short list of expected paths. Both optional; absent fields leave the parsed plan exactly as today.
- **Deviation from next.md's wording, for review:** a configured `testCommand` counts as the explicit "existing suite passes"
  condition for every step that gives no `check`. The plan is blocked ("step N has no pass condition…") only when a step has
  no `check` **and** the run has no test command. Reason: forcing `"check": "existing-suite"` on every step adds boilerplate for
  the planner and churn across every fixture, while the engine already knows whether a suite exists. `none` must be explicit
  and is shown to the plan reviewer, who is told to block it on a code step.
- The rule runs in the plan phase after parsing and before the reviewer, through the existing "could not be used as a plan"
  feedback path, so it costs no model call and the author gets a precise retry.
- The gate keeps the single `tests` result shape, adding `stage: 'check' | 'tests'`, so F8, the G2 hand-over, the deadlock
  settlement and the operator service keep working unchanged. A failing `check` skips `testCommand`.
- The scope flag for unexpected files is G4's; G3 only parses, validates and shows `files`.

Not in scope: G4, G3b, conductor.js, the service, the operator app.
