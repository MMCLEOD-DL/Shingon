# Codex re-review: KB privacy and document identity (PR31/34)

Date: 30 October 2026 (Europe/London). Reviewer: Codex. Correction owner: Claude.
Corrections: `4dea212` (PR31, KB-R2/R3); `5701ab9` (PR34, identity/opaque IDs/originals).
Reviewed integrated baseline: `35baba5db9bd55bc13ef9ae2bfc416ed5d5a9ee7` (PR35/36 merged).

**Disposition: KB-R1, KB-R2 and the demonstrated KB-R3 identifier disclosure are resolved
in the reviewed source.** Collection-qualified identity, opaque chunk IDs and current-only
originals satisfy the examined parts of decisions 1 and 3. **The v1 contract is still not
frozen and K6 admission remains held:** KB-R4 and the remaining decisions below are open.
This review changes no service, schema or Claude-owned contract file.

## KB-R1 and identities: resolved at the examined scope

The canonical original route uses `(collectionId, documentId, versionId)`. Each identifier
is encoded as one path segment by `contract.original_path`; the same key/version in two
collections now produces distinct URLs. The updated standalone control uses that helper
rather than recreating the obsolete collection-less route.

Real database fixture replay covers the same source key in two collections, different ACLs,
only one copy visible to a restricted principal, and the distinct original lookups. Search
results retain collection and version identity; the original lookup includes collection,
tenant, allowed scope, active status, requested current version and source ACL in its query.
It does not construct an original filesystem path from the requested source key.

The original query joins the requested current version, so an old or unknown version gets
the same not-found response as a hidden or missing document. Positive current-file fixtures
check attachment headers, fixed MIME treatment, nosniff, no-store, size and SHA256. Version
replacement and deletion/revocation tests pass. This is the core service boundary; there is
still no HTTP byte-delivery implementation or download ticket to certify.

Migration 002 gives chunks persisted public IDs from two UUIDv4 values; serial IDs remain
internal. The live database tests confirm 64-hex IDs distinct from serials and each other,
and new IDs after version replacement. Migration idempotence passes. Existing-row backfill
was source-reviewed but not independently seeded/retested here; Claude's recorded migration
check remains owner evidence. Opacity does not replace future passage-lookup ACL checks.

Reviewed: `knowledge/src/shingon_knowledge/{contract.py,service.py,migrations/002_opaque_chunk_ids.sql}`;
`knowledge/tests/{test_contract_fixtures.py,test_permissions_and_sync.py,test_reference_privacy.py}`.

## KB-R2: corrected wire refusals verified

The real checker rejects NaN/Infinity, impossible timestamps and zero versions. The negative
retryAfter case is now tested by mutating a valid wire body, because the constructor itself
correctly refuses that value. The unknown destination case is refused. The current checker
also covers malformed containers/types, strict JSON serialisation, positive page/slide
numbers, nonnegative generation and bounded retry delays in the normal test suite.

All 25 committed fixtures pass the applicable search/error/operator-report/original-header
shape checks. This includes authored examples, which remain shapes rather than implementation
evidence. The live database suite separately regenerates the generated fixture subset and
matches it to the committed artifact; the review does not equate the two forms of evidence.

The stricter destination vocabulary is useful but does not implement the separate registered
participant/application checks or fixed operator-only withheld-message semantics from decision 4.
No full request/endpoint validation or arbitrary malformed-input proof is claimed.

## KB-R3: real SQL privacy regression verified

The search query exposes the successor name through an ACL-checked lateral lookup, requiring
an active target in the same collection. The caller without the successor's ACL receives
null and the hidden name is absent from its wire result. The authorised principal still
receives the name. Conservative supersession demotion remains equal for both principals,
as requested in the original review; it is not claimed to eliminate every ranking signal.

The three real PostgreSQL two-principal tests pass on current source. Running those same
tests against archived pre-PR31 service source `5adfad9` yields **one expected failure and
two passes**: the denied caller receives `acme/expenses-policy.docx` instead of null.
This is independent regression evidence on synthetic data, not merely a SQL-text assertion.

