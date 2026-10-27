# Task 7: Money reports and spreadsheet export

**Repo: `/root/highland-foundation`.**

Spec §2.2: report totals and VAT sums must be proven with known worked examples. Ruling 4: **exports never calculate**. `buildMoneyReport` (in `@hf/shared`, so the screen can use it too) computes every subtotal and total once in integer pence; `renderXlsx` lays it out; Task 8's `renderPdf` lays out the same model.

The worked examples live in one file, `packages/shared/test/worked-examples.ts`, which this task's tests and Task 8's tests both import.

**Files:**
- Create: `packages/shared/src/report.ts`, `packages/shared/test/worked-examples.ts`
- Create: `modules/xlsx-export/src/xlsx.ts`, `apps/server/src/modules/exports/reply.ts`
- Modify: `packages/shared/src/index.ts`, `modules/xlsx-export/src/index.ts`, `modules/xlsx-export/package.json` (dependencies `@hf/shared`, `write-excel-file`; devDependency `read-excel-file`), `apps/server/package.json` (dependency `@hf/xlsx-export`), `CHANGELOG.md`
- Test: `packages/shared/test/report.test.ts`, `modules/xlsx-export/test/xlsx.test.ts`, `apps/server/test/export-reply.test.ts`

**Interfaces:**
- Consumes: `Pence`, `formatPounds`, `sumPence`, `MoneyError` (Task 1).
- Produces: `ReportColumn`, `ReportInput`, `MoneyReport`, `buildMoneyReport`, `formatCell` (`@hf/shared`); `renderXlsx` (`@hf/xlsx-export`); `sendReport` (index), and the worked examples `W1_MARCH`, `W2_LARGE`, `W3_AWKWARD` with their expected figures.

Rules for `buildMoneyReport`:
- every `money` cell must be a safe integer (pence), else `MoneyError` with `Row 3, column "VAT" is not a whole number of pence.` (1-based row);
- every `date` cell must be `YYYY-MM-DD` and a real day;
- groups by `groupBy` (missing → one group with `label: null`), sorted by label with `localeCompare(…, 'en-GB')`; rows within a group by date, then input order;
- `subtotals` and `totals` contain every money column, summed with `sumPence`;
- `generatedAtText` is `generatedAt` in `Europe/London` as `27 October 2026, 14:05`.

