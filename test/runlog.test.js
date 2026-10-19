import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunLog, callRole } from '../src/runlog.js';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { fakeParticipant, approve } from './helpers/fakes.js';

// RunLog is given the run's metadata directory (Workspace#metaDir) and creates it.
function wsDir() {
  return path.join(mkdtempSync(path.join(tmpdir(), 'rl-')), 'ws.conductor');
}
const lines = (d) => readFileSync(path.join(d, 'transcript.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('DEFAULT_OPTIONS is frozen with the documented caps', () => {
  assert.ok(Object.isFrozen(DEFAULT_OPTIONS));
  assert.equal(DEFAULT_OPTIONS.localRounds, 3);
  assert.equal(DEFAULT_OPTIONS.frontierRounds, 2);
});

test('event appends JSON lines and notifies onEvent', () => {
  const d = wsDir();
  const seen = [];
  const log = new RunLog(d, { onEvent: (e) => seen.push(e.type) });
  log.event('phase', { name: 'plan' });
  log.event('phase', { name: 'chunks' });
  const l = lines(d);
  assert.equal(l.length, 2);
  assert.equal(l[1].name, 'chunks');
  assert.ok(l[0].ts);
  assert.deepEqual(seen, ['phase', 'phase']);
});

test('a throwing onEvent does not break logging', () => {
  const d = wsDir();
  const log = new RunLog(d, { onEvent: () => { throw new Error('ui crashed'); } });
  assert.doesNotThrow(() => log.event('x'));
  assert.equal(lines(d).length, 1);
});

test('state round-trips atomically; missing is null; corrupt throws', () => {
  const d = wsDir();
  const log = new RunLog(d);
  assert.equal(log.loadState(), null);
  log.saveState({ phase: 'chunks', chunkIndex: 2 });
  assert.deepEqual(log.loadState(), { phase: 'chunks', chunkIndex: 2 });
  assert.deepEqual(readdirSync(d).filter((n) => n.endsWith('.tmp')), []);
  writeFileSync(path.join(d, 'state.json'), '{oops');
  assert.throws(() => log.loadState(), /corrupt run state/);
});

test('callRole forwards opts, returns the Result, and logs call + result', async () => {
  const d = wsDir();
  const log = new RunLog(d);
  const p = fakeParticipant({ name: 'rev', script: () => ({ text: 'fine', ...approve() }) });
  const r = await callRole(log, p, 'reviewer', 'task', 'ctx', { cwd: d });
  assert.equal(r.ok, true);
  assert.deepEqual(p.calls[0].opts, { cwd: d });
  const l = lines(d);
  assert.deepEqual(l.map((e) => e.type), ['call', 'result']);
  assert.equal(l[1].participant, 'rev');
  assert.equal(l[1].verdict.decision, 'APPROVE');
});

test('callRole turns a throw into ok:false', async () => {
  const d = wsDir();
  const log = new RunLog(d);
  const p = fakeParticipant({ name: 'x', script: () => { throw new Error('spawn ENOENT'); } });
  const r = await callRole(log, p, 'author', 't');
  assert.equal(r.ok, false);
  assert.match(r.error, /spawn ENOENT/);
  assert.equal(lines(d)[1].ok, false);
});

test('callRole clips long output in the transcript', async () => {
  const d = wsDir();
  const log = new RunLog(d);
  const p = fakeParticipant({ name: 'x', script: () => ({ text: 'y'.repeat(10000) }) });
  await callRole(log, p, 'author', 't');
  assert.ok(lines(d)[1].text.length < 2100);
});
