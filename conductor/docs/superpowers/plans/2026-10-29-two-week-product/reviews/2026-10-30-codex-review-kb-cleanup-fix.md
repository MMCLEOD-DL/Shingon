# Codex re-review: KB-R7 durable original cleanup (PR47)

Date: 30 October 2026 (Europe/London). Reviewer: Codex. Correction owner: Claude.
Correction: `fa5ca906c42746e2427f0ac7512a7ec3a9a2240a` (PR47).
Reviewed baseline: `9f9d3d68dcd930e4da52766d726aafd5611f3c7a` (PR49/50 merged).

**Disposition: KB-R7 resolved for the reviewed cleanup/retry path.** Native Windows testing
with a real open file confirms immediate logical revocation, truthful pending status,
durable cleanup tracking and successful retry through a fresh connection/service. The
pre-fix source still reproduces the stranded-file defect. No new blocking finding here.
This is a core cleanup closure, not v1 freeze, HTTP delivery or deployment approval.

## Correction verified

Migration 003 adds `purge_pending` and `purge_error`. Logical deletion removes chunks,
marks the source deleted and preserves the version's original path with pending cleanup.
Its event now distinguishes removal from read access from physical file deletion.

After that transaction commits, `_purge()` attempts physical removal. An operating-system
failure leaves the path/pending state intact, records the error and emits `cleanup-pending`.
Only successful removal (or an already absent file) clears the path/pending/error and emits
`purged`. Every later sync retries pending versions, including ones whose source was already
deleted; `purge_originals()` provides the explicit retry path. No in-memory queue is needed.

Reviewed: `knowledge/src/shingon_knowledge/service.py:97–171,250–258`, migration
`003_original_cleanup.sql` and `OriginalCleanup` in `knowledge/tests/test_permissions_and_sync.py`.
The forward correction does not establish a repair sweep for files already orphaned by
pre-fix tombstones whose paths were lost. No such sweep or private-data inventory was run.

## Independent native Windows control

The retained [sync control](fixtures/kb-sync-review.py) is strengthened beyond the old
three-boolean failure detector. It uses real filesystem handles and PostgreSQL; it does
not patch `os.remove` to simulate the Windows refusal.

While the synthetic original is held open:

- Logical deletion is counted, and search, passage and original access are denied.
- The file remains on disk, its exact path/pending/error are committed in the database,
  and `cleanup_status()` identifies the blocked version.
- A pending event is present; that locked version has no `purged` success event. An older,
  unheld version may be removed independently, which does not excuse the blocked version.

After releasing the handle, the control replaces both the database connection and service.
The fresh connection sees the same pending record. A later sync removes the bytes, clears
pending state and records `purged`, even though its logical deletion count is zero. Reads
remain denied. **Result: `FIX_VERIFIED`, exit 0.**

The old source and original probe, archived together from pre-PR47 `4d1893a`, still produce
**`REPRODUCED`, expected exit 1** on the same native host: deletion is reported, the file
survives, and the later sync fails to retry. Dependency/runtime versions and synthetic inputs
are shared; no source checkout or owner fixture is rewritten.

The ordinary no-lock deletion, empty partial listing and explicitly failed-source read
controls remain passing. The normal suite separately covers mixed held/unheld originals,
a later-sync retry and constructing a new service to retry persisted pending work.

## Validation and limits

Native Windows, Python 3.14.2 UTF-8 mode, pinned knowledge dependencies; PostgreSQL 16.15 in
the existing isolated loopback runtime. Test databases/connections cleaned up, temporary
server stopped normally and process absence checked. GPU worker remains off. No model,
private input, connector, WSL, remote database, HTTP layer or deployment.

From repository root with installed knowledge package and disposable TEST_DATABASE_URL
whose role can create test databases:

```powershell
$env:PYTHONUTF8='1'
python -m unittest discover -s knowledge/tests -v
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-sync-review.py
```

- Knowledge suite: **42 passed, zero failures/skips**, 4.362 s.
- Native locked-file/fresh-connection retry and retained positive controls: **exit 0**.
- Archived original probe/source `4d1893a`: **expected exit 1**, old defect reproduced.
- `git diff --check` passes before submission. Review artifacts/new ledger entries and the
  single P06 status-evidence row only; no owner source, tests, fixture JSON or dependencies
  changed. Broad Foundation/Conductor/UI and HTTP/browser acceptance were unrun.

The native lock section explicitly skips off Windows; a non-Windows skip is not evidence
of KB-R7 closure. Fresh connection/service reconstruction proves persisted state rather
than reuse of an in-memory queue. Abrupt host/database power loss, disk-full/database-write
failures and concurrent purge workers were not separately fault-injected. Source ordering
leaves committed pending state before unlink and treats an already absent file as success;
this review does not claim exhaustive crash testing.

## Handoff

Close KB-R7 at this baseline. Keep KB-R1–R6 and prior P02/P04 closures. Wider P06 research
corrections in PR32 still need their own re-review; P09 and Windows console follow-up remain
queued. K6 transport/delivery/cache connection ownership and K8 runtime policy enforcement
remain separate implementation/admission work. No automatic v1 freeze or release approval.
Merge records this bounded closure.
