# Task 3: Local OCR engine and the receipt corpus

**Repo: `/root/highland-foundation`.**

This task turns images and PDFs into `OcrResult`s on the box itself, with Tesseract (LSTM) through `tesseract.js` (see the index's engine choice). It also builds the **receipt corpus**: fictional receipts rendered to images, plus, once the operator has made them, photos of printed fictional receipts. The corpus measures the whole chain (engine + Task 2's extraction) against Ruling 2.

**Files:**
- Create: `modules/ocr/src/types.ts` (`OcrInputType`, `EngineFields`, `OcrResult`, `OcrEngine`, `UnreadableError`), `modules/ocr/src/local.ts`, `modules/ocr/src/pdfText.ts`, `modules/ocr/src/readReceipt.ts`, `modules/ocr/src/bench.ts` (library function plus a CLI: `node modules/ocr/dist/bench.js <dir> [--today YYYY-MM-DD] [--json <file>]`)
- Create: `modules/ocr/test/fixtures/make-receipts.ts` (renders `templates/*.html` with Playwright Chromium to `receipts/rendered/*.png` and `*.jpg`; run by hand, outputs committed), `modules/ocr/test/fixtures/templates/*.html`, `modules/ocr/test/fixtures/receipts/rendered/*`, `modules/ocr/test/fixtures/receipts/pdf/{e-ticket.pdf,scanned.pdf}`, `modules/ocr/test/fixtures/receipts/expected.json`, `modules/ocr/test/fixtures/receipts/photos/README.md` (how the operator adds photos; the folder starts empty)
- Create: `modules/ocr/vitest.accuracy.config.ts`
- Modify: `modules/ocr/package.json` (dependencies), `modules/ocr/src/index.ts`, root `package.json` (script `"test:ocr": "vitest run -c modules/ocr/vitest.accuracy.config.ts"`, and `verify:full` runs it after `test:e2e`), root `vitest.config.ts` (the `modules/ocr` project excludes `**/*.accuracy.test.ts`), `CHANGELOG.md`
- Test: `modules/ocr/test/local.test.ts`, `modules/ocr/test/pdf-text.test.ts`, `modules/ocr/test/read-receipt.test.ts`, `modules/ocr/test/corpus.accuracy.test.ts`

**Interfaces:**
- Consumes: `extractReceipt`, `OcrLine` (Task 2); `ReceiptProposal`, `CONFIDENT` (`@hf/shared`).
- Produces: `OcrEngine`, `OcrResult`, `EngineFields`, `OcrInputType`, `UnreadableError`, `createLocalEngine`, `localEngineOptions`, `readReceipt`, `benchCorpus`, `BenchReport` (signatures in the index), and `writeAccuracyReport(r: BenchReport, file: string): Promise<void>` in `bench.ts`. The test helpers `fixturesDir(rel)` and `hasImages(dir)` live in `modules/ocr/test/helpers.ts`.

- [ ] **Step 1: Install (pins from the pre-flight)**

```bash
npm -w @hf/ocr i tesseract.js@7.0.0 @tesseract.js-data/eng@1.0.0 pdfjs-dist@6.4.299
npm run licences
```
Expected: licences PASS (all three trees are permissive). If not, stop and ask the operator.

- [ ] **Step 2: Build the rendered corpus**

Eight templates in `templates/`, each a fictional receipt as plain HTML and CSS with a monospace "thermal" look. Their values are the first seven rows of Task 2's table plus `smudged`:
`cafe`, `taxi`, `supermarket`, `fuel`, `train`, `hotel`, `restaurant`, `smudged`.

`make-receipts.ts` renders each one at 80 mm width and 300 dpi to two variants:
- `<name>-clean.png`: straight, black on white;
- `<name>-photo.jpg`: rotated 2.5°, low contrast, with an SVG `feTurbulence` grain over it, JPEG quality 70, about 1500 px on the long side, to look like a phone snapshot.

