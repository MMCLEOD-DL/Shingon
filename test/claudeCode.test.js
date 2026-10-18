// test/claudeCode.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { ClaudeCodeAdapter } from '../src/adapters/claudeCode.js';

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
