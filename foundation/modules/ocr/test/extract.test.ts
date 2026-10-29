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

// Ruling (Task 2, round 4): a VAT-only line after the total whose amount is the VAT that fits does not make the total
// unsure. These ordinary receipts must be read right and confidently (amount, VAT, date).
const LEGIT_ROUND_4: [string, string[], Truth][] = [
  ['hotel Total VAT line', ['Glen Lodge', 'Invoice date 11/03/2026', 'Room 2 nights £200.00', 'Breakfast £40.00', 'Total £240.00', 'Total VAT £40.00', 'Paid by card £240.00'], { amount: 24000, vat: 4000, date: '2026-03-11', merchant: 'Glen Lodge' }],
  ['restaurant VAT amount line', ['Harbour Deli', '19/03/2026 20:15', 'Food £19.99', 'Total £19.99', 'VAT amount £3.33', 'Card £19.99'], { amount: 1999, vat: 333, date: '2026-03-19', merchant: 'Harbour Deli' }],
  ['supermarket table + VAT TOTAL', ['Harbour Foods', '19/03/26 14:02', 'SUBTOTAL 23.49', 'BALANCE DUE £23.49', 'A 20% 16.66 3.33 19.99', 'B 0% 3.50 0.00 3.50', 'VAT TOTAL 3.33'], { amount: 2349, vat: 333, date: '2026-03-19', merchant: 'Harbour Foods' }],
];

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
  // Re-review 2 (round 3): totals.
  ['service charge then Total paid', ['Harbour Deli', '19/03/2026 20:15', 'Total £19.99', 'Service charge 12.5% £2.50', 'Total paid £22.49'], { ...DELI, amount: 2249, vat: null }],
  ['service charge then Amount paid', ['Harbour Deli', '19/03/2026 20:15', 'Total £19.99', 'Service charge 12.5% £2.50', 'Amount paid £22.49'], { ...DELI, amount: 2249, vat: null }],
  ['service charge then Charged to card', ['Harbour Deli', '19/03/2026 20:15', 'Total £19.99', 'Service charge 12.5% £2.50', 'Charged to card £22.49'], { ...DELI, amount: 2249, vat: null }],
  ['service charge, Amount paid and VAT', ['Harbour Deli', '19/03/2026 20:15', 'Total £19.99', 'Service charge £2.50', 'Amount paid £22.49', 'VAT £3.33'], { ...DELI, amount: 2249, vat: 333 }],
  ['TOTAL INC GRATUITY', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'Gratuity £1.00', 'TOTAL INC GRATUITY £9.75'], { ...CAFE, amount: 975, vat: null }],
  ['Total with tip', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'Tip £1.00', 'Total with tip £9.75'], { ...CAFE, amount: 975, vat: null }],
  ['Total after discount', ['Corner Café', '05/03/2026 12:41', 'Total £9.75', 'Staff -£1.00', 'Total after discount £8.75', 'VAT 1.46'], CAFE],
  ['Total after savings', ['Corner Café', '05/03/2026 12:41', 'Total £9.75', 'Staff -£1.00', 'Total after savings £8.75', 'VAT 1.46'], CAFE],
  ['Total after points', ['Corner Café', '05/03/2026 12:41', 'Total £9.75', 'Staff -£1.00', 'Total after points £8.75', 'VAT 1.46'], CAFE],
  ['Promo total', ['Corner Café', '05/03/2026 12:41', 'Total £9.75', 'Staff -£1.00', 'Promo total £8.75', 'VAT 1.46'], CAFE],
  ['Balance after deposit', ['Glen Lodge', 'Invoice date 11/03/2026', 'Total £240.00', 'Deposit received £50.00', 'Balance after deposit £190.00'], { ...HOTEL, amount: 19000, vat: null }],
  ['Cash total after delivery', ['Corner Café', '05/03/2026 12:41', 'Total £8.75', 'Delivery £2.00', 'Cash total £10.75'], { ...CAFE, amount: 1075, vat: null }],
  ['Subscription total', ['Gym', '05/03/2026', 'Joining fee £10.00', 'Total £10.00', 'Subscription total £35.00'], { amount: 4500, vat: null, date: '2026-03-05', merchant: 'Gym' }],
  ['TOTAL DUE then DUE £0.00', ['Corner Café', '05/03/2026 12:41', 'TOTAL DUE £8.75', 'DUE £0.00'], { ...CAFE, vat: null }],
  // Re-review 2 (round 3): labelled dates (no transaction date at all).
  ['label Sell by 20/03/2026', ['Shop', 'Sell by 20/03/2026', 'TOTAL £8.75'], { ...CAFE, vat: null, date: null, merchant: 'Shop' }],
  ['label Display until 20/03/2026', ['Shop', 'Display until 20/03/2026', 'TOTAL £8.75'], { ...CAFE, vat: null, date: null, merchant: 'Shop' }],
  ['label Exp 20/03/2026', ['Shop', 'Exp 20/03/2026', 'TOTAL £8.75'], { ...CAFE, vat: null, date: null, merchant: 'Shop' }],
  ['label Exchange by 20/03/2026', ['Shop', 'Exchange by 20/03/2026', 'TOTAL £8.75'], { ...CAFE, vat: null, date: null, merchant: 'Shop' }],
  ['label Guarantee to 20/03/2026', ['Shop', 'Guarantee to 20/03/2026', 'TOTAL £8.75'], { ...CAFE, vat: null, date: null, merchant: 'Shop' }],
  ['label Last visit 01/03/2026', ['Shop', 'Last visit 01/03/2026', 'TOTAL £8.75'], { ...CAFE, vat: null, date: null, merchant: 'Shop' }],
  ['label Packed on 01/03/2026', ['Shop', 'Packed on 01/03/2026', 'TOTAL £8.75'], { ...CAFE, vat: null, date: null, merchant: 'Shop' }],
  ['label Member since 01/06/2025', ['Shop', 'Member since 01/06/2025', 'TOTAL £8.75'], { ...CAFE, vat: null, date: null, merchant: 'Shop' }],
  ['label Account opened 10/10/2025', ['Shop', 'Account opened 10/10/2025', 'TOTAL £8.75'], { ...CAFE, vat: null, date: null, merchant: 'Shop' }],
  // Own pass against the round-3 rules.
  ['label above a bare date', ['Shop', 'Last visit', '01/03/2026', 'TOTAL £8.75'], { ...CAFE, vat: null, date: null, merchant: 'Shop' }],
  ['label with a colon above a bare date', ['Shop', 'Offer valid until:', '30/03/2026', '05/03/2026 12:41', 'TOTAL £8.75'], { ...CAFE, vat: null, merchant: 'Shop' }],
  ['allow-listed word as a label (Sale ends)', ['Shop', 'Sale ends 20/03/2026', 'TOTAL £8.75'], { ...CAFE, vat: null, date: null, merchant: 'Shop' }],
  ['two bare dates', ['Shop', '05/03/2026', '01/03/2026', 'TOTAL £8.75'], { ...CAFE, vat: null, merchant: 'Shop' }],
  ['discount after the total, then a bare amount', ['Shop', '05/03/2026', 'Total £9.75', 'Staff discount -£1.00', '£8.75'], { ...CAFE, vat: null, merchant: 'Shop' }],
  ['voucher after the total, card charged less', ['Shop', '05/03/2026', 'Total £9.75', 'Less voucher 1.00', 'Card payment £8.75'], { ...CAFE, vat: null, merchant: 'Shop' }],
  ['bare amount after the total', ['Shop', '05/03/2026', 'TOTAL £8.75', 'Gratuity', '£9.75'], { ...CAFE, amount: 975, vat: null, merchant: 'Shop' }],
  ['subtotal larger than the total with no saving shown', ['Shop', '05/03/2026', 'Subtotal £9.75', 'TOTAL £8.75'], { ...CAFE, amount: 975, vat: null, merchant: 'Shop' }],
  // Re-review 3 (round 4): the reviewer's inputs.
  ['next appointment (label line, no colon) + till-labelled txn date', ['Hair Studio', 'TILL 2 OP 14 05/03/2026 12:41', 'Cut and blow dry £35.00', 'TOTAL £35.00', 'Next appointment', '12/03/2026 10:00'], { amount: 3500, vat: null, date: '2026-03-05', merchant: 'Hair Studio' }],
  ['grocery delivery slot bare, order placed labelled', ['Fresh Grocer Online', 'Order confirmation', 'Order placed 01/03/2026', 'Your delivery slot', 'Thursday 12 March 2026 08:00 - 09:00', 'Order total £54.20'], { amount: 5420, vat: null, date: '2026-03-01', merchant: null }],
  ['cinema booking: Booked on + performance line', ['Picturehouse Five', 'Booking confirmation', 'Booked on 01/03/2026', 'Thu 12 Mar 2026 at 19:30', 'Screen 3', '2 x Adult £24.00', 'Booking fee £1.50', 'Total £25.50'], { amount: 2550, vat: null, date: '2026-03-01', merchant: 'Picturehouse Five' }],
  ['hotel arrival on own line below "Arrival"', ['Glen Lodge', 'Arrival', '09/03/2026', 'Departure', '11/03/2026', 'Invoice 4471', 'Total £240.00', 'VAT £40.00'], { amount: 24000, vat: 4000, date: '2026-03-11', merchant: 'Glen Lodge' }],
  ['parcel: Collection / date', ['Post Shop', 'Trans 2231 05/03/2026', 'Collection', '07/03/2026', 'TOTAL £3.20'], { amount: 320, vat: null, date: '2026-03-05', merchant: 'Post Shop' }],
  ['MOT due below the label "MOT expires on" ok, "Next MOT"', ['Kwik Garage', 'Inv 1234 05/03/2026 Op 3', 'MOT test £54.85', 'Total £54.85', 'Next MOT', '04/03/2027'], { amount: 5485, vat: null, date: '2026-03-05', merchant: 'Kwik Garage' }],
  ['date with till/op labels only, appointment same-line', ['Optician', '05/03/2026 Till 1', 'Total £85.00', 'Appointment 12/03/2026'], { amount: 8500, vat: null, date: '2026-03-05', merchant: 'Optician' }],
  ['train: Purchased labelled + travel bare', ['Fictional Rail Ltd', 'Purchased 28/02/2026', 'Travel', '02/03/2026', 'Total £3.20'], { amount: 320, vat: null, date: '2026-02-28', merchant: null }],
  ['Valid from (label line) season ticket', ['Fictional Rail Ltd', 'Season ticket', 'Purchased 28/02/2026', 'Valid', '02/03/2026', 'Total £320.00'], { amount: 32000, vat: null, date: '2026-02-28', merchant: null }],
  ['event "Date" for a ticket', ['Theatre Royal', 'Booked 01/03/2026', 'Date', '20/03/2026', 'Total £40.00'], { amount: 4000, vat: null, date: '2026-03-01', merchant: 'Theatre Royal' }],
  ['hotel deposit receipt (payment received before booking total)', ['Glen Lodge', 'Invoice date 05/03/2026', 'Payment received £50.00', 'Total booking value £240.00', 'VAT £40.00'], { amount: 5000, vat: null, date: '2026-03-05', merchant: 'Glen Lodge' }],
  ['deposit receipt: Deposit taken then total cost of stay', ['Glen Lodge', '05/03/2026', 'Deposit taken today £50.00', 'Total cost of stay £240.00'], { amount: 5000, vat: null, date: '2026-03-05', merchant: 'Glen Lodge' }],
  ['split bill: Your share after total', ['Harbour Deli', '19/03/2026 20:15', 'Total £60.00', 'Split 3 ways', 'Your share £20.00'], { amount: 2000, vat: null, date: '2026-03-19', merchant: 'Harbour Deli' }],
  ['taxi tip after total, card line no amount', ['Northside Taxis', '12 Mar 2026', 'Fare £12.40', 'Total £12.40', 'Tip £2.00', 'Card ending 4421'], { amount: 1440, vat: null, date: '2026-03-12', merchant: 'Northside Taxis' }],
  ['service charge after total, nothing else', ['Harbour Deli', '19/03/2026 20:15', 'Food 19.99', 'Total £19.99', 'Service charge 12.5% £2.50'], { amount: 2249, vat: null, date: '2026-03-19', merchant: 'Harbour Deli' }],
  ['Visa line with amount after total (gift cert part-pay)', ['Bookshop', '05/03/2026', 'Order total £33.99', 'Gift certificate £10.00', 'Visa £23.99'], { amount: 3399, vat: null, date: '2026-03-05', merchant: 'Bookshop' }],
  ['loyalty spend after total', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'Your spend this year £450.00'], { amount: 875, vat: null, date: '2026-03-05', merchant: 'Corner Café' }],
  ['petrol pre-auth', ['Fuel Stop', '23-03-2026', 'Pump 3 Unleaded £45.00', 'Pre-auth £99.00', 'TOTAL £45.00', 'VAT 20.00% £7.50'], { amount: 4500, vat: 750, date: '2026-03-23', merchant: 'Fuel Stop' }],
  ['parking cash paid + change', ['City Car Park', '05/03/2026 09:12', 'Tariff 2 hrs', 'Amount due £3.20', 'Paid £5.00', 'Change £1.80'], { amount: 320, vat: null, date: '2026-03-05', merchant: 'City Car Park' }],
  ['multi-buy saving after total then bare', ['Harbour Foods', '19/03/26', 'Cola 3 for £2.00 2.00', 'TOTAL £12.00', 'You saved £1.00'], { amount: 1200, vat: null, date: '2026-03-19', merchant: 'Harbour Foods' }],
  ['Clubcard: Clubcard Prices saving after total', ['Harbour Foods', '19/03/26', 'Milk 1.25', 'Bread 1.10', 'TOTAL £2.35', 'Clubcard Prices saving 0.40'], { amount: 235, vat: null, date: '2026-03-19', merchant: 'Harbour Foods' }],
  ['Nectar: points worth £ after total', ['Harbour Foods', '19/03/26', 'TOTAL £12.00', 'Nectar worth £2.50 redeemed'], { amount: 1200, vat: null, date: '2026-03-19', merchant: 'Harbour Foods' }],
  ['Total VAT after total, wrong total before service', ['Harbour Deli', '19/03/2026', 'Total £19.99', 'Service £2.50', 'Total VAT £3.33'], { amount: 2249, vat: 375, date: '2026-03-19', merchant: 'Harbour Deli' }],
  ['online: total then refund of one item listed as Returned', ['Shop Online', 'Order date 01/03/2026', 'Order total £40.00', 'Item returned £10.00'], { amount: 3000, vat: null, date: '2026-03-01', merchant: 'Shop Online' }],
  ['taxi: meter + extras line after total with no word', ['Northside Taxis', '12/03/2026', 'Total £12.40', 'Airport surcharge £3.00'], { amount: 1540, vat: null, date: '2026-03-12', merchant: 'Northside Taxis' }],
  ['two receipts merged? amount to pay after card', ['Corner Café', '05/03/2026', 'TOTAL £8.75', 'Contactless £8.75'], { amount: 875, vat: null, date: '2026-03-05', merchant: 'Corner Café' }],
  ['VAT on food only line + total VAT', ['Harbour Deli', '19/03/2026', 'Total £23.99', 'VAT 20% £3.33', 'VAT 0% £0.00'], { amount: 2399, vat: 333, date: '2026-03-19', merchant: 'Harbour Deli' }],
  ['VAT rate written 20.00 with space', ['Fuel Stop', '23/03/2026', 'TOTAL £45.00', 'VAT 20.00 % £7.50'], { amount: 4500, vat: 750, date: '2026-03-23', merchant: 'Fuel Stop' }],
  // The real VAT is unknown here (part of the food is zero-rated); 200 stands for "not 50p for certain".
  ['VAT 5% portion only (mixed restaurant takeaway)', ['Chippy', '19/03/2026', 'Hot food £10.50', 'Cold drink £1.50', 'Total £12.00', 'VAT £0.50'], { amount: 1200, vat: 200, date: '2026-03-19', merchant: 'Chippy' }],
  // Re-review 3 (round 4): exploits of the VAT-line exemption.
  ['EXPLOIT merged columns VAT due + Total due', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'VAT due £1.46   Total due £9.75'], { amount: 975, vat: null, date: '2026-03-05', merchant: 'Corner Café' }],
  ['EXPLOIT Total VAT + Amount payable one line', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'Total VAT £1.46 Amount payable £9.75'], { amount: 975, vat: null, date: '2026-03-05', merchant: 'Corner Café' }],
  ['EXPLOIT VAT total incl service', ['Harbour Deli', '19/03/2026', 'Total £19.99', 'VAT total incl service £3.33'], { amount: 1999, vat: 333, date: '2026-03-19', merchant: 'Harbour Deli' }],
  ['EXPLOIT second VAT line disagrees', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'VAT £1.63', 'Total VAT £1.46'], { amount: 875, vat: null, date: '2026-03-05', merchant: 'Corner Café' }],
  ['EXPLOIT Amount due VAT inc', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'Amount due VAT inc £0.44'], { amount: 875, vat: null, date: '2026-03-05', merchant: 'Corner Café' }],
  ['EXPLOIT merged VAT + deposit paid', ['Glen Lodge', 'Invoice date 05/03/2026', 'Total booking £240.00', 'Total VAT £40.00   Deposit paid £50.00'], { amount: 5000, vat: null, date: '2026-03-05', merchant: 'Glen Lodge' }],
  ['EXPLOIT merged VAT + Paid by card smaller', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'VAT amount £1.46 Paid £5.00'], { amount: 500, vat: null, date: '2026-03-05', merchant: 'Corner Café' }],
  // Own pass against the round-4 rules.
  ['label on line 1 above the only date', ['Next appointment', '12/03/2026', 'Hair Studio', 'TOTAL £35.00'], { amount: 3500, vat: null, date: null, merchant: 'Hair Studio' }],
  ['weekday line between label and date', ['Hair Studio', 'TOTAL £35.00', 'Next appointment', 'Thursday', '12/03/2026 10:00'], { amount: 3500, vat: null, date: null, merchant: 'Hair Studio' }],
  ['Date line between label and date', ['Hair Studio', 'TOTAL £35.00', 'Your next visit', 'Date', '12/03/2026'], { amount: 3500, vat: null, date: null, merchant: 'Hair Studio' }],
  ['service incl. VAT after total', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'Service incl. VAT £1.00'], { amount: 975, vat: null, date: '2026-03-05', merchant: 'Corner Café' }],
  ['delivery inc VAT after total', ['Shop', '05/03/2026', 'Total £30.00', 'Delivery inc VAT £3.99'], { amount: 3399, vat: null, date: '2026-03-05', merchant: 'Shop' }],
  ['tax on tip after total', ['Diner', '05/03/2026', 'Total £30.00', 'Tip (no tax) £3.00'], { amount: 3300, vat: null, date: '2026-03-05', merchant: 'Diner' }],
  ['net after total then cash', ['Shop', '05/03/2026', 'Total £30.00', 'Net amount £25.00', 'Cash £40.00', 'Change £10.00'], { amount: 3000, vat: null, date: '2026-03-05', merchant: 'Shop' }],
  ['VAT due line exactly fitting but extra after', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'VAT due £1.46', 'Service £1.00'], { amount: 975, vat: null, date: '2026-03-05', merchant: 'Corner Café' }],
  ['VAT amount with rate @', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'VAT amount @ 20% £1.46'], { amount: 875, vat: 146, date: '2026-03-05', merchant: 'Corner Café' }],
  ['TAX TOTAL fitting 5%', ['Chippy', '05/03/2026', 'TOTAL £21.00', 'TAX TOTAL £1.00'], { amount: 2100, vat: 100, date: '2026-03-05', merchant: 'Chippy' }],
  ['Total VAT zero after total', ['Shop', '05/03/2026', 'TOTAL £8.75', 'Total VAT £0.00'], { amount: 875, vat: 0, date: '2026-03-05', merchant: 'Shop' }],
  ['Total VAT equals 20% but a second VAT TOTAL', ['Shop', '05/03/2026', 'TOTAL £8.75', 'Total VAT £1.46', 'VAT total £0.42'], { amount: 875, vat: null, date: '2026-03-05', merchant: 'Shop' }],
  ['received before total equal', ['Glen Lodge', 'Invoice date 05/03/2026', 'Total £240.00', 'Payment received £240.00'], { amount: 24000, vat: null, date: '2026-03-05', merchant: 'Glen Lodge' }],
  ['payment on account before total', ['Glen Lodge', 'Invoice date 05/03/2026', 'Payment on account £100.00', 'Total £240.00'], { amount: 14000, vat: null, date: '2026-03-05', merchant: 'Glen Lodge' }],
  ['pre-paid line before total', ['Glen Lodge', 'Invoice date 05/03/2026', 'Prepaid £100.00', 'Total £240.00'], { amount: 14000, vat: null, date: '2026-03-05', merchant: 'Glen Lodge' }],
  ['amount already settled before total', ['Glen Lodge', 'Invoice date 05/03/2026', 'Already settled £100.00', 'Total £240.00'], { amount: 14000, vat: null, date: '2026-03-05', merchant: 'Glen Lodge' }],
  ['Paypal line after', ['Bookshop', '05/03/2026', 'Order total £33.99', 'PayPal £23.99'], { amount: 2399, vat: null, date: '2026-03-05', merchant: 'Bookshop' }],
  ['reprinted receipt: the bare date is the sale', ['Shop', 'Printed 05/03/2026', '04/03/2026', 'TOTAL £8.75'], { amount: 875, vat: null, date: '2026-03-04', merchant: 'Shop' }],
  // Re-review 4: a "Printed" date may be the sale date itself, so it still competes.
  ['theatre: printed sale date above the show date', ['Theatre Royal', 'Printed 01/03/2026 10:15', 'Seat B12 Stalls', 'Sat 14/03/2026 19:30', 'Total £40.00'], { amount: 4000, vat: null, date: '2026-03-01', merchant: 'Theatre Royal' }],
  ['cinema: printed sale date below the screening', ['Picturehouse Five', 'Screen 3 Seat F7', 'Thu 12 Mar 2026 19:30', 'Adult £12.00', 'Total £12.00', 'Printed 01/03/2026 10:15'], { amount: 1200, vat: null, date: '2026-03-01', merchant: 'Picturehouse Five' }],
  ['hotel folio: printed date beside the night stayed', ['Glen Lodge', 'Printed 11/03/2026', '09/03/2026', 'Room 1 night £120.00', 'Total £120.00', 'VAT £20.00'], { amount: 12000, vat: 2000, date: '2026-03-11', merchant: 'Glen Lodge' }],
  ['show in merchant name', ['Showcase Cinema', 'Showcase 05/03/2026', '06/03/2026', 'TOTAL £8.75'], { amount: 875, vat: null, date: '2026-03-05', merchant: 'Showcase Cinema' }],
  ['order date vs order date', ['Shop Online', 'Order date 01/03/2026', 'Dispatched 03/03/2026', 'Invoice date 04/03/2026', 'Total £30.00'], { amount: 3000, vat: null, date: '2026-03-04', merchant: 'Shop Online' }],
  ['order date with invoice date', ['Shop Online', 'Order date 01/03/2026', 'Invoice date 04/03/2026', 'Total £30.00'], { amount: 3000, vat: null, date: '2026-03-04', merchant: 'Shop Online' }],
  ['order date then a reorder date', ['Shop Online', 'Order date 01/03/2026', 'Order date of last order 01/02/2026', 'Total £30.00'], { amount: 3000, vat: null, date: '2026-03-01', merchant: 'Shop Online' }],
  ['VAT only line repaired OCR', ['Corner Café', '05/03/2026 12:41', 'TOTAL £8.75', 'Total VAT £1.4S'], { amount: 875, vat: 146, date: '2026-03-05', merchant: 'Corner Café' }],
  ['VAT only line GBP', ['Glen Lodge', 'Invoice date 11/03/2026', 'Total GBP 240.00', 'Total VAT GBP 40.00'], { amount: 24000, vat: 4000, date: '2026-03-11', merchant: 'Glen Lodge' }],
  ['tip line labelled tax', ['Diner', '05/03/2026', 'Total £30.00', 'Tax free tip £3.00'], { amount: 3300, vat: null, date: '2026-03-05', merchant: 'Diner' }],
  ['cash tip after', ['Diner', '05/03/2026', 'Total £30.00', 'Cash tip £3.00'], { amount: 3300, vat: null, date: '2026-03-05', merchant: 'Diner' }],
  ['change given then extra', ['Diner', '05/03/2026', 'Total £30.00', 'Change for parking £3.00'], { amount: 3300, vat: null, date: '2026-03-05', merchant: 'Diner' }],
  ...LEGIT_ROUND_4,
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

