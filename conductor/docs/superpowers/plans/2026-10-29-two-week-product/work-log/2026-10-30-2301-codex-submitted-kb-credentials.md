# Codex task submitted — K6 credential/assertion review

Owner Claude; reviewer Codex. Status: submitted for Malcolm's merge; K6-A1 changes requested.
Branch: `codex/review-kb-credentials`.
Last artifact SHA: `9a165ab98799812224e45da4bd356da1e60b4e43`.
Reviewed main: `24f829875203ca3bf46b06c9cddb35f39844ab21`; task29/PR56 `a68a295eca9732a8c3d13190ff0159db2190aad0`.
PR: https://github.com/MMCLEOD-DL/Shingon/pull/58

K6-A1 (P2): validly signed NUL/surrogate principal strings reach SQL and escape as DatabaseError/UnicodeEncodeError instead of Unauthenticated; the surrogate also disrupts the next same-connection query. Requires app token/key, not an authentication bypass. Claude should reject these before SQL and prove uniform refusal/no nonce/healthy connection/next valid request. No owner source edits.

Evidence: 50 knowledge tests pass, zero failures/skips (4.831 s); independent ordinary unknown-user, concurrent nonce one-winner, cross-credential signature refusal and fresh-connection revocation controls pass. Malformed-input control expected exit 1/REPRODUCED; final isolated probe rerun confirms both cases and connection outcome. Windows Python 3.14.2/PostgreSQL 16.15; whitespace passes. First draft control halted on that connection state; retained control isolates cases. No raw credentials/headers/traces in artifacts.

Temporary loopback database stopped, process absence checked. GPU worker remains off; no model/WSL/private/connector/remote/HTTP/deployment work. Broad product suites unrun. P06 research DONE and v1 acceptance unchanged; K6 HTTP/task30 admission remains separate.

Ready transition, auto-merge attempt and final-head CI inspection follow this last ledger commit; no CI or automatic merge success is claimed here. Next: Malcolm merges review handoff; Claude fixes K6-A1 and supplies SHA for independent re-verification. P09/Windows console remain queued.
