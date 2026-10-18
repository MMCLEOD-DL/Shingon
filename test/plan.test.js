import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../src/plan.js';

const good = { summary: 'S', chunks: [{ title: 'A', instructions: 'do a' }, { title: 'B', instructions: 'do b' }] };
const fenced = (o) => 'Here is the plan.\n```json\n' + JSON.stringify(o) + '\n```\n';

test('parses the json block', () => {
  const r = parsePlan(fenced(good));
  assert.equal(r.ok, true);
  assert.equal(r.plan.summary, 'S');
  assert.deepEqual(r.plan.chunks.map((c) => c.title), ['A', 'B']);
});

test('uses the last json block when there are several', () => {
  const r = parsePlan(fenced({ summary: 'old', chunks: [{ title: 'X', instructions: 'x' }] }) + fenced(good));
  assert.equal(r.plan.summary, 'S');
});

test('accepts bare JSON (outer fence already stripped by the normalizer)', () => {
  assert.equal(parsePlan(JSON.stringify(good)).ok, true);
});

test('trims strings and defaults a missing summary', () => {
  const r = parsePlan(fenced({ chunks: [{ title: '  A ', instructions: ' a ' }] }));
  assert.deepEqual(r.plan, { summary: '', chunks: [{ title: 'A', instructions: 'a' }] });
});

test('errors: no block, bad JSON, no chunks, too many, incomplete chunk', () => {
  assert.match(parsePlan('just prose').error, /no ```json plan block/);
  assert.match(parsePlan('```json\n{nope\n```').error, /not valid JSON/);
  assert.match(parsePlan(fenced({ summary: 's', chunks: [] })).error, /no chunks/);
  const many = { chunks: Array.from({ length: 4 }, (_, i) => ({ title: `t${i}`, instructions: 'i' })) };
  assert.match(parsePlan(fenced(many), { maxChunks: 3 }).error, /4 chunks \(max 3\)/);
  assert.match(parsePlan(fenced({ chunks: [{ title: 'A' }] })).error, /chunk 1 is missing/);
  assert.match(parsePlan(fenced([1, 2])).error, /must be an object/);
  assert.match(parsePlan(undefined).error, /no ```json plan block/);
});
