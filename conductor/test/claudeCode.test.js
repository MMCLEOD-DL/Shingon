// test/claudeCode.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { ClaudeCodeAdapter } from '../src/adapters/claudeCode.js';
import { Participant } from '../src/participant.js';
import { Seat, HealthBoard } from '../src/router.js';
import { makeResult } from '../src/result.js';

function tmp() { return mkdtempSync(path.join(tmpdir(), 'cc-')); }

test('parses claude -p JSON into a Result with cost', async () => {
  const dir = tmp();
  // Fake claude: emit the Claude Code JSON envelope.
  const bin = writeStubCli(dir, 'claude', `
    const out = { result: "VERDICT: APPROVE", total_cost_usd: 0.25, is_error: false };
    process.stdout.write(JSON.stringify(out));
  `);
  const r = await new ClaudeCodeAdapter({ bin }).run('reviewer', 'check this');
  assert.equal(r.ok, true);
  assert.equal(r.verdict.decision, 'APPROVE');
  assert.equal(r.usage.costUsd, 0.25);
});

test('passes role preset via --append-system-prompt and task as prompt', async () => {
  const dir = tmp();
  const bin = writeStubCli(dir, 'claude', `
    const i = args.indexOf('--append-system-prompt');
    const sys = args[i+1] || '';
    const prompt = args[args.indexOf('-p')+1] || '';
    process.stdout.write(JSON.stringify({ result: sys.includes('REVIEWER') && prompt.includes('my task') ? 'ok' : 'bad', is_error:false }));
  `);
  const r = await new ClaudeCodeAdapter({ bin }).run('reviewer', 'my task');
  assert.equal(r.text, 'ok');
});

test('non-zero exit or is_error yields ok:false with stderr captured', async () => {
  const dir = tmp();
  const bin = writeStubCli(dir, 'claude', `
    process.stderr.write("unknown variant 'max'");
    process.exit(1);
  `);
  const r = await new ClaudeCodeAdapter({ bin }).run('author', 't');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown variant/);
});

test('malformed JSON stdout does not throw; raw kept in text', async () => {
  const dir = tmp();
  const bin = writeStubCli(dir, 'claude', `process.stdout.write("not json at all");`);
  const r = await new ClaudeCodeAdapter({ bin }).run('author', 't');
  assert.equal(r.ok, false);
  assert.match(r.text, /not json/);
});

