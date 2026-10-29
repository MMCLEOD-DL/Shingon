// test/result.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeResult, isResult } from '../src/result.js';

test('makeResult fills defaults', () => {
  const r = makeResult({ text: 'hi' });
  assert.equal(r.text, 'hi');
  assert.equal(r.diff, null);
  assert.equal(r.verdict, null);
  assert.deepEqual(r.usage, { costUsd: null, raw: null });
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.ok(isResult(r));
});

test('makeResult passes through supplied fields', () => {
  const r = makeResult({ text: 't', ok: false, error: 'boom', usage: { costUsd: 0.5, raw: { a: 1 } } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'boom');
  assert.equal(r.usage.costUsd, 0.5);
});

test('isResult rejects non-results', () => {
  assert.equal(isResult({ text: 'x' }), false);
  assert.equal(isResult(null), false);
});