Spreadsheet layout (`renderXlsx`), one sheet named after `title` (each of `[]:*?/\` replaced by a space, runs of spaces collapsed, trimmed, then cut to 31 characters):
- row 1: `title`; row 2: `periodLabel`; row 3: `Generated <generatedAtText>`; row 4 empty;
- row 5: column labels, bold;
- then for each group: a bold group heading row (when grouped), its rows, and a bold `Subtotal: <label>` row with each money subtotal;
- then a bold `Total` row; money cells are numbers (`pence / 100`) with format `£#,##0.00`; dates are real dates with format `dd/mm/yyyy`; text cells are strings (never formulas);
- totals are **values, not formulas** (Ruling 4).

## Worked examples (`worked-examples.ts`)

**W1_MARCH**: "March 2026 expenses", grouped by `category`. Columns `date` (date), `person` (text), `category` (text), `merchant` (text), `gross` (money, label "Total"), `vat` (money, label "VAT").

| date | person | category | merchant | gross | vat |
|---|---|---|---|---|---|
| 2026-03-02 | Alice Example | Travel | Fictional Rail Ltd | 320 | 0 |
| 2026-03-05 | Alice Example | Subsistence | Corner Café | 875 | 146 |
| 2026-03-12 | Ben Sample | Travel | Northside Taxis | 1240 | 207 |
| 2026-03-19 | Ben Sample | Subsistence | Harbour Deli | 2399 | 400 |
| 2026-03-23 | Alice Example | Travel | Fuel Stop | 4500 | 750 |
| 2026-03-30 | Ben Sample | Office | Paper & Pens | 10 | 2 |
| 2026-03-31 | Ben Sample | Office | Paper & Pens | 20 | 3 |

Expected (worked by hand): groups in the order **Office, Subsistence, Travel**.
- Office: gross 30 (£0.30), VAT 5 (£0.05). The 10p + 20p rows are the floating-point trap.
- Subsistence: gross 3274 (£32.74), VAT 546 (£5.46).
- Travel: gross 6060 (£60.60), VAT 957 (£9.57). Includes the spec's "£12.40 receipt with £2.07 VAT … in March's report under Travel".
- **Total: gross 9364 (£93.64), VAT 1508 (£15.08).** Seven rows.
- Every row's VAT equals `vatFromGross(gross, 2000)` except the train (zero-rated): a separate assertion, so the example itself is checked.

**W2_LARGE**: 200 rows, all `2026-04-01`, category `Equipment`, gross 123456 (£1,234.56), VAT 20576 (£205.76). Expected total **£246,912.00**, VAT **£41,152.00**. It pins thousands separators and, in Task 8, page breaks.

**W3_AWKWARD**: four rows, ungrouped:
- merchant `=HYPERLINK("http://x","click")`, gross 1000, VAT 167;
- merchant `Łódź Café 🍕`, gross 450, VAT 75;
- a 200-character merchant name, gross 100, VAT 17;
- a refund, merchant `Corner Café (refund)`, gross −500, VAT −83.

Expected total gross 1050 (£10.50), VAT 176 (£1.76).

- [ ] **Step 1: Install**

```bash
npm -w @hf/xlsx-export i write-excel-file@4.1.1
npm -w @hf/xlsx-export i -D read-excel-file@9.3.12
npm run licences
```
Expected: PASS.

- [ ] **Step 2: Write the failing tests**

`packages/shared/test/report.test.ts`:

```ts
test('W1: subtotals and totals are exact', () => {
  const r = buildMoneyReport(W1_MARCH);
  expect(r.groups.map((g) => g.label)).toEqual(['Office', 'Subsistence', 'Travel']);
  expect(r.groups.map((g) => g.subtotals)).toEqual([{ gross: 30, vat: 5 }, { gross: 3274, vat: 546 }, { gross: 6060, vat: 957 }]);
  expect(r.totals).toEqual({ gross: 9364, vat: 1508 });
  expect(r.rowCount).toBe(7);
});
test('W1: each row\'s VAT is 20% of its gross, half up (the train is zero-rated)', () => {
  for (const row of W1_MARCH.rows) if (row.merchant !== 'Fictional Rail Ltd') expect(row.vat).toBe(vatFromGross(row.gross as number, 2000));
});
test('W2: £246,912.00 and £41,152.00', () => {
  const r = buildMoneyReport(W2_LARGE);
  expect(r.totals).toEqual({ gross: 24691200, vat: 4115200 });
  expect(formatPounds(r.totals.gross!)).toBe('£246,912.00');
});
test('W3: refunds count, totals stay exact', () => {
  expect(buildMoneyReport(W3_AWKWARD).totals).toEqual({ gross: 1050, vat: 176 });
});
test('a money cell in pounds is refused with the row and column named', () => {
  expect(() => buildMoneyReport({ ...W1_MARCH, rows: [{ ...W1_MARCH.rows[0]!, vat: 0.5 }] })).toThrow('Row 1, column "VAT" is not a whole number of pence.');
});
test('formatCell', () => {
  expect(formatCell({ key: 'd', label: 'Date', kind: 'date' }, '2026-03-12')).toBe('12/03/2026');
  expect(formatCell({ key: 'g', label: 'Total', kind: 'money' }, -500)).toBe('−£5.00');
});
test('generated time is shown in UK time across the clock change', () => {
  expect(buildMoneyReport({ ...W1_MARCH, generatedAt: new Date('2026-03-29T00:30:00Z') }).generatedAtText).toBe('29 March 2026, 00:30');
  expect(buildMoneyReport({ ...W1_MARCH, generatedAt: new Date('2026-03-29T01:30:00Z') }).generatedAtText).toBe('29 March 2026, 02:30');
});
```

`modules/xlsx-export/test/xlsx.test.ts` (read back with `read-excel-file/node`, and the raw sheet XML with `fflate`'s `unzipSync`):
- `'W1: the totals in the file are the totals the app computed'`: the `Total` row's two money cells are the numbers `93.64` and `15.08`; the three `Subtotal: …` rows hold `0.3`/`0.05`, `32.74`/`5.46`, `60.6`/`9.57`; and `Math.round(cell * 100)` of every money cell equals the model's pence.
- `'money is stored as exact decimals with a pounds format'`: the sheet XML contains `<v>93.64</v>` and `<v>15.08</v>`, and the style for those cells has the format code `£#,##0.00`.
- `'totals are values, not formulas'`: the sheet XML contains no `<f>` element.
- `'dates are real dates'`: the first data row's date cell reads back as `2026-03-02` (UTC midnight), with format `dd/mm/yyyy`.
- `'formula-looking text stays text'` (W3): the `=HYPERLINK(...)` merchant reads back as that exact string, and the XML stores it as a string cell (`t="s"` or `t="inlineStr"`), never `<f>`.
- `'unusual characters survive'` (W3): `Łódź Café 🍕` reads back unchanged.
- `'W2: 200 rows and the large total'`: 200 data rows; the total reads back as `246912` and `41152`.
- `'the sheet name is made safe'`: a title of `Expenses: March/April [draft]` gives the sheet name `Expenses March April draft`.

`apps/server/test/export-reply.test.ts`: a test-only Fastify route (registered in the test, through `defineRoute` with `{ permission: 'self:manage' }`) calls `sendReport(reply, buildMoneyReport(W1_MARCH), 'xlsx', 'March 2026 expenses')`; `inject` shows:
- `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`;
- `Content-Disposition: attachment; filename*=UTF-8''March%202026%20expenses.xlsx`;
- `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`;
- the body is a ZIP (starts with `PK`).
The PDF branch is tested in Task 8; until then `format: 'pdf'` throws `PDF export is not installed in this app.`

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run packages/shared/test/report.test.ts modules/xlsx-export apps/server/test/export-reply.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement** `buildMoneyReport` and `formatCell` (rules above); `renderXlsx` with `writeXlsxFile(data, { columns, sheet }).toBuffer()` from `write-excel-file/node`, using `type: Number` with `format: '£#,##0.00'` for money, `type: Date` with `format: 'dd/mm/yyyy'` for dates (built as `new Date(Date.UTC(y, m - 1, d))`), and `type: String` for text; `sendReport` (headers above; filename encoded exactly as Plan 6's file downloads do).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/shared modules/xlsx-export apps/server/test/export-reply.test.ts` → PASS. `npm run verify` → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(exports): money report model in whole pence and spreadsheet export, pinned by worked examples

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
