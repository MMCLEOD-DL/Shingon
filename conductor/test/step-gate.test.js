import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runChunk, gateExcerpt, validateGateCommands } from '../src/chunkPhase.js';
import { isProtectedPath } from '../src/council/foundationRules.js';
import { fakeParticipant, approve, makeCtx } from './helpers/fakes.js';

const pass = { ran: true, passed: true, code: 0, output: '' };
const fail = (output) => ({ ran: true, passed: false, code: 1, output });
const GATES = [{ name: 'lint', command: 'lint' }, { name: 'types', command: 'types' }];

const write = (cwd, rel) => {
  mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  writeFileSync(path.join(cwd, rel), 'x\n');
};

async function context(chunk, { results = {}, files = ['out.txt'], authorFiles = files, options = {} } = {}) {
  const edit = (list) => (_r, _t, _c, opts) => { for (const f of list) write(opts.cwd, f); return { text: 'done' }; };
  const team = {
    local: fakeParticipant({ name: 'local', kind: 'local-agent', script: edit(files) }),
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role, ...a) => role === 'reviewer' ? approve() : edit(authorFiles)(role, ...a) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: approve }),
  };
  const events = [];
  const ctx = await makeCtx({ team, options: { localRounds: 2, frontierRounds: 1, testCommand: 'suite', ...options }, hooks: { onEvent: (e) => events.push(e) } });
  ctx.state.plan = { summary: 's', chunks: [chunk] };
  const seen = [];
  ctx.ws.runTests = async (cmd) => { seen.push(cmd); if (!cmd) return { ran: false }; return results[cmd] ? results[cmd].shift() ?? pass : pass; };
  return { ctx, seen, events };
}

test('G4 stage order: a failing gate stops the rest, skips check and suite, never reaches the reviewer', async () => {
  const noise = Array.from({ length: 30 }, (_, i) => `NOISE_LINE_${i}`);
  const output = [...noise, 'context A', 'context B', 'src/a.ts(3,1): error TS2322: bad type', 'after line'].join('\n');
  const chunk = { title: 'T', instructions: 'i', check: 'node ok.cjs' };
  const { ctx, seen, events } = await context(chunk, { options: { gateCommands: GATES }, results: { types: [fail(output)] } });
  // the first attempt fails the gate; the second passes everything
  const r = await runChunk(ctx, chunk, 0);
  assert.equal(r.status, 'done');
  assert.deepEqual(seen.slice(0, 2), ['lint', 'types']);
  assert.ok(!seen.slice(0, 2).includes('suite') && !seen.slice(0, 2).includes('node ok.cjs'));
  const gates = events.filter((e) => e.type === 'gate');
  assert.equal(gates[0].failedStage, 'types');
  assert.equal(gates[0].result, 'failed');
  assert.equal(gates[0].attempt, 1);
  assert.equal(gates[0].of, 2);
  assert.equal(gates[0].index, 0);
  assert.match(gates[0].excerpt, /TS2322/);
  assert.ok(gates[0].excerpt.length < output.length);
  assert.doesNotMatch(gates[0].excerpt, /NOISE_LINE_5\b/);
  // reviewer ran once: for the second (passing) attempt only
  assert.equal(ctx.team.reviewer.calls.length, 1);
  const retry = ctx.team.local.calls[1].task;
  assert.match(retry, /TS2322/);
  assert.match(retry, /types/);
  assert.match(retry, /context A/);
  assert.doesNotMatch(retry, /NOISE_LINE_27\b/);
  assert.equal(gates[1].result, 'passed');
  assert.equal(gates[1].failedStage, null);
  assert.equal(gates[1].attempt, 2);
});

test('G4: a failing gate never calls the reviewer when every attempt fails', async () => {
  const chunk = { title: 'T', instructions: 'i' };
  const { ctx, seen } = await context(chunk, { options: { gateCommands: GATES, localRounds: 1, frontierRounds: 1 }, results: { lint: [fail('error one'), fail('error two')] } });
  const r = await runChunk(ctx, chunk, 0);
  assert.notEqual(r.status, 'paused');
  assert.equal(ctx.team.reviewer.calls.length, 0);
  assert.ok(!seen.includes('suite'));
});

test('G4: all gates passing run lint, types, suite in order, one passed event each attempt', async () => {
  const chunk = { title: 'T', instructions: 'i' };
  const { ctx, seen, events } = await context(chunk, { options: { gateCommands: GATES } });
  assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
  assert.deepEqual(seen, ['lint', 'types', 'suite']);
  const gates = events.filter((e) => e.type === 'gate');
  assert.equal(gates.length, 1);
  assert.equal(gates[0].result, 'passed');
  assert.equal(gates[0].failedStage, null);
  assert.equal(gates[0].excerpt, null);
  assert.equal(gates[0].attempt, 1);
  assert.equal(gates[0].of, 2);
});

test('G4 gateExcerpt: failing line at the end of 10 kB, and no matching line', () => {
  const filler = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
  const out = [...filler, 'before one', 'before two', 'FAIL here is the problem'].join('\n');
  assert.ok(out.length > 9000);
  const ex = gateExcerpt(out);
  assert.ok(ex.length <= 3000);
  assert.ok(ex.startsWith('before one\nbefore two\nFAIL'));
  const quiet = Array.from({ length: 500 }, (_, i) => `quiet ${i}`).join('\n');
  assert.equal(gateExcerpt(quiet), quiet.slice(0, 3000));
  assert.equal(gateExcerpt(''), '');
  const long = ['error: ' + 'y'.repeat(5000)].join('');
  assert.equal(gateExcerpt(long).length, 3000);
});

