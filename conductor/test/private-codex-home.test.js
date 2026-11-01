import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, linkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../src/adapters/codex.js';
import { openPrivateCodexHome } from '../src/adapters/privateCodexHome.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

async function fixture(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'private-home-'));
  const options = { base: path.join(dir, 'cache'), config: 'model = "local"\n', identity: 'local-test', reuse: true };
  try { await fn(options, dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('same identity excludes concurrent use, and release allows the next call', async () => {
  await fixture(async options => {
    const first = await openPrivateCodexHome(options);
    try { await assert.rejects(openPrivateCodexHome(options), /busy or unavailable/); }
    finally { await first.close(); }
    const next = await openPrivateCodexHome(options);
    assert.equal(next.home, first.home);
    await next.close();
  });
});

test('configuration and executable identities get separate persistent state', async () => {
  await fixture(async options => {
    const leases = [];
    try {
      leases.push(await openPrivateCodexHome(options));
      leases.push(await openPrivateCodexHome({ ...options, config: 'model = "other"\n' }));
      leases.push(await openPrivateCodexHome({ ...options, identity: 'other-executable' }));
      assert.equal(new Set(leases.map(x => x.home)).size, 3);
    } finally { for (const lease of leases) await lease.close(); }
  });
});

test('ephemeral homes are still removed, including their synthetic setup state', async () => {
  await fixture(async options => {
    const lease = await openPrivateCodexHome({ ...options, reuse: false });
    writeFileSync(path.join(lease.home, 'synthetic-setup-marker'), 'fixture');
    await lease.close();
    assert.equal(existsSync(lease.home), false);
  });
});

test('refuses an agent-writable home and a non-file config; releases lease after refusal', async () => {
  await fixture(async (options, dir) => {
    await assert.rejects(openPrivateCodexHome({ ...options, cwd: dir }), /outside the agent workspace/);
    const lease = await openPrivateCodexHome(options);
    const file = path.join(lease.home, 'config.toml');
    await lease.close();
    rmSync(file);
    // A directory in place of the generated config must never be overwritten.
    mkdirSync(file);
    await assert.rejects(openPrivateCodexHome(options), /regular unlinked file/);
    rmSync(file, { recursive: true });
    const recovered = await openPrivateCodexHome(options);
    await recovered.close();
  });
});

test('refuses linked config files and redirected homes without touching the target', async () => {
  await fixture(async (options, dir) => {
    const lease = await openPrivateCodexHome(options);
    await lease.close();
    const configFile = path.join(lease.home, 'config.toml');
    const target = path.join(dir, 'do-not-touch');
    writeFileSync(target, 'preserved');
    rmSync(configFile);
    linkSync(target, configFile);
    await assert.rejects(openPrivateCodexHome(options), /regular unlinked file/);
    assert.equal(readFileSync(target, 'utf8'), 'preserved');
    rmSync(configFile);
    rmSync(lease.home, { recursive: true });
    const other = path.join(dir, 'other');
    mkdirSync(other);
    symlinkSync(other, lease.home, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(openPrivateCodexHome(options), /real directory/);
    assert.equal(existsSync(path.join(other, 'config.toml')), false);
  });
});

test('a second process is excluded and its lease disappears on process death', async () => {
  await fixture(async options => {
    const moduleUrl = pathToFileURL(path.resolve('src/adapters/privateCodexHome.js')).href;
    const script = `import {openPrivateCodexHome} from ${JSON.stringify(moduleUrl)};
      await openPrivateCodexHome(JSON.parse(process.argv[1]));
      console.log('READY'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(options)], { windowsHide: true });
    const exited = once(child, 'exit');
    try {
      const ready = await Promise.race([
        once(child.stdout, 'data').then(([chunk]) => chunk.toString()),
        exited.then(() => { throw new Error('fixture exited before acquiring lease'); }),
        new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 5000); timer.unref(); }),
      ]);
      assert.match(ready, /READY/);
      await assert.rejects(openPrivateCodexHome(options), /busy or unavailable/);
    } finally { child.kill(); await exited; }
    const next = await openPrivateCodexHome(options);
    await next.close();
  });
});

test('persistent reuse cannot accidentally use personal frontier configuration', () => {
  assert.throws(() => new CodexAdapter({ reuseHome: true }), /generated private config/);
});

test('repeated persistent local calls retain setup state and refresh generated config', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conductor-home-test-'));
  const cache = mkdtempSync(path.join(tmpdir(), 'conductor-home-cache-'));
  const previousCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  writeFileSync(path.join(dir, 'exec'), `
    const fs = require('node:fs'); const path = require('node:path');
    const args = process.argv.slice(2); const home = process.env.CODEX_HOME;
    const marker = path.join(home, 'synthetic-setup-marker');
    const ready = fs.existsSync(marker);
    const cfg = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    fs.writeFileSync(marker, 'synthetic only');
    if (fs.existsSync(path.join(process.cwd(), 'fail'))) process.exit(2);
    if (fs.existsSync(path.join(process.cwd(), 'hang'))) setInterval(() => {}, 1000);
    fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify({home,ready,cfg}));
  `);
  try {
    const make = () => new CodexAdapter({ bin: process.execPath, homeConfig: 'model = "local"\n', reuseHome: true });
    const first = JSON.parse((await make().run('grunt', 't', '', { cwd: dir })).text);
    assert.equal(first.ready, false);
    assert.equal(existsSync(first.home), true);
    writeFileSync(path.join(first.home, 'config.toml'), 'unwanted = true\n');
    const second = JSON.parse((await make().run('grunt', 't', '', { cwd: dir })).text);
    assert.equal(second.home, first.home);
    assert.equal(second.ready, true);
    assert.equal(second.cfg, 'model = "local"\n');
    assert.equal(readFileSync(path.join(first.home, 'synthetic-setup-marker'), 'utf8'), 'synthetic only');
    writeFileSync(path.join(dir, 'fail'), 'fixture');
    assert.equal((await make().run('grunt', 't', '', { cwd: dir })).ok, false);
    rmSync(path.join(dir, 'fail'));
    writeFileSync(path.join(dir, 'hang'), 'fixture');
    assert.equal((await make().run('grunt', 't', '', { cwd: dir, timeoutMs: 200 })).failure, 'timeout');
    rmSync(path.join(dir, 'hang'));
    const recovered = JSON.parse((await make().run('grunt', 't', '', { cwd: dir })).text);
    assert.equal(recovered.home, first.home);
    assert.equal(recovered.ready, true);
  } finally {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});
