// test/normalizer.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalizer.js';

test('plain text passes through trimmed', () => {
  const r = normalize('  looks good  ');
  assert.equal(r.text, 'looks good');
  assert.equal(r.diff, null);
  assert.equal(r.verdict, null);
});

test('strips a single outer code fence wrapping the whole reply', () => {
  const r = normalize('```\nhello world\n```');
  assert.equal(r.text, 'hello world');
});

test('extracts a fenced diff block', () => {
  const raw = 'Here is the change:\n```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n```\nDone.';
  const r = normalize(raw);
  assert.match(r.diff, /\+new/);
  assert.match(r.diff, /^--- a\/x/);
});

test('parses APPROVE verdict', () => {
  const r = normalize('All tests pass.\nVERDICT: APPROVE');
  assert.deepEqual(r.verdict, { decision: 'APPROVE', reason: '' });
});

test('parses BLOCK verdict with reason and various separators/case', () => {
  const r = normalize('verdict: block — the migration drops a column');
  assert.equal(r.verdict.decision, 'BLOCK');
  assert.match(r.verdict.reason, /drops a column/);
});

test('messy reply: prose + fenced diff + verdict all recovered', () => {
  const raw = '```\nI made the change.\n```diff\n--- a/f\n+++ b/f\n@@\n+x\n```\nVERDICT: BLOCK: needs a test\n```';
  const r = normalize(raw);
  assert.match(r.diff, /\+x/);
  assert.equal(r.verdict.decision, 'BLOCK');
  assert.match(r.verdict.reason, /needs a test/);
});

test('never throws on empty or null-ish input', () => {
  assert.doesNotThrow(() => normalize(''));
  assert.doesNotThrow(() => normalize(undefined));
});

test('does not strip fences when the reply is not a single wrapping fence', () => {
  const r = normalize('```js\na\n```\nmid\n```py\nb\n```');
  assert.ok(r.text.includes('mid'));
  assert.ok(r.text.includes('```py'));
});

test('APPROVED / BLOCKED normalize to APPROVE / BLOCK', () => {
  assert.equal(normalize('VERDICT: APPROVED').verdict.decision, 'APPROVE');
  const b = normalize('VERDICT: BLOCKED - needs a test').verdict;
  assert.equal(b.decision, 'BLOCK');
  assert.match(b.reason, /needs a test/);
});

test('verdict tolerates markdown bold / quote decoration', () => {
  assert.equal(normalize('**VERDICT: APPROVE**').verdict.decision, 'APPROVE');
  assert.equal(normalize('> VERDICT: BLOCK - x').verdict.decision, 'BLOCK');
});

test('verdict line and diff block are removed from text', () => {
  const r = normalize('Prose here.\n```diff\n--- a/x\n+++ b/x\n@@\n+n\n```\nVERDICT: APPROVE');
  assert.equal(r.text, 'Prose here.');
  assert.ok(!/VERDICT/.test(r.text));
  assert.ok(!/```/.test(r.text));
  assert.match(r.diff, /\+n/);
  assert.equal(r.verdict.decision, 'APPROVE');
});

test('a VERDICT-looking context line inside the diff does not win', () => {
  const r = normalize('```diff\n--- a/x\n+++ b/x\n@@\n+VERDICT: BLOCK inside diff\n```\nVERDICT: APPROVE');
  assert.equal(r.verdict.decision, 'APPROVE');
});

test('large whitespace input does not hang (no catastrophic backtracking)', () => {
  const r = normalize(' \n'.repeat(50000));
  assert.equal(r.verdict, null);
  assert.equal(typeof r.text, 'string');
});

test('non-string input never throws', () => {
  assert.doesNotThrow(() => normalize(null));
  assert.doesNotThrow(() => normalize(42));
  assert.doesNotThrow(() => normalize({}));
});
