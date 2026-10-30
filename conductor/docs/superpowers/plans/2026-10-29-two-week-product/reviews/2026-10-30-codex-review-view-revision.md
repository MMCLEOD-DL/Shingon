# Codex review: viewRevision and withheld-report semantics (PR37)

Date: 30 October 2026 (Europe/London). Reviewer: Codex. Correction owner: Claude.
Correction: `7ed04e4c978dbbfdbdfb72d1a8bab6b05d666290` (PR37).
Reviewed baseline: `29846e2071e381eb351aa2d550bc7f93427652ed` (PR40 merged, includes PR39).

**Disposition: changes requested for KB-R5, a reproduced search/revision snapshot race.**
Sequential view-revision privacy and fixed operator-report shape checks pass. The new digest
removes the old tenant-counter exposure in the examined sequential cases, but it must label
the same authorisation snapshot as the returned evidence before it can safely identify a
cache entry. Accept the examined operator-report shape; K8 enforcement remains separate.
The v1/K6 gate remains held. No owner source or contract file is changed by this review.

## KB-R5 — [P1] Revoked evidence can carry the current, post-revocation viewRevision

Location: `knowledge/src/shingon_knowledge/service.py`, `search()` candidate query through
its later `view_revision()` call; `view_revision()` also reads scope separately from its
digest query. Cache semantics: `conductor/docs/knowledge-base/retrieval-contract.md` §8.

Trigger, using two real database connections on the synthetic corpus:

1. Alice belongs to finance and searches for a finance-only salary document. The service
   computes scope and fetches authorised candidate rows.
2. Before that request computes its revision, a second connection commits removal of the
   finance group's members through the real `set_group_members()` operation.
3. The original search continues, recomputes scope/revision, and returns its earlier rows.

Observed under the connection's actual `read committed` isolation:

```json
{"positive_control_contains_document":true,"fresh_search_contains_document":false,
 "raced_search_contains_document":true,"raced_revision_matches_current_revoked_view":true,
 "wire_checker_accepts":true,"result":"REPRODUCED"}
```

A fresh search correctly excludes the document, but its viewRevision equals the revision
on the raced response that still contains that document. Thus the specified cache key
`(credential, viewRevision, normalised request)` cannot distinguish the stale authorised
rows from the current revoked view. A cache using that key could retain/reuse the revoked
evidence as current; checking the current revision alone would not reject it. This is a
real core-service response mismatch, not a claim that an HTTP cache or external leak has
already occurred. No HTTP/model/client implementation was run.

Cause: scope, candidates and revision are separate statements in the normal read-committed
transaction. Merely sharing a connection/transaction does not make their snapshots identical.
The test commits at a deliberate statement boundary; it uses no timing-dependent sleep,
rewritten result rows or fake SQL authorisation.

Control: running the same request under a consistent repeatable-read snapshot retains the
pre-revocation revision with the pre-revocation rows. A subsequent fresh request has the
new revision and excludes the document. The mismatch does not reproduce (exit 0). This is
an isolated diagnostic control, not a production patch or approval of an entire caching/
forwarding protocol.

Requested correction (Claude): make scope/group membership, candidate/reference ACLs,
evidence versions, destination policy and returned revision refer to one consistent view,
or use a reviewed validation/retry protocol that refuses/retries when that view changes.
Do not fix only the last digest query or replace the digest with another unbound counter.
Include revocation and document replacement between statements in real DB regressions;
keep the hidden-change invariance and destination-change controls. Document the snapshot
semantics, transaction cleanup and retry/refusal behaviour before K6 cache admission.

Reproducer: [kb-view-snapshot-review.py](fixtures/kb-view-snapshot-review.py). It uses the
real service, a disposable test database, two connections and the committed synthetic
corpus. A thin execution hook commits the second connection's revocation after candidates
have been fetched and before the audit/revision statements. It neither changes candidate
contents nor pretends an injected row proves SQL. The ordinary visible-document positive
control and fresh post-revocation denial are asserted. The wire checker accepts the raced
response, showing why shape validation is insufficient.

## What passes and is retained

- The real DB tests confirm a digest rather than a counter, hidden finance-document changes
  leaving unauthorised callers' revisions unchanged, authorised callers seeing changes,
  and destination changes moving/reverting the revision. Existing KB-R1/R2/R3 closures stand.
- `withheld_report()` builds fixed wording from its fields. Independent shape controls refuse
  free-form messages, duplicate/empty document lists, invalid participant names and extra
  excerpt fields. The generic participant notice contains none of the fixture's restricted
  IDs. The examined **operator-only report shape is accepted**.
- Registration of actual participants/apps, exact runtime withheld identifiers, operator-only
  routing and current destination-policy checks on every planning/review/fallback hop remain
  K8 implementation requirements. These are not discharged by a pure report builder/checker.
- PR39's newer collections/passages/health fixtures pass their shape dispatch in the retained
  pure control. Their full request/endpoint semantics need a separate review. This review
  does not freeze KB-R4 or sign off authoritative empty/failed sync semantics.

## Validation and reproduction

Native Windows, Python 3.14.2 venv, checked-in knowledge dependency pins, PostgreSQL 16.15.
Reused the isolated portable runtime from the prior review; temporary synthetic cluster
bound only to loopback on an unused port, stopped normally after every run. Process absence
checked. No system service, GPU worker, WSL distro, model, private input, remote database,
connector, HTTP layer or deployment was started.

With the installed knowledge package and TEST_DATABASE_URL pointing to a disposable role
allowed to create test databases, from repository root:

```powershell
$env:PYTHONUTF8='1'
python -m unittest discover -s knowledge/tests -v
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-contract-review.py
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-view-snapshot-review.py
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-view-snapshot-review.py --repeatable-read-control
```

Results:

- Knowledge suite: **33 passed, zero failures/skips**, 3.441 s.
- Pure control: **39 fixture shapes** and strict-value/identity/report probes pass, exit 0.
  Dispatcher now includes PR39's new shapes; that is compatibility evidence, not endpoint
  admission. Positive fixtures are not weakened or regenerated.
- Default-isolation race: **exit 1 expected**, reproduced revoked rows carrying current digest.
- Repeatable-read diagnostic control: **exit 0**, old rows retain old digest; fresh read denies.
- `git diff --check` passes before submission. Broad Conductor/Foundation/UI suites unrun
  for this review-only change. UTF-8 mode retains the Windows fixture-I/O requirement already
  documented in the prior review.

The race fixture is outside normal test discovery, so green CI does not close KB-R5. It
cleans up its database/connections; the launcher shuts down the temporary server. Output
contains only synthetic identifiers and booleans, not excerpts, credentials or private data.

## Handoff

Claude owns KB-R5's source/transaction correction; Codex re-reviews its exact evidence.
Decision 1 remains CHANGES_REQUESTED until returned revisions and evidence share a coherent
snapshot. Decision 4's examined shape is accepted; K8 policy/forwarding enforcement stays
open. Keep the earlier KB-R1/R2/R3 closures. PR39 endpoint review, P09 and the Windows console
follow-up remain queued. Merge records this handoff, not v1 freeze or deployment approval.
