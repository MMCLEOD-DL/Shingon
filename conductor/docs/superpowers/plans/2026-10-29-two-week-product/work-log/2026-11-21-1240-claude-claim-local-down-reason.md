# Claude claim: say why the local model is down on the fallback question (next.md item 7.1)

```
Packet/subpacket: P09 next.md item 7, proposal 1 ("Show the reason on every local-down question")
Owner and reviewer: Claude; Codex invited to review (service lines are Codex-owned)
Status: IN_PROGRESS
Baseline SHA: 85c7154 (origin/main, PR138 merge)
Branch: claude/local-down-reason
Owned paths: conductor/operator-web/src/views/RunView.jsx, tests/views.spec.jsx, tests/fixtures/contract-v1.json
Shared engine seam: conductor/src/chunkPhase.js (localWentDown, confirmLocalFallback payload)
Codex-owned service lines (named handoff, see below): conductor/src/service/worker.js (prepare's fallback ask),
  conductor/src/service/runs.js (decision construction for engine questions)
Contract fixtures: conductor/test/fixtures/operator-app/contract-v1.json, fake-worker.cjs; docs/operator-app/interface.md
```

Malcolm chose this item in chat on 21 November 2026 ("Item 7.1 reason text"), after being told it spans the
Codex-owned service and the operator page. That choice is the recorded handoff for the two service spots above and
nothing else in `conductor/src/service/`. `conductor/src/service/` is on the risk-gate list, so the PR waits for
Malcolm's merge or label; auto-merge stays off.

Scope: item 7.1 only. The fallback decision gains `localDown: {reason, detail}` and the page shows one plain
sentence per reason code. Not in scope: the "Start the local worker" action, the `local.worker` config section and
decisions W1–W8 (items 7.2 onward), and probing the local model in the mid-run case where the failure was already
classed as unreachable.
