import { test, expect } from 'vitest';
import { toPence, formatPounds, sumPence, vatFromGross, MoneyError } from '../src/money.js';

test('toPence reads pounds exactly', () => {
  expect(toPence('12.40')).toBe(1240);
  expect(toPence('£1,234.56')).toBe(123456);
  expect(toPence('0.1')).toBe(10);
  expect(toPence('7')).toBe(700);
  expect(toPence('-5.00')).toBe(-500);
});
test('toPence refuses what is not money', () => {
  for (const bad of ['12.345', '', 'abc', '1,23.00', '£', '1e3', '90071992547409.92']) expect(() => toPence(bad)).toThrow(MoneyError);
});
test('formatPounds', () => {
  expect(formatPounds(1240)).toBe('£12.40');
  expect(formatPounds(123456)).toBe('£1,234.56');
  expect(formatPounds(0)).toBe('£0.00');
  expect(formatPounds(-500)).toBe('−£5.00');
  expect(formatPounds(24691200)).toBe('£246,912.00');
});
test('sumPence never drifts: 10p + 20p is 30p', () => {
  expect(sumPence([10, 20])).toBe(30);
  expect(sumPence([])).toBe(0);
  expect(() => sumPence([10, 0.5])).toThrow(MoneyError);
});
test('vatFromGross: half up, integers only (spec example £12.40 -> £2.07)', () => {
  expect(vatFromGross(1240, 2000)).toBe(207);
  expect(vatFromGross(4500, 2000)).toBe(750);
  expect(vatFromGross(875, 2000)).toBe(146);
  expect(vatFromGross(2399, 2000)).toBe(400);
  expect(vatFromGross(3, 2000)).toBe(1);     // 0.5p rounds up
  expect(vatFromGross(9, 2000)).toBe(2);     // 1.5p rounds up
  expect(vatFromGross(1050, 500)).toBe(50);  // 5% rate
  expect(vatFromGross(1240, 0)).toBe(0);
});
test('refunds and large values', () => {
  expect(vatFromGross(-1240, 2000)).toBe(-207);
  expect(vatFromGross(-3, 2000)).toBe(-1);
  expect(Object.is(vatFromGross(-1, 2000), 0)).toBe(true);
  expect(() => vatFromGross(Number.MAX_SAFE_INTEGER, 2000)).toThrow(MoneyError);
  expect(() => formatPounds(0.5)).toThrow(MoneyError);
  expect(toPence(formatPounds(-500))).toBe(-500);
});
