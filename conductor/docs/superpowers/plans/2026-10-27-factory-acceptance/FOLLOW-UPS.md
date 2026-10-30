# Plan 12 follow-ups (recorded 2026-10-29)

Plan 12 built foundation v0.2.0 (released locally as tag `v0.2.0`, not pushed) and Conductor's acceptance kit
(merged to master). These items were found in review and deliberately left for later. None blocks the
acceptance run.

## Operator checks (need real devices or accounts)

- Photograph printed fictional receipts into the foundation's `photos/` folder and re-run the modest-box check.
- On a real iPhone: a 48 MP HEIC photo uploads and reads.
- A long portrait till roll, downsized to 2,000 px, still reads (raise the cap to 3,000 px only if it fails).
- Only if an Azure account is ever set up: confirm the resource's real region matches `OCR_AZURE_REGION`, and
  measure "confidently wrong" on Azure readings.
- Before the first contract: a solicitor's check of the ownership and licence terms (§5a).

## Foundation (next release)

- Receipt reading: a VAT table whose net plus VAT disagrees with the total should also cap the total;
  "of which VAT £x" and "Includes VAT of £x" after the total cause an unnecessary "Please check"; a header date
  next to a "Delivered" date is ambiguous.
- PDF reading: the pre-scan budget can be bypassed by predictor amplification and repeated references (the two
  memory watchdogs still hold it at about 385 MB); scanned JBIG2/CCITT PDFs say "couldn't be opened" rather than
  "scanned picture"; an object stream containing the word "stream" is refused; `engine.read()` still reads PDFs
  after `close()`; a tesseract error while its model loads can't be caught without patching tesseract.js.
- Cloud fallback: count fallbacks for the ops monitor (`/readyz` details or a log watch).
- Readings queue: no test for re-reading a reading reset while in flight; a failed finish during the start-up
  load skips loading the rest.
- Phone pages: no error boundary when the lazy receipt chunk fails to download; after a 90-second run of server
  errors with no reading, "You can type the details now" shows with no form; date/merchant focus untested.
- Exports: `sendReport` passes no app name to the PDF; a subtotal can land alone at the top of a page; the
  one-at-a-time export lock has no timeout.
- Ops: mixed CRLF/LF lines in `.env`; a relative `OPS_WORK_DIR` isn't checked by set-env; set-env's lock check
  doesn't pass `DOCKER_CONFIG`; the file lock's stale-takeover has a rare race; the crash handlers in `cli.ts`
  aren't exercised end to end.
- Smoke and images: the modest-box run doesn't use production's `--read-only`/`--cap-drop`; the export side
  hasn't run inside the image; the vite "no modules" fallback rule has no test.

## Conductor

- ~~`PROTECTED_PATHS` for the v0.2.0 layout (modules, app jobs, receipt pages).~~ Done 30 October 2026: see the work log, Claude task 12.
- When Plans 9/10 read the box through `update --json` / `status --json`, map the new `unknown` update outcome to
  `lost-contact`.
- The acceptance checker doesn't flag a hand-made commit after the approved version (C15 stays the operator's).
