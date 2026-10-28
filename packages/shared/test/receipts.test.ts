import { test, expect } from 'vitest';
import { ConfirmReadingInput, IsoDate, correctedFields, type ConfirmedReceipt, type ReceiptProposal } from '../src/receipts.js';

const proposal: ReceiptProposal = {
  amountPence: { value: 875, confidence: 0.95 },
  vatPence: { value: 146, confidence: 0.95 },
  date: { value: '2026-03-05', confidence: 0.95 },
  merchant: { value: 'Corner Café', confidence: 0.9 },
  currency: 'GBP',
  warnings: [],
};
const same: ConfirmedReceipt = { amountPence: 875, vatPence: 146, date: '2026-03-05', merchant: 'Corner Café' };

test('correctedFields: nothing corrected when every confirmed value equals the proposal', () => {
  expect(correctedFields(proposal, same)).toEqual([]);
});
test('correctedFields: lists the fields that differ, in order', () => {
  expect(correctedFields(proposal, { ...same, merchant: 'Corner Cafe Ltd', amountPence: 857 })).toEqual(['amount', 'merchant']);
});
test('correctedFields: all four when there was no proposal', () => {
  expect(correctedFields(null, same)).toEqual(['amount', 'vat', 'date', 'merchant']);
});
test('correctedFields: a proposal field that is null counts as corrected', () => {
  expect(correctedFields({ ...proposal, vatPence: null, date: null }, same)).toEqual(['vat', 'date']);
});
test('correctedFields: "no VAT shown" confirmed as no VAT is not a correction', () => {
  expect(correctedFields({ ...proposal, vatPence: { value: null, confidence: 0.7 } }, { ...same, vatPence: null })).toEqual([]);
  expect(correctedFields({ ...proposal, vatPence: { value: null, confidence: 0.7 } }, same)).toEqual(['vat']);
});

test('ConfirmReadingInput accepts a good reading and trims the merchant', () => {
  expect(ConfirmReadingInput.parse({ ...same, merchant: '  Corner Café  ' })).toEqual(same);
  expect(ConfirmReadingInput.parse({ ...same, vatPence: null }).vatPence).toBeNull();
});
test('ConfirmReadingInput refuses VAT above the total', () => {
  const r = ConfirmReadingInput.safeParse({ ...same, vatPence: 876 });
  expect(r.success).toBe(false);
  expect(r.error?.issues.map((i) => i.message)).toContain("The VAT can't be more than the total.");
  expect(ConfirmReadingInput.safeParse({ ...same, vatPence: 875 }).success).toBe(true);
});
test('ConfirmReadingInput refuses a day that does not exist', () => {
  expect(ConfirmReadingInput.safeParse({ ...same, date: '2026-02-30' }).success).toBe(false);
  expect(IsoDate.safeParse('2026-02-30').success).toBe(false);
  expect(IsoDate.safeParse('2028-02-29').success).toBe(true);
  expect(IsoDate.safeParse('2026-02-29').success).toBe(false);
  expect(IsoDate.safeParse('05/03/2026').success).toBe(false);
});
test('ConfirmReadingInput refuses extra keys', () => {
  expect(ConfirmReadingInput.safeParse({ ...same, ownerId: 'x' }).success).toBe(false);
});
test('ConfirmReadingInput refuses fractions of a penny, empty merchants and silly amounts', () => {
  expect(ConfirmReadingInput.safeParse({ ...same, amountPence: 8.75 }).success).toBe(false);
  expect(ConfirmReadingInput.safeParse({ ...same, merchant: '   ' }).success).toBe(false);
  expect(ConfirmReadingInput.safeParse({ ...same, amountPence: 0 }).success).toBe(false);
  expect(ConfirmReadingInput.safeParse({ ...same, amountPence: 10_000_001 }).success).toBe(false);
  expect(ConfirmReadingInput.safeParse({ ...same, vatPence: -1 }).success).toBe(false);
});
