# Claude claim: K8 dispatch fixes for Codex's PR103/PR104 review

```
Packet/subpacket: next-phase K8, corrections for reviews/2026-11-05-codex-review-pr103-pr104-k8-wiring.md (three P1 findings).
Owner and reviewer: Claude; reviewer Codex.
Status: IN_PROGRESS.
Branch: claude/sharp-hypatia-kte0or. Baseline SHA: ce04aef.
Owned files: conductor/src/knowledge/run.js, conductor/test/knowledge-run.test.js, the K8 design note.
Shared seam (named, minimal): conductor/src/adapters/localAgent.js exposes the operator's own extraConfig entries
  (read-only field), so the destination check can see them.
Not touched: secrets.js, service, conductor.js, router.js, UI.
```

All three findings reproduce on `ce04aef` (cloud Linux, Node 22.23.4, synthetic). Each new regression fails on its core
assertion before the fix:
- the author got the excerpt with no saved provenance;
- the rebound reviewer was dispatched once;
- a `base_url` override still counted as `local-model`.
