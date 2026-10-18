import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleDeadlock } from '../src/deadlock.js';

const pass = { ran: true, passed: true, code: 0, output: '' };
const fail = { ran: true, passed: false, code: 1, output: 'x' };

test('reversible disagreement with passing tests is accepted with a note', () => {
  const r = settleDeadlock({ reason: 'prefer a map over a loop', tests: pass });
  assert.equal(r.action, 'accept');
  assert.match(r.note, /prefer a map over a loop/);
});

test('no tests configured still accepts a reversible disagreement', () => {
  assert.equal(settleDeadlock({ reason: 'naming', tests: { ran: false } }).action, 'accept');
  assert.equal(settleDeadlock({ reason: 'naming' }).action, 'accept');
});

test('failing tests escalate', () => {
  const r = settleDeadlock({ reason: 'naming', tests: fail });
  assert.equal(r.action, 'escalate');
  assert.match(r.note, /tests are failing/i);
  assert.match(r.recommendation, /^Reject/);
});

test('accepted settlements carry no recommendation', () => {
  assert.equal(settleDeadlock({ reason: 'naming' }).recommendation, null);
});

test('IRREVERSIBLE marker escalates, any case', () => {
  assert.equal(settleDeadlock({ reason: 'IRREVERSIBLE: drops the users table', tests: pass }).action, 'escalate');
  assert.equal(settleDeadlock({ reason: 'irreversible: renames public API', tests: pass }).action, 'escalate');
});

test('unreviewed or unproduced work escalates', () => {
  assert.equal(settleDeadlock({ reason: 'reviewer failed: exit 1', tests: pass }).action, 'escalate');
  assert.equal(settleDeadlock({ reason: 'reviewer gave no VERDICT line', tests: pass }).action, 'escalate');
  assert.equal(settleDeadlock({ reason: 'whatever', tests: pass, produced: false }).action, 'escalate');
});