test.each(LEGIT_ROUND_4)('round 4: %s is read right and confidently', (_name, texts, truth) => {
  const p = extractReceipt(texts.map((text) => ({ text, confidence: 0.95 })), { today: '2026-03-31' });
  expect(p.amountPence).toEqual({ value: truth.amount, confidence: 0.95 });
  expect(p.vatPence).toEqual({ value: truth.vat, confidence: 0.95 });
  expect(p.date).toEqual({ value: truth.date, confidence: 0.95 });
  expect(p.warnings).toEqual([]);
});

// The cost of Ruling 2: every rule that marks a field "Please check" also catches some honest receipts. This floor stops
// a future change from quietly turning every field into "Please check" (which would also give zero confidently wrong).
const ORDINARY: [string, string[], Truth][] = [
  ['Tesco-like with Clubcard savings', ['Harbour Foods', '1 Quay Street, Anytown AB5 6GH', 'VAT No. GB 987 6543 21', 'Milk 1.25', 'Bread 1.10', 'Wine 9.00', 'Clubcard Price -1.00', 'TOTAL £10.35', 'Contactless £10.35', 'Clubcard points this visit 10', 'VAT A 20% 1.33', '19/03/26 14:02 Store 2231 Till 4'], { amount: 1035, vat: 133, date: '2026-03-19', merchant: 'Harbour Foods' }],
  ['Sainsbury-like Nectar', ['Market Grocer', 'Anytown AB5 6GH', 'Apples 2.00', 'Cheese 3.50', 'BALANCE DUE £5.50', 'VISA DEBIT £5.50', 'Nectar points earned 5', '19/03/2026 10:12'], { amount: 550, vat: null, date: '2026-03-19', merchant: 'Market Grocer' }],
  ['cafe card slip', ['Bean There', '4 High St, Anytown AB1 1AA', 'Latte 3.20', 'Muffin 2.50', 'Total £5.70', 'Card £5.70', 'VAT 20% £0.95', '05/03/2026 08:41'], { amount: 570, vat: 95, date: '2026-03-05', merchant: 'Bean There' }],
  ['pub with service', ['The Red Lion', 'Anytown AB1 2BB', '19/03/2026 21:03', '2 x Pint £11.00', 'Burger £14.50', 'Subtotal £25.50', 'Service 10% £2.55', 'Total £28.05', 'VAT £4.67'], { amount: 2805, vat: 467, date: '2026-03-19', merchant: 'The Red Lion' }],
  ['petrol station', ['Fuel Stop', 'Ring Road AB7 8JK', '23/03/2026 08:15', 'Pump 2 Diesel', '30.12 L @ 149.9p £45.15', 'TOTAL £45.15', 'VAT @ 20% £7.53', 'Contactless £45.15'], { amount: 4515, vat: 753, date: '2026-03-23', merchant: 'Fuel Stop' }],
  ['taxi simple', ['Northside Taxis', '12/03/2026 22:05', 'Fare £15.00', 'Total £15.00', 'Paid by card'], { amount: 1500, vat: null, date: '2026-03-12', merchant: 'Northside Taxis' }],
  ['parking machine', ['City Car Park', 'Pay & Display', '05/03/2026 09:12', 'Tariff 3 hrs', 'Amount paid £4.50'], { amount: 450, vat: null, date: '2026-03-05', merchant: 'City Car Park' }],
  ['train ticket office', ['Fictional Rail Ltd', 'Anytown to Otherville', 'Off-Peak Return', 'Price £12.40', 'Total £12.40', 'Date 02/03/2026'], { amount: 1240, vat: null, date: '2026-03-02', merchant: 'Fictional Rail Ltd' }],
  ['hotel with total VAT line', ['Glen Lodge', 'Invoice date 11/03/2026', 'Room 2 nights £200.00', 'Breakfast £40.00', 'Total £240.00', 'Total VAT £40.00', 'Paid by card £240.00'], { amount: 24000, vat: 4000, date: '2026-03-11', merchant: 'Glen Lodge' }],
  ['online order', ['Shop Online Ltd', 'Order date 01/03/2026', 'Items £30.00', 'Delivery £3.99', 'Order total £33.99', 'VAT included £5.67'], { amount: 3399, vat: 567, date: '2026-03-01', merchant: 'Shop Online Ltd' }],
  ['restaurant VAT amount line', ['Harbour Deli', '19/03/2026 20:15', 'Food £19.99', 'Total £19.99', 'VAT amount £3.33', 'Card £19.99'], { amount: 1999, vat: 333, date: '2026-03-19', merchant: 'Harbour Deli' }],
  ['cash cafe', ['Corner Café', '05/03/2026 12:41', 'Tea 1.80', 'TOTAL £1.80', 'Cash paid £2.00', 'Change £0.20'], { amount: 180, vat: null, date: '2026-03-05', merchant: 'Corner Café' }],
  ['hardware store till line', ['Hammer & Co', '12 Mill Lane AB1 2CD', 'Screws 4.99', 'TOTAL £4.99', 'VAT 0.83', 'Till 3 Op 12 05/03/2026 12:41'], { amount: 499, vat: 83, date: '2026-03-05', merchant: 'Hammer & Co' }],
];
/** Confident-and-correct fields (amount, VAT, date; the merchant is never confident) measured in fix round 4. */
const ORDINARY_FLOOR = 28;

