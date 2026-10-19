// test/codex.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
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

const ECHO_ARGS = `
  const oi = args.indexOf('-o');
  require('node:fs').writeFileSync(args[oi+1], 'cwd=' + process.cwd() + ' ' + args.join(' '));
`;

test('runs in opts.cwd and uses workspace-write when opts.write', async () => {
  const dir = tmp();
  const bin = writeStubCli(tmp(), 'codex', ECHO_ARGS);
  const r = await new CodexAdapter({ bin }).run('grunt', 't', '', { cwd: dir, write: true });
  assert.match(r.text, new RegExp('cwd=' + dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(r.text, /--sandbox workspace-write/);
});

test('defaults to read-only sandbox when not writing', async () => {
  const bin = writeStubCli(tmp(), 'codex', ECHO_ARGS);
  const r = await new CodexAdapter({ bin }).run('reviewer', 't');
  assert.match(r.text, /--sandbox read-only/);
});

test('opts.timeoutMs overrides the constructor timeout', async () => {
  const bin = writeStubCli(tmp(), 'codex', `setTimeout(() => {}, 10000);`);
  const t0 = Date.now();
  const r = await new CodexAdapter({ bin, timeoutMs: 60000 }).run('author', 't', '', { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
  assert.ok(Date.now() - t0 < 5000);
});

test('removes its temp output dir on success and failure', async () => {
  const marker = path.join(tmp(), 'marker.txt');
  const record = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, args[args.indexOf('-o') + 1]);`;

  const ok = writeStubCli(tmp(), 'codex', `${record}\nrequire('node:fs').writeFileSync(args[args.indexOf('-o') + 1], 'done');`);
  const r1 = await new CodexAdapter({ bin: ok }).run('author', 't');
  assert.equal(r1.ok, true);
  assert.equal(existsSync(path.dirname(readFileSync(marker, 'utf8'))), false);

  const bad = writeStubCli(tmp(), 'codex', `${record}\nprocess.exit(3);`);
  const r2 = await new CodexAdapter({ bin: bad }).run('author', 't');
  assert.equal(r2.ok, false);
  assert.equal(existsSync(path.dirname(readFileSync(marker, 'utf8'))), false);
});

test('a failed run reports a short reason and flags a dead backend as infrastructure', async () => {
  const bin = writeStubCli(tmp(), 'codex', `
    process.stderr.write('OpenAI Codex v0.163.0\\nuser\\n' + args[1] + '\\nERROR: Reconnecting... 5/5\\nERROR: stream disconnected before completion: response.failed event received\\n');
    process.exit(1);
  `);
  const r = await new CodexAdapter({ bin }).run('grunt', 'a long task prompt');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ERROR: stream disconnected before completion: response.failed event received');
  assert.equal(r.failure, 'infrastructure');
  const bad = writeStubCli(tmp(), 'codex', `process.stderr.write('ERROR: model refused the tool call\\n'); process.exit(1);`);
  assert.equal((await new CodexAdapter({ bin: bad }).run('grunt', 't')).failure, null);
});

test('only a Codex ERROR: line can mark a failure as infrastructure', async () => {
  const bin = writeStubCli(tmp(), 'codex', `process.stderr.write('curl: (7) Failed to connect: Connection refused\\n'); process.exit(1);`);
  const r = await new CodexAdapter({ bin }).run('grunt', 't');
  assert.equal(r.error, 'curl: (7) Failed to connect: Connection refused');
  assert.equal(r.failure, null);
  const bad = writeStubCli(tmp(), 'codex', `process.stderr.write('ERROR: unexpected status 502 Bad Gateway\\n'); process.exit(1);`);
  assert.equal((await new CodexAdapter({ bin: bad }).run('grunt', 't')).failure, 'infrastructure');
});

test('a timed-out run is failure "timeout"', async () => {
  const bin = writeStubCli(tmp(), 'codex', `setTimeout(() => {}, 10000);`);
  const r = await new CodexAdapter({ bin }).run('grunt', 't', '', { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timed out');
  assert.equal(r.failure, 'timeout');
});

test('a context overflow wins over the infrastructure classification', async () => {
  const bin = writeStubCli(tmp(), 'codex', `process.stderr.write('ERROR: unexpected status 500: the request exceeds the available context size\\n'); process.exit(1);`);
  const r = await new CodexAdapter({ bin }).run('grunt', 't');
  assert.equal(r.failure, 'context-overflow');
});

test("Codex's usage-limit ERROR: line is an infrastructure failure (C1)", async () => {
  const bin = writeStubCli(tmp(), 'codex', `process.stderr.write("ERROR: You've hit your usage limit. Upgrade to Pro or try again in 3 days.\\n"); process.exit(1);`);
  const r = await new CodexAdapter({ bin }).run('author', 't');
  assert.equal(r.ok, false);
  assert.match(r.error, /usage limit/);
  assert.equal(r.failure, 'infrastructure');
});
