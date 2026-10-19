// test/health.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { checkHealth, classifyFailure, summarizeFailure, isInfrastructureFailure } from '../src/health.js';

function tmp() { return mkdtempSync(path.join(tmpdir(), 'hc-')); }

test('healthy CLI returns ok', async () => {
  const bin = writeStubCli(tmp(), 'claude', `process.stdout.write("2.1.302");`);
  const r = await checkHealth({ kind: 'claude-code', bin });
  assert.equal(r.ok, true);
});

test('classifies known failure signatures', () => {
  assert.equal(classifyFailure("Could not parse your authentication token"), 'unauthorized');
  assert.equal(classifyFailure("unknown variant `max`"), 'version-skew');
  assert.equal(classifyFailure("429 rate limit reached"), 'rate-limit');
  assert.equal(classifyFailure("some other explosion"), 'unavailable');
});

test('non-zero version check returns ok:false with a reason', async () => {
  const bin = writeStubCli(tmp(), 'codex', `process.stderr.write("401 unauthorized");process.exit(1);`);
  const r = await checkHealth({ kind: 'codex', bin });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unauthorized');
});

test('missing binary is unavailable, not a throw', async () => {
  const r = await checkHealth({ kind: 'codex', bin: '/no/such/codex' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unavailable');
});

test('timeout yields unavailable (not classified)', async () => {
  const bin = writeStubCli(tmp(), 'codex', `setInterval(()=>{},1000);`);
  const r = await checkHealth({ kind: 'codex', bin }, { timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unavailable');
});

test('invokes the CLI with --version', async () => {
  const bin = writeStubCli(tmp(), 'claude', `if (args[0] !== '--version') process.exit(1); process.stdout.write('2.1.302');`);
  const r = await checkHealth({ kind: 'claude-code', bin });
  assert.equal(r.ok, true);
});

// The shape of a real Codex failure (loop smoke run 1): banner, echoed prompt, retry chatter.
const CODEX_STDERR = [
  'Reading additional input from stdin...', 'OpenAI Codex v0.163.0', '--------', 'workdir: /w', '--------',
  'user', 'You are the EXECUTOR. Fix the 401 handling.', 'warning: Codex could not find bubblewrap on PATH.',
  'ERROR: Reconnecting... 1/5', 'ERROR: Reconnecting... 5/5',
  'ERROR: stream disconnected before completion: response.failed event received',
  'ERROR: stream disconnected before completion: response.failed event received',
].join('\n');

test('summarizeFailure keeps only the distinct final ERROR lines', () => {
  assert.equal(summarizeFailure(CODEX_STDERR), 'ERROR: stream disconnected before completion: response.failed event received');
  assert.equal(summarizeFailure('ERROR: a\nERROR: b\nERROR: c'), 'ERROR: b / ERROR: c');
  assert.equal(summarizeFailure('banner\nsomething broke\n\n'), 'something broke');
  assert.equal(summarizeFailure(''), '');
  assert.ok(summarizeFailure('ERROR: ' + 'x'.repeat(1000)).length < 320);
});

test('isInfrastructureFailure spots dead backends, not model mistakes', () => {
  assert.equal(isInfrastructureFailure(summarizeFailure(CODEX_STDERR)), true);
  assert.equal(isInfrastructureFailure('error sending request: connection refused'), true);
  assert.equal(isInfrastructureFailure('API Error: 429 rate limit'), true);
  assert.equal(isInfrastructureFailure('ERROR: tool call failed: file not found'), false);
  // the echoed prompt mentions 401, but the summary is what gets classified
  assert.equal(summarizeFailure(CODEX_STDERR).includes('401'), false);
});
