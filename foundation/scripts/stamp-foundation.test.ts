import { afterAll, test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readStamp } from './stamp-foundation.js';

const dir = mkdtempSync(path.join(tmpdir(), 'hf-stamp-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
const put = (text: string): string => { const f = path.join(dir, `f${String(Math.random())}.json`); writeFileSync(f, text); return f; };

test('reads a good stamp', () => {
  expect(readStamp(put('{"name":"highland-foundation","version":"1.2.3","commit":"v1.2.3"}')).version).toBe('1.2.3');
});
test('a missing or damaged stamp fails in plain English', () => {
  expect(() => readStamp(path.join(dir, 'nope.json'))).toThrow('foundation.json is missing');
  expect(() => readStamp(put('{oops'))).toThrow('not valid JSON');
  expect(() => readStamp(put('{"name":"highland-foundation","version":"x","commit":"c"}'))).toThrow('damaged');
  expect(() => readStamp(put('{"name":"other","version":"1.0.0","commit":"c"}'))).toThrow('damaged');
});