test('ordinary receipts: never confidently wrong, and at least the measured number of fields confident and correct', () => {
  let confidentAndRight = 0;
  for (const [name, texts, truth] of ORDINARY) {
    const p = extractReceipt(texts.map((text) => ({ text, confidence: 0.95 })), { today: '2026-03-31' });
    for (const [field, right] of [[p.amountPence, truth.amount], [p.vatPence, truth.vat], [p.date, truth.date], [p.merchant, truth.merchant]] as const) {
      if (!field || field.confidence < CONFIDENT) continue;
      expect(field.value, name).toBe(right);
      confidentAndRight += 1;
    }
  }
  expect(confidentAndRight).toBeGreaterThanOrEqual(ORDINARY_FLOOR);
});

test('"Total incl. VAT £8.75" with "VAT £1.46" is now confident and correct', () => {
  const p = extractReceipt([...CAFE_TOP, 'Total incl. VAT £8.75', 'VAT £1.46'].map((text) => ({ text, confidence: 0.95 })), { today: '2026-03-31' });
  expect(p.amountPence).toEqual({ value: 875, confidence: 0.95 });
  expect(p.vatPence).toEqual({ value: 146, confidence: 0.95 });
  expect(p.warnings).toEqual([]);
});

test('a 4-column VAT table that adds up is read confidently', () => {
  const p = extractReceipt([...MIXED_TOP, 'A 20% 16.66 3.33 19.99', 'B 0% 3.50 0.00 3.50'].map((text) => ({ text, confidence: 0.95 })), { today: '2026-03-31' });
  expect(p.amountPence).toEqual({ value: 2349, confidence: 0.95 });
  expect(p.vatPence).toEqual({ value: 333, confidence: 0.95 });
});

