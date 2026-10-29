# Task 8: PDF export

**Repo: `/root/highland-foundation`. Needs the operator's answer to Operator question 1 before Step 1.**

The same `MoneyReport` as Task 7, laid out as an A4 PDF that looks finished enough to hand a finance manager (spec §2.3). No arithmetic happens here (Ruling 4). The tests read the PDF back with `pdfjs-dist` and look for the exact figures from the worked examples.

**Files:**
- Create: `modules/pdf-export/src/pdf.ts`, `modules/pdf-export/src/winAnsi.ts`
- Create **only if the exception is refused**: `modules/pdf-export/src/writer.ts`
- Modify: `modules/pdf-export/src/index.ts`, `modules/pdf-export/package.json`, `apps/server/package.json` (dependency `@hf/pdf-export`), `apps/server/src/modules/exports/reply.ts` (the PDF branch), `licence-exceptions.json` (only with the operator's approval), `CHANGELOG.md`
- Test: `modules/pdf-export/test/pdf.test.ts`, `modules/pdf-export/test/win-ansi.test.ts`, `modules/pdf-export/test/helpers/pdfText.ts`; extend `apps/server/test/export-reply.test.ts`

**Interfaces:**
- Consumes: `MoneyReport`, `formatCell`, `formatPounds` (Task 7); the worked examples `W1_MARCH`, `W2_LARGE`, `W3_AWKWARD` (`packages/shared/test/worked-examples.ts`); `sendReport` (Task 7).
- Produces: `renderPdf(report, opts?): Promise<Buffer>`, `toWinAnsi(text): string`.

Layout:
- A4 portrait, 40 pt margins, Helvetica 9 pt for rows, Helvetica-Bold for headings, group rows, subtotals and the total.
- Page header on **every** page: `opts.appName` (if given), `title`, `periodLabel`; then the column labels.
- Money columns right-aligned; text wraps within its column (never runs into the next); a row never splits across pages.
- After each group: `Subtotal: <label>` with its money subtotals. After the last group: `Total` with the totals, on the **last page only**.
- Footer on every page: `Generated <generatedAtText>` on the left, `Page N of M` on the right.
- All text goes through `toWinAnsi`: characters outside Windows-1252 become `?` (Review Focus 4). `£` and `é` are inside Windows-1252, so they print as themselves.

- [ ] **Step 1: Install (one of two paths)**

**If the operator approved the exception:**
```bash
npm -w @hf/pdf-export i pdfkit@0.20.2
npm -w @hf/pdf-export i -D pdfjs-dist@6.4.299
```
Add exactly the operator-approved entry from Operator question 1 to `licence-exceptions.json`, with the date of approval. Then `npm run licences` → PASS.

**If the exception is refused:** install only `pdfjs-dist@6.4.299` (dev) and write `writer.ts`. It is a minimal PDF 1.4 writer with no dependencies:
- objects, an xref table and a trailer;
- the standard Helvetica and Helvetica-Bold fonts with `WinAnsiEncoding`;
- text placement, and lines for the table rules;
- content streams compressed with `node:zlib` `deflateSync`;
- text width measured from the Helvetica AFM widths for Windows-1252, as two 256-entry tables in `writer.ts`. Those widths come from Adobe's Core 14 AFM files, which may be copied and distributed for any purpose as long as the copyright notice is kept, so put that notice in the file's header comment.

`renderPdf` then calls `writer.ts` instead of pdfkit; everything else in this task is the same.

- [ ] **Step 2: Write the failing tests**

`modules/pdf-export/test/helpers/pdfText.ts`: `pdfPages(buf): Promise<string[][]>`, the text items of each page in reading order (with `pdfjs-dist/legacy/build/pdf.mjs`, `isEvalSupported: false`).

`modules/pdf-export/test/pdf.test.ts`:

```ts
test('W1: the figures on the page are the figures the app computed', async () => {
  const pages = await pdfPages(await renderPdf(buildMoneyReport(W1_MARCH), { appName: 'Acme Expenses' }));
  const all = pages.flat();
  expect(pages).toHaveLength(1);
  expect(all).toEqual(expect.arrayContaining(['March 2026 expenses', '12/03/2026', 'Northside Taxis', '£12.40', '£2.07']));
  expect(seq(all, ['Subtotal: Office', '£0.30', '£0.05'])).toBe(true);
  expect(seq(all, ['Subtotal: Subsistence', '£32.74', '£5.46'])).toBe(true);
  expect(seq(all, ['Subtotal: Travel', '£60.60', '£9.57'])).toBe(true);
  expect(seq(all, ['Total', '£93.64', '£15.08'])).toBe(true);
  expect(all).toContain('Page 1 of 1');
});

test('W2: many pages, a header on each, the total once on the last', async () => {
  const pages = await pdfPages(await renderPdf(buildMoneyReport(W2_LARGE)));
  expect(pages.length).toBeGreaterThanOrEqual(3);
  for (const [i, p] of pages.entries()) {
    expect(p).toContain(W2_LARGE.title);
    expect(p).toContain(`Page ${i + 1} of ${pages.length}`);
  }
  expect(pages.flat().filter((t) => t === 'Total')).toHaveLength(1);
  expect(seq(pages.at(-1)!, ['Total', '£246,912.00', '£41,152.00'])).toBe(true);
  expect(pages.flat().filter((t) => t === '£1,234.56')).toHaveLength(200);    // no row lost or split across a page break
});

test('W3: awkward text never breaks the document', async () => {
  const all = (await pdfPages(await renderPdf(buildMoneyReport(W3_AWKWARD)))).flat().join(' ');
  expect(all).toContain('=HYPERLINK("http://x","click")');
  expect(all).toContain('?ód? Café ?');
  expect(all).toContain('-£5.00');            // Windows-1252 has no U+2212, so toWinAnsi prints a hyphen-minus
  expect(seq(all.split(' '), ['Total', '£10.50', '£1.76'])).toBe(true);
});

test('the PDF is the same every time for the same report (no random ids)', async () => {
  const r = buildMoneyReport(W1_MARCH);
  expect((await renderPdf(r)).equals(await renderPdf(r))).toBe(true);
});
```

(`seq(items, wanted)` is true when `wanted` appears as consecutive items.)

`win-ansi.test.ts`: `toWinAnsi('Café £5 – “quotes”')` is unchanged (all in Windows-1252); `toWinAnsi('Łódź 🍕')` is `'?ód? ?'` (the emoji is one `?`, not two); `toWinAnsi('−5')` is `'-5'`; control characters are removed.

`export-reply.test.ts` adds: `format: 'pdf'` → `Content-Type: application/pdf`, `attachment; filename*=UTF-8''March%202026%20expenses.pdf`, body starts with `%PDF-`.

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run modules/pdf-export apps/server/test/export-reply.test.ts` → FAIL.

- [ ] **Step 4: Implement** `toWinAnsi` and `renderPdf` (layout above). With pdfkit: `new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { CreationDate: report generatedAt, Producer: 'Highland' } })` so output is repeatable; draw page footers at the end with `switchToPage`. Measure with `widthOfString` to right-align and wrap.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run modules/pdf-export apps/server` → PASS. `npm run verify` → PASS (licences included).
Open the W1 PDF once (`npx tsx -e` writing to `/tmp/w1.pdf`) and look at it: it must look like a finished report.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(exports): PDF export of the money report, pinned by the same worked examples

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
