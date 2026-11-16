import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { runChunk } from '../src/chunkPhase.js';
import { fakeParticipant, approve, block, makeCtx } from './helpers/fakes.js';
import { parseCli } from '../src/cli/args.js';
import { main, EXIT } from '../src/cli/main.js';
import { parseTranscript, stepReport, aggregate, formatReport, findTranscripts } from '../src/cli/report.js';

const chunk = { title: 'Synthetic edit', instructions: 'write result.txt' };
const pass = { ran: true, passed: true, code: 0, output: '' };
const fail = { ran: true, passed: false, code: 1, output: 'assertion failed' };
const tmp = () => mkdtempSync(path.join(tmpdir(), 'report-'));

const edit = (_role, _task, _ctx, opts) => {
  writeFileSync(path.join(opts.cwd, 'result.txt'), 'x\n');
  return { text: 'done' };
};

async function realRun({ outcomes, reviewer = approve, authorCost, localRounds = 3 }) {
  const team = {
    local: fakeParticipant({ name: 'local', kind: 'local-agent', script: edit }),
    author: fakeParticipant({
      name: 'claude', kind: 'claude-code',
      script: (role, ...a) => (role === 'reviewer' ? approve() : { ...edit(role, ...a), ...(authorCost ? { usage: { costUsd: authorCost } } : {}) }),
    }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: reviewer }),
  };
  const ctx = await makeCtx({ team, options: { localRounds, frontierRounds: 2 } });
  ctx.state.plan = { summary: 's', chunks: [chunk] };
  if (outcomes) { let i = 0; ctx.ws.runTests = async () => outcomes[Math.min(i++, outcomes.length - 1)]; }
  const r = await runChunk(ctx, chunk, 0);
  assert.equal(r.status, 'done');
  const text = readFileSync(ctx.log.transcript, 'utf8');
  return { ctx, text, report: stepReport(parseTranscript(text), { source: ctx.log.transcript }) };
}

test('G1 a logged run: local, 3 attempts, 2 blocked by tests, no fallback, 1 frontier call', async () => {
  const { report } = await realRun({ outcomes: [fail, fail, pass] });
  assert.equal(report.steps.length, 1);
  const s = report.steps[0];
  assert.equal(s.index, 0);
  assert.equal(s.producedBy, 'local');
  assert.equal(s.outcome, 'done');
  assert.equal(s.localAttempts, 3);
  assert.deepEqual(s.blockedByTests, { local: 2, frontier: 0 });
  assert.equal(s.blockedByReviewer, 0);
  assert.equal(s.frontierTookOver, null);
  assert.equal(s.frontierCalls, 1);
  assert.ok(s.calls.length >= 4);
  assert.ok(s.calls.every((c) => typeof c.ms === 'number' && c.ms >= 0), JSON.stringify(s.calls));
  assert.deepEqual(report.warnings, []);
});

test('fallback: local blocked by the reviewer until the frontier author takes over', async () => {
  let n = 0;
  const { report } = await realRun({ localRounds: 2, reviewer: () => (n++ < 2 ? block('too long') : approve()) });
  const s = report.steps[0];
  assert.equal(s.outcome, 'fallback-then-done');
  assert.equal(s.producedBy, 'claude');
  assert.equal(s.localAttempts, 2);
  assert.equal(s.blockedByReviewer, 2);
  assert.equal(s.frontierTookOver.to, 'claude');
  assert.match(s.frontierTookOver.reason, /too long/);
  assert.equal(s.frontierCalls, 4, '2 blocked reviews + the author fallback call + 1 approving review');
});

