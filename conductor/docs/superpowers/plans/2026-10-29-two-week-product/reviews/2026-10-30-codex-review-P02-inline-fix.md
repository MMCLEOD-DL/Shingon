# Codex re-review: P02-R3 inline-image detection (PR36)

Date: 30 October 2026 (Europe/London). Reviewer: Codex. Correction owner: Claude.
Correction: `380aeb91badbbc2b21b875bd2432c836483d4256` (PR36).
Reviewed baseline: `cac0a4c9dd79280b7f1146d7d613700bfd60c437` (PR38 merged).

**Disposition: P02-R3 resolved for the demonstrated inline-header boundary.** No new blocking
finding in this correction. Retain Malcolm's flag-not-refuse decision, prior P02-R1/R2
closures and the existing limits. The examined P02 work is DONE; this does not certify
every PDF grammar, Linux watchdog behaviour on Windows or full browser/cloud acceptance.

## Correction verified

`pdfWorker.ts` replaces the two 4,096-character inline-header regexes with operator-token
scanning. Finding `BI` marks a picture before looking for `ID`, so a long or incomplete
header cannot turn picture detection back off. The header is examined for a literal filter
key; matching filtered inline data retains the existing refusal. Image data is skipped to
`EI` before continuing. The scanner remains conservative about BI-looking text: a false
positive can ask staff to check, rather than claim ignored evidence was completely read.

The enclosing decoded-stream budget, 20 MB input bound, three-page limit, reader deadline,
queue and memory ceilings are unchanged. Supported image-bearing text retains the warning
and capped line confidence; textless-page and over-page-count refusals remain active.
This review does not prove the token scanner is a complete PDF parser or every encoding of
an inline filter is refused; it verifies the reported whitespace boundary and the retained
exercised defences.

Reviewed locations: `foundation/modules/ocr/src/pdfWorker.ts:34–40,254–278,368–370`;
`foundation/modules/ocr/test/pdf-text.test.ts` and `test/helpers.ts` padded inline controls.

## Independent controls

The retained [boundary control](fixtures/p02-picture-boundary-reproduce.mts) now requires a
picture warning and every non-null proposed field below CONFIDENT (0.85), rather than only
looking for the previous exact confidence-1/no-warning combination. It also includes a
100,000-space compressed-header case. Independent PDF.js operator lists confirm one actual
image paint in each fixture before the real local engine reads it.

| Inline header | Content stream | Image paints | Amount confidence | Picture warning |
|---|---|---:|---:|---|
| Ordinary | plain | 1 | 0.6 | present |
| 5,000 extra spaces | plain | 1 | 0.6 | present |
| 5,000 extra spaces | Flate | 1 | 0.6 | present |
| 100,000 extra spaces | Flate | 1 | 0.6 | present |

Current exit: **0**. With the same strengthened control against archived pre-PR36 OCR
source `7e4ce83`, exit is **1**: the ordinary-header control passes, and all three padded
cases return confidence 1 with no warning. Only source differs; the installed lockfile
dependencies and synthetic input generator are shared. No checkout was reset.

The unchanged original page-count control exits **0**: supported one/three-page text is
read; normal and false-count four-page documents are refused; mixed text/image-only pages
are refused. The strengthened scanner-footer control also exits **0**, retaining warning
propagation and low confidence for both painted and deliberately unused image resources.

## Validation and limits

Native Windows, Node 24.12.0; locked PDF.js 6.4.299 and Vitest 5.0.5. Local launch wrapper
only hides child consoles; product code is unchanged. From `foundation/`:

```powershell
./node_modules/.bin/vitest.cmd run --project @hf/ocr --maxWorkers=1 -t '^(?!.*the reader process is held to its memory ceiling)'
```

**335 passed, 6 intentionally excluded, zero failures**, seven files, 20.57 s. The six
excluded checks need Linux `/proc` memory observations; they are not claimed passed here.
Claude's Linux watchdog evidence remains separately recorded. Included stream-budget,
deadline, queue, page-tree, textless-page and filtered-inline refusal tests pass, including
plain/Flate padded headers and the ordinary-header positive controls.

From repository root (existing shared package build and Foundation dependencies required):

```powershell
./foundation/node_modules/.bin/tsx.cmd conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/p02-reproduce.mts
./foundation/node_modules/.bin/tsx.cmd conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/p02-followup-reproduce.mts
./foundation/node_modules/.bin/tsx.cmd conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/p02-picture-boundary-reproduce.mts
```

All three exit **0** on current source; boundary backtest exits **1** on `7e4ce83` as above.
`git diff --check` passes before submission. No OCR-owned source/test, manifest, policy or
resource limit changed. Full Foundation/DB/browser suites, real uploads, cloud OCR, models
and deployment were unrun. Inputs are synthetic; the one-pixel inline image proves detection,
not OCR of a receipt image. The local GPU worker remains off; no database was started.

## Handoff

Close P02-R3 at the reviewed baseline and retain the previous demonstrated P02-R1/R2
closures. P02's examined work is DONE within these evidence limits. No new correction is
requested from Claude for this finding. Next supplied peer review is PR37's viewRevision
and withheld-report semantics; P09 and the Windows console runtime follow-up remain queued.
Merging this review records the bounded closure, not release or live acceptance approval.
