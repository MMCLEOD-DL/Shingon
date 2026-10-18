// test/codex.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { CodexAdapter } from '../src/adapters/codex.js';

function tmp() { return mkdtempSync(path.join(tmpdir(), 'cx-')); }

// Fake codex: writes the final message to the path after -o, echoes it too.
const FAKE = `
  const oi = args.indexOf('-o');
  const outFile = oi >= 0 ? args[oi+1] : null;
  const msg = "done\\nVERDICT: APPROVE";
  if (outFile) require('node:fs').writeFileSync(outFile, msg);
  process.stdout.write("codex log line");
`;

test('reads the -o output file and normalizes it', async () => {
  const bin = writeStubCli(tmp(), 'codex', FAKE);
  const r = await new CodexAdapter({ bin }).run('reviewer', 'review x');
  assert.equal(r.ok, true);
  assert.equal(r.verdict.decision, 'APPROVE');
  assert.equal(r.text, 'done');
});

test('passes extraConfig as -c flags and sandbox', async () => {
  const bin = writeStubCli(tmp(), 'codex', `
    const oi = args.indexOf('-o');
    require('node:fs').writeFileSync(args[oi+1], args.join(' '));
  `);
  const r = await new CodexAdapter({ bin, extraConfig: ['model_provider=localai'], sandbox: 'workspace-write' }).run('grunt', 't');
  assert.match(r.text, /-c model_provider=localai/);
  assert.match(r.text, /--sandbox workspace-write/);
});

test('non-zero exit yields ok:false', async () => {
  const bin = writeStubCli(tmp(), 'codex', `process.stderr.write("boom");process.exit(2);`);
  const r = await new CodexAdapter({ bin }).run('author', 't');
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test('missing output file yields ok:false', async () => {
  const bin = writeStubCli(tmp(), 'codex', `process.stdout.write("no file written");`);
  const r = await new CodexAdapter({ bin }).run('author', 't');
  assert.equal(r.ok, false);
});