test('G1 missing cost: reported cost is summed, unreported never shows as $0.00', async () => {
  let n = 0;
  const withCost = await realRun({ localRounds: 1, authorCost: 0.12, reviewer: () => (n++ < 1 ? block('no') : approve()) });
  const c = withCost.report.steps[0].cost;
  assert.equal(c.reportedUsd, 0.12);
  assert.equal(c.reportedCalls, 1);
  assert.ok(c.unreportedCalls >= 2);
  const textWith = formatReport([withCost.report], aggregate([withCost.report]));
  assert.match(textWith, /\$0\.12 \(1 calls? reported, \d+ not reported\)/);

  const none = await realRun({ outcomes: [pass] });
  assert.equal(none.report.steps[0].cost.reportedCalls, 0);
  const textNone = formatReport([none.report], aggregate([none.report]));
  assert.match(textNone, /not reported/);
  assert.doesNotMatch(textNone, /\$0\.00/);
  assert.doesNotMatch(textNone, /\$/);
});

const T = (s) => `2026-11-01T10:00:${String(s).padStart(2, '0')}.000Z`;
const line = (s, type, data = {}) => JSON.stringify({ ts: T(s), type, ...data });
const HAND = [
  line(0, 'start'),
  line(1, 'baseline-tests', { commit: 'abc123', passed: true }),
  line(2, 'chunk', { index: 0, title: 'First' }),
  line(3, 'call', { participant: 'local', role: 'grunt' }),
  line(5, 'result', { participant: 'local', role: 'grunt', ok: true, costUsd: null }),
  line(6, 'call', { participant: 'codex', role: 'reviewer' }),
  '',
  '{not json',
  line(10, 'resume', { phase: 'chunks', chunkIndex: 0 }),
  line(11, 'chunk', { index: 0, title: 'First' }),
  line(12, 'chunk-done', { index: 0, sha: 'f', files: [], by: 'local' }),
].join('\n');

test('hand-written transcript: resume block, baseline, malformed line, unmatched call', () => {
  const events = parseTranscript(HAND);
  assert.equal(events.length, 9);
  const r = stepReport(events, { source: 'x' });
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[0].resumed, false);
  assert.equal(r.steps[1].resumed, true);
  assert.equal(r.steps[0].outcome, 'incomplete');
  assert.equal(r.steps[0].producedBy, null);
  assert.equal(r.steps[1].producedBy, 'local');
  assert.equal(r.steps[1].outcome, 'done');
  assert.deepEqual(r.run.baseline, { passed: true, commit: 'abc123' });
  assert.equal(r.run.resumed, 1);
  assert.equal(r.run.status, 'running');
  assert.equal(r.run.started, T(0));
  assert.equal(r.run.finished, T(12));
  const calls = r.steps[0].calls;
  assert.equal(calls[0].ms, 2000);
  assert.equal(calls[1].ms, null);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /line 8/);
});

test('findTranscripts: base dir plus archived logs, oldest first; explicit paths of three kinds', () => {
  const root = tmp();
  const baseDir = path.join(root, 'workspaces');
  const meta = path.join(baseDir, 'conductor-ws-x.conductor');
  mkdirSync(meta, { recursive: true });
  mkdirSync(path.join(baseDir, 'conductor-ws-x'));
  mkdirSync(path.join(baseDir, 'logs'));
  const live = path.join(meta, 'transcript.jsonl');
  const archived = path.join(baseDir, 'logs', 'y.jsonl');
  const sibling = path.join(root, 'logs');
  mkdirSync(sibling);
  const sib = path.join(sibling, 'z.jsonl');
  for (const f of [live, archived, sib]) writeFileSync(f, line(0, 'start') + '\n');
  utimesSync(live, 300, 300);
  utimesSync(archived, 100, 100);
  utimesSync(sib, 200, 200);
  assert.deepEqual(findTranscripts({ baseDir, paths: [] }), [archived, sib, live]);
  assert.deepEqual(findTranscripts({ baseDir: path.join(tmp(), 'none'), paths: [] }), []);
  assert.deepEqual(findTranscripts({ baseDir, paths: [live] }), [live]);
  assert.deepEqual(findTranscripts({ baseDir, paths: [meta] }), [live]);
  assert.deepEqual(findTranscripts({ baseDir, paths: [path.join(baseDir, 'conductor-ws-x')] }), [live]);
  assert.throws(() => findTranscripts({ baseDir, paths: [path.join(root, 'missing')] }), /missing/);
});

