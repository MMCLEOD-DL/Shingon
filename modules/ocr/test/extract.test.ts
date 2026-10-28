import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CONFIDENT, type Scored } from '@hf/shared';
import { extractReceipt, type OcrLine } from '../src/index.js';

/** One recognised line per line, optionally followed by a TAB and the line's confidence (default 0.95). */
function lines(name: string): OcrLine[] {
  const text = readFileSync(new URL(`./text-fixtures/${name}`, import.meta.url), 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [t = '', c] = l.split('\t');
      return { text: t, confidence: c === undefined ? 0.95 : Number(c) };
    });
}

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

test.each(CASES)('%s: the VAT and date are confident too, except "no VAT shown"; the merchant is a guess by position, never certain', (file, _amount, vat) => {
  const p = extractReceipt(lines(file), { today: '2026-03-31' });
  if (vat === null) expect(p.vatPence).toEqual({ value: null, confidence: 0.7 });
  else expect(p.vatPence!.confidence).toBeGreaterThanOrEqual(CONFIDENT);
  // Ruling (Task 2, round 2): a travel date is not the purchase date, so the e-ticket's date is offered but marked.
  if (file === 'train.txt') expect(p.date!.confidence).toBeLessThan(CONFIDENT);
  else expect(p.date!.confidence).toBeGreaterThanOrEqual(CONFIDENT);
  expect(p.merchant!.confidence).toBe(0.8);
  expect(p.warnings).toEqual([]);
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

test('a date more than 400 days old is marked for checking', () => {
  const p = extractReceipt([{ text: 'Date 05/03/2025', confidence: 0.99 }, { text: 'TOTAL £1.00', confidence: 0.99 }], { today: '2026-04-30' });
  expect(p.date).toMatchObject({ value: '2025-03-05' });
  expect(p.date!.confidence).toBeLessThan(CONFIDENT);
});

test('nothing at all gives an empty proposal, not an error', () => {
  expect(extractReceipt([], { today: '2026-03-31' })).toEqual({ amountPence: null, vatPence: null, date: null, merchant: null, currency: 'unknown', warnings: [] });
});

test('impossible dates are never proposed', () => {
  const p = extractReceipt([{ text: 'Date 31/02/2026', confidence: 0.99 }, { text: 'TOTAL £1.00', confidence: 0.99 }], { today: '2026-03-31' });
  expect(p.date).toBeNull();
});

test('every UK date form is read, day first', () => {
  const read = (text: string) => extractReceipt([{ text, confidence: 0.9 }], { today: '2026-12-31' }).date?.value;
  expect(read('19/03/2026')).toBe('2026-03-19');
  expect(read('19/03/26')).toBe('2026-03-19');
  expect(read('19-03-2026')).toBe('2026-03-19');
  expect(read('19.03.26')).toBe('2026-03-19');
  expect(read('2 March 2026')).toBe('2026-03-02');
  expect(read('2 Mar 2026')).toBe('2026-03-02');
  expect(read('2026-03-19')).toBe('2026-03-19');
  expect(read('03/04/2026')).toBe('2026-04-03');
});

test('without £ or GBP anywhere the currency is unknown and the total is never confident', () => {
  const p = extractReceipt([{ text: 'Shop Name', confidence: 0.99 }, { text: 'TOTAL 5.00', confidence: 0.99 }], { today: '2026-03-31' });
  expect(p.currency).toBe('unknown');
  expect(p.amountPence).toMatchObject({ value: 500 });
  expect(p.amountPence!.confidence).toBeLessThan(CONFIDENT);
});

test('"Total incl. VAT" is the total, never a VAT amount', () => {
  const p = extractReceipt([{ text: 'Shop Name', confidence: 0.99 }, { text: 'Total incl. VAT £12.40', confidence: 0.99 }], { today: '2026-03-31' });
  expect(p.amountPence).toEqual({ value: 1240, confidence: 0.99 });
  expect(p.vatPence).toEqual({ value: null, confidence: 0.7 });
});

test('a VAT summary table whose rows do not add up to the total is marked for checking', () => {
  const p = extractReceipt(
    [
      { text: 'Shop Name', confidence: 0.99 },
      { text: 'BALANCE DUE £23.49', confidence: 0.99 },
      { text: 'A 20% 16.66 3.33', confidence: 0.99 },
      { text: 'B 0% 3.60 0.00', confidence: 0.99 },
    ],
    { today: '2026-03-31' },
  );
  expect(p.vatPence).toMatchObject({ value: 333 });
  expect(p.vatPence!.confidence).toBeLessThan(CONFIDENT);
});

test('a merchant line is never a total, a date or an address', () => {
  const p = extractReceipt(
    [
      { text: 'RECEIPT', confidence: 0.99 },
      { text: '05/03/2026', confidence: 0.99 },
      { text: 'TOTAL £8.75', confidence: 0.99 },
      { text: '12 Mill Lane, Anytown AB1 2CD', confidence: 0.99 },
    ],
    { today: '2026-03-31' },
  );
  expect(p.merchant).toBeNull();
});

test('confidences are rounded to two decimals', () => {
  const p = extractReceipt([{ text: 'Corner Café', confidence: 0.876543 }, { text: 'TOTAL £8.75', confidence: 0.876543 }], { today: '2026-03-31' });
  expect(p.amountPence!.confidence).toBe(0.88);
  expect(p.merchant!.confidence).toBe(0.8); // merchants are capped at 0.8 (Ruling (Task 2))
});

test('odd text never throws, and an over-long number is not money', () => {
  const p = extractReceipt(
    [
      { text: 'TOTAL £99999999999999999999.99', confidence: 0.99 },
      { text: 'BB.OO SS.ll %%% ££ 1.2.3.4 ....', confidence: 0.99 },
      { text: 'Date 99/99/9999 0000-00-00', confidence: 0.99 },
    ],
    { today: '2026-03-31' },
  );
  expect(p.amountPence).toBeNull();
  expect(p.date).toBeNull();
});

// Ruling (Task 2): Ruling 2 overrides the brief's selection rules. Every receipt below is constructed to tempt the
// rules into a wrong answer; each field must be right, or marked "Please check".
interface Truth { amount: number | null; vat: number | null; date: string | null; merchant: string | null }
const CAFE_TOP = ['Corner Café', '12 Mill Lane, Anytown AB1 2CD', '05/03/2026 12:41', 'Flat white 2.95', 'Cheese toastie 5.80'];
const CAFE: Truth = { amount: 875, vat: 146, date: '2026-03-05', merchant: 'Corner Café' };
const HOTEL_TOP = ['Glen Lodge', 'Glen Road, Anyglen AB9 1LM', 'Invoice date 11/03/2026', '2 nights bed and breakfast 240.00'];
const HOTEL: Truth = { amount: 24000, vat: 4000, date: '2026-03-11', merchant: 'Glen Lodge' };
const DELI_TOP = ['Harbour Deli', '3 Quay Street, Anytown AB5 6GJ', '19/03/2026 20:15', 'Food 19.99', 'Service charge (optional) 4.00'];
const DELI: Truth = { amount: 2399, vat: 400, date: '2026-03-19', merchant: 'Harbour Deli' };
const MIXED_TOP = ['Harbour Foods', '1 Quay Street, Anytown AB5 6GH', '19/03/26 14:02', 'SUBTOTAL 23.49', 'BALANCE DUE £23.49'];
const MIXED: Truth = { amount: 2349, vat: 333, date: '2026-03-19', merchant: 'Harbour Foods' };

const ADVERSARIAL: [string, string[], Truth][] = [
  ['singular TOTAL SAVING', [...CAFE_TOP, 'TOTAL £8.75', 'TOTAL SAVING £1.00', 'VAT @ 20% 1.46'], CAFE],
  ['Total saved today', [...CAFE_TOP, 'TOTAL £8.75', 'VAT @ 20% 1.46', 'Total saved today £2.50'], CAFE],
  ['TOTAL REDUCTIONS', [...CAFE_TOP, 'TOTAL £8.75', 'TOTAL REDUCTIONS £1.20', 'VAT @ 20% 1.46'], CAFE],
  ['hotel Payment received / Balance due 0.00', [...HOTEL_TOP, 'Total GBP 240.00', 'VAT 40.00', 'Payment received 240.00', 'Balance due 0.00'], HOTEL],
  ['Deposit paid / Balance due', [...HOTEL_TOP, 'Total GBP 240.00', 'VAT 40.00', 'Deposit paid 50.00', 'Balance due 190.00'], HOTEL],
  ['AMOUNT DUE £0.00', [...CAFE_TOP, 'TOTAL £8.75', 'VAT @ 20% 1.46', 'Paid by card 8.75', 'AMOUNT DUE £0.00'], CAFE],
  ['Total tendered', [...CAFE_TOP, 'TOTAL £8.75', 'VAT @ 20% 1.46', 'Total tendered £10.00', 'Change due £1.25'], CAFE],
  ['CASH TOTAL', [...CAFE_TOP, 'TOTAL £8.75', 'VAT @ 20% 1.46', 'CASH TOTAL £10.00', 'CHANGE £1.25'], CAFE],
  ['suggested tip', [...DELI_TOP, 'Total £23.99', 'VAT 4.00', 'Suggested tip 10% £2.40', 'Total with suggested tip £26.39'], DELI],
  ['a time printed on the total line', [...CAFE_TOP, 'TOTAL £8.75 at 12.41', 'VAT @ 20% 1.46'], CAFE],
  ['T0TAL then a saving', [...CAFE_TOP, 'T0TAL £8.75', 'T0TAL SAVING £1.00', 'VAT @ 20% 1.46'], CAFE],
  ['T0TAL then tendered', [...CAFE_TOP, 'T0TAL £8.75', 'VAT @ 20% 1.46', 'T0TAL TENDERED £10.00'], CAFE],
  ['mixed-rate VAT lines 20% and 0%', [...MIXED_TOP, 'VAT 20% £3.33', 'VAT 0% £0.00'], MIXED],
  ['4-column VAT table with VAT TOTAL 0.00', [...MIXED_TOP, 'CODE RATE NET VAT GROSS', 'A 20% 16.66 3.33 19.99', 'B 0% 3.50 0.00 3.50', 'VAT TOTAL 0.00'], MIXED],
  ['4-column VAT table with VAT TOTAL 3.33', [...MIXED_TOP, 'CODE RATE NET VAT GROSS', 'A 20% 16.66 3.33 19.99', 'B 0% 3.50 0.00 3.50', 'VAT TOTAL 3.33'], MIXED],
  ['4-column VAT table whose row does not add up', [...MIXED_TOP, 'A 20% 16.66 3.33 19.90', 'B 0% 3.50 0.00 3.50'], MIXED],
  ['Incl. gratuity 0.00', [...DELI_TOP, 'Total £23.99', 'VAT 4.00', 'Incl. gratuity 0.00'], DELI],
  ['REPRINT date', [...CAFE_TOP, 'TOTAL £8.75', 'VAT @ 20% 1.46', 'Reprint date 07/03/2026 10:02'], CAFE],
  ['Due date above Invoice date', ['Glen Lodge', 'Glen Road, Anyglen AB9 1LM', 'Due date 30/03/2026', 'Invoice date 11/03/2026', 'Total GBP 240.00', 'VAT 40.00'], HOTEL],
  ['two plain dates', ['Corner Café', 'Order placed 01/03/2026', '05/03/2026 12:41', '06/03/2026', 'TOTAL £8.75', 'VAT @ 20% 1.46'], CAFE],
  ['CUSTOMER COPY above the merchant', ['CUSTOMER COPY', ...CAFE_TOP, 'TOTAL £8.75', 'VAT @ 20% 1.46'], CAFE],
  ['Welcome line', ['Welcome to', ...CAFE_TOP, 'TOTAL £8.75', 'VAT @ 20% 1.46'], CAFE],
  ['Table 4 first', ['Table 4', ...DELI_TOP, 'Total £23.99', 'VAT 4.00'], DELI],
  ['street address first', ['12 Mill Lane', 'Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'VAT @ 20% 1.46'], CAFE],
  ['Server and till lines first', ['Server: Sam', 'Till 2', 'Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'VAT @ 20% 1.46'], CAFE],
  ['REFUND TOTAL -£8.75', ['Corner Café', '05/03/2026 12:41', 'REFUND', 'Flat white -2.95', 'Cheese toastie -5.80', 'REFUND TOTAL -£8.75', 'VAT -1.46'], { ...CAFE, amount: -875, vat: -146 }],
  ['Total incl. VAT', [...CAFE_TOP, 'Total incl. VAT £8.75', 'VAT £1.46'], CAFE],
  ['Total including VAT and Total excl. VAT', [...CAFE_TOP, 'Total excl. VAT £7.29', 'Total including VAT £8.75', 'VAT £1.46'], CAFE],
  ['Total ex VAT last', [...CAFE_TOP, 'Total incl. VAT £8.75', 'VAT £1.46', 'Total ex VAT £7.29'], CAFE],
  ['net line', [...CAFE_TOP, 'Net total £7.29', 'VAT £1.46', 'Total £8.75'], CAFE],
  ['zero total', [...CAFE_TOP, 'TOTAL £0.00', 'VAT 0.00'], CAFE],
  // Re-review, round 2: totals.
  ['service charge after the total', ['Harbour Deli', '19/03/2026 20:15', 'Total £19.99', 'Service charge 12.5% £2.50', 'Amount payable £22.49'], { ...DELI, amount: 2249, vat: null }],
  ['service charge after the total, with VAT', ['Harbour Deli', '19/03/2026 20:15', 'Total £19.99', 'Service charge 12.5% £2.50', 'Amount payable £22.49', 'VAT £3.33'], { ...DELI, amount: 2249, vat: 333 }],
  ['hotel room total then bar', ['Glen Lodge', 'Invoice date 11/03/2026', 'Room total £200.00', 'Bar £40.00', 'Amount payable £240.00', 'VAT £40.00'], HOTEL],
  ['food total then service charge', ['Harbour Deli', '19/03/2026 20:15', 'Food total £19.99', 'Service charge 12.5% £2.50', 'Amount payable £22.49', 'VAT £3.75'], { ...DELI, amount: 2249, vat: 375 }],
  ['order total then a voucher', [...CAFE_TOP, 'Order total £9.75', 'Voucher -£1.00', 'Pay £8.75', 'VAT 1.46'], CAFE],
  ['a tip after the total', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'VAT 1.46', 'TIP £1.00', 'AMOUNT £9.75'], { ...CAFE, amount: 975 }],
  ['TOTAL on its own line, then a loyalty total', ['Corner Café', '05/03/2026 12:41', 'TOTAL', '£8.75', 'Loyalty total £1.00', 'VAT 1.46'], CAFE],
  ['Total before V.A.T.', ['Shop', '05/03/2026', 'Total before V.A.T. £7.29', 'V.A.T. @ 20% £1.46', 'Amount payable £8.75'], { ...CAFE, merchant: 'Shop' }],
  ['Total excluding V.A.T', ['Shop', '05/03/2026', 'Total excluding V.A.T £7.29', 'V A T £1.46', 'Amount payable £8.75'], { ...CAFE, merchant: 'Shop' }],
  ['Goods total (excl)', ['Shop', '05/03/2026', 'Goods total (excl) £7.29', 'VAT 1.46'], { ...CAFE, merchant: 'Shop' }],
  ['REFUND TOTAL £8.75-', ['Corner Café', '05/03/2026 12:41', 'REFUND TOTAL £8.75-', 'VAT 1.46'], { ...CAFE, amount: -875, vat: -146 }],
  ['REFUND TOTAL (£8.75)', ['Corner Café', '05/03/2026 12:41', 'REFUND TOTAL (£8.75)', 'VAT 1.46'], { ...CAFE, amount: -875, vat: -146 }],
  ['TOTAL £8.75 CR', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75 CR', 'VAT 1.46'], { ...CAFE, amount: -875, vat: -146 }],
  ['REFUND TOTAL £8.75', ['Corner Café', '05/03/2026 12:41', 'REFUND TOTAL £8.75', 'VAT 1.46'], { ...CAFE, amount: -875, vat: -146 }],
  // Re-review, round 2: dates.
  ['collection date', ['Shop', '05/03/2026 12:41', 'Collection date 12/03/2026', 'TOTAL £8.75', 'VAT 1.46'], { ...CAFE, merchant: 'Shop' }],
  ['delivery date', ['Shop', '05/03/2026 12:41', 'Delivery date 09/03/2026', 'TOTAL £8.75', 'VAT 1.46'], { ...CAFE, merchant: 'Shop' }],
  ['performance date', ['Shop', '05/03/2026 12:41', 'Performance date 20/03/2026 19:30', 'TOTAL £8.75', 'VAT 1.46'], { ...CAFE, merchant: 'Shop' }],
  ['order date and delivered', ['Shop', 'Order date 05/03/2026', 'Delivered 07/03/2026', 'TOTAL £8.75', 'VAT 1.46'], { ...CAFE, merchant: 'Shop' }],
  ['lone best before', ['Shop', 'Best before 20/03/2026', 'TOTAL £8.75', 'VAT 1.46'], { ...CAFE, date: null, merchant: 'Shop' }],
  ['lone use by', ['Shop', 'Use by 07/03/2026', 'TOTAL £8.75', 'VAT 1.46'], { ...CAFE, date: null, merchant: 'Shop' }],
  ['lone offer ends', ['Shop', 'Offer ends 20/03/2026', 'TOTAL £8.75', 'VAT 1.46'], { ...CAFE, date: null, merchant: 'Shop' }],
  ['US diner, month first', ['Diner', '03/02/2026 12:41', 'TOTAL $8.75', 'Tax 0.70'], { amount: 875, vat: 70, date: '2026-03-02', merchant: 'Diner' }],
  // Own adversarial pass.
  ['cashback after the total', [...CAFE_TOP, 'TOTAL £8.75', 'VAT 1.46', 'Cashback £20.00'], CAFE],
  ['deposit then balance to pay', [...HOTEL_TOP, 'Deposit £50.00', 'Total £240.00', 'Balance to pay £190.00', 'VAT 40.00'], HOTEL],
  ['discount in brackets after the total', [...CAFE_TOP, 'Total £8.75', 'Staff discount (£1.00)', 'VAT 1.46'], CAFE],
  ['an item dearer than the total', ['Shop', '05/03/2026', 'Television 500.00', 'Promotion -100.00', 'Total £400.00'], { amount: 40000, vat: null, date: '2026-03-05', merchant: 'Shop' }],
  ['VAT and net on one line', [...CAFE_TOP, 'TOTAL £8.75', 'VAT 1.46 Net 7.29'], CAFE],
  ['exchange-by date', [...CAFE_TOP, 'TOTAL £8.75', 'VAT 1.46', 'Exchange by 04/04/2026'], CAFE],
  ['valid-until voucher date', [...CAFE_TOP, 'TOTAL £8.75', 'VAT 1.46', 'Next visit 10% off, valid until 30/04/2026'], CAFE],
  ['credit note', ['Corner Café', '05/03/2026 12:41', 'CREDIT NOTE', 'Total £8.75', 'VAT 1.46'], { ...CAFE, amount: -875, vat: -146 }],
  ['VAT in brackets on the total line', ['Corner Café', '05/03/2026 12:41', 'Total £8.75 (incl VAT £1.46)'], CAFE],
  ['a second, zero amount due', ['Corner Café', '05/03/2026 12:41', 'TOTAL DUE £8.75', 'DUE £0.00', 'VAT 1.46'], CAFE],
  ['member-since date', ['Corner Café', '05/03/2026 12:41', 'Member since 01/01/2019', 'TOTAL £8.75', 'VAT 1.46'], CAFE],
  ['next appointment date', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'VAT 1.46', 'Next appointment 12/03/2026'], CAFE],
  ['amount charged after a gift voucher', [...CAFE_TOP, 'Total £8.75', 'Gift voucher £5.00', 'Amount charged £3.75', 'VAT 1.46'], { ...CAFE, amount: 375 }],
];

test.each(ADVERSARIAL)('adversarial: %s is right or marked "Please check" on every field', (_name, texts, truth) => {
  const p = extractReceipt(texts.map((text) => ({ text, confidence: 0.95 })), { today: '2026-03-31' });
  const fields: [Scored<unknown> | null, unknown][] = [
    [p.amountPence, truth.amount],
    [p.vatPence, truth.vat],
    [p.date, truth.date],
    [p.merchant, truth.merchant],
  ];
  for (const [field, right] of fields) {
    if (field && field.value !== right) expect(field.confidence, `${String(field.value)} instead of ${String(right)}`).toBeLessThan(CONFIDENT);
  }
});

test('"Total incl. VAT £8.75" with "VAT £1.46" is now confident and correct', () => {
  const p = extractReceipt([...CAFE_TOP, 'Total incl. VAT £8.75', 'VAT £1.46'].map((text) => ({ text, confidence: 0.95 })), { today: '2026-03-31' });
  expect(p.amountPence).toEqual({ value: 875, confidence: 0.95 });
  expect(p.vatPence).toEqual({ value: 146, confidence: 0.95 });
  expect(p.warnings).toEqual([]);
});

test('a 4-column VAT table that adds up is read confidently', () => {
  const p = extractReceipt([...MIXED_TOP, 'A 20% 16.66 3.33 19.99', 'B 0% 3.50 0.00 3.50', 'VAT TOTAL 3.33'].map((text) => ({ text, confidence: 0.95 })), { today: '2026-03-31' });
  expect(p.vatPence).toEqual({ value: 333, confidence: 0.95 });
});

test('"Total before V.A.T." with "Amount payable" is confident and correct', () => {
  const p = extractReceipt(['Shop', '05/03/2026', 'Total before V.A.T. £7.29', 'V.A.T. @ 20% £1.46', 'Amount payable £8.75'].map((text) => ({ text, confidence: 0.95 })), { today: '2026-03-31' });
  expect(p.amountPence).toEqual({ value: 875, confidence: 0.95 });
  expect(p.vatPence).toEqual({ value: 146, confidence: 0.95 });
  expect(p.date).toEqual({ value: '2026-03-05', confidence: 0.95 });
});

test('a collection date does not stop the receipt date being confident', () => {
  const p = extractReceipt(['Shop', '05/03/2026 12:41', 'Collection date 12/03/2026', 'TOTAL £8.75'].map((text) => ({ text, confidence: 0.95 })), { today: '2026-03-31' });
  expect(p.date).toEqual({ value: '2026-03-05', confidence: 0.95 });
});
