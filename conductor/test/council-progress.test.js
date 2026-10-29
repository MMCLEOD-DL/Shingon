import { test } from 'node:test';
import assert from 'node:assert/strict';
import { councilProgressLine as line } from '../src/council/progress.js';

test('council events become short plain progress lines', () => {
  assert.equal(line({ type: 'council-start', round: 1, members: ['security', 'legal', 'correctness', 'design', 'reliability'] }), 'Council round 1: Security, Legal, Correctness, Design, Reliability');
  assert.equal(line({ type: 'council-evidence', stage: 'smoke', status: 'start', machine: 'ct111' }), 'Council: deploying on test machine ct111: backup, restore, alerts and updates (10–20 minutes)…');
  assert.equal(line({ type: 'council-evidence', stage: 'smoke', status: 'error', machine: 'ct111' }), 'Council: the reliability test did not finish.');
  assert.equal(line({ type: 'council-evidence', stage: 'cached', status: 'ok' }), 'Council: using the checks already done for this version.');
  assert.equal(line({ type: 'council-verdict', round: 2, verdict: 'blocked', blocking: 1, warning: 3 }), 'Council round 2: 1 problem to fix');
  assert.equal(line({ type: 'council-verdict', round: 3, verdict: 'approved-with-warnings', blocking: 0, warning: 2 }), 'Council round 3: approved, 2 warnings');
  assert.equal(line({ type: 'council-tool', member: 'design', tool: 'axe', status: 'ran', findings: 1 }), null);
});

test('the other table rows', () => {
  assert.equal(line({ type: 'council-evidence', stage: 'reuse', status: 'ok' }), "Council: using the build's own checks for this version.");
  assert.equal(line({ type: 'council-evidence', stage: 'gates', status: 'start' }), 'Council: running the checks the build did not cover (axe, or missing reports)…');
  assert.equal(line({ type: 'council-evidence', stage: 'acquire', status: 'start' }), 'Council: starting a test machine…');
  assert.equal(line({ type: 'council-evidence', stage: 'acquire', status: 'ok', machine: 'x' }), null);
  assert.equal(line({ type: 'council-member', member: 'design', stage: 'interpreting' }), 'Council: Design is being read by the reviewer…');
  assert.equal(line({ type: 'council-member', member: 'design', stage: 'tools' }), null);
  assert.equal(line({ type: 'council-verdict', round: 1, verdict: 'approved', blocking: 0, warning: 0 }), 'Council round 1: approved');
  assert.equal(line({ type: 'council-report-saved', md: '/b/council/report.md' }), 'Council report saved: /b/council/report.md');
  assert.equal(line({ type: 'phase' }), null);
});
