import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusModel } from '../src/ui/status.js';

const run = (events) => { const m = new StatusModel(); for (const e of events) m.apply(e); return m.lines(); };
const BUILT = [
  { type: 'plan-agreed', chunks: ['Add parser'], rounds: 1, author: 'claude', reviewer: 'codex' },
  { type: 'chunk', index: 0, title: 'Add parser' },
  { type: 'call', participant: 'local', role: 'grunt', write: true },
  { type: 'result', participant: 'local', servedBy: 'local', role: 'grunt', ok: true },
  { type: 'call', participant: 'codex', role: 'reviewer', write: false },
  { type: 'result', participant: 'codex', servedBy: 'codex', role: 'reviewer', ok: true },
  { type: 'chunk-done', index: 0, by: 'local' },
  { type: 'phase', name: 'final' },
  { type: 'call', participant: 'codex', role: 'reviewer', write: false },
  { type: 'result', participant: 'codex', servedBy: 'codex', role: 'reviewer', ok: true },
];
const ROUND1 = [
  ...BUILT,
  { type: 'council-start', round: 1, members: ['security', 'legal', 'correctness'] },
  { type: 'council-member', member: 'security', stage: 'tools' },
];

test('while the council works, the final check says reviewed, not waiting for approval', () => {
  const lines = run(ROUND1);
  assert.equal(lines[2], '  ✓ Final check                       codex reviewed ✓');
  assert.equal(lines[3], '  ⟳ Council (round 1)                 Security running its checks…');
  const interp = run([...ROUND1,
    { type: 'council-member', member: 'correctness', stage: 'interpreting' },
    { type: 'call', participant: 'claude-backup', role: 'reviewer', write: false }]);
  assert.equal(interp[2], '  ✓ Final check                       codex reviewed ✓', 'a council call does not rename the final reviewer');
  assert.equal(interp[3], '  ⟳ Council (round 1)                 Correctness: claude-backup reading the findings…');
});

test('blocked with rounds left: the fix step is queued and the council line says so', () => {
  assert.deepEqual(run([...ROUND1,
    { type: 'council-verdict', round: 1, verdict: 'blocked', blocking: 2, warning: 0, note: 0 },
    { type: 'council-fix', round: 1, title: 'Council fixes, round 1', blocking: 2 }]), [
    '  ✓ Plan agreed                       claude drafted · codex reviewed (1 round)',
    '  ✓ Step 1/2   Add parser             local ✎ · codex reviewed ✓',
    '    Step 2/2   Council fixes, round 1 queued',
    '  ↺ Council (round 1)                 2 problems sent back to be fixed',
    '  frontier cost reported so far: ~$0.00 · local steps: 1',
  ]);
});

test('round 2 approved: the gate waits; landing ticks the final check', () => {
  const round2 = [...ROUND1,
    { type: 'council-verdict', round: 1, verdict: 'blocked', blocking: 2, warning: 0, note: 0 },
    { type: 'council-fix', round: 1, title: 'Council fixes, round 1', blocking: 2 },
    { type: 'chunk', index: 1, title: 'Council fixes, round 1' },
    { type: 'chunk-done', index: 1, by: 'local' },
    { type: 'phase', name: 'final' },
    { type: 'result', participant: 'codex', servedBy: 'codex', role: 'reviewer', ok: true }];
  assert.equal(run(round2)[3], '  ✓ Final check                       codex reviewed ✓', 'a known council means the gate is not next yet');
  const approved = [...round2,
    { type: 'council-start', round: 2, members: [] },
    { type: 'council-verdict', round: 2, verdict: 'approved-with-warnings', blocking: 0, warning: 1, note: 0 }];
  const lines = run(approved);
  assert.equal(lines[3], '  ⟳ Final check                       waiting for your approval');
  assert.equal(lines[4], '  ✓ Council (round 2)                 approved · 1 warning');
  assert.equal(run([...approved, { type: 'finish', status: 'landed' }])[3], '  ✓ Final check                       done');
});

test('still blocking at the cap: shown plainly; approving the escalation moves on to the gate', () => {
  const stuck = [...ROUND1, { type: 'council-verdict', round: 1, verdict: 'blocked', blocking: 1, warning: 0, note: 0 }];
  assert.equal(run(stuck)[3], '  ✗ Council (round 1)                 1 problem still blocking');
  assert.equal(run([...stuck, { type: 'decision', kind: 'council', title: 'the council review', decision: 'approve' }])[2],
    '  ⟳ Final check                       waiting for your approval');
});

test('a run that ends while the council is working does not look busy', () => {
  assert.equal(run([...ROUND1, { type: 'finish', status: 'paused' }])[3], '  ⏸ Council (round 1)                 paused');
  assert.equal(run([...ROUND1, { type: 'finish', status: 'failed' }])[3], '  ✗ Council (round 1)                 failed');
  assert.equal(run([...ROUND1, { type: 'finish', status: 'interrupted' }])[3], '  ✗ Council (round 1)                 stopped');
  const done = [...ROUND1, { type: 'council-verdict', round: 1, verdict: 'approved', blocking: 0, warning: 0, note: 0 }, { type: 'finish', status: 'rejected' }];
  assert.equal(run(done)[3], '  ✓ Council (round 1)                 approved', 'a finished council keeps its verdict');
});

test('no council: the final check behaves exactly as before', () => {
  assert.equal(run(BUILT)[2], '  ⟳ Final check                       waiting for your approval');
  assert.equal(run(BUILT).some((l) => l.includes('Council')), false);
});
