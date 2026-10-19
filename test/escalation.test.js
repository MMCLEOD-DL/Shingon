import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEscalation, buildSummary, plainReason } from '../src/escalation.js';

test('plainReason strips the marker', () => {
  assert.equal(plainReason('IRREVERSIBLE: deletes data'), 'deletes data');
  assert.equal(plainReason('fine'), 'fine');
});

test('escalation is plain English with approve/reject and no marker', () => {
  const e = buildEscalation({ kind: 'chunk', title: 'Step 2: migrate data', reason: 'IRREVERSIBLE: drops a column', recommendation: 'Approve: the column is unused.' });
  assert.equal(e.kind, 'chunk');
  assert.deepEqual(e.options, ['approve', 'reject']);
  assert.match(e.message, /Step 2: migrate data/);
  assert.match(e.message, /drops a column/);
  assert.doesNotMatch(e.message, /IRREVERSIBLE/);
  assert.match(e.message, /Recommendation: Approve: the column is unused\./);
  assert.match(e.message, /reject to stop/i);
});

test('each kind has its own explanation', () => {
  const msgs = ['plan', 'chunk', 'final'].map((kind) => buildEscalation({ kind, title: 't', reason: 'r', recommendation: 'x' }).message);
  assert.equal(new Set(msgs).size, 3);
});

test('summary lists steps, files, tests and notes', () => {
  const s = buildSummary({
    request: 'CSV export',
    plan: { summary: 's', chunks: [{ title: 'Backend' }, { title: 'UI' }] },
    notes: ['Accepted over an objection: naming'],
    files: ['a.js', 'b.js'],
    tests: { ran: true, passed: true },
  });
  assert.match(s, /CSV export/);
  assert.match(s, /1\. Backend[\s\S]*2\. UI/);
  assert.match(s, /Files changed \(2\): a\.js, b\.js/);
  assert.match(s, /Tests: passing/);
  assert.match(s, /naming/);
});

test('summary caps a long file list and handles no tests / no notes', () => {
  const files = Array.from({ length: 35 }, (_, i) => `f${i}`);
  const s = buildSummary({ request: 'r', plan: { chunks: [] }, files });
  assert.match(s, /\+ 5 more/);
  assert.match(s, /Tests: not configured/);
  assert.doesNotMatch(s, /Notes:/);
  assert.match(buildSummary({ request: 'r', plan: { chunks: [] }, tests: { ran: true, passed: false } }), /Tests: FAILING/);
});

test('plainReason strips the marker wherever it appears, any case', () => {
  assert.equal(plainReason('Concern: IRREVERSIBLE: drops table'), 'Concern: drops table');
  assert.equal(plainReason('Concern: irreversible: drops table'), 'Concern: drops table');
});

test('escalation message hides a mid-string marker', () => {
  const e = buildEscalation({ kind: 'chunk', title: 't', reason: 'Concern: IRREVERSIBLE: drops table', recommendation: 'Reject.' });
  assert.match(e.message, /Concern: drops table/);
  assert.doesNotMatch(e.message, /IRREVERSIBLE/i);
});

test('summary notes are passed through plainReason (marker mid-string)', () => {
  const s = buildSummary({
    request: 'r', plan: { chunks: [] },
    notes: ['Plan: you approved it over the concern: Concern: IRREVERSIBLE: deletes the user table'],
  });
  assert.doesNotMatch(s, /IRREVERSIBLE/i);
  assert.match(s, /Concern: deletes the user table/);
});

test('What happened follows the situation, falling back to the disagreement wording (I4)', () => {
  const msg = (kind, situation) => buildEscalation({ kind, title: 't', reason: 'r', recommendation: 'x', situation }).message;
  assert.match(msg('chunk', 'unreviewed'), /could not check this step/);
  assert.match(msg('plan', 'unreviewed'), /could not check the plan/);
  assert.match(msg('chunk', 'tests-failing'), /tests are failing/);
  assert.match(msg('chunk', 'irreversible'), /hard to undo/);
  assert.match(msg('chunk', undefined), /could not agree on one step/);
  assert.match(msg('final', 'unreviewed'), /final check/);
});
