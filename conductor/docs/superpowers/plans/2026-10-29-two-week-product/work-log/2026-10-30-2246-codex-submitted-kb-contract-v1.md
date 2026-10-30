# Codex task submitted — retrieval contract v1 acceptance

Owner/co-acceptor Claude; reviewer/co-acceptor Codex. Status: submitted for Malcolm's merge.
Branch: `codex/accept-kb-contract-v1`.
Last artifact SHA: `312f170de372b66956f5a73974e027d19722fb80`.
Reviewed main: `15a559b1ea41d09b29f0443fa1c4ef08e75693d4`; candidate PR52 `aef2189bd45195318a0521a93e10077bc34bdd7b`.
PR: https://github.com/MMCLEOD-DL/Shingon/pull/54

Accept retrieval contract and 39 fixtures as v1 under task27's explicit handoff. Status/acceptance and obsolete draft wording only; all fixture payloads and other JSON fields unchanged (32 generated, seven authored). K6's contract-acceptance dependency is met, not its implementation/admission. P06 stays IN_REVIEW; research R4 sentence and D3/D4 remain open separately.

Evidence: native Windows Python 3.14.2 / PostgreSQL 16.15; 42 knowledge tests pass, zero failures/skips (4.248 s). Independent wire, endpoint --database and native held-file/fresh-connection retry controls exit 0. UTF-8 semantic fixture comparison, post-status endpoint control and whitespace pass. Temporary loopback database stopped and matching process absence verified; GPU worker off. No live/private/model/connector/remote/HTTP/deployment acceptance. Broad product suites unrun for docs/status only.

K6 auth, limits/errors, checked serialization, path decoding, request ids, delivery-time reauthorisation and K8 participant/destination/policy/report enforcement remain mandatory implementation gates. No runtime or release approval. K3/K4/K5/K13 remain separate. Evidence: reviews/2026-10-30-codex-review-kb-contract-v1.md.

Changed paths do not match the risk gate. Ready transition, auto-merge attempt and final-head CI inspection follow this last ledger commit; no CI or automatic-merge success is claimed here. Next action: Malcolm reviews/merges PR54; K6 can then be separately claimed. P09/Windows console follow-up remain queued.
