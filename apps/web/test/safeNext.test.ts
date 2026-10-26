import { test, expect } from 'vitest';
import { safeNext } from '../src/safeNext.js';

test('only a path on this site is accepted', () => {
  expect(safeNext('/notes')).toBe('/notes');
  expect(safeNext('/profile?tab=2#x')).toBe('/profile?tab=2#x');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', 'notes', '', '/a\nb', '/\t/evil.example', null, undefined]) {
    expect(safeNext(bad)).toBe('/');
  }
  expect(safeNext('//evil.example', '/notes')).toBe('/notes');
});