test('parseCli: report takes paths and --json, rejects unknown flags', () => {
  const a = parseCli(['report']);
  assert.equal(a.command, 'report');
  assert.deepEqual(a.paths, []);
  assert.equal(a.json, false);
  const b = parseCli(['report', 'a', 'b', '--json']);
  assert.deepEqual(b.paths, ['a', 'b']);
  assert.equal(b.json, true);
  assert.ok(parseCli(['report', '--bogus']).error);
  assert.ok(parseCli(['runs', '--json']).error);
});

function capture() {
  let out = '';
  return { stdout: new Writable({ write(c, _e, cb) { out += c; cb(); } }), get out() { return out; } };
}

test('main report: text and --json agree; no transcripts is exit 0; unreadable path is usage', async () => {
  const { text } = await realRun({ outcomes: [fail, fail, pass] });
  const dir = tmp();
  const file = path.join(dir, 'run.jsonl');
  writeFileSync(file, text);
  const env = { CONDUCTOR_BASE_DIR: path.join(dir, 'empty') };
  const run = async (argv) => { const cap = capture(); const code = await main(argv, { cwd: dir, env, stdout: cap.stdout }); return { code, out: cap.out }; };

  const t = await run(['report', file]);
  assert.equal(t.code, 0);
  assert.match(t.out, /Step 1/);
  assert.match(t.out, /local, 3 attempts/);
  assert.match(t.out, /not reported/);
  assert.match(t.out, /Total across 1 run/);

  const j = await run(['report', file, '--json']);
  assert.equal(j.code, 0);
  const parsed = JSON.parse(j.out);
  assert.equal(parsed.runs.length, 1);
  assert.equal(parsed.runs[0].steps[0].localAttempts, 3);
  assert.equal(parsed.totals.runs, 1);
  assert.equal(parsed.totals.blockedByTests.local, 2);

  const none = await run(['report']);
  assert.equal(none.code, 0);
  assert.match(none.out, /No run transcripts found\./);

  const bad = await run(['report', path.join(dir, 'nope')]);
  assert.equal(bad.code, EXIT.usage);
  assert.match(bad.out, /nope/);
});

test('allowance limits: failovers and failed calls per step, run level, and totals', () => {
  const text = [
    line(0, 'start'),
    line(1, 'route-failover', { seat: 'author', from: 'claude', reason: 'rate-limit', error: 'x' }),
    line(2, 'chunk', { index: 0, title: 'Limited' }),
    line(3, 'route-failover', { seat: 'author', from: 'claude', reason: 'rate-limit', error: '429' }),
    line(4, 'route-failover', { seat: 'author', from: 'claude', reason: 'unavailable', error: 'down' }),
    line(5, 'call', { participant: 'claude', role: 'author' }),
    line(6, 'result', { participant: 'claude', role: 'author', ok: false, error: 'HTTP 429 rate limit' }),
    line(7, 'chunk-done', { index: 0, by: 'codex' }),
    line(8, 'chunk', { index: 1, title: 'Clean' }),
    line(9, 'chunk-done', { index: 1, by: 'local' }),
  ].join('\n');
  const r = stepReport(parseTranscript(text), { source: 'x' });
  assert.deepEqual(r.steps[0].allowanceLimits, { failovers: 1, failedCalls: 1 });
  assert.deepEqual(r.steps[1].allowanceLimits, { failovers: 0, failedCalls: 0 });
  assert.deepEqual(r.run.allowanceLimits, { failovers: 1, failedCalls: 0 });
  assert.deepEqual(r.totals.allowanceLimits, { failovers: 2, failedCalls: 1 });
  assert.deepEqual(aggregate([r]).allowanceLimits, { failovers: 2, failedCalls: 1 });
  const out = formatReport([r], aggregate([r]));
  assert.match(out, /allowance +1 limit failover, 1 call failed on a limit/);
  assert.match(out, /allowance +2 limit failovers, 1 call failed on a limit/);
  assert.equal(out.match(/allowance/g).length, 2, 'only the step with a non-zero count, plus the totals');
});
