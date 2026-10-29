import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clip } from '../src/text.js';

test('short text unchanged', () => {
  assert.equal(clip('abc', 10), 'abc');
});

test('long text keeps head and tail with a marker', () => {
  const s = 'A'.repeat(50) + 'B'.repeat(50);
  const c = clip(s, 20);
  assert.ok(c.startsWith('A'.repeat(10)));
  assert.ok(c.endsWith('B'.repeat(10)));
  assert.match(c, /\[80 chars clipped\]/);
});

test('non-string becomes empty string', () => {
  assert.equal(clip(undefined), '');
});

test('clip boundary: exactly max is unchanged, max+1 is clipped (T2)', () => {
  assert.equal(clip('x'.repeat(20), 20), 'x'.repeat(20));
  const c = clip('x'.repeat(21), 20);
  assert.match(c, /\[1 chars clipped\]/);
});
