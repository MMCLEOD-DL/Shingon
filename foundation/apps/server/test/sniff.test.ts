import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sniffType } from '../src/files/sniff.js';

const f = (n: string) => readFileSync(new URL(`./fixtures/files/${n}`, import.meta.url));
test('accepted types are recognised by their bytes', () => {
  expect(sniffType(f('tiny.jpg'))).toBe('image/jpeg');
  expect(sniffType(f('tiny.png'))).toBe('image/png');
  expect(sniffType(f('tiny.webp'))).toBe('image/webp');
  expect(sniffType(f('tiny.heic'))).toBe('image/heic');
  expect(sniffType(f('tiny.pdf'))).toBe('application/pdf');
});
test('SVG, HTML, empty and junk are refused whatever they are called', () => {
  expect(sniffType(f('evil.svg'))).toBeNull();
  expect(sniffType(f('evil.html'))).toBeNull();
  expect(sniffType(Buffer.alloc(0))).toBeNull();
  expect(sniffType(Buffer.from('GIF89a'))).toBeNull();
});
