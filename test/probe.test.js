// test/probe.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { runCommand } from '../src/exec.js';

test('probe runs a participant end-to-end and prints the verdict', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'probe-'));
  const claude = writeStubCli(dir, 'claude', `
    process.stdout.write(JSON.stringify({ result: "looks fine\\nVERDICT: APPROVE", total_cost_usd: 0.1, is_error: false }));
  `);
  const cfg = path.join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ participants: [
    { name: 'claude', adapter: 'claude-code', bin: claude, roles: ['reviewer'] },
  ]}));

  const probe = path.resolve('bin/conductor-probe.js');
  const r = await runCommand({
    cmd: process.execPath,
    args: [probe, '--config', cfg, '--participant', 'claude', '--role', 'reviewer', '--task', 'review this'],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /APPROVE/);
  assert.match(r.stdout, /0\.1/);
});

test('probe exits 1 when the participant is not ok', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'probe2-'));
  const claude = writeStubCli(dir, 'claude', `process.exit(1);`);
  const cfg = path.join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ participants: [
    { name: 'claude', adapter: 'claude-code', bin: claude, roles: ['author'] },
  ]}));
  const probe = path.resolve('bin/conductor-probe.js');
  const r = await runCommand({ cmd: process.execPath, args: [probe, '--config', cfg, '--participant', 'claude', '--role', 'author', '--task', 't'] });
  assert.equal(r.code, 1);
});
