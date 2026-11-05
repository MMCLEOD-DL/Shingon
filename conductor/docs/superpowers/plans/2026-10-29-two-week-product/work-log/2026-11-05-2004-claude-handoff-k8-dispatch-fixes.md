# Claude handoff: K8 dispatch fixes for Codex's PR103/PR104 review

```
Packet/subpacket: next-phase K8, corrections for reviews/2026-11-05-codex-review-pr103-pr104-k8-wiring.md.
Owner and reviewer: Claude; reviewer Codex (re-review before slice 4 service forwarding).
Status: IN_REVIEW.
Baseline SHA: ce04aef. Branch: claude/sharp-hypatia-kte0or.
Files: conductor/src/knowledge/run.js; conductor/src/adapters/localAgent.js (shared seam, named and minimal: a frozen
  copy of the operator's extraConfig on the adapter, read by the destination check only);
  conductor/test/knowledge-run.test.js; docs/knowledge-base/k8-conductor-evidence.md §9.2.
  No secrets.js, service, conductor.js, router.js or UI change.
```

## Findings and fixes

| Finding | Reproduced on `ce04aef` (new test, before the fix) | Fix |
|---|---|---|
| P1-1: dispatch after a failed provenance save | The author got the excerpt with `saveState` throwing ENOSPC | On a failed save, provenance is removed from memory, evidence is turned off for the run (`evidence-dropped`) and the call goes out without it |
| P1-2: on Resume, a name rebound to another approved destination | The rebound `rev` (local-model, then codex-subscription) was dispatched once with the derived task | `scope` is saved as `{ name: destination }`. Both `knowledgeForCall` and the Seat gate require the current destination to equal the recorded one. A name-only (legacy) scope never matches, so the run stops |
| P1-3: a LocalAI `-c` override contradicts the private endpoint | A real `LocalAgentAdapter` with a `base_url` override was still `local-model` | Entries matching provider, base_url or profile make the candidate untrusted. `profile` was also added for frontier Codex |

## Checks

Cloud Linux, Node 22.23.4, synthetic (loopback stub service, fake participants, the real adapter constructor; no model
and no knowledge service).

- `node --test test/knowledge-run.test.js test/knowledge-evidence.test.js`: 40 pass, 0 fail, 0 skipped. Before the fix
  the three new tests fail on their core assertions.
- Five mutation controls each fail exactly one new test:
  - a save failure ignored;
  - the destination not compared;
  - legacy name-list provenance accepted;
  - local overrides ignored;
  - `profile` not refused.
- Every Conductor test file except `test/service/engine.test.js` (it hangs here without an orphan reaper; see
  05-validation): 1638 tests, 1634 pass, 0 fail, 4 skipped. CI runs the full suite.

## Limits

- The Seat gate and `knowledgeForCall` share one destination check. The new rebinding test reaches it through
  `knowledgeForCall`; the gate path is covered by the existing revocation and added-candidate tests.
- Runs paused under the old name-only provenance stop at their next call. There is no migration, and the operator starts
  a fresh run.
- Routes Conductor cannot see (for example settings inside a home it does not generate) still rest on the operator's
  approval.

## Next

Codex re-reviews at the PR head. Slice 4 service forwarding waits for that.
