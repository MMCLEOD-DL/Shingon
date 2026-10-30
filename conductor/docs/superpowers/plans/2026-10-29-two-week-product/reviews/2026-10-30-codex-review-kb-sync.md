# Codex review: authoritative sync and removal (PR41)

Date: 30 October 2026 (Europe/London). Reviewer: Codex. Correction owner: Claude.
Correction: `86b5496154afde86d6dbe8725291b8d402fdbede` (PR41).
Reviewed baseline: `0205e373dd40762ff28d112bd14f52a32e861ec7` (PR43 merged).

**Disposition: explicit complete/partial listing and examined failed-read semantics pass;
changes requested for KB-R7, a reproduced Windows original-cleanup failure.** Keep the
complete-listing correction. Deletion correctly removes read access but can silently retain
stored original bytes while reporting that they were deleted. This review does not close
KB-R5/R6 or freeze v1/K6. No owner implementation or contract files were changed.

## What the complete-listing correction fixes

`sync(..., complete=[...])` explicitly names authoritative collections, including ones with
zero listed sources. Only those collections delete absent sources. Other collections remain
partial: listed sources can be added/updated while unlisted sources are retained. Unknown or
duplicate complete collections are refused before processing; omitting the required argument
is refused rather than guessing that an empty listing is complete.

The normal suite and an independent real-DB control confirm:

- An empty partial listing deletes nothing and preserves a known original and readable source.
- An empty complete listing removes the last document in the named collection. Search is
  empty, old passage and original lookups are denied, the revision changes in the normal
  suite, and the unblocked original file is actually removed.
- A specifically listed source whose file cannot be read is marked failed and disappears
  from search, passage and original access, with an actionable failed import status. It is
  not returned as stale. The rest of a partial listing is not interpreted as deletion.

The prose correctly narrows `stale` to a newer version known upstream while the indexed
version remains authorised. A local missing-file test does not establish real connector
permission refresh or propagation. An upstream listing failure must not be mislabelled as
an authoritative empty listing; `complete` is an assertion by the trusted ingestion caller,
not evidence that a connector actually read the listing/permissions successfully. Those
connector mappings remain a future live-integration obligation.

## KB-R7 — [P2] A locked original survives deletion and loses its cleanup tracking

Location: `knowledge/src/shingon_knowledge/service.py:209–217`, `_delete()`, and the
`sync()` deletion selector at line 122.

Trigger on native Windows: a normal read handle remains open on the stored original when
an authoritative empty listing deletes the collection's last document. This can occur
while a file is being read. The reproduction opens only a tiny synthetic Markdown original,
not a user file, and uses the real filesystem and PostgreSQL operations.

Observed:

```json
{"reported_deleted":true,"original_survived_delete":true,"read_api_denies":true,
 "retry_deleted":0,"original_survived_retry_after_close":true,"result":"REPRODUCED"}
```

The normal no-lock deletion control removes the original. With the open handle, Windows
refuses removal, but `shutil.rmtree(..., ignore_errors=True)` suppresses that failure. The
transaction marks the source deleted and clears every version's `original_path`; the import
event says its stored original was deleted and sync counts one deletion. After the handle
closes, another complete empty sync deletes zero sources because its selector excludes
already-deleted rows. The surviving bytes are not retried or represented as pending cleanup.

Consequence: the source is correctly unavailable through the read API, but the zero-day
physical-cleanup behaviour and success message are false. Files can remain after the
reported deletion without a durable retry path. This is not a reproduced read-authorisation
leak. The underlying `_delete()` implementation predates PR41; this is an existing defect
confirmed while reviewing the newly enabled complete-empty removal path, not a regression
attributed to the `complete` parameter itself.

Requested correction (Claude): keep logical revocation immediate even when byte cleanup
fails, preserve durable cleanup targets/pending state, expose cleanup failure accurately
and retry after the blocker clears (including across restarts). Do not reactivate a deleted
source or restore its searchability to handle a filesystem error. Add a native Windows
open-file regression or equivalent controlled filesystem-failure tests plus retry/restart
and successful-cleanup controls. Do not report physical deletion complete until it succeeds.

Evidence: [kb-sync-review.py](fixtures/kb-sync-review.py). It first asserts empty-partial,
ordinary complete-empty and failed-read behaviour, then holds the original open, runs the
real deletion and retries only after closing the handle. The probe exits **1** on this
Windows baseline. It closes handles/connections and removes its own disposable data.
The Windows-specific part is explicitly skipped on other platforms; a skip is not closure.

## Validation and reproduction

Native Windows, Python 3.14.2 venv with pinned knowledge dependencies, PostgreSQL 16.15.
Reused the isolated portable runtime, loopback-only temporary cluster and synthetic corpus.
Temporary server stopped normally; process absence checked. No GPU worker, model, WSL,
remote database, private data, connector, HTTP service or deployment was started.

From repository root with the installed knowledge package and TEST_DATABASE_URL pointing
to a disposable PostgreSQL role allowed to create test databases:

```powershell
$env:PYTHONUTF8='1'
python -m unittest discover -s knowledge/tests -v
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-sync-review.py
```

- Knowledge suite: **36 passed, zero failures/skips**, 3.574 s.
- Independent positive controls: empty partial preserves, complete empty removes the last
  source/unblocked file and denies all reads, failed source read denies all reads with a
  failed import event. **Pass**.
- Windows locked-original case: **exit 1 expected**, retained file remains after a later
  sync even after the handle closes; logical original access is denied throughout.
- `git diff --check` passes before submission. Broad Foundation/Conductor/UI suites and live
  connector/permission refresh, host crashes, filesystem faults beyond this case and HTTP
  byte delivery were unrun. No owner source/test, corpus or fixture JSON was changed.

This standalone review probe is outside CI discovery. Ordinary green tests and this review's
positive cases do not close KB-R7. Retained failed-refresh bytes are not themselves this
finding: the contract permits operational version retention while access is denied. KB-R7
concerns a source whose stored original was explicitly reported physically deleted.

## Handoff

Accept the examined complete/partial/failed-read API semantics while keeping cleanup
CHANGES_REQUESTED for KB-R7. Claude owns the durable-cleanup correction; Codex re-reviews.
Keep existing KB-R5/R6 and remaining K6/K8 gates open, along with live connector obligations.
P09 and the Windows console follow-up remain queued; newly supplied corrections retain
their own review pins. Merge records this handoff, not a contract freeze or release approval.
