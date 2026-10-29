/**
 * Worked examples for money reports (spec §2.2). Every expected figure was worked out by hand and is written next to
 * the example, so a test that checks a report against these numbers checks the arithmetic, not the code against itself.
 * Task 7 (spreadsheet) and Task 8 (PDF) both import this file. All names are fictional.
 */
import type { ReportColumn, ReportInput } from '../src/report.js';

const EXPENSE_COLUMNS: ReportColumn[] = [
  { key: 'date', label: 'Date', kind: 'date' },
  { key: 'person', label: 'Person', kind: 'text' },
  { key: 'category', label: 'Category', kind: 'text' },
  { key: 'merchant', label: 'Merchant', kind: 'text' },
  { key: 'gross', label: 'Total', kind: 'money' },
  { key: 'vat', label: 'VAT', kind: 'money' },
];

/**
 * March 2026, grouped by category. Expected, by hand:
 * - Office: gross 30 (£0.30), VAT 5 (£0.05) — 10p + 20p, the floating-point trap.
 * - Subsistence: gross 3274 (£32.74), VAT 546 (£5.46).
 * - Travel: gross 6060 (£60.60), VAT 957 (£9.57) — includes the spec's £12.40 receipt with £2.07 VAT.
 * - Total: gross 9364 (£93.64), VAT 1508 (£15.08); seven rows; groups in the order Office, Subsistence, Travel.
 * Every VAT is 20% of its gross, half up, except the train (zero-rated).
 */
export const W1_MARCH: ReportInput = {
  title: 'March 2026 expenses',
  periodLabel: '1 to 31 March 2026',
  generatedAt: new Date('2026-04-01T08:30:00Z'),
  columns: EXPENSE_COLUMNS,
  groupBy: 'category',
  rows: [
    { date: '2026-03-02', person: 'Alice Example', category: 'Travel', merchant: 'Fictional Rail Ltd', gross: 320, vat: 0 },
    { date: '2026-03-05', person: 'Alice Example', category: 'Subsistence', merchant: 'Corner Café', gross: 875, vat: 146 },
    { date: '2026-03-12', person: 'Ben Sample', category: 'Travel', merchant: 'Northside Taxis', gross: 1240, vat: 207 },
    { date: '2026-03-19', person: 'Ben Sample', category: 'Subsistence', merchant: 'Harbour Deli', gross: 2399, vat: 400 },
    { date: '2026-03-23', person: 'Alice Example', category: 'Travel', merchant: 'Fuel Stop', gross: 4500, vat: 750 },
    { date: '2026-03-30', person: 'Ben Sample', category: 'Office', merchant: 'Paper & Pens', gross: 10, vat: 2 },
    { date: '2026-03-31', person: 'Ben Sample', category: 'Office', merchant: 'Paper & Pens', gross: 20, vat: 3 },
  ],
};
export const W1_EXPECTED = {
  groups: ['Office', 'Subsistence', 'Travel'],
  subtotals: [{ gross: 30, vat: 5 }, { gross: 3274, vat: 546 }, { gross: 6060, vat: 957 }],
  totals: { gross: 9364, vat: 1508 },
  rowCount: 7,
} as const;

/** 200 rows of £1,234.56 with £205.76 VAT. Expected: total £246,912.00, VAT £41,152.00. Pins thousands separators and page breaks. */
export const W2_LARGE: ReportInput = {
  title: 'April 2026 equipment',
  periodLabel: '1 to 30 April 2026',
  generatedAt: new Date('2026-05-01T08:30:00Z'),
  columns: EXPENSE_COLUMNS,
  groupBy: 'category',
  rows: Array.from({ length: 200 }, (_, i) => ({
    date: '2026-04-01', person: 'Alice Example', category: 'Equipment', merchant: `Fictional Supplies Ltd, order ${String(i + 1)}`, gross: 123456, vat: 20576,
  })),
};
export const W2_EXPECTED = { totals: { gross: 24691200, vat: 4115200 }, rowCount: 200 } as const;

/** A merchant name of exactly 200 characters. */
export const LONG_MERCHANT = 'The Long-Named Fictional Stationery, Printing and Office Furniture Company of Northern England and the Scottish Borders (Trading as Example Supplies), Unit 4, Imaginary Industrial Estate, Nowhereshire';

/** Awkward text, ungrouped: a formula-looking merchant, characters outside Latin-1, a 200-character name and a refund. Expected: gross 1050 (£10.50), VAT 176 (£1.76). */
export const W3_AWKWARD: ReportInput = {
  title: 'Awkward receipts',
  periodLabel: 'March 2026',
  generatedAt: new Date('2026-04-01T08:30:00Z'),
  columns: [
    { key: 'date', label: 'Date', kind: 'date' },
    { key: 'person', label: 'Person', kind: 'text' },
    { key: 'merchant', label: 'Merchant', kind: 'text' },
    { key: 'gross', label: 'Total', kind: 'money' },
    { key: 'vat', label: 'VAT', kind: 'money' },
  ],
  rows: [
    { date: '2026-03-03', person: 'Alice Example', merchant: '=HYPERLINK("http://x","click")', gross: 1000, vat: 167 },
    { date: '2026-03-04', person: 'Alice Example', merchant: 'Łódź Café 🍕', gross: 450, vat: 75 },
    { date: '2026-03-05', person: 'Ben Sample', merchant: LONG_MERCHANT, gross: 100, vat: 17 },
    { date: '2026-03-06', person: 'Ben Sample', merchant: 'Corner Café (refund)', gross: -500, vat: -83 },
  ],
};
export const W3_EXPECTED = { totals: { gross: 1050, vat: 176 }, rowCount: 4 } as const;
