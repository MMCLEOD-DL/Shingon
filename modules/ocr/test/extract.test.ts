import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CONFIDENT } from '@hf/shared';
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

test.each(CASES)('%s: the VAT, date and merchant are confident too, except "no VAT shown"', (file, _amount, vat) => {
  const p = extractReceipt(lines(file), { today: '2026-03-31' });
  if (vat === null) expect(p.vatPence).toEqual({ value: null, confidence: 0.7 });
  else expect(p.vatPence!.confidence).toBeGreaterThanOrEqual(CONFIDENT);
  expect(p.date!.confidence).toBeGreaterThanOrEqual(CONFIDENT);
  expect(p.merchant!.confidence).toBeGreaterThanOrEqual(CONFIDENT);
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

test('"Total incl. VAT" is never confidently a VAT amount', () => {
  const p = extractReceipt([{ text: 'Shop Name', confidence: 0.99 }, { text: 'Total incl. VAT £12.40', confidence: 0.99 }], { today: '2026-03-31' });
  expect(p.vatPence === null || p.vatPence.confidence < CONFIDENT).toBe(true);
  expect(p.amountPence === null || p.amountPence.confidence < CONFIDENT).toBe(true);
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
  expect(p.merchant!.confidence).toBe(0.88);
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
