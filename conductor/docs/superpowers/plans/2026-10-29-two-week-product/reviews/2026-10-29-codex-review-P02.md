# Codex review: P02 PDF completeness

**Reviewer:** Codex. **Date:** 29 October 2026 (client date). **Reviewed change:**
`f188ec154ca3eb567dbf457a3b171004d9eb120d`. **Integrated baseline:** `f23057b`.
`git diff f188ec1 f23057b -- foundation/modules/ocr` is empty.

**Disposition: changes requested for the safety acceptance criterion.** The ordinary
page-limit defect is fixed: valid one- and three-page text PDFs read fully, and ordinary
four- and 200-page PDFs are refused. I reproduced the original failure and the fix.
Two other incomplete-read cases still produce an unwarned amount at confidence 1.
Both also reproduce before P02; these are remaining gaps, not regressions introduced by Claude.
Do not revert the useful page-limit fix. Claude owns the follow-up implementation.

## Findings

### P02-R1 — High: an image-only page silently disappears from a mixed PDF

**Location:** `foundation/modules/ocr/src/pdfWorker.ts:282`–288;
`foundation/modules/ocr/src/pdfText.ts:66`–67.

**Trigger:** a valid two-page PDF has `Total GBP 10.00` as text on page one and
an image of the fictional taxi receipt on page two. That image contains a different
`Total to pay £12.40` (the repository fixture and its expected.json establish the value).
There are two page-tree children and `/Count 2`; no malformed metadata is needed.

**Observed:** the real local engine returns only page one's line. `readReceipt`
then returns `amountPence: {value: 1000, confidence: 1}` and `warnings: []`.
The scanned-page refusal tests the **combined** lines array, so text on another
page masks a page that supplied no readable text. The omitted receipt's amount/date
never enters the conflict checks. Human confirmation still exists, but the field is
presented as confident and the missing evidence is undisclosed.

**Correction:** make completeness a per-page decision. Conservatively refuse unsupported
scanned content (or carry explicit incomplete evidence through every consumer and cap
all affected fields below CONFIDENT). Distinguish known blank pages if retaining them;
simply collecting some text somewhere in the document is insufficient. Include a mixed
text/image regression and a supported all-text control. Keep this work inside the
existing isolated reader and retain the memory/deadline limits. This does not require
adding OCR of PDFs to the milestone.

### P02-R2 — Medium: an understated page-tree count bypasses the new limit

**Location:** `foundation/modules/ocr/src/pdfWorker.ts:279`–282.

**Trigger:** generate the same four-page text fixture used by P02, with four `/Kids`
references and a corrected `GBP 100.00` total on page four. Change the top-level
`/Count 4` to `/Count 3`. This is malformed page metadata; the same-width edit leaves
all cross-reference offsets valid. It is a separate case from a valid four-page PDF.

**Observed:** PDF.js 6.4.299 reports three pages, the worker visits exactly those three,
and the real local engine plus `readReceipt` again returns 1000 pence at confidence 1,
with no warning. Declared counts of 1 and 2 also silently omit reachable pages in the
exploratory probe. A correct count of 4 is refused. PDF.js's `checkLastPage()` only
recounts after an error reaching the declared last page; an understated count can
reach that page successfully. `doc.numPages` is therefore not independent evidence
that the entire page tree was accounted for.

**Correction:** validate completeness with a bounded check of the reachable page tree
and reject inconsistent/unverifiable metadata, including nested count mismatches.
Do not merely regex-count `/Page` tokens or raise MAX_PAGES. Keep validation under
existing process, memory and time limits and stop once the safe page limit is exceeded.
If the available parser cannot establish this safely, fail closed. Add an understated
count regression alongside the ordinary four-page and valid one/three-page controls.

## Reproduction

From the repository root, using the installed lockfile dependencies:

```sh
foundation/node_modules/.bin/tsx \
  conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/p02-reproduce.mts
```

The [checked-in reproducer](fixtures/p02-reproduce.mts) uses the real local engine and
its normal PDF child process, then the real `readReceipt`. It creates synthetic bytes
in memory; the photographed receipt is an existing fictional fixture. It makes no
network/model calls, changes no source or files, closes the engine, and returns exit 1
while the two unsafe results remain. It prints:

```text
1 page: all pages read
3 pages: all pages read
4 pages: refused with TOO_MANY_PAGES_PDF
mixed text and scanned page: UNSAFE, amountPence={value:1000,confidence:1}, warnings=[]
understated page count: UNSAFE, amountPence={value:1000,confidence:1}, warnings=[]
```

For the before-fix comparison, I copied current OCR src/test into an external temporary
directory, replaced **only that copy's** pdfText.ts and pdfWorker.ts with `git show
f188ec1^:<path>`, and symlinked the installed dependencies. No working checkout was reset
or stashed. The same reproducer accepts that OCR directory as an argument. Both findings
also reproduce there; the ordinary four-page control additionally returns the original
confidently wrong result. This separates the useful fix from the remaining gaps.

## Checks and limits

Host: cloud Debian 13, Node 24.19.0, npm 11.9.0, PDF.js 6.4.299. Commands below run from
`foundation/`, with the retained development environment helper sourced:

- `npx vitest run --project @hf/ocr pdf-text.test.ts extract.test.ts read-receipt.test.ts --maxWorkers=1`:
  **255 passed**, exit 0 (45.34 s).
- `npx vitest run --project @hf/ocr --maxWorkers=1`: **316 passed** across seven files,
  exit 0 (47.97 s). Existing compression-bomb, both independent memory watchdogs,
  stalled-parent, repeated-read cleanup, timeout and queue tests were retained and run.
- Current P02 page-boundary tests against the external before-fix source copy:
  **3 failed / 2 passed / 29 intentionally filtered out**, exit 1. Both supported-size
  controls pass; the corrected-total/date and long-document cases fail as Claude reported.
- From `conductor/`, with the retained development helper sourced:
  `python3 /workspace/shingon-dev/reap.py node --test --test-concurrency=4`:
  **1,559 passed / 0 failed/skipped/cancelled**, exit 0 (69.91 s).
- Checked-in real-engine reproducer: **two unsafe results**, exit 1 on current main and
  before-fix source; these are expected review failures, not passing safety tests.

Code read confirms `finally` destroys the PDF.js task even on the new early refusal;
child process settings, queue, 20 MB input bound, 4 MB reply bound, 3 s deadline and
320 MiB watchdog threshold are unchanged. The server reading queue already maps an
UnreadableError to `status: unreadable`, `proposal: null` and its userMessage; the
web form displays that problem. No real upload-through-browser test was run for this review.
No new memory-limit regression was reproduced. Sampled watchdog ceilings allow the existing
overshoot tolerance; they are not a hard instantaneous RSS reservation.

Known predictor amplification, repeated references, scanned JBIG2/CCITT wording and
other items in factory-acceptance/FOLLOW-UPS.md remain acknowledged deferrals. Neither
finding above is one of those listed deferrals. This review does not approve Azure,
other receipt parsing, Conductor shipping, native Windows or live models. No production
implementation, OCR-owned test, dependency, CI or gate was edited. Required hosted CI
will validate the documentation/reproducer PR against the integrated tree; its green
checks cannot close these intentionally reproduced safety findings.
