import { test, expect } from 'vitest';
import { toWinAnsi } from '../src/index.js';

test('text inside Windows-1252 is unchanged', () => {
  expect(toWinAnsi('Café £5 – “quotes”')).toBe('Café £5 – “quotes”');
  expect(toWinAnsi('€10 … ‘a’ — Œuvre ™')).toBe('€10 … ‘a’ — Œuvre ™');
});

test('characters outside Windows-1252 print as one ? each; an emoji is one ?, not two', () => {
  expect(toWinAnsi('Łódź 🍕')).toBe('?ód? ?');
  expect(toWinAnsi('👨\u200d👩\u200d👧 family 🇬🇧')).toBe('? family ?');   // a joined emoji and a flag are one character each to a reader
  expect(toWinAnsi('漢字')).toBe('??');
});

test('a decomposed accent prints as the accented letter', () => {
  expect(toWinAnsi('Café')).toBe('Café');
});

test('the minus sign prints as a hyphen-minus (Windows-1252 has no U+2212)', () => {
  expect(toWinAnsi('−5')).toBe('-5');
  expect(toWinAnsi('−£5.00')).toBe('-£5.00');
});

test('control and invisible formatting characters are removed; tabs and line breaks become a space', () => {
  expect(toWinAnsi('a\u0000b\u0007c\u007fd\u0085e')).toBe('abcde');
  expect(toWinAnsi('Shop\u202eevil\u200b')).toBe('Shopevil');
  expect(toWinAnsi('two\nlines\tand\r\ntab')).toBe('two lines and tab');
});
