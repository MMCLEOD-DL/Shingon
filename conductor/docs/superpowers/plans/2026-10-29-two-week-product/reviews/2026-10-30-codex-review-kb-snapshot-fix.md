# Codex re-review: KB-R5 snapshot correction (PR44)

Date: 30 October 2026 (Europe/London). Reviewer: Codex. Correction owner: Claude.
Correction: `b32a9d63db88a3e0c344e1b831a5e6363cf503f4` (PR44).
Reviewed baseline: `dfaaf6cb1b9854a0e6a6e8953f63266e4a136d2f` (PR45 merged).

**Disposition: KB-R5 resolved for the reviewed evidence/revision race.** The independent
revocation reproducer passes current source and still fails pre-correction source. The
whole read uses a consistent snapshot; a failed read rolls back its audit and the connection
can be reused. No new blocking finding in this correction. KB-R6/R7 and remaining K6/K8
admission requirements stay open; this is not v1 freeze or deployment approval.

## Correction verified

`KnowledgeService._snapshot()` starts a repeatable-read transaction before scope/group
queries and commits after the read, rolling back exceptions from the body. Search calls
its internal `_revision()` with the same scope/groups instead of entering a separate public
revision read. Collections, passage, original lookup and standalone view_revision use the
same snapshot boundary. Rows are fetched inside it; no later lazy cursor constructs a
response from a different view.

This covers scope, candidate/reference ACLs, versions, destinations and the returned digest
within one request. An independent writer may commit a revocation or replacement during
the request, but it cannot label the earlier evidence with that later view's revision.
The next read sees the change. Public methods no longer commit from inside nested revision
calculation, which would have broken the enclosing snapshot.

Reviewed: `knowledge/src/shingon_knowledge/service.py:235–250,259–309,310–355,359–398,405–430`;
`knowledge/tests/test_reference_privacy.py`, `SnapshotCoherence`.

## Independent race and regression sensitivity

The retained [two-connection probe](fixtures/kb-view-snapshot-review.py) commits finance
membership revocation after candidate retrieval and before revision calculation. No result
rows, policy outcomes or SQL are substituted. On the corrected source:

```json
{"connection_default_isolation":"read committed","explicit_snapshot_control":false,
 "positive_control_contains_document":true,"fresh_search_contains_document":false,
 "raced_search_contains_document":true,"raced_revision_matches_current_revoked_view":false,
 "wire_checker_accepts":true,"result":"NOT_REPRODUCED"}
```

The default connection remains read committed outside the operation; the product itself
now establishes the per-read repeatable snapshot. No diagnostic isolation override was
used. Earlier evidence is still returned under its earlier snapshot, while the fresh request
correctly excludes it and has a different revision. The normal regression suite explicitly
asserts equality between the raced revision and the pre-revocation revision.

The same probe using archived pre-PR44 service source `0205e37` yields **exit 1** and
`REPRODUCED`: old evidence again carries the current revoked view's digest. Current source
exits **0**. Both use the same dependency installation, PostgreSQL server and synthetic
corpus. No source checkout was reset.

The normal real-DB suite additionally covers replacement during search and changes between
collection/passage statements. These tests preserve both old-view and fresh-view controls,
not merely a changed hash or absence of an exception.

## Exception and connection-reuse control

New [rollback/reuse control](fixtures/kb-snapshot-cleanup-review.py) lets the real search
insert its audit record, then raises a synthetic exception after the revision SQL executes.
It verifies that the failure propagates, no audit insert remains pending, per-transaction
isolation is reset and the same connection successfully serves the next search. **Exit 0.**
The exception is injected at the execution boundary; rollback and subsequent queries use
real PostgreSQL. Product code is not patched by this control.

The core owns the connection/transaction for each call, including committing prior work
before setting isolation. This review does not establish safety for multiple concurrent
requests sharing one connection or reads nested in caller-owned write transactions. K6
must supply appropriate connection ownership/serialisation. Network loss, commit failure
and database/pool recovery outside this exercised body exception were not fault-injected.

## Validation and reproduction

Native Windows, Python 3.14.2 with UTF-8 mode and pinned knowledge dependencies; PostgreSQL
16.15 using the existing isolated portable runtime. Temporary synthetic cluster bound only
to loopback and stopped normally after runs; process absence checked. GPU worker remains
off. No WSL, model, connector, private input, HTTP layer, remote DB or deployment was used.

From repository root with installed knowledge package and a disposable TEST_DATABASE_URL
whose role can create test databases:

```powershell
$env:PYTHONUTF8='1'
python -m unittest discover -s knowledge/tests -v
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-view-snapshot-review.py
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-snapshot-cleanup-review.py
```

- Knowledge suite: **39 passed, zero failures/skips**, 4.139 s.
- Independent default-connection revocation probe: **exit 0**, no mismatched revision.
- Same probe against `0205e37`: **expected exit 1**, old mismatch reproduced.
- Rollback/reuse probe: **exit 0**, audit rolled back, default isolation restored, next read succeeds.
- `git diff --check` passes before submission. Review artifacts/ledger only; no owner source,
  tests, contract, fixture JSON or dependency edits. Broad Conductor/Foundation/UI suites unrun.

The retained race output now calls the observed outer connection setting
`connection_default_isolation`, avoiding the implication that it describes the product's
inner transaction. The explicit diagnostic override remains optional; it was not needed
for this correction's passing result. Standalone controls remain outside CI discovery.

## Handoff

Close KB-R5 at the reviewed baseline. Retain earlier KB-R1/R2/R3 and P02/P04 closures.
KB-R6's passage-fixture identity mismatch and KB-R7's durable cleanup/retry remain with
Claude, as do runtime K6 delivery/cache integration and K8 policy enforcement gates. In
particular original-byte delivery still needs K6's delivery-time reauthorisation; returning
a Path from this core is not an HTTP delivery guarantee. No v1 freeze is granted here.
P09 and the Windows console follow-up remain queued, along with supplied correction reviews.
Merge records the bounded closure, not release or live acceptance authority.


Integration note: PR46/main `4d1893a` was merged during submission. It changes the passage fixture/test, not the snapshot service. KB-R6's correction is now supplied and awaiting independent re-review; KB-R5's closure stays pinned to `dfaaf6c` and the results above. Both lanes' ledger histories are preserved.
