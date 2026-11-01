# Codex claim: P08 F8 failed tests block automatic step approval

Owner Codex; reviewer Claude. IN_PROGRESS. Branch codex/failed-tests-block-step.
Baseline 3950535 (PR70 merged; all five required final-head checks green).
Malcolm approved F8 in this chat's 1 November 'go ahead', recorded in prior handoffs.
Shared seam handoff: PR66 F8 explicitly assigns engine implementation to Codex.
Scope: chunkPhase.js, review.js retry feedback, prompts.js/deadlock.js accurate
test-failure wording (including escalation.js), focused engine regressions and setup/ledger documentation.
Executed failed tests block a round before any reviewer call. Preserve bounded
local/frontier retries, passing/no-test rival review, explicit user escalation and
workspace rollback. No automatic approval of failing tests, no UI or other lane edits.
Reproduce with approving fake reviewers, real disposable Git workspaces and injected
test outcomes; cover a real failing command too. No live model/subscription calls.
F2 actual UAC/write acceptance still requires Malcolm's live check. F3/F4 remains
queued: preserving supported subscription authentication while isolating settings
needs a verified auth/config design; do not copy credentials or invent that seam.
F8 is independent and already authorized, so advance it while those checks remain.
