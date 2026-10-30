# Codex handoff — K6 credential/assertion review

Packet/subpacket: K6 part1 (task29/PR56); P06 research DONE unchanged.
Owner Claude; reviewer Codex. Status: CHANGES_REQUESTED for K6-A1 (P2).
Branch `codex/review-kb-credentials`; baseline `24f829875203ca3bf46b06c9cddb35f39844ab21`.
Reviewed source `a68a295eca9732a8c3d13190ff0159db2190aad0`.

Finding: signed NUL/surrogate user ids reach SQL in auth._user; they escape as DatabaseError/UnicodeEncodeError instead of Unauthenticated. The surrogate case disrupts the next same-connection query. Requires a valid app token/key; no auth bypass or HTTP response observed. Claude should validate NUL/strict UTF-8 before SQL and retain unknown-user, nonce and valid Unicode semantics.

Evidence: 50 knowledge tests pass, zero failures/skips (4.831 s). Independent control expected exit 1/REPRODUCED on two malformed inputs; ordinary unknown user/no-nonce, concurrent same-assertion one-winner, cross-credential signature refusal and fresh-connection revocation controls pass. Windows Python 3.14.2/PostgreSQL 16.15. Temporary database/server cleaned up, matching processes absent; whitespace passes. First draft probe halted on the disrupted connection; retained probe isolates cases.

Artifact: reviews/2026-10-30-codex-review-kb-credentials.md and fixtures/kb-auth-review.py. Review/ledger only, no owner source edits. GPU off; no model/private/connector/remote/HTTP/deployment work. Broad product suites unrun. K6 HTTP admission and task30 remain separate; specification acceptance unchanged.
Next: Claude fixes K6-A1 and supplies SHA; Codex re-verifies. Malcolm merges this review handoff. P09/Windows console remain queued.
