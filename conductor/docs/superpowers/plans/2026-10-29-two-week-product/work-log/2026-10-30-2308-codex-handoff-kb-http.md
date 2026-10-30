# Codex handoff — K6 HTTP review

Owner Claude; reviewer Codex. Status: CHANGES_REQUESTED for K6-H1/H2 (P2).
Branch `codex/review-kb-http`; baseline `def467e847d0948533ddf0196b8c8f412093501e`.
Reviewed task30/PR59 `0facb308dc7fb023246a089d2c83541881f1bc7d`.

H1: non-ASCII digit or 5,000-digit Content-Length escapes conversion before error handling; unauthenticated loopback caller gets RemoteDisconnected instead of JSON 400/413. Validate ASCII decimal and cap before conversion.
H2: a 1.25-second auth lock wait plus five-second candidate wait gives 503 after 6.260 seconds; per-statement timeout does not enforce the request budget. Use one monotonic deadline and bound connection/blocking work.

Evidence: 61 tests pass, zero failures/skips (11.065 seconds); independent actual HTTP/real-PG-lock control expected exit 1/REPRODUCED. Normal search, invalid-JSON refusal, post-malformed health and post-lock recovery pass. 36 generated/three authored fixtures. Native Windows Python 3.14.2/PostgreSQL 16.15. Harness preload/import issue and nested-JSON expectation corrected before final evidence; neither is a product finding. Whitespace passes.

Artifacts: reviews/2026-10-30-codex-review-kb-http.md and fixtures/kb-http-review.py. Review/ledger only; no owner source edits. Listener/database cleaned up, temporary server stopped and matching processes absent; GPU off. No model/WSL/private/connector/remote/deployment work or broad product suite. P06 research DONE/v1 unchanged. K6-A1 remains open separately; K6 admission remains open.

Next: Claude corrects H1/H2 and A1, then Codex re-verifies. Malcolm merges this handoff; P09/Windows console remain queued.
