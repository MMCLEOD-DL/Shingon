// test/health.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { checkHealth, classifyFailure } from '../src/health.js';

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
