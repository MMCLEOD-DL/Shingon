# Task 2: Receipt field extraction

**Repo: `/root/highland-foundation`.**

This is the heart of "numbers must be correct" for OCR (spec §2.2, §2.5). It is a **pure function** from recognised lines to a proposal with confidences, so it is tested exactly and fast, with no engine involved. Task 3 then measures the whole chain on images.

The safety rule is Ruling 2: **never confidently wrong.** When the rules are unsure, the confidence must fall below `CONFIDENT` (0.85) so the form says "Please check".

**Files:**
- Create: `packages/shared/src/receipts.ts` (types, `CONFIDENT`, `ConfirmReadingInput`, `IsoDate`, `correctedFields`, `ReadingView`)
- Create: `modules/ocr/src/extract.ts`, `modules/ocr/src/money-tokens.ts`, `modules/ocr/src/dates.ts`
- Create: `modules/ocr/test/text-fixtures/*.txt` (the cases below; one recognised line per line, optionally followed by a TAB and the line's confidence 0–1, default 0.95)
- Modify: `packages/shared/src/index.ts`, `modules/ocr/src/index.ts`, `modules/ocr/package.json` (dependency `@hf/shared`)
- Test: `modules/ocr/test/extract.test.ts`, `packages/shared/test/receipts.test.ts`

**Interfaces:**
- Consumes: `Pence`, `toPence`, `vatFromGross` (Task 1).
- Produces: `ReceiptField`, `Scored`, `ReceiptProposal`, `CONFIDENT`, `ConfirmReadingInput`, `ConfirmedReceipt`, `correctedFields`, `ReadingView`, `IsoDate` (`z.iso.date()` plus a check that the day exists) in `@hf/shared`; `OcrLine` and `extractReceipt` in `@hf/ocr`.

- [ ] **Step 1: Write the text fixtures**

All merchants, addresses, numbers and VAT numbers are fictional. Each file's expected values are in the test table in Step 2.

| File | What it is | The traps in it |
|---|---|---|
| `cafe.txt` | Corner Café, 2 items, `TOTAL £8.75`, `VAT @ 20% 1.46`, date `05/03/2026 12:41` | phone line `Tel 01234 567890`, `VAT No. GB 123 4567 89` |
| `taxi.txt` | Northside Taxis, `Fare 12.40`, `Total to pay £12.40`, `incl. VAT £2.07`, `12 Mar 2026` | `Card ending 4421`, `Auth code 004417` |
| `supermarket.txt` | Harbour Foods, 9 lines with A/B VAT codes, `SUBTOTAL 26.49`, `Total savings 3.00`, `BALANCE DUE 23.49`, VAT summary rows `A 20% 16.66 3.33` and `B 0% 3.50 0.00` (net, then VAT; 16.66 + 3.33 + 3.50 = 23.49), `CASH 30.00`, `CHANGE 6.51`, date `19/03/26` | subtotal, savings, cash and change amounts |
| `fuel.txt` | Fuel Stop, `UNLEADED 37.50L @ 120.0p`, `TOTAL £45.00`, `VAT 20.00% £7.50`, `23-03-2026` | price per litre `120.0p`, litres |
| `train.txt` | Fictional Rail Ltd e-ticket, `Total £3.20`, no VAT line, `Date of travel: 2 March 2026` | zero-rated: no VAT shown |
| `hotel.txt` | Glen Lodge, `Arrive 09/03/2026`, `Depart 11/03/2026`, `Invoice date 11/03/2026`, `Total GBP 240.00`, `VAT 40.00` | three dates |
| `restaurant.txt` | Harbour Deli, `Food 19.99`, `Service charge (optional) 4.00`, `Total 23.99`, `VAT 4.00`, date `19/03/2026` | service charge equal to the VAT amount |
| `euro.txt` | Café de la Gare, `TOTAL 14,50 €`, `TVA 10% 1,32`, `03/03/2026` | not pounds |
| `smudged.txt` | Corner Café again, but the total line is `T0TAL £8.7S` with confidence 0.41 | OCR letter-for-digit mix-ups, low line confidence |
| `vat-mismatch.txt` | `TOTAL £12.40`, `VAT £2.70` (OCR misread of 2.07) | VAT inconsistent with 20% of the gross |
| `no-total.txt` | Paper & Pens, three item lines `0.10`, `0.20`, `4.99` and no total keyword | must not be certain |
| `future-date.txt` | Corner Café with date `05/03/2036` | a year typo |

- [ ] **Step 2: Write the failing tests**

`modules/ocr/test/extract.test.ts` loads a fixture with a small helper `lines(name): OcrLine[]` (split on newlines, optional TAB confidence) and calls `extractReceipt(lines(name), { today: '2026-03-31' })`.

```ts
const CASES = [
  // file,              amount, vat,   date,         merchant contains
  ['cafe.txt',          875,   146,   '2026-03-05', 'Corner Café'],
  ['taxi.txt',          1240,  207,   '2026-03-12', 'Northside Taxis'],
  ['supermarket.txt',   2349,  333,   '2026-03-19', 'Harbour Foods'],
  ['fuel.txt',          4500,  750,   '2026-03-23', 'Fuel Stop'],
  ['train.txt',         320,   null,  '2026-03-02', 'Fictional Rail'],
  ['hotel.txt',         24000, 4000,  '2026-03-11', 'Glen Lodge'],
  ['restaurant.txt',    2399,  400,   '2026-03-19', 'Harbour Deli'],
] as const;

test.each(CASES)('%s: every field right and confident', (file, amount, vat, date, merchant) => {
  const p = extractReceipt(lines(file), { today: '2026-03-31' });
  expect(p.amountPence).toEqual({ value: amount, confidence: expect.any(Number) });
  expect(p.amountPence!.confidence).toBeGreaterThanOrEqual(CONFIDENT);
  expect(p.vatPence?.value).toBe(vat);
  expect(p.date?.value).toBe(date);
  expect(p.merchant?.value).toContain(merchant);
  expect(p.currency).toBe('GBP');
});

test('distractor lines are never taken as the total or the VAT', () => {
  // phone, VAT number, card digits, auth code, subtotal, savings, cash, change, price per litre
  for (const f of ['cafe.txt', 'taxi.txt', 'supermarket.txt', 'fuel.txt']) {
    const p = extractReceipt(lines(f), { today: '2026-03-31' });
    expect([123456789, 4421, 4417, 2649, 300, 3000, 651, 12000]).not.toContain(p.amountPence?.value);
    expect([123456789, 4421, 2649, 300, 651]).not.toContain(p.vatPence?.value);
  }
});

test('the hotel invoice date wins over arrive and depart', () => {
  expect(extractReceipt(lines('hotel.txt'), { today: '2026-03-31' }).date).toMatchObject({ value: '2026-03-11' });
});

test('a receipt not in pounds is flagged and never confident', () => {
  const p = extractReceipt(lines('euro.txt'), { today: '2026-03-31' });
  expect(p.currency).toBe('other');
  expect(p.amountPence!.confidence).toBeLessThan(CONFIDENT);
  expect(p.warnings).toContain('This receipt may not be in pounds. Please check the amount.');
});

test('a smudged total is read but marked for checking', () => {
  const p = extractReceipt(lines('smudged.txt'), { today: '2026-03-31' });
  expect(p.amountPence?.value).toBe(875);              // T0TAL -> TOTAL, 8.7S -> 8.75
  expect(p.amountPence!.confidence).toBeLessThan(CONFIDENT);
});

test('VAT that does not fit 20% of the total is marked for checking', () => {
  const p = extractReceipt(lines('vat-mismatch.txt'), { today: '2026-03-31' });
  expect(p.amountPence).toMatchObject({ value: 1240 });
  expect(p.vatPence!.confidence).toBeLessThan(CONFIDENT);
  expect(p.warnings).toContain("The VAT doesn't match the usual rates for this total. Please check it.");
});

test('without a total line the largest amount is offered, but never confidently', () => {
  const p = extractReceipt(lines('no-total.txt'), { today: '2026-03-31' });
  expect(p.amountPence).toMatchObject({ value: 499 });
  expect(p.amountPence!.confidence).toBeLessThan(CONFIDENT);
});

test('a date in the future is marked for checking', () => {
  const p = extractReceipt(lines('future-date.txt'), { today: '2026-03-31' });
  expect(p.date).toMatchObject({ value: '2036-03-05' });
  expect(p.date!.confidence).toBeLessThan(CONFIDENT);
});

test('nothing at all gives an empty proposal, not an error', () => {
  expect(extractReceipt([], { today: '2026-03-31' })).toEqual({ amountPence: null, vatPence: null, date: null, merchant: null, currency: 'unknown', warnings: [] });
});

test('impossible dates are never proposed', () => {
  const p = extractReceipt([{ text: 'Date 31/02/2026', confidence: 0.99 }, { text: 'TOTAL £1.00', confidence: 0.99 }], { today: '2026-03-31' });
  expect(p.date).toBeNull();
});
```

`packages/shared/test/receipts.test.ts`:
- `correctedFields` returns `[]` when every confirmed value equals the proposal; `['amount', 'merchant']` when those two differ; all four when the proposal is `null`; a proposal field that is `null` counts as corrected.
- `ConfirmReadingInput` refuses VAT above the total with `The VAT can't be more than the total.`, refuses `2026-02-30`, refuses extra keys, and trims the merchant.

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run modules/ocr/test/extract.test.ts packages/shared/test/receipts.test.ts`
Expected: FAIL (`extractReceipt` not defined).

- [ ] **Step 4: Implement `extractReceipt(lines, { today }): ReceiptProposal`**

The tests fix the results; this is the approach, so two implementers end up with the same behaviour:
- **Money tokens** (`money-tokens.ts`): find amounts with exactly two decimals (`12.40`, `£12.40`, `12,40` only when the receipt is not GBP). Inside a token only, repair OCR swaps `O→0`, `o→0`, `S→5`, `l→1`, `I→1`, `B→8`, and lower that token's confidence by 0.3 for each repair. Ignore numbers that are part of a phone number, a VAT number (`VAT (No|Reg)`), a card or auth line, a price per litre (`p` suffix) or a quantity (`L`, `x`).
- **Total:** candidates are amounts on lines with `total|balance due|amount due|to pay|grand total`, excluding lines with `sub|savings|vat|tax|net|discount`. Prefer the **last** such line. Confidence = line confidence × 1.0 for a keyword match; the fallback (largest amount anywhere) is capped at 0.6.
- **VAT:** amounts on lines with `vat|tax|incl` that are not the VAT-number line. In a VAT summary table (`A 20% 16.66 3.33`), the VAT is the last amount per row, summed across rows. Cross-check, keeping the confidence when it fits and otherwise capping it at 0.5 and adding the warning:
  - with a summary table: each row's VAT is within 1p of `net × rate` (half up), and the rows' net plus VAT add up to the total exactly (mixed-rate receipts such as `supermarket.txt` fit this way, not the single-rate way);
  - without one: the VAT is within 1p of `vatFromGross(total, 2000)`, `vatFromGross(total, 500)` or 0. No VAT line at all: `vatPence = { value: null, confidence: 0.7 }` (never confident, because "no VAT" can also be a missed line).
- **Date** (`dates.ts`): UK order only: `dd/mm/yyyy`, `dd/mm/yy` (→ 20yy), `dd-mm-yyyy`, `dd.mm.yy`, `d Month yyyy`, `d Mon yyyy`, ISO `yyyy-mm-dd`. Prefer a line with `invoice|date|issued` over `arrive|depart|check`; otherwise the first date. Days that don't exist are dropped. A date after `today` or more than 400 days before it is capped at 0.5.
- **Merchant:** the first of the top five lines with three or more letters that is not an address (postcode pattern), phone, URL, `VAT`, `receipt`, `invoice` or a date. Confidence = line confidence capped at 0.9.
- **Currency:** `€`, `EUR`, `$`, `USD`, `TVA`, `MwSt` → `other` (cap the amount at 0.5, add the warning); `£` or `GBP` anywhere → `GBP`; otherwise `unknown` (cap the amount at 0.8).
- All confidences are rounded to two decimals.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run modules/ocr packages/shared` → PASS. Then `npm run verify` → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ocr): receipt field extraction with confidences, never confidently wrong on the text fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
