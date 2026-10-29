import { test, expect } from 'vitest';
import { CONFIDENT } from '@hf/shared';
import { readReceipt, type OcrResult } from '../src/index.js';

const line = (text: string, confidence = 0.95) => ({ text, confidence });
const result = (over: Partial<OcrResult>): OcrResult => ({ engine: 'fake', lines: [], warnings: [], ms: 1, ...over });
const TODAY = '2026-03-31';

test('engine fields win, and lines fill the gaps', () => {
  const p = readReceipt(
    result({
      lines: [line('Northside Taxis'), line('12 Mar 2026 22:05'), line('Fare 12.40'), line('Total to pay £12.40', 0.7), line('incl. VAT £2.07')],
      fields: { amountPence: { value: 1240, confidence: 0.97 } },
    }),
    TODAY,
  );
  expect(p.amountPence).toEqual({ value: 1240, confidence: 0.97 });
  // The lines' VAT was checked against the lines' own unsure total, so it stays marked; the value comes from the lines.
  expect(p.vatPence).toMatchObject({ value: 207 });
  expect(p.date).toMatchObject({ value: '2026-03-12' });
  expect(p.merchant?.value).toBe('Northside Taxis');
  expect(p.warnings).toEqual([]);
});

test('an engine field still goes through the VAT cross-check', () => {
  const p = readReceipt(
    result({ fields: { amountPence: { value: 1240, confidence: 0.97 }, vatPence: { value: 270, confidence: 0.99 } } }),
    TODAY,
  );
  expect(p.amountPence).toMatchObject({ value: 1240 });
  expect(p.vatPence).toMatchObject({ value: 270 });
  expect(p.vatPence!.confidence).toBeLessThan(CONFIDENT);
  expect(p.warnings).toContain("The VAT doesn't match the usual rates for this total. Please check it.");
});

test('an engine VAT that fits is kept, and the mismatch warning from the lines is dropped', () => {
  // The lines read 2.70 for the VAT; the engine read 2.07, which fits 20% of £12.40, but the lines disagree with it.
  const p = readReceipt(
    result({
      lines: [line('Northside Taxis'), line('Total to pay £12.40'), line('incl. VAT £2.70')],
      fields: { vatPence: { value: 207, confidence: 0.99 } },
    }),
    TODAY,
  );
  expect(p.vatPence).toMatchObject({ value: 207 });
  expect(p.vatPence!.confidence).toBeLessThan(CONFIDENT);
  expect(p.warnings).not.toContain("The VAT doesn't match the usual rates for this total. Please check it.");
});

test('"no VAT shown" from an engine is never confident', () => {
  const p = readReceipt(result({ fields: { amountPence: { value: 320, confidence: 0.95 }, vatPence: { value: null, confidence: 0.99 } } }), TODAY);
  expect(p.vatPence).toEqual({ value: null, confidence: 0.7 });
});

test('an engine amount on a receipt that may not be in pounds is never certain', () => {
  const p = readReceipt(result({ lines: [line('Café Lumière'), line('TOTAL 14,50 €')], fields: { amountPence: { value: 1450, confidence: 0.99 } } }), TODAY);
  expect(p.currency).toBe('other');
  expect(p.amountPence).toMatchObject({ value: 1450 });
  expect(p.amountPence!.confidence).toBeLessThan(CONFIDENT);
  expect(p.warnings).toContain('This receipt may not be in pounds. Please check the amount.');
});

test('engine warnings are kept', () => {
  const p = readReceipt(result({ lines: [line('Corner Café'), line('TOTAL £8.75')], warnings: ['x'] }), TODAY);
  expect(p.warnings).toContain('x');
});

test('with no engine fields the reading is exactly the extraction', () => {
  const lines = [line('Corner Café'), line('05/03/2026 12:41'), line('TOTAL £8.75'), line('VAT @ 20% 1.46')];
  const p = readReceipt(result({ lines }), TODAY);
  expect(p.amountPence).toMatchObject({ value: 875 });
  expect(p.vatPence).toMatchObject({ value: 146 });
  expect(p.vatPence!.confidence).toBeGreaterThanOrEqual(CONFIDENT);
});

test('an engine VAT that disagrees with the VAT table is marked, even when it is 20% of the total', () => {
  const p = readReceipt(
    result({
      lines: [line('Harbour Foods'), line('BALANCE DUE £23.49'), line('A 20% 16.66 3.33'), line('B 0% 3.50 0.00')],
      fields: { vatPence: { value: 392, confidence: 0.99 } },
    }),
    TODAY,
  );
  expect(p.vatPence).toMatchObject({ value: 392 });
  expect(p.vatPence!.confidence).toBeLessThan(CONFIDENT);
  expect(p.warnings).toContain("The VAT doesn't match the usual rates for this total. Please check it.");
});

test('an engine VAT with no total to check it against is never certain', () => {
  const p = readReceipt(result({ lines: [line('Corner Café')], fields: { vatPence: { value: 146, confidence: 0.99 } } }), TODAY);
  expect(p.amountPence).toBeNull();
  expect(p.vatPence).toMatchObject({ value: 146 });
  expect(p.vatPence!.confidence).toBeLessThan(CONFIDENT);
});

test('an engine amount on a receipt that never says its currency is capped like the extraction caps its own', () => {
  const p = readReceipt(result({ lines: [line('Corner Café'), line('TOTAL 8.75')], fields: { amountPence: { value: 875, confidence: 0.99 } } }), TODAY);
  expect(p.currency).toBe('unknown');
  expect(p.amountPence).toEqual({ value: 875, confidence: 0.8 });
});

test('an engine total or date is capped at 0.8 unless the lines read the same value', () => {
  const lines = [line('Northside Taxis'), line('12 Mar 2026 22:05'), line('Total to pay £12.40')];
  const disagree = readReceipt(result({
    lines,
    fields: { amountPence: { value: 1500, confidence: 0.99 }, date: { value: '2026-03-13', confidence: 0.99 } },
  }), TODAY);
  expect(disagree.amountPence).toEqual({ value: 1500, confidence: 0.8 });
  expect(disagree.date).toEqual({ value: '2026-03-13', confidence: 0.8 });

  const nothingOnTheLines = readReceipt(result({
    lines: [line('Northside Taxis'), line('Paid in £')],
    fields: { amountPence: { value: 1240, confidence: 0.99 }, date: { value: '2026-03-12', confidence: 0.99 } },
  }), TODAY);
  expect(nothingOnTheLines.amountPence!.confidence).toBeLessThanOrEqual(0.8);
  expect(nothingOnTheLines.date).toEqual({ value: '2026-03-12', confidence: 0.8 });

  const agree = readReceipt(result({
    lines,
    fields: { amountPence: { value: 1240, confidence: 0.99 }, date: { value: '2026-03-12', confidence: 0.98 } },
  }), TODAY);
  expect(agree.amountPence).toEqual({ value: 1240, confidence: 0.99 });
  expect(agree.date).toEqual({ value: '2026-03-12', confidence: 0.98 });
});

test('an engine merchant is never certain, even when the lines agree', () => {
  const p = readReceipt(result({ lines: [line('Northside Taxis'), line('Total £12.40')], fields: { merchant: { value: 'Northside Taxis', confidence: 0.99 } } }), TODAY);
  expect(p.merchant).toEqual({ value: 'Northside Taxis', confidence: 0.8 });
});