// Ruling (Task 2, round 4) replaces round 3's "even VAT TOTAL": a VAT-only line after the total leaves the total
// confident only when its amount is exactly the VAT that fits (see LEGIT_ROUND_4); any other VAT TOTAL still does not.
test('Ruling (Task 2, round 4): a "VAT TOTAL" after the total that is not the fitting VAT makes the total unsure', () => {
  const p = extractReceipt([...MIXED_TOP, 'A 20% 16.66 3.33 19.99', 'B 0% 3.50 0.00 3.50', 'VAT TOTAL 3.30'].map((text) => ({ text, confidence: 0.95 })), { today: '2026-03-31' });
  expect(p.amountPence).toEqual({ value: 2349, confidence: 0.6 });
  expect(p.vatPence).toEqual({ value: 333, confidence: 0.5 });
});

test('a zero balance due beside a real total shows the real total, never confidently', () => {
  const p = extractReceipt(['Corner Café', '05/03/2026 12:41', 'TOTAL DUE £8.75', 'DUE £0.00'].map((text) => ({ text, confidence: 0.95 })), { today: '2026-03-31' });
  expect(p.amountPence).toEqual({ value: 875, confidence: 0.6 });
});

test('a plain date with a time, a weekday or a transaction label is still confident', () => {
  for (const text of ['Date: 05/03/2026', 'Thu 05/03/2026 12:41 pm', 'Transaction date 05/03/2026', 'Tax point 05/03/2026', '5 March 2026', 'Date of issue 05/03/2026']) {
    const p = extractReceipt([{ text: 'Shop', confidence: 0.95 }, { text, confidence: 0.95 }, { text: 'TOTAL £8.75', confidence: 0.95 }], { today: '2026-03-31' });
    expect(p.date, text).toEqual({ value: '2026-03-05', confidence: 0.95 });
  }
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