The old review script injected an already-populated successor column after SQL execution.
That probe cannot test an authorisation fix inside SQL, so it has been retired from the pure
control. Its replacement evidence is the real database regression above. The pure control
makes no SQL privacy claim and now exits 0 after the corrected checks pass.

## Remaining freeze gates (unchanged ownership)

- Decision 1: replace tenant-wide `indexGeneration` with reviewed authorisation-view semantics;
  hidden changes still move the exposed counter. Opaque chunk IDs do not resolve this.
- Decision 2: authoritative collection-scoped sync, including deleting the last source from
  an empty complete listing; distinguish failure/partial listing and reconcile stale semantics.
- KB-R4: fixtures and validation for the complete admitted endpoint/request surface, including
  collections, passage expansion, health, 401/413 and request-ID/mode/filter semantics. Positive
  originals are now covered; this does not close the rest of KB-R4.
- Decision 4 / K8: registered destination/participant semantics, exact withheld identifiers,
  fixed messages, operator-only disclosure and current-policy revalidation on every hop.

These are already recorded contract tasks, not newly discovered regressions. Claude retains
implementation ownership. The separate wider research findings are not signed off by this
source/contract review. No deployment, client runtime access or private ingestion is approved.

## Validation and reproduction

Native Windows, Python 3.14.2 venv using the checked-in knowledge dependency pins;
PostgreSQL **16.15**, isolated synthetic cluster bound only to loopback on a temporary port.
Official portable binaries were selected via the
[PostgreSQL Windows download page](https://www.postgresql.org/download/windows/) and its
[EDB binary archive link](https://www.enterprisedb.com/download-postgresql-binaries).
Archive: `postgresql-16.15-5-windows-x64-binaries.zip`; locally recorded SHA256
`43bb45f173a6f08cf1d29a97a6d8deb119e8e8093a24c00d2d1001a0ccaa8281`.
This hash records the downloaded artifact, not an independently published checksum match.
No installer/system service was registered. The temporary server was shut down and its
process absence checked. No model, GPU worker, WSL distro or remote database was started.

From repository root, with TEST_DATABASE_URL pointing to a disposable PostgreSQL role
allowed to create test databases and the existing venv/package installed:

```powershell
$env:PYTHONUTF8='1'
python -m unittest discover -s knowledge/tests -v
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-contract-review.py
```

- Full knowledge suite with DB: **26 passed, zero failures/skips**, 2.692 s.
- Updated pure control: **25 fixture shapes and all correction probes pass**, exit 0.
- Pre-PR31 SQL privacy backtest: **3 tests, one expected failure/two passes**, exit 1.
- Initial run without a DB: seven offline tests passed, five DB classes skipped; superseded
  by the full database run, not counted as DB acceptance.
- First DB run under Windows' default cp1252: fixture replay had nine Unicode comparison
  subtest failures. Fixture loading uses `Path.read_text()` without explicit encoding.
  UTF-8 mode resolves those comparisons; no fixtures/product bytes were rewritten. Windows
  test commands need this mode until fixture I/O names its encoding explicitly.
- `git diff --check` passes before submission. The local startup harness was corrected after
  an inherited Windows output pipe blocked its first launch; only the completed run counts.

DBs, corpus and credentials were synthetic/local; no private source, live connector, model,
HTTP layer, broader Conductor/Foundation/UI suite or deployment was used. The GPU worker
remains off. The downloaded runtime is outside the checkout and is not committed.

## Handoff

Record KB-R1/R2 and the demonstrated KB-R3 disclosure as closed at this baseline, with the
scope above. Keep contract status CHANGES_REQUESTED and K6 held for the explicit remaining
gates. Next supplied peer correction is P02-R3 in PR36; P09 and the Windows console follow-up
remain queued. Merging this review accepts these bounded closures, not a v1 contract freeze.