`expected.json` maps each file name to `{ amountPence, vatPence, date, merchant }`. `pdf/e-ticket.pdf` is the train receipt as a text PDF (rendered with Chromium's `page.pdf()`); `pdf/scanned.pdf` is the same receipt as an image-only PDF.

Run it once: `npx tsx modules/ocr/test/fixtures/make-receipts.ts`. Commit the outputs. Nothing in `npm test` renders; the tests only read committed files.

- [ ] **Step 3: Write the failing tests**

`modules/ocr/test/local.test.ts` (part of `npm test`; two images only, to keep `verify` quick):

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createLocalEngine, localEngineOptions, UnreadableError, type OcrEngine } from '../src/index.js';

let engine: OcrEngine;
const fx = (p: string) => readFileSync(new URL(`./fixtures/receipts/${p}`, import.meta.url));
beforeAll(async () => { engine = await createLocalEngine({ workers: 1, timeoutMs: 60_000 }); }, 120_000);
afterAll(async () => { await engine.close(); });

test('the model is read from disk, never downloaded', () => {
  const o = localEngineOptions();
  expect(path.isAbsolute(o.langPath)).toBe(true);
  expect(existsSync(path.join(o.langPath, 'eng.traineddata.gz'))).toBe(true);
  expect(o.cacheMethod).toBe('none');
  expect(o.langPath).not.toMatch(/^https?:/);
});

test('a clean receipt is read with its total in the lines', async () => {
  const r = await engine.read({ bytes: fx('rendered/taxi-clean.png'), type: 'image/png' });
  expect(r.engine).toBe('local-tesseract');
  expect(r.lines.map((l) => l.text).join('\n')).toMatch(/12\.40/);
  expect(r.lines.every((l) => l.confidence >= 0 && l.confidence <= 1)).toBe(true);
}, 60_000);

test('a photo-like JPEG is read', async () => {
  const r = await engine.read({ bytes: fx('rendered/cafe-photo.jpg'), type: 'image/jpeg' });
  expect(r.lines.length).toBeGreaterThan(3);
}, 60_000);

test('HEIC is refused with a sentence staff can act on', async () => {
  await expect(engine.read({ bytes: Buffer.from('....ftypheic'), type: 'image/heic' })).rejects.toThrow(UnreadableError);
  await expect(engine.read({ bytes: Buffer.from('....ftypheic'), type: 'image/heic' })).rejects.toMatchObject({
    userMessage: "Photos in HEIC format can't be read automatically. Please type the details, or take the photo again from this page.",
  });
});

test('engine identity', () => {
  expect(engine).toMatchObject({ id: 'local-tesseract', kind: 'local', outboundId: null });
});
```

`modules/ocr/test/pdf-text.test.ts`:
- `'a text PDF gives its lines with confidence 1'`: `engine.read({ bytes: e-ticket.pdf, type: 'application/pdf' })` has a line matching `/Total £3\.20/` and every confidence `1`.
- `'a scanned PDF is refused'`: `scanned.pdf` rejects with `UnreadableError` and `userMessage` `This PDF is a scanned picture, so it can't be read automatically. Please type the details.`
- `'a PDF that is not a PDF inside is refused, not a crash'`: `Buffer.from('%PDF-1.7 junk')` rejects with `UnreadableError` (`This PDF couldn't be opened. Please type the details.`).

`modules/ocr/test/read-receipt.test.ts` (no engine; fake `OcrResult`s):
- `'engine fields win, and lines fill the gaps'`: `fields: { amountPence: { value: 1240, confidence: 0.97 } }` with lines that give VAT 2.07 and a date → amount from the engine fields, VAT and date from the lines.
- `'an engine field still goes through the VAT cross-check'`: engine `vatPence 270` with total `1240` → confidence below `CONFIDENT` and the mismatch warning from Task 2.
- `'engine warnings are kept'`: `warnings: ['x']` appears in the proposal's warnings.

