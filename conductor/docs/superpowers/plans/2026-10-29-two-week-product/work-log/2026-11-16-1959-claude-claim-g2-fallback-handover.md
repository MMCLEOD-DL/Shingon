# Claude claim: G2, the frontier fallback inherits the local attempts' failure history (and the G2–G4 seam note)

```
Packet/subpacket: P09 next-phase item 6, task G2 (conductor/docs/operator-app/next.md). Owner Claude; Codex reviews.
Decided by: Malcolm in chat, 16 November 2026: "go ahead with G2 to G4, record the seam note". Recorded here as GD4.
Status: IN_PROGRESS. Packet rows in 04-work-log.md unchanged.
Baseline SHA: 580d8da (PR121 merge). Branch: claude/brave-ride-tz7f25.
```

## GD4 (Malcolm, 16 November 2026)

G2, G3 and G4 go ahead, one task per PR, in that order. G3b and G5 are not included: G3b builds on G3 and stays off by
default (GD2); G5 waits for G1's numbers from real runs (GD1 settled that it never replaces the frontier review).

## Seam note for G2–G4 (the "named, minimal change" the lane rules require for shared engine code)

The engine files these tasks touch are shared seams. `conductor.js` is a high-risk path and is **not** touched by any of
them; the planned changes avoid it as next.md foresaw.

| Task | File | Change |
|---|---|---|
| G2 | `conductor/src/review.js` | `reviewLoop` gains an optional `start: { feedback, feedbackKind }` seed for round 1. Default behaviour unchanged. |
| G2 | `conductor/src/chunkPhase.js` | In `runChunkFrom`, the fallback loop is seeded with the local loop's last reason and a clipped test excerpt; the `chunk-fallback` event gains a `handover` field. |
| G2 | `conductor/src/prompts.js` | `chunkExec` gains feedback kind `inherited`, worded for a reset workspace (never "your earlier edits are still in place"). |
| G3 | `conductor/src/plan.js`, `prompts.js`, `chunkPhase.js` | Optional plan-step fields `check` and `files`; plan review blocks a code step with no pass condition; the gate runs `check` before `testCommand`. Old plans stay valid. |
| G4 | `conductor/src/options.js`, `chunkPhase.js`, `prompts.js` | Optional `gateCommands`, run cheapest first before the tests; a `gate` event per attempt; the scope flag goes to the reviewer. |

Each task records its own exact diff in its handoff. Codex reviews each PR; the operator service (Codex-owned) is not
changed by G2 and will need its own change to show `gate` events (G4), to be handed off then.

## G2 scope

Acceptance (next.md): given three failed local attempts on a step, when the frontier fallback starts, its first prompt
contains the last local failure reason and a clipped test excerpt, and the transcript shows it.

- The hand-over is built from the local loop's result: `lastReason`, the per-round reasons from `history`, and the test
  output of the last inspected attempt, clipped by a fixed rule (no model).
- The transcript shows it through the `chunk-fallback` event's `handover` field (redacted on write, as every event is).
- Only the frontier's **first** attempt gets the inherited text; later rounds get the ordinary reviewer or test feedback.
- Resume is unaffected: a step restarts from its base, as today.

Not in scope: G3, G4, the operator app, any change to `conductor.js` or `src/service/**`.
