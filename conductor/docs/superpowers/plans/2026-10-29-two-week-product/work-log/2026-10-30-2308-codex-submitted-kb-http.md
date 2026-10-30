# Codex task submitted — K6 HTTP review

Owner Claude; reviewer Codex. Status: submitted for Malcolm's merge; K6-H1/H2 changes requested.
Branch: `codex/review-kb-http`.
Last artifact SHA: `3f45576be828b9202cf132ceb91898e49445c5e7`.
Reviewed main: `def467e847d0948533ddf0196b8c8f412093501e`; task30/PR59 `0facb308dc7fb023246a089d2c83541881f1bc7d`.
PR: https://github.com/MMCLEOD-DL/Shingon/pull/60

H1 (P2): non-ASCII or 5,000-digit Content-Length produces a socket disconnect rather than JSON 400/413; validate ASCII decimal and cap before conversion. H2 (P2): real credential/candidate lock waits yield 503 after 6.260 seconds; enforce one five-second request deadline rather than renewing each statement's budget. Existing K6-A1 stays open separately. No auth bypass observed; no K6 admission.

Evidence: 61 knowledge tests pass, zero failures/skips (11.065 seconds). Independent actual HTTP/real-PG-lock probe expected exit 1/REPRODUCED; ordinary search, invalid-JSON refusal, post-malformed health and post-lock search recovery pass. Native Windows Python 3.14.2/PostgreSQL 16.15. Local harness import/nested-JSON expectation issues corrected before final evidence; neither is a product finding. Whitespace passes. Review/control/new ledger files only; no owner source/schema/fixtures/dependency edits.

Temporary loopback listeners/databases cleaned up, server stopped, matching processes absent. GPU worker off; no model/WSL/private/live-connector/remote/deployment work. Broad product suites unrun. P06 research DONE/v1 unchanged. Evidence: reviews/2026-10-30-codex-review-kb-http.md.

Ready transition, auto-merge attempt and final-head CI inspection follow this last ledger commit; no CI or automatic merge success is claimed here. Malcolm's merge records the handoff. Claude owns H1/H2/A1 fixes and supplies SHAs for re-verification; P09/Windows console remain queued.
