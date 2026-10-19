import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusModel } from '../src/ui/status.js';

const run = (events) => { const m = new StatusModel(); for (const e of events) m.apply(e); return m.lines(); };
const PLAN = [
  { type: 'phase', name: 'plan' },
  { type: 'call', participant: 'claude', role: 'author', write: false },
  { type: 'result', participant: 'claude', servedBy: 'claude', role: 'author', ok: true, costUsd: 0.1 },
  { type: 'call', participant: 'codex', role: 'reviewer', write: false },
  { type: 'result', participant: 'codex', servedBy: 'codex', role: 'reviewer', ok: true, verdict: { decision: 'APPROVE' }, costUsd: null },
  { type: 'plan-agreed', chunks: ['export util', 'UI button for the reports page'], rounds: 1, author: 'claude', reviewer: 'codex' },
];

test('planning, then the agreed plan with queued steps', () => {
  assert.deepEqual(run(PLAN.slice(0, 2)), [
    '  ⟳ Planning                          claude drafting the plan…',
    '  frontier cost reported so far: ~$0.00 · local steps: 0',
  ]);
  assert.deepEqual(run(PLAN), [
    '  ✓ Plan agreed                       claude drafted · codex reviewed (1 round)',
    '    Step 1/2   export util            queued',
    '    Step 2/2   UI button for the rep… queued',
    '  frontier cost reported so far: ~$0.10 · local steps: 0',
  ]);
});

test('a step: editing, reviewing, done by local', () => {
  const step = [
    ...PLAN,
    { type: 'chunk', index: 0, title: 'export util' },
    { type: 'call', participant: 'local', role: 'grunt', write: true },
  ];
  assert.equal(run(step)[1], '  ⟳ Step 1/2   export util            local ✎ …');
  step.push({ type: 'result', participant: 'local', servedBy: 'local', role: 'grunt', ok: true });
  step.push({ type: 'call', participant: 'codex', role: 'reviewer', write: false });
  assert.equal(run(step)[1], '  ⟳ Step 1/2   export util            local ✎ · codex reviewing…');
  step.push({ type: 'result', participant: 'codex', servedBy: 'codex', role: 'reviewer', ok: true, verdict: { decision: 'APPROVE' } });
  step.push({ type: 'chunk-done', index: 0, by: 'local' });
  const lines = run(step);
  assert.equal(lines[1], '  ✓ Step 1/2   export util            local ✎ · codex reviewed ✓');
  assert.equal(lines.at(-1), '  frontier cost reported so far: ~$0.10 · local steps: 1');
});

test('a fallback step says who took over and does not count as local', () => {
  const lines = run([
    ...PLAN,
    { type: 'chunk', index: 0, title: 'export util' },
    { type: 'call', participant: 'local', role: 'grunt', write: true },
    { type: 'result', participant: 'local', role: 'grunt', ok: false },
    { type: 'chunk-fallback', index: 0, to: 'claude' },
    { type: 'call', participant: 'claude', role: 'author', write: true },
    { type: 'result', participant: 'claude', servedBy: 'codex', role: 'author', ok: true, costUsd: 0.05 },
    { type: 'call', participant: 'codex', role: 'reviewer', write: false },
    { type: 'result', participant: 'codex', servedBy: 'codex', role: 'reviewer', ok: true, verdict: { decision: 'APPROVE' } },
    { type: 'chunk-done', index: 0, by: 'codex' },
  ]);
  assert.equal(lines[1], '  ✓ Step 1/2   export util            codex ✎ (took over) · codex reviewed ✓');
  assert.equal(lines.at(-1), '  frontier cost reported so far: ~$0.15 · local steps: 0');
});

test('the final check, waiting for approval, then done', () => {
  const ev = [...PLAN, { type: 'phase', name: 'final' }, { type: 'call', participant: 'codex', role: 'reviewer', write: false }];
  assert.equal(run(ev).at(-2), '  ⟳ Final check                       codex checking the whole change…');
  ev.push({ type: 'result', participant: 'codex', servedBy: 'codex', role: 'reviewer', ok: true, verdict: { decision: 'APPROVE' } });
  assert.equal(run(ev).at(-2), '  ⟳ Final check                       waiting for your approval');
  ev.push({ type: 'finish', status: 'landed' });
  assert.equal(run(ev).at(-2), '  ✓ Final check                       done');
});

test('routing notices: plain words, last three only, same-vendor once', () => {
  const lines = run([
    ...PLAN,
    { type: 'route-failover', seat: 'claude', from: 'claude', reason: 'unauthorized' },
    { type: 'same-vendor-review', phase: 'chunk', index: 0, vendor: 'openai' },
    { type: 'same-vendor-review', phase: 'chunk', index: 1, vendor: 'openai' },
    { type: 'route-wait', seat: 'codex', ms: 30400 },
    { type: 'api-in-use', seat: 'codex', participant: 'gpt-api' },
  ]);
  assert.deepEqual(lines.slice(-3), [
    '  ! a step was checked by the same AI company that wrote it',
    '  ⏸ every model for codex is rate-limited; waiting 30s',
    '  $ using the paid API (gpt-api); this costs money',
  ]);
  assert.ok(!lines.some((l) => l.includes('↪')), 'only the last three notices are shown');
  assert.equal(run([{ type: 'route-failover', seat: 's', from: 'claude', reason: 'unauthorized' }]).at(-1),
    '  ↪ claude is not signed in, or its key was refused; switching to the next model');
});

test('seed shows a resumed run; unknown or malformed events are ignored', () => {
  const m = new StatusModel();
  m.seed({ chunks: ['One', 'Two'], done: 1 });
  m.apply({ type: 'something-new' });
  m.apply(null);
  m.apply({ type: 'chunk', index: 99, title: 'ghost' });
  assert.deepEqual(m.lines().slice(0, 3), [
    '  ✓ Plan agreed                       from the earlier run',
    '  ✓ Step 1/2   One                    done earlier',
    '    Step 2/2   Two                    queued',
  ]);
});