test('G4 scope: a file outside the step files is flagged to the reviewer, not a failure', async () => {
  const chunk = { title: 'T', instructions: 'i', files: ['src/a.js'] };
  const { ctx, events } = await context(chunk, { files: ['src/a.js', 'src/b.js'] });
  assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
  const task = ctx.team.reviewer.calls[0].task;
  assert.match(task, /Files outside the expected set \(a flag, not a failure\): src\/b\.js/);
  assert.doesNotMatch(task, /outside the expected set[^\n]*src\/a\.js/);
  const flag = events.find((e) => e.type === 'scope-flag');
  assert.deepEqual(flag.outside, ['src/b.js']);
  assert.equal(flag.index, 0);
});

test('G4 scope: a step without files never flags', async () => {
  const chunk = { title: 'T', instructions: 'i' };
  const { ctx, events } = await context(chunk, { files: ['src/a.js', 'src/b.js'] });
  assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
  assert.doesNotMatch(ctx.team.reviewer.calls[0].task, /outside the expected set/);
  assert.equal(events.some((e) => e.type === 'scope-flag'), false);
});

test('G4 protected path: blocked before the reviewer; repeated edits end the step without a review', async () => {
  assert.equal(isProtectedPath('foundation.json'), true);
  assert.equal(isProtectedPath('src/a.js'), false);
  // local writes it first time only via the author fake: local always writes it, author does not
  const chunk = { title: 'T', instructions: 'i' };
  const a = await context(chunk, { files: ['foundation.json', 'ok.txt'], authorFiles: ['ok.txt'], options: { localRounds: 2, frontierRounds: 1, factoryFeature: {} } });
  const r = await runChunk(a.ctx, chunk, 0);
  assert.equal(r.status, 'done');
  const ev = a.events.filter((e) => e.type === 'protected-path');
  assert.equal(ev.length, 2);
  assert.deepEqual(ev[0].files, ['foundation.json']);
  assert.equal(ev[0].participant, 'local');
  assert.equal(a.ctx.team.reviewer.calls.length, 1); // only the fallback's clean attempt
  assert.match(a.ctx.team.author.calls[0].task, /The step edited protected files: foundation\.json/);

  const b = await context(chunk, { files: ['foundation.json'], authorFiles: ['foundation.json'], options: { localRounds: 1, frontierRounds: 1, factoryFeature: {} } });
  const rb = await runChunk(b.ctx, chunk, 0);
  assert.notEqual(rb.status, 'done');
  assert.equal(b.ctx.team.reviewer.calls.length, 0);
});

test('G4 validation: bad gateCommands throw the exact message', async () => {
  const msg = 'options.gateCommands must be a list of { name, command } with distinct names';
  for (const bad of [[{ name: 'x' }], [{ name: 'a', command: 'c' }, { name: 'a', command: 'd' }], 'lint', [{ name: '', command: 'c' }], [null]]) {
    assert.throws(() => validateGateCommands({ gateCommands: bad }), { message: msg });
  }
  validateGateCommands({});
  validateGateCommands({ gateCommands: GATES });
  const chunk = { title: 'T', instructions: 'i' };
  const { ctx } = await context(chunk, { options: { gateCommands: [{ name: 'x' }] } });
  await assert.rejects(runChunk(ctx, chunk, 0), { message: msg });
});

test('G4: no gateCommands and no files behave as before', async () => {
  const chunk = { title: 'T', instructions: 'i' };
  const { ctx, seen, events } = await context(chunk);
  assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
  assert.deepEqual(seen, ['suite']);
  for (const t of ['gate', 'scope-flag', 'protected-path']) assert.equal(events.some((e) => e.type === t), false, t);
});

test('G4 protected path: blocked even with no test command, gate or check configured', async () => {
  const chunk = { title: 'T', instructions: 'i' };
  const { ctx, events } = await context(chunk, { files: ['foundation.json'], authorFiles: ['ok.txt'], options: { testCommand: null, localRounds: 1, frontierRounds: 1, factoryFeature: {} } });
  const r = await runChunk(ctx, chunk, 0);
  assert.equal(r.status, 'done');
  assert.equal(events.filter((e) => e.type === 'protected-path').length, 1);
  assert.equal(ctx.team.reviewer.calls.length, 1); // the fallback's clean attempt only
  assert.match(ctx.team.author.calls[0].task, /The step edited protected files: foundation\.json/);
});

test('G4 scope: the flag reaches the reviewer even with no test command', async () => {
  const chunk = { title: 'T', instructions: 'i', files: ['src/a.js'] };
  const { ctx, events } = await context(chunk, { files: ['src/a.js', 'src/b.js'], options: { testCommand: null } });
  assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
  assert.match(ctx.team.reviewer.calls[0].task, /Files outside the expected set \(a flag, not a failure\): src\/b\.js/);
  assert.deepEqual(events.find((e) => e.type === 'scope-flag').outside, ['src/b.js']);
});

test('G4 protected path: ordinary runs (no factoryFeature) are not blocked, same gate as the council', async () => {
  const chunk = { title: 'T', instructions: 'i' };
  const { ctx, events } = await context(chunk, { files: ['foundation.json', 'modules/x.js'] });
  assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
  assert.equal(events.some((e) => e.type === 'protected-path'), false);
  assert.equal(ctx.team.reviewer.calls.length, 1);
  assert.equal(ctx.team.local.calls.length, 1);
});
