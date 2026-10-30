# Codex re-review: P02 PDF completeness follow-up

Reviewer: Codex. Date: 30 October 2026 (Europe/London).
Reviewed implementation: `2405affb62b5bff1afcbfe048a19c2d689b30c13` (PR #19).
Integrated review baseline: `18f8f5b474192daad15eaaf21ae317e27c1f0465`.
`git diff 2405aff HEAD -- foundation/modules/ocr` is empty at this baseline.
Implementation owner: Claude. Review request: issue #20, item 1, including the stated residual.

**Disposition: P02-R2 resolved for the reviewed cases; P02-R1 partially fixed, changes still
requested for the all-or-nothing safety criterion.** The original two-page image-only-page
reproduction is now refused correctly. The disclosed same-page image/text residual can
still reproduce the same confidently wrong amount even when the extra text contains no
amount at all. Keep the useful page-count and textless-page corrections.

> Follow-up: [PR27 picture re-review](2026-10-30-codex-review-P02-pictures.md) closes the demonstrated scanner-footer case and records P02-R3. The footer control now asserts Malcolm's flag-not-refuse policy and exits 0 on PR27; the exit-1 instructions below describe the historical case.

## Verified corrections

The existing [original reproducer](fixtures/p02-reproduce.mts) now exits **0**:

- valid one- and three-page text PDFs return all their lines;
- an ordinary four-page PDF is refused with `TOO_MANY_PAGES_PDF`;
- the original text page followed by the image-only taxi page is refused with
  `PARTLY_SCANNED_PDF` (P02-R1's original trigger);
- four real pages with `/Count 3` are refused with `TOO_MANY_PAGES_PDF` (P02-R2).

The same unmodified script against an external archived copy of `f63b83b` (immediately before
this follow-up) exits **1**: both original findings produce GBP 10.00 at confidence 1 with no
warning. One/three-page and ordinary four-page controls keep the expected results there.
No source checkout was reset or stashed for the comparison.

The focused suite independently passes the nested false-count, repeated-node,
object-stream-hidden-page, untyped-page and comment-in-object-header cases, plus supported
page-tree controls. The pre-scan counts page-like objects independently of declared counts;
the reader then checks distinct visited references and the count equality. This resolves
P02-R2's demonstrated omission cases. It is not a proof of every possible PDF grammar or
malformed-input variation.

## P02-R1 residual — [P1] A non-amount scanner footer restores the confidently wrong result

**Location:** `foundation/modules/ocr/src/pdfWorker.ts:394-401`;
`foundation/modules/ocr/src/pdfText.ts:70`.

**Trigger (valid two-page PDF):**

1. Page one has the text `Total GBP 10.00`.
2. Page two paints the existing fictional taxi receipt JPEG, whose actual total is GBP 12.40
   (`test/fixtures/receipts/expected.json`), and has one additional text line:
   `Scanned with PhoneScan`.
3. Both pages are listed correctly and `/Count` is 2. No malformed metadata is involved.

**Observed using the real local engine/PDF child and real `readReceipt`:**

```json
{
  "lines": [
    {"text":"Total GBP 10.00","confidence":1},
    {"text":"Scanned with PhoneScan","confidence":1}
  ],
  "amountPence":{"value":1000,"confidence":1},
  "warnings":[]
}
```

Page two has a text line, so `textless` stays zero. The PDF image is not read, the conflict
between GBP 10.00 and GBP 12.40 is lost, and `pdfText` assigns confidence 1 to the surviving
text. Staff confirmation is retained but no amount warning communicates the incomplete
reading. The same case also reproduces before `2405aff`; this is an unresolved gap, not a
new regression caused by the follow-up.

**Answer to the proposed residual disposition:** do not treat "the footer rarely carries an
amount" as enough to defer this case while calling P02 complete. The footer in this
reproduction contains no amount. Its mere presence allows the amount from another page to
remain fully confident while conflicting receipt evidence is ignored. The original harmful
outcome therefore remains possible under the disclosed condition.

**Requested correction:** conservatively refuse unsupported image-bearing evidence, or
propagate explicit incomplete-evidence metadata through every consumer and keep affected
receipt fields below `CONFIDENT`. This review does not require rendering, decoding or OCR
of PDF images, increasing the memory ceiling or relaxing the deadline. A bounded structural
refusal is a valid conservative direction; if it also refuses logos or unused image
resources, record that compatibility trade-off explicitly. A selective detector must cover
actual paint paths (including forms/inline images) rather than treating a text line as
proof of complete evidence. Claude owns the implementation and its resource-bound choice.

Required regression: the mixed PDF with a harmless scanner footer, an image-only control,
supported all-text documents, and an explicit decision/test for decorative or non-painted
image resources. Keep the existing memory/deadline/queue defences.

## Independent reproduction

New [standalone reproducer](fixtures/p02-followup-reproduce.mts), from repository root:

```powershell
./foundation/node_modules/.bin/tsc.cmd -b foundation/packages/shared
./foundation/node_modules/.bin/tsx.cmd conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/p02-followup-reproduce.mts
```

On Linux, use `tsc`/`tsx` without `.cmd`. Install dependencies from `foundation/package-lock.json`
first (`npm ci` in `foundation/`). The shared build is required for the standalone dynamic
imports; the Vitest alias alone does not build that package.

Expected exit **1** while the finding remains. The script prints three cases:

| Case | Current result |
|---|---|
| Text page plus image page without footer | Refused, `PARTLY_SCANNED_PDF` |
| Text pages with the JPEG resource present but not painted | Read; ordinary all-text control |
| Text page plus painted image and non-amount footer | UNSAFE: GBP 10.00, confidence 1, no warnings |

It builds synthetic PDF bytes in memory with a correct cross-reference table, checks the
repository's known taxi amount, and makes no network call. It accepts an optional archived
OCR directory, matching the original reproducer. It is intentionally outside CI test
collection: a green hosted suite does not close this recorded residual.

## Validation and limits

Host: Windows, Node `v24.12.0`, npm `11.6.2`, lockfile PDF.js `6.4.299`.
`npm ci --no-audit --no-fund` installed 454 packages; package/lockfiles are unchanged.

From `foundation/`:

```powershell
./node_modules/.bin/vitest.cmd run --project @hf/ocr pdf-text.test.ts -t 'a PDF is read whole or not at all|a text PDF gives|a scanned PDF is refused|a PDF that is not' --maxWorkers=1
```

**21 passed, 26 intentionally filtered out**, 6.79 seconds. This exercises the real PDF child,
not an injected classifier.

```powershell
./node_modules/.bin/vitest.cmd run --project @hf/ocr --maxWorkers=1 -t '^(?!.*the reader process is held to its memory ceiling)'
```

**323 passed, 6 intentionally filtered out, zero failed**, seven files, 17.22 seconds.
The six excluded tests depend on Linux `/proc` memory/exit observations. Windows does not
supply those semantics, so this review makes no claim that those watchdog checks passed.
Compression-bomb pre-scan cases and the other included OCR checks pass. The earlier Linux
watchdog results stay historical; no production ceiling/deadline setting was changed.

Standalone original reproduction: current exit **0**; archived `f63b83b` exit **1**.
New footer reproduction: current and archived `f63b83b` exit **1** with the same unsafe amount.
The external baseline shares the current lockfile dependencies through a local junction;
only its archived OCR source/test tree differs. It is a controlled source comparison, not a
reproduction of an earlier operating-system installation.

No OCR-owned implementation/test file changed. Full Foundation database/browser/image checks,
full Conductor, Azure, real uploads and production deployment were not run. Existing server
queue source (`queue.ts:106-107`) still maps `UnreadableError` to an unreadable status,
`proposal: null` and its actionable message; this mapping was source-read, not re-exercised
through the browser. Native Windows OCR reading here does not certify Linux watchdogs or
the separate native Windows Conductor acceptance packet.

## Handoff

Claude: retain the fixed P02-R2 controls and the useful per-page refusal, then address or
explicitly seek Malcolm's disposition on the demonstrated P02-R1 residual. The work-log P02
row stays CHANGES_REQUESTED until that happens. No live-model or cloud-OCR scope is needed
to reproduce or conservatively fix this case. Codex's next independent task after this
review merges is retrieval-contract review (K6 unblock), followed by P04/P06/P09 reviews.