`modules/ocr/test/corpus.accuracy.test.ts` (only in `npm run test:ocr`):

```ts
test('the rendered corpus meets the bar', async () => {
  const r = await benchCorpus(engine, fixturesDir('receipts/rendered'), '2026-03-31');
  writeAccuracyReport(r, 'reports/ocr-accuracy.md');                // plain-English table per field and per file
  for (const f of ['amount', 'vat', 'date', 'merchant'] as const) expect(r.perField[f].confidentlyWrong).toBe(0);   // Ruling 2
  const clean = r.cases.filter((c) => c.file.endsWith('-clean.png'));
  expect(clean.filter((c) => c.right.amount).length).toBe(clean.length);                    // every clean total right
  expect(r.cases.filter((c) => c.right.amount).length / r.cases.length).toBeGreaterThanOrEqual(0.75);
}, 900_000);

test('operator photos, when present, are never confidently wrong', async () => {
  const dir = fixturesDir('receipts/photos');
  if (!hasImages(dir)) return;                                      // the folder starts empty (operator follow-up)
  const r = await benchCorpus(engine, dir, '2026-03-31');
  writeAccuracyReport(r, 'reports/ocr-accuracy-photos.md');
  for (const f of ['amount', 'vat', 'date', 'merchant'] as const) expect(r.perField[f].confidentlyWrong).toBe(0);
}, 900_000);
```

A field counts as **right** when it equals `expected.json`, **wrongFlagged** when wrong with confidence below `CONFIDENT`, **confidentlyWrong** when wrong at or above it, **missing** when `null`. The merchant is right when the expected merchant is contained in the proposal, ignoring case.

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run modules/ocr/test/local.test.ts modules/ocr/test/pdf-text.test.ts modules/ocr/test/read-receipt.test.ts`
Expected: FAIL (`createLocalEngine` not defined).

- [ ] **Step 5: Implement**

- `local.ts`, `createLocalEngine(opts)`:
  - a `tesseract.js` scheduler with `opts.workers ?? 1` workers, each `createWorker('eng', OEM.LSTM_ONLY, { ...localEngineOptions(), logger: undefined })`;
  - `localEngineOptions()` resolves `@tesseract.js-data/eng/4.0.0_best_int` with `createRequire(import.meta.url).resolve('@tesseract.js-data/eng/package.json')`;
  - recognise with page segmentation `PSM.SINGLE_COLUMN` (receipts are one column) and `rotateAuto: true`; map Tesseract's lines to `OcrLine` with confidence ÷ 100;
  - images are passed only as `Buffer`; JPEG, PNG and WebP are accepted; HEIC throws the `UnreadableError` above;
  - a job longer than `timeoutMs` terminates that worker, starts a fresh one, and throws `UnreadableError("This receipt took too long to read. Please type the details.")`;
  - `close()` terminates the scheduler.
- `pdfText.ts`: `pdfjs-dist/legacy/build/pdf.mjs`, `getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false })`; read at most the first 3 pages; group text items into lines by their y position; no text → the "scanned picture" error; a load error → "couldn't be opened".
- `readReceipt(result, today)`: run `extractReceipt(result.lines, { today })`, then replace each field the engine supplied, then re-run the VAT cross-check on the final amount and VAT (export the cross-check from `extract.ts` as `checkVat(amount, vat, lines)` so both paths share it).
- `bench.ts`: for each image or PDF in the folder with an `expected.json` entry, `engine.read` then `readReceipt`, score each field, time each case. The CLI prints the report as JSON and exits 0; Task 10 runs it inside the image.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run modules/ocr` → PASS.
Run: `npm run test:ocr` → PASS, and read `reports/ocr-accuracy.md`. If a clean receipt's total is wrong, fix the extraction rules or the template's realism; **never** loosen the `confidentlyWrong === 0` assertion.
Run: `npm run verify` → PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(ocr): local Tesseract engine (offline model), PDF text layer, rendered receipt corpus and accuracy report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
