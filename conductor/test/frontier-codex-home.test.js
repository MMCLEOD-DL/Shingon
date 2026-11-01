import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { CodexAdapter, frontierCodexConfig } from '../src/adapters/codex.js';
import { LocalAgentAdapter } from '../src/adapters/localAgent.js';

test('frontier calls isolate personal settings and retain only their own state across calls', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'frontier-home-'));
  const cwd = path.join(root, 'workspace');
  const personal = path.join(root, 'personal');
  mkdirSync(cwd); mkdirSync(personal);
  const previous = { CODEX_HOME: process.env.CODEX_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
  process.env.CODEX_HOME = personal;
  process.env.XDG_CACHE_HOME = path.join(root, 'cache');
  const sentinel = '[mcp_servers.personal]\ncommand = "DO-NOT-LAUNCH"\n[projects.private]\ntrust_level = "trusted"\n';
  writeFileSync(path.join(personal, 'config.toml'), sentinel);
  writeFileSync(path.join(personal, 'auth.json'), 'SYNTHETIC-PERSONAL-AUTH');
  // Node is a real native child, not Codex: "exec" is a fixture script in cwd.
  writeFileSync(path.join(cwd, 'exec'), `
    const fs = require('node:fs'), path = require('node:path');
    const home = process.env.CODEX_HOME, args = process.argv.slice(2);
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    const auth = path.join(home, 'auth.json');
    const seen = {home, config, hadAuth: fs.existsSync(auth)};
    fs.writeFileSync(path.join(home, 'fixture-state'), 'retained');
    fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(seen));
  `);
  try {
    const adapter = new CodexAdapter({ bin: process.execPath });
    const firstResult = await adapter.run('reviewer', 'synthetic', '', {cwd});
    assert.equal(firstResult.ok, true, firstResult.error);
    const first = JSON.parse(firstResult.text);
    assert.notEqual(first.home, personal, 'frontier CLI inherited personal CODEX_HOME');
    assert.equal(first.hadAuth, false, 'personal credentials must not be copied');
    assert.match(first.config, /^forced_login_method = "chatgpt"$/m);
    assert.doesNotMatch(first.config, /mcp|plugin|projects|DO-NOT-LAUNCH/);
    assert.equal(existsSync(first.home), true);
    // The operator-supported login will create its own state. Synthetic fixture only.
    writeFileSync(path.join(first.home, 'auth.json'), 'SYNTHETIC-DEDICATED-AUTH');
    writeFileSync(path.join(first.home, 'config.toml'), 'unwanted_personal_setting = true\n');
    const second = JSON.parse((await new CodexAdapter({bin: process.execPath, model: 'different-model', extraConfig: ['fixture=true']})
      .run('reviewer', 'synthetic', '', {cwd})).text);
    assert.equal(second.home, first.home);
    assert.equal(second.hadAuth, true);
    assert.equal(second.config, first.config);
    assert.equal(readFileSync(path.join(first.home, 'auth.json'), 'utf8'), 'SYNTHETIC-DEDICATED-AUTH');
    assert.equal(readFileSync(path.join(first.home, 'fixture-state'), 'utf8'), 'retained');
    assert.equal(readFileSync(path.join(personal, 'config.toml'), 'utf8'), sentinel);
    assert.equal(readFileSync(path.join(personal, 'auth.json'), 'utf8'), 'SYNTHETIC-PERSONAL-AUTH');
    assert.equal(process.env.CODEX_HOME, personal);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, {recursive: true, force: true});
  }
});

test('offline preparation matches runtime, never launches the configured executable, and excludes local homes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'frontier-prepare-'));
  const oldCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = path.join(root, 'cache');
  try {
    const missingBin = path.join(root, 'not-installed-codex');
    const configFile = path.join(root, 'config.json');
    const cli = path.resolve('bin/conductor-codex-home.js');
    writeFileSync(configFile, JSON.stringify({participants: [
      {name: 'frontier', adapter: 'codex', bin: missingBin, roles: ['reviewer']},
      {name: 'local', adapter: 'local-agent', bin: missingBin, model: 'fixture', roles: ['grunt']},
    ]}));
    const prepared = JSON.parse(execFileSync(process.execPath, [cli, '--config', configFile, '--participant', 'frontier'], {encoding: 'utf8', windowsHide: true}));
    assert.equal(prepared.bin, missingBin);
    assert.equal(prepared.home, await new CodexAdapter({bin: missingBin}).prepareHome());
    const local = new LocalAgentAdapter({bin: missingBin, model: 'fixture'})._codex;
    const lease = await local.openHome();
    try { assert.notEqual(lease.home, prepared.home); }
    finally { await lease.close(); }
    const busy = await new CodexAdapter({bin: missingBin}).openHome();
    try {
      const rejected = spawnSync(process.execPath, [cli, '--config', configFile, '--participant', 'frontier'], {encoding: 'utf8', windowsHide: true});
      assert.equal(rejected.status, 2);
      assert.equal(rejected.stdout, '');
      assert.doesNotMatch(rejected.stderr, /not-installed-codex|config.json/);
    } finally { await busy.close(); }
    for (const participant of ['local', 'missing']) {
      const rejected = spawnSync(process.execPath, [cli, '--config', configFile, '--participant', participant], {encoding: 'utf8', windowsHide: true});
      assert.equal(rejected.status, 2);
      assert.equal(rejected.stdout, '');
    }
    // The same preparation seam rejects a cache placed inside an agent workspace.
    await assert.rejects(new CodexAdapter({bin: missingBin}).prepareHome({cwd: root}), /outside the agent workspace/);
    await assert.rejects(new CodexAdapter({homeConfig: 'fixture=true', reuseHome: false}).prepareHome(), /retained/);
    assert.equal(existsSync(missingBin), false);
  } finally {
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = oldCache;
    rmSync(root, {recursive: true, force: true});
  }
});

test('frontier generated settings select subscription login and preserve the Windows sandbox default', () => {
  assert.match(frontierCodexConfig('win32'), /^\[windows\]\nsandbox = "elevated"$/m);
  for (const platform of ['linux', 'darwin']) assert.equal(frontierCodexConfig(platform), 'forced_login_method = "chatgpt"\n');
  assert.throws(() => new CodexAdapter({homeConfig: null}), /generated private config/);
});
