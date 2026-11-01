import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localCodexConfig, LocalAgentAdapter } from '../src/adapters/localAgent.js';
import { buildAdapter } from '../src/config.js';

const provider = { provider: 'localai', baseUrl: 'http://localhost:8080/v1', envKey: 'LOCALAI_API_KEY' };

test('private config emits the selected Windows sandbox in its own TOML table', () => {
  for (const mode of ['elevated', 'unelevated']) {
    const config = localCodexConfig({ ...provider, windowsSandbox: mode });
    assert.match(config, new RegExp(`\\[windows\\]\\nsandbox = "${mode}"`));
    assert.match(config, /\[model_providers.localai\]\nname = "localai"/);
    assert.doesNotMatch(config, /mcp_servers|plugins|projects|auth/);
  }
});

test('Windows default is elevated; other hosts omit Windows config', () => {
  const config = localCodexConfig(provider);
  if (process.platform === 'win32') assert.match(config, /\[windows\]\nsandbox = "elevated"/);
  else assert.doesNotMatch(config, /\[windows\]/);
});

test('rejects unsupported Windows modes instead of writing arbitrary TOML', () => {
  for (const mode of ['', 'disabled', 'Elevated', null, false, 'elevated"\n[evil]']) {
    assert.throws(() => new LocalAgentAdapter({ model: 'm', windowsSandbox: mode }), /windowsSandbox/);
  }
});

test('participant config forwards the Windows sandbox choice', () => {
  const adapter = buildAdapter({ name: 'local', adapter: 'local-agent', model: 'm', windowsSandbox: 'unelevated' });
  assert.match(adapter._codex.homeConfig, /\[windows\]\nsandbox = "unelevated"/);
});

test('native child receives isolated Windows config and requested write mode on repeated calls', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conductor-win-config-'));
  // Node is the native stand-in executable; its first argument (exec) is our script.
  writeFileSync(path.join(dir, 'exec'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    const home = process.env.CODEX_HOME;
    fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({
      home, cfg: fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), args
    }));
  `);
  try {
    const adapter = new LocalAgentAdapter({ bin: process.execPath, model: 'm', windowsSandbox: 'unelevated' });
    const homes = [];
    for (const write of [true, false, true]) {
      const result = await adapter.run('grunt', 'synthetic task', '', { cwd: dir, write });
      assert.equal(result.ok, true, result.error);
      const seen = JSON.parse(result.text);
      assert.match(seen.cfg, /\[windows\]\nsandbox = "unelevated"/);
      assert.equal(seen.args[seen.args.indexOf('--sandbox') + 1], write ? 'workspace-write' : 'read-only');
      assert.ok(seen.args.includes('shell_environment_policy.exclude=["*KEY*","*TOKEN*","*SECRET*","*PASSWORD*","*CREDENTIAL*"]'));
      assert.equal(existsSync(seen.home), false);
      homes.push(seen.home);
    }
    assert.equal(new Set(homes).size, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
