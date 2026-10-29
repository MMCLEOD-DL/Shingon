import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { memoryFileFor, readWorkerMemory, rememberWorkers, recallWorkers, createUsageTracker } from '../src/workerMemory.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'wm-'));
const part = (name, kind) => ({ name, adapter: { kind } });

test('memoryFileFor puts the file in the run base directory', () => {
  assert.equal(memoryFileFor('/b/ws'), path.join('/b/ws', '.workers.json'));
});

test('remember then read: runs count up, lastUsedAt moves, kind follows the config', () => {
  const file = memoryFileFor(path.join(tmp(), 'nested', 'ws'));
  assert.equal(rememberWorkers(file, [{ name: 'local', kind: 'local-agent' }, { name: 'local', kind: 'local-agent' }, { name: 'claude', kind: 'claude-code' }], { now: () => 1000 }), true);
  assert.equal(rememberWorkers(file, [{ name: 'local', kind: 'local-agent' }], { now: () => 2000 }), true);
  const m = readWorkerMemory(file);
  assert.deepEqual(m, { version: 1, workers: {
    local: { kind: 'local-agent', lastUsedAt: 2000, runs: 2 },
    claude: { kind: 'claude-code', lastUsedAt: 1000, runs: 1 },
  } });
  assert.equal(existsSync(`${file}.${process.pid}.tmp`), false, 'the temp file is renamed away');
});

test('missing, corrupt or wrong-shaped memory reads as empty (Review Focus 2)', () => {
  const dir = tmp();
  const empty = { version: 1, workers: {} };
  assert.deepEqual(readWorkerMemory(path.join(dir, 'none.json')), empty);
  for (const body of ['{not json', '[]', '{"version":2,"workers":{}}', '{"version":1,"workers":[]}', 'null']) {
    const f = path.join(dir, 'm.json');
    writeFileSync(f, body);
    assert.deepEqual(readWorkerMemory(f), empty, body);
  }
  const f = path.join(dir, 'bad-entry.json');
  writeFileSync(f, JSON.stringify({ version: 1, workers: { a: { kind: 'x', lastUsedAt: 'yesterday', runs: 1 }, b: { kind: 'y', lastUsedAt: 5, runs: 1 } } }));
  assert.deepEqual(Object.keys(readWorkerMemory(f).workers), ['b']);
});

test('an unwritable memory file returns false and never throws (Review Focus 2)', { skip: process.getuid?.() === 0 && 'root ignores file modes' }, () => {
  const dir = tmp();
  mkdirSync(path.join(dir, 'ro'));
  chmodSync(path.join(dir, 'ro'), 0o500);
  assert.equal(rememberWorkers(path.join(dir, 'ro', '.workers.json'), [{ name: 'local', kind: 'local-agent' }]), false);
});

test('a path that cannot be a file returns false and never throws (Review Focus 2)', () => {
  const dir = tmp();
  const file = path.join(dir, 'is-a-dir');
  mkdirSync(file);
  assert.equal(rememberWorkers(file, [{ name: 'local', kind: 'local-agent' }]), false);
  assert.equal(existsSync(`${file}.${process.pid}.tmp`), false, 'a failed rename leaves no temp file behind');
  assert.equal(rememberWorkers(path.join(dir, 'x.json'), []), true, 'nothing to remember is not a failure');
  assert.equal(existsSync(path.join(dir, 'x.json')), false);
});

test('recallWorkers keeps configured participants only, newest first (Review Focus 3)', () => {
  const memory = { version: 1, workers: {
    old: { kind: 'local-agent', lastUsedAt: 10, runs: 1 },
    gone: { kind: 'local-agent', lastUsedAt: 99, runs: 4 },
    local: { kind: 'local-agent', lastUsedAt: 50, runs: 2 },
  } };
  const ps = [part('local', 'local-agent'), part('old', 'local-agent'), part('claude', 'claude-code')];
  assert.deepEqual(recallWorkers(memory, ps).map((x) => [x.participant.name, x.lastUsedAt]), [['local', 50], ['old', 10]]);
});

test('the usage tracker records who really served successful calls', () => {
  const byName = new Map([['claude', part('claude', 'claude-code')], ['codex', part('codex', 'codex')], ['local', part('local', 'local-agent')]]);
  const t = createUsageTracker(byName);
  t.onEvent({ type: 'call', participant: 'local' });
  t.onEvent({ type: 'result', participant: 'local', servedBy: 'local', ok: false });
  t.onEvent({ type: 'result', participant: 'claude', servedBy: 'codex', ok: true });
  t.onEvent({ type: 'result', participant: 'local', servedBy: null, ok: true });
  t.onEvent({ type: 'result', participant: 'seat-x', servedBy: 'not-configured', ok: true });
  t.onEvent({ type: 'result', participant: 'codex', servedBy: 'codex', ok: true });
  t.onEvent(null);
  assert.deepEqual(t.used(), [{ name: 'codex', kind: 'codex' }, { name: 'local', kind: 'local-agent' }]);
});
