import { test, expect } from 'vitest';
import { buildMoneyReport, formatCell } from '../src/report.js';
import { formatPounds, vatFromGross, MoneyError } from '../src/money.js';
import { LONG_MERCHANT, W1_EXPECTED, W1_MARCH, W2_EXPECTED, W2_LARGE, W3_AWKWARD, W3_EXPECTED } from './worked-examples.js';

test('W1: subtotals and totals are exact', () => {
  const r = buildMoneyReport(W1_MARCH);
  expect(r.groups.map((g) => g.label)).toEqual(['Office', 'Subsistence', 'Travel']);
  expect(r.groups.map((g) => g.subtotals)).toEqual([{ gross: 30, vat: 5 }, { gross: 3274, vat: 546 }, { gross: 6060, vat: 957 }]);
  expect(r.totals).toEqual({ gross: 9364, vat: 1508 });
  expect(r.rowCount).toBe(7);
  // The hand-worked figures written next to the example agree.
  expect(r.groups.map((g) => g.label)).toEqual(W1_EXPECTED.groups);
  expect(r.groups.map((g) => g.subtotals)).toEqual(W1_EXPECTED.subtotals);
  expect(r.totals).toEqual(W1_EXPECTED.totals);
});
test('W1: each row\'s VAT is 20% of its gross, half up (the train is zero-rated)', () => {
  for (const row of W1_MARCH.rows) if (row.merchant !== 'Fictional Rail Ltd') expect(row.vat).toBe(vatFromGross(row.gross as number, 2000));
});
test('W1: the money in pounds reads as the hand-worked figures', () => {
  const r = buildMoneyReport(W1_MARCH);
  expect(r.groups.map((g) => [formatPounds(g.subtotals.gross!), formatPounds(g.subtotals.vat!)])).toEqual([['£0.30', '£0.05'], ['£32.74', '£5.46'], ['£60.60', '£9.57']]);
  expect([formatPounds(r.totals.gross!), formatPounds(r.totals.vat!)]).toEqual(['£93.64', '£15.08']);
});
test('W1: rows in a group are in date order', () => {
  const travel = buildMoneyReport(W1_MARCH).groups[2]!;
  expect(travel.rows.map((row) => row.merchant)).toEqual(['Fictional Rail Ltd', 'Northside Taxis', 'Fuel Stop']);
});
test('W2: £246,912.00 and £41,152.00', () => {
  const r = buildMoneyReport(W2_LARGE);
  expect(r.totals).toEqual({ gross: 24691200, vat: 4115200 });
  expect(r.totals).toEqual(W2_EXPECTED.totals);
  expect(r.rowCount).toBe(200);
  expect(formatPounds(r.totals.gross!)).toBe('£246,912.00');
  expect(formatPounds(r.totals.vat!)).toBe('£41,152.00');
});
test('W3: refunds count, totals stay exact', () => {
  const r = buildMoneyReport(W3_AWKWARD);
  expect(r.totals).toEqual({ gross: 1050, vat: 176 });
  expect(r.totals).toEqual(W3_EXPECTED.totals);
  expect(r.groups).toHaveLength(1);
  expect(r.groups[0]!.label).toBeNull();
  expect(r.groups[0]!.subtotals).toEqual(r.totals);
  expect(LONG_MERCHANT).toHaveLength(200);
});
test('a money cell in pounds is refused with the row and column named', () => {
  expect(() => buildMoneyReport({ ...W1_MARCH, rows: [{ ...W1_MARCH.rows[0]!, vat: 0.5 }] })).toThrow('Row 1, column "VAT" is not a whole number of pence.');
  const third = W1_MARCH.rows.map((row, i) => (i === 2 ? { ...row, gross: '12.40' } : row));
  const err = (() => { try { buildMoneyReport({ ...W1_MARCH, rows: third }); } catch (e) { return e; } })();
  expect(err).toBeInstanceOf(MoneyError);
  expect((err as MoneyError).userMessage).toBe('Row 3, column "Total" is not a whole number of pence.');
});
test('a date that is not a real day is refused', () => {
  for (const date of ['2026-02-30', '12/03/2026', '2026-3-1', '']) {
    expect(() => buildMoneyReport({ ...W1_MARCH, rows: [{ ...W1_MARCH.rows[0]!, date }] })).toThrow('Row 1, column "Date" is not a date like 2026-03-12.');
  }
});
test('formatCell', () => {
  expect(formatCell({ key: 'd', label: 'Date', kind: 'date' }, '2026-03-12')).toBe('12/03/2026');
  expect(formatCell({ key: 'g', label: 'Total', kind: 'money' }, -500)).toBe('−£5.00');
  expect(formatCell({ key: 'm', label: 'Merchant', kind: 'text' }, '=HYPERLINK("http://x","click")')).toBe('=HYPERLINK("http://x","click")');
});
test('generated time is shown in UK time across the clock change', () => {
  expect(buildMoneyReport({ ...W1_MARCH, generatedAt: new Date('2026-03-29T00:30:00Z') }).generatedAtText).toBe('29 March 2026, 00:30');
  expect(buildMoneyReport({ ...W1_MARCH, generatedAt: new Date('2026-03-29T01:30:00Z') }).generatedAtText).toBe('29 March 2026, 02:30');
  expect(buildMoneyReport({ ...W1_MARCH, generatedAt: new Date('2026-10-27T14:05:00Z') }).generatedAtText).toBe('27 October 2026, 14:05');
});
test('the input is not changed and every money column is totalled even when there are no rows', () => {
  const before = structuredClone(W1_MARCH);
  buildMoneyReport(W1_MARCH);
  expect(W1_MARCH).toEqual(before);
  const empty = buildMoneyReport({ ...W1_MARCH, rows: [] });
  expect(empty.totals).toEqual({ gross: 0, vat: 0 });
  expect(empty.groups).toEqual([]);
  expect(empty.rowCount).toBe(0);
});