test('is_error:true in JSON yields ok:false', async () => {
  const bin = writeStubCli(tmp(), 'claude', `process.stdout.write(JSON.stringify({ result: "boom", is_error: true }));`);
  const r = await new ClaudeCodeAdapter({ bin }).run('author', 't');
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test('timeout yields ok:false with "timed out"', async () => {
  const bin = writeStubCli(tmp(), 'claude', `setInterval(()=>{},1000);`);
  const r = await new ClaudeCodeAdapter({ bin, timeoutMs: 200 }).run('author', 't');
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
});

test('valid-but-non-object JSON does not throw', async () => {
  const bin = writeStubCli(tmp(), 'claude', `process.stdout.write("null");`);
  const r = await new ClaudeCodeAdapter({ bin }).run('author', 't');
  assert.equal(r.ok, false);
});

test('passes --model when set', async () => {
  const bin = writeStubCli(tmp(), 'claude', `
    const i = args.indexOf('--model');
    process.stdout.write(JSON.stringify({ result: (i>=0 && args[i+1]==='claude-opus-4-8') ? 'ok' : 'no-model', is_error:false }));
  `);
  const r = await new ClaudeCodeAdapter({ bin, model: 'claude-opus-4-8' }).run('author', 't');
  assert.equal(r.text, 'ok');
});

test('folds context into the prompt', async () => {
  const bin = writeStubCli(tmp(), 'claude', `
    const p = args[args.indexOf('-p')+1] || '';
    process.stdout.write(JSON.stringify({ result: p.includes('CTX-MARKER') ? 'ok' : 'no-ctx', is_error:false }));
  `);
  const r = await new ClaudeCodeAdapter({ bin }).run('author', 'do it', 'CTX-MARKER');
  assert.equal(r.text, 'ok');
});

const CLAUDE_ECHO = `
  process.stdout.write(JSON.stringify({ result: 'cwd=' + process.cwd() + ' ' + args.join(' '), is_error: false }));
`;

test('runs in opts.cwd and adds acceptEdits when opts.write', async () => {
  const dir = tmp();
  const bin = writeStubCli(tmp(), 'claude', CLAUDE_ECHO);
  const r = await new ClaudeCodeAdapter({ bin }).run('author', 't', '', { cwd: dir, write: true });
  assert.ok(r.text.includes('cwd=' + dir));
  assert.match(r.text, /--permission-mode acceptEdits/);
});

test('no permission-mode flag when not writing', async () => {
  const bin = writeStubCli(tmp(), 'claude', CLAUDE_ECHO);
  const r = await new ClaudeCodeAdapter({ bin }).run('reviewer', 't');
  assert.doesNotMatch(r.text, /--permission-mode/);
});

test('opts.timeoutMs overrides the constructor timeout (T1)', async () => {
  const bin = writeStubCli(tmp(), 'claude', `setTimeout(() => {}, 10000);`);
  const t0 = Date.now();
  const r = await new ClaudeCodeAdapter({ bin, timeoutMs: 60000 }).run('author', 't', '', { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timed out');
  assert.ok(Date.now() - t0 < 5000);
});

test('a timed-out claude run is failure "timeout"', async () => {
  const bin = writeStubCli(tmp(), 'claude', `setTimeout(() => {}, 10000);`);
  const r = await new ClaudeCodeAdapter({ bin }).run('author', 't', '', { timeoutMs: 300 });
  assert.equal(r.failure, 'timeout');
});

// C1: claude -p --output-format json reports a spent subscription or a lost sign-in on stdout.
const QUOTA_JSON = JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1760000000' });

for (const exitCode of [0, 1]) {
  test(`an is_error usage-limit JSON on exit ${exitCode} is an infrastructure failure (C1)`, async () => {
    const bin = writeStubCli(tmp(), 'claude', `process.stdout.write(${JSON.stringify(QUOTA_JSON)}); process.exit(${exitCode});`);
    const r = await new ClaudeCodeAdapter({ bin }).run('author', 't');
    assert.equal(r.ok, false);
    assert.match(r.error, /usage limit reached/);
    assert.equal(r.failure, 'infrastructure');
  });
}

test('an is_error sign-in JSON is an infrastructure failure; a plain is_error is not (C1)', async () => {
  const login = writeStubCli(tmp(), 'claude', `process.stdout.write(JSON.stringify({ is_error: true, result: 'Invalid API key · Please run /login' })); process.exit(1);`);
  const r = await new ClaudeCodeAdapter({ bin: login }).run('author', 't');
  assert.equal(r.failure, 'infrastructure');
  assert.match(r.error, /Please run \/login/);
  const plain = writeStubCli(tmp(), 'claude', `process.stdout.write(JSON.stringify({ is_error: true, result: 'boom' }));`);
  assert.equal((await new ClaudeCodeAdapter({ bin: plain }).run('author', 't')).failure, null);
});

test("a Seat [claude, codex] moves to codex after claude's quota error (C1)", async () => {
  const bin = writeStubCli(tmp(), 'claude', `process.stdout.write(${JSON.stringify(QUOTA_JSON)});`);
  const caps = { is_agentic: true, can_edit_files: true };
  const claude = new Participant({ name: 'claude', adapter: new ClaudeCodeAdapter({ bin }), roles: ['author', 'reviewer'], capabilities: caps });
  let codexCalls = 0;
  const codex = new Participant({ name: 'codex', adapter: { kind: 'codex', run: async () => { codexCalls += 1; return makeResult({ text: 'ok' }); } }, roles: ['author', 'reviewer'], capabilities: caps });
  const board = new HealthBoard();
  const r = await new Seat({ name: 'claude', candidates: [claude, codex], board }).run('author', 'x');
  assert.equal(r.ok, true);
  assert.equal(r.servedBy, 'codex');
  assert.equal(codexCalls, 1);
  assert.equal(board.state('claude').reason, 'rate-limit');
});
