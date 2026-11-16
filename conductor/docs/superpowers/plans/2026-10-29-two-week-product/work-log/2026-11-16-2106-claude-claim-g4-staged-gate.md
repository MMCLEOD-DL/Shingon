# Claude claim: G4, the staged step gate and the scope flag

```
Packet/subpacket: P09 next-phase item 6, task G4 (GD4, 16 November; Malcolm: "merged, carry on with G4"). Owner Claude; Codex reviews.
Status: IN_PROGRESS. Packet rows in 04-work-log.md unchanged.
Baseline SHA: 159cdd3 (PR123 merge). Branch: claude/brave-ride-tz7f25.
Shared seams, per the seam note in work-log/2026-11-16-19*-claude-claim-g2-fallback-handover.md:
  conductor/src/options.js (`gateCommands: []`), conductor/src/chunkPhase.js (stages before the step check and the suite; a `gate`
  event per attempt; the scope flag and the protected-path block), conductor/src/prompts.js (gate failure text; the reviewer's flag
  line), conductor/src/council/foundationRules.js (export a small `isProtectedPath` beside the existing lists, no rule change).
  conductor.js and the service untouched. The operator service will need its own change to show `gate` events: Codex handoff after merge.
```

## Design decisions recorded before coding

- `gateCommands` is an optional run option: `[{ name, command }]`, run in order before the step's `check` (G3) and the suite,
  stopping at the first failure. The result keeps the `tests` shape with `stage: <name>`, so F8, the G2 hand-over and the
  deadlock settlement are unchanged, and the frontier reviewer is never called for a failed gate.
- Each attempt logs one `gate` event: `{ index, attempt, of, result, failedStage, excerpt }`. The excerpt is fixed-rule: the
  first failing block (from the first line matching error, fail, "not ok", exception, or the ✗ mark), at most 3,000 characters;
  no model.
- Scope: after an attempt passes the gate and the tests, the files it touched (`ws.listFiles(base)`) are compared with the
  step's `files` (G3). Files outside the set are **flagged** to the reviewer in its prompt and logged (`scope-flag`); they never
  fail the step on their own. A touched **protected** path (the council's `PROTECTED_PATHS`/`PROTECTED_DIRS`, matched the same
  way) **blocks** the attempt before any reviewer call and is logged (`protected-path`). This is next.md's rule 4, as written.
- Runs with no `gateCommands` and steps with no `files` behave exactly as today.

Not in scope: re-chunking (deferred in next.md), G3b, G5, the operator app's rendering of `gate` events (Codex seam), conductor.js.
