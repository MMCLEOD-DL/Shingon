# Codex re-review: P02 picture-confidence correction (PR27)

Date: 30 October 2026 (Europe/London). Reviewer: Codex. Implementation owner: Claude.
Correction: `ec6ddd8f0e3dad5d24e805e6fde12fc41c154729` (PR27).
Integrated baseline: `740d355f0f074353aa62ce531f274ff5ca555da8` (PR30/31 merged).

**Disposition: the recorded scanner-footer case is resolved; changes requested for one
remaining picture-detection boundary (P02-R3).** Retain the correction and Malcolm's
recorded decision to flag pictures while keeping supported text readable. P02-R1's
previously demonstrated footer case and P02-R2's page-count cases pass. This is a bounded
source/engine review, not proof that every PDF grammar is handled or a browser acceptance run.

## Verified corrections

- The real local engine returns the original scanner-footer PDF's text with confidence 0.6;
  `readReceipt` retains the picture warning and every non-null proposed field is below
  `CONFIDENT` (0.85). The GBP 10.00 amount is a flagged proposal, not an OCR reading of the
  photographed GBP 12.40 receipt. That matches the recorded flag-not-refuse decision.
- The same warning/cap applies to the unused image resource. This is the deliberate
  compatibility trade-off, not a reason to remove detection.
- A textless picture page remains refused with `PARTLY_SCANNED_PDF`. One/three-page text
  PDFs remain readable; ordinary four-page and false-count four-page cases remain refused.
- Existing tests cover ordinary painted/unused/inline pictures, all-text confidence, worker
  replies, extraction and warning propagation. Local line confidence is capped before
  extraction; local warnings reach the proposal through `readReceipt`.

The retained footer reproducer now explicitly requires the warning, checks all non-null
fields below 0.85, and only accepts the expected textless-page refusal. Its current exit is
0. Against pre-PR27 source `77a9419` in an external archived OCR tree, it exits 1 at the
missing-picture-warning assertion. Both use the same installed lockfile dependencies.
The original page-count reproducer also exits 0 on current source.

## P02-R3 — [P2] Whitespace beyond the inline-image lookahead bypasses the picture flag

Location: `foundation/modules/ocr/src/pdfWorker.ts:36,341` (`INLINE_IMAGE` and its use).

Trigger: a valid one-page PDF contains one unfiltered inline image followed by text
`Total GBP 10.00`. Insert 5,000 spaces after `BI`, before `/W 1 /H 1 /CS /G /BPC 8 ID`.
The stream has a correct length and the PDF has a correct cross-reference table. The same
case also works when that content stream is Flate-compressed.

Observed through the real local engine and `readReceipt`:

| Case | PDF bytes | PDF.js image paint operations | Proposed amount confidence | Warnings |
|---|---:|---:|---:|---|
| Ordinary inline header | 650 | 1 | 0.6 | picture warning |
| Header with 5,000 extra spaces | 5,652 | 1 | 1 | none |
| Same padded header, Flate content stream | 681 | 1 | 1 | none |

Independent PDF.js `getOperatorList()` confirms an actual image paint operation in every
case, so this does not rely on a string resembling an image operator. The fixture is a
one-pixel grey image, not a decoded receipt; it demonstrates the missing warning/cap, not
an observed wrong monetary value in that image. No large image, compression bomb or
resource-limit bypass is required to reproduce this finding.

Cause: the bounded `BI`-to-`ID` expression cannot match beyond 4,096 characters. No image
XObject or JPEG filter is present to set the flag by another route, so `pictures` remains
false and `readPdf` gives the retained text confidence 1 with no warning. The enclosing
stream is already decoded within the existing budget; ordinary PDF whitespace changes
the safety outcome. This leaves the explicit any-picture policy incomplete.

Requested correction (Claude): detect the inline-image start conservatively or parse its
header within existing resource limits and mark uncertainty as incomplete evidence. Do
not merely increase the lookahead to another fixed value and assume the boundary is gone.
Keep the flag-not-refuse policy for supported text, existing stream budgets, watchdogs,
page-count checks and textless-page refusals. Add regressions for long whitespace in
unfiltered and Flate content streams, alongside the ordinary inline and all-text controls.

Standalone evidence: [p02-picture-boundary-reproduce.mts](fixtures/p02-picture-boundary-reproduce.mts).
It asserts that PDF.js paints the picture, asserts the ordinary-header flag as a positive
control, then prints the two unflagged cases and exits **1** while this finding remains.
It is outside CI discovery; green existing tests do not close the boundary finding.

## Validation

Host: Windows, Node 24.12.0; existing locked PDF.js 6.4.299 and Vitest 5.0.5 installation.
Local launcher sets child processes to `windowsHide: true`; product source is unchanged.
From `foundation/`:

```powershell
./node_modules/.bin/vitest.cmd run --project @hf/ocr --maxWorkers=1 -t '^(?!.*the reader process is held to its memory ceiling)'
```

**328 passed, 6 intentionally excluded, zero failures**, seven files, 18.73 seconds.
The excluded watchdog tests require Linux `/proc` memory observations. They were not
passed on Windows; the existing Linux owner evidence remains separate. Included pre-scan,
compression-bomb, deadline and queue tests pass. No ceilings or deadlines changed.

From repository root, with the existing shared package built and Foundation tooling installed:

```powershell
./foundation/node_modules/.bin/tsx.cmd conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/p02-reproduce.mts
./foundation/node_modules/.bin/tsx.cmd conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/p02-followup-reproduce.mts
./foundation/node_modules/.bin/tsx.cmd conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/p02-picture-boundary-reproduce.mts
```

Exits: **0**, **0**, **1 expected for P02-R3**, respectively. The updated footer control
against archived `77a9419` exits **1**, as expected before the picture correction.
`git diff --check` passes before submission. No OCR-owned implementation/test file changed.
Full Foundation DB/browser suites, real uploads, Azure/cloud OCR, live models and deployments
were not run. New fixture inputs are synthetic and generated in memory; no private input.

## Handoff

P02 remains CHANGES_REQUESTED solely for the newly reproduced P02-R3 in this review.
The prior demonstrated scanner-footer failure is closed by PR27; retain its controls and
warning behaviour. Claude owns the detector correction; Codex re-reviews the exact evidence.
P04 PR29, retrieval-contract PR31 and P09 remain separate review backlog. The recorded
Windows console follow-up is a separate Codex implementation task.
