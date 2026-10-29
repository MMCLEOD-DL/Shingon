import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSmokeLog } from '../src/council/smoke.js';
import { smokeFindings, RELIABILITY } from '../src/council/reliability.js';
import { applyInterpretation } from '../src/council/interpret.js';

const log = (f) => readFileSync(new URL(`./fixtures/council-full/${f}`, import.meta.url), 'utf8');

test('a passing smoke is a note naming what was proven', () => {
  const [f] = smokeFindings(parseSmokeLog(log('smoke-passed.log'), 0), { machine: 'ct111' });
  assert.equal(f.grade, 'note');
  assert.equal(f.title, 'Deployed on a fresh test machine (ct111), backed up and restored, stopped and restarted with the alert sent and cleared, and a broken update undone automatically');
});

test('a failed step blocks, locked, in plain words', () => {
  const [f] = smokeFindings(parseSmokeLog(log('smoke-failed-step5.log'), 1), { machine: 'ct111' });
  assert.deepEqual([f.title, f.grade, f.locked, f.tool], ['The reliability test failed at: back up, then test a restore', 'blocking', true, 'smoke']);
  assert.match(f.detail, /^restore-test: Restore test failed: 2 tables differ\n/);
});

test('timed out or refused: "not proven", a locked warning', () => {
  const [t] = smokeFindings(parseSmokeLog('== Step 8: update\n', 124, { timedOut: true }), { machine: 'ct111' });
  assert.deepEqual([t.title, t.grade, t.locked], ['Reliability was not proven: the test took longer than the time allowed (it stopped at: update, then undo a broken update automatically)', 'warning', true]);
  const [r] = smokeFindings(parseSmokeLog(log('smoke-refused-images.log'), 2), { machine: 'ct111' });
  assert.match(r.title, /^Reliability was not proven: This machine already has highland\/app or highland\/ops images/);
  assert.equal(r.grade, 'warning');
});

test('RELIABILITY.collect: no machine → not proven; ordinary repo → nothing', async () => {
  const [run] = await RELIABILITY.collect({ brief: {}, evidence: { smoke: null, smokeStatus: 'missing', smokeNote: 'No test machine is set up (factory.machines in the config), so the reliability test did not run.', machine: null } });
  assert.equal(run.status, 'missing');
  assert.deepEqual(run.findings.map((f) => [f.grade, f.locked]), [['warning', true]]);
  assert.match(run.findings[0].title, /^Reliability was not proven: No test machine is set up/);
  assert.deepEqual(await RELIABILITY.collect({ brief: null, evidence: null }), []);
  const [ok] = await RELIABILITY.collect({ brief: {}, evidence: { smokeStatus: 'ran', machine: 'ct111', smoke: parseSmokeLog(log('smoke-passed.log'), 0), smokeNote: null } });
  assert.match(ok.context, /✓ back up, then test a restore/);
  assert.match(ok.context, /Not covered: a sudden crash of the database or the box/);
});

test('the interpreter cannot clear or lower a failed step, nor set aside "not proven"', () => {
  const fail = smokeFindings(parseSmokeLog(log('smoke-failed-step5.log'), 1), { machine: 'm' });
  const unproven = smokeFindings(parseSmokeLog(log('smoke-refused-images.log'), 2), { machine: 'm' });
  const out = applyInterpretation([...fail, ...unproven], ['R1', 'R2'], {
    findings: [{ id: 'R1', decision: 'dismiss', grade: 'note', why: 'flaky' }, { id: 'R2', decision: 'dismiss', why: 'machine problem' }], extra: [] }, { member: 'reliability' });
  assert.deepEqual(out.map((f) => [f.grade, f.dismissed]), [['blocking', false], ['warning', false]]);
});

test('an unreadable smoke result is "not proven", never a note or a block', async () => {
  for (const odd of [{}, { passed: 'yes' }, { passed: 'false' }, { passed: 1 }, { ran: true }, { passed: false }]) {
    const [f] = smokeFindings(odd, { machine: 'm' });
    assert.deepEqual([f.grade, f.locked], ['warning', true], JSON.stringify(odd));
    assert.equal(f.title, 'Reliability was not proven: the reliability test returned something that could not be read');
    const [run] = await RELIABILITY.collect({ brief: {}, evidence: { smoke: odd, smokeStatus: 'ran', machine: 'm' } });
    assert.equal(run.status, 'error');
  }
});

test('collect: timed out and refused are ToolRun status error; fallbacks', async () => {
  const [t] = await RELIABILITY.collect({ brief: {}, evidence: { smokeStatus: 'ran', machine: 'm', smoke: parseSmokeLog('== Step 8: update\n', 124, { timedOut: true }) } });
  assert.equal(t.status, 'error');
  const [r] = await RELIABILITY.collect({ brief: {}, evidence: { smokeStatus: 'ran', machine: 'm', smoke: parseSmokeLog(log('smoke-refused-images.log'), 2) } });
  assert.equal(r.status, 'error');
  const [b] = smokeFindings(parseSmokeLog('', 1), { machine: 'm' });
  assert.deepEqual([b.title, b.grade], ['The reliability test failed at: before its first step', 'blocking']);
  const [n] = await RELIABILITY.collect({ brief: {}, evidence: { smoke: null, smokeStatus: 'missing' } });
  assert.match(n.findings[0].title, /^Reliability was not proven: the reliability test gave no result$/);
});

test('odd steps in a smoke result never crash the member: a non-list or non-object step is skipped', async () => {
  for (const steps of ['x', { n: 1 }, [null, 7, 'a', { n: '5', title: 'back up, then test a restore', ok: false }]]) {
    const [run] = await RELIABILITY.collect({ brief: {}, evidence: { smokeStatus: 'ran', machine: 'm', smoke: { passed: false, failure: 'boom', steps, failedStep: '5' } } });
    assert.equal(run.findings[0].grade, 'blocking', JSON.stringify(steps));
    assert.ok(run.context.endsWith('(the test stops and starts the app and ops cleanly).'));
  }
  const [run] = await RELIABILITY.collect({ brief: {}, evidence: { smokeStatus: 'ran', machine: 'm', smoke: { passed: false, failure: 'boom', steps: [null, { title: 'back up', ok: false }] } } });
  assert.match(run.context, /^✗ back up\n/);
});
