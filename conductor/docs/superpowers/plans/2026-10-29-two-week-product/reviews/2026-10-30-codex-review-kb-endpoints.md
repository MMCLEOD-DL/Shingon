# Codex review: KB endpoint and request contract (PR39)

Date: 30 October 2026 (Europe/London). Reviewer: Codex. Correction owner: Claude.
Correction: `fee43f026a6d4f7fb7cdba637de66e5acd74149a` (PR39).
Reviewed baseline: `41fc4ccd8eb1c12360c95eb9874fdaad2742cf56` (PR42 merged, includes PR41).

**Disposition: changes requested for KB-R6, an inconsistent successful passage fixture.**
The previously missing route families and request/error shapes are now present. Examined
core lookup/ACL and request-refusal controls pass. The fixture's request/focus identity must
be corrected before accepting it as the v1 dispatch oracle. Existing KB-R5 remains open;
this review neither duplicates nor closes that snapshot finding. No HTTP service was run.

> Follow-up: [PR46 fixture re-review](2026-10-30-codex-review-kb-fixture-fix.md) closes KB-R6. The retained endpoint control now reports MATCH/exit 0 on corrected fixtures; the mismatch below describes the historical baseline.

## KB-R6 — [P2] The positive passage fixture's focused chunk is not the requested chunk

Location: `knowledge/tests/test_contract_fixtures.py:125–134`, `_passage()`;
`knowledge/contract/kb-contract-v1.json:940–974`, `passage-neighbours`.

Trigger: replay the committed successful `GET /passages/:chunkId` fixture and compare the
requested opaque ID with the response passage marked `focus`.

Observed:

```text
request: 8c5c5e3a9d6e96ca1141b4d3d9e03c5700295c3b28218091eae7c01d005303c8
focus:   51d71a22b886e67db6d09cff0701d051fa01d309aa67254b6ef634075b1c6e46
```

The response passes `check_passage_body()` and the generated-fixture equality test, but it
contains no focused passage with the ID requested by its own route. This contradicts the
route's promise that exactly one passage is the one asked for. K6 consumers/tests cannot
use that fixture to establish exact opaque-ID lookup semantics.

Cause: `_passage()` rewrites returned IDs as `_stand_in(fid, i)` but independently rewrites
the request path as `_stand_in(fid, "path")`. The generator preserves two different hashes
rather than preserving identity between the request and the focused result. Regeneration
repeats the same inconsistency, so a green equality check does not detect it.

Requested correction (Claude): normalise each real chunk ID through one consistent mapping
for both request and response, or derive the request stand-in from the focused result's
stand-in. Assert before and after normalisation that the decoded requested ID equals the
single focused chunk ID. Regenerate/review the fixture and add a request/response relational
regression. Retain opaque IDs, bounded neighbours and missing/hidden refusal controls; do
not weaken the check by dropping the focus identity requirement.

Evidence: [kb-endpoint-contract-review.py](fixtures/kb-endpoint-contract-review.py) reads
the committed fixture, calls the real shape checker and independently compares request
identity to focus identity. It prints `MISMATCH` and exits **1** while KB-R6 remains.
This is a fixture-contract defect, not a demonstrated runtime cross-document/data leak.

## Core and request controls that pass

With a real disposable PostgreSQL database, the same review script searches a visible
expense policy, expands its real opaque chunk ID, and asserts:

- The focused chunk equals the requested chunk; document/collection/version identity agrees
  with the original hit; expansion with one neighbour returns at most three passages.
- The finance-only salary passage is refused to Andy, Bella and the project-scoped Conductor
  credential. An opaque ID does not bypass principal, tenant or collection scope checks.

The real core satisfies these controls. That separates KB-R6's fixture normalisation error
from the underlying lookup. The normal suite also replays generated collection/passage/
health/original fixtures, scoped counts, versions, revocation and the labelled retrieval set.

Independent parser controls accept an ordinary scoped keyword request, reject boolean/
out-of-range limits, wrong-typed collections and a caller-supplied principal, and explicitly
refuse hybrid mode/nonempty filters as `unsupported`. These refusals do not silently run a
broader query. The normal suite additionally covers request-ID format and error shapes.

The retained pure dispatcher validates **39 fixture shapes** across search, collections,
passages, health, errors, originals and the operator report. This proves applicable body
checks, not request/response relationships or future HTTP authentication/rate limiting.
The latter distinction is exactly why KB-R6 escaped the existing shape tests.

## Admission boundaries retained

KB-R4's missing route/request coverage is substantially supplied by PR39, but its successful
passage example needs KB-R6's correction before the fixture set is accepted as coherent.
No v1/K6 freeze is granted. The following also remain separate gates:

- **KB-R5**: evidence/revision snapshot consistency is still faulty. The retained real-DB
  revocation control still reproduces under default read committed. Collection and passage
  methods use the same separate data/revision assembly pattern; the owner's correction must
  cover those read paths as well, not just search. That extension is source-read here, not
  a newly executed race for each route.
- **K6 transport**: enforce raw request/response byte limits, authentication, HTTP dispatch,
  encoded path handling, error/503 mapping and delivery-time reauthorisation. There is no
  HTTP layer yet. Authored 401/413/429/503 examples do not implement those behaviours.
- **K8**: registration, operator-only withheld routing and destination-policy freshness at
  each hop remain runtime requirements despite accepted report shapes.
- **PR41**: authoritative complete/partial sync semantics have arrived but need their own
  review. This task adapts only review controls to its required `complete` argument.

## Validation and reproduction

Native Windows, Python 3.14.2 with UTF-8 mode, pinned knowledge dependencies; PostgreSQL
16.15 in an isolated loopback cluster using the prior portable runtime. Every test database
and connection is cleaned up; the temporary server was stopped and process absence checked.
GPU worker remains off. No private data, model, live connector, remote database or deployment.

From repository root with the installed knowledge package and a disposable TEST_DATABASE_URL
whose role can create databases:

```powershell
$env:PYTHONUTF8='1'
python -m unittest discover -s knowledge/tests -v
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-contract-review.py
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-endpoint-contract-review.py --database
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-view-snapshot-review.py
```

- Knowledge suite: **36 passed, zero failures/skips**, 3.751 s.
- Pure shape/strict-value/report controls: **39 fixture shapes pass**, exit 0.
- New endpoint control: **expected exit 1** for KB-R6; parser and real core identity/denied-
  principal controls pass before that final status.
- Retained KB-R5 control: **expected exit 1**, same revoked-evidence/current-revision mismatch.
- `git diff --check` passes before submission. Broad Foundation/Conductor/UI and HTTP/browser
  suites unrun for this review-only change. No owner source, fixture JSON or tests rewritten.

The first custom DB probe stopped on PR41's new required `complete` argument. The review
scripts were adapted to explicitly name the complete synthetic manifest collections, then
rerun successfully through all controls. This is API compatibility, not a fix for KB-R5.
Standalone reproductions remain outside CI discovery; green CI does not close KB-R5/R6.

## Handoff

Claude owns KB-R6's fixture/generator correction and KB-R5's existing snapshot correction.
Accept the demonstrated core/request controls while keeping KB-R4 fixture admission held
for KB-R6. Preserve all earlier KB/P02/P04 closures. Next peer review is PR41 sync semantics;
P09 and the Windows console follow-up remain queued. Merge records this handoff, not a
contract freeze, source correction or release approval.
