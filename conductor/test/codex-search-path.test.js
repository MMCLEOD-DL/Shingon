import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../src/adapters/codex.js';
import { LocalAgentAdapter } from '../src/adapters/localAgent.js';
import { codexSearchEnv } from '../src/adapters/codexSearchEnv.js';

test('Windows PATH spellings, spaces, existing order and duplicate helper entries are handled without mutation', () => {
  const bin = 'C:\\Codex Install\\bin\\codex.exe';
  const helper = 'C:\\Codex Install\\codex-path';
  const env = { Path: `C:\\Windows;"c:\\codex install\\codex-path";D:\\Tools`, KEEP: 'synthetic' };
  const result = codexSearchEnv(bin, env, { platform: 'win32', isFile: file => file === helper + '\\rg.exe' });
  assert.equal(result.Path, `${helper};C:\\Windows;D:\\Tools`);
  assert.equal(result.KEEP, env.KEEP);
  assert.match(env.Path, /"c:\\codex install/);
  const duplicate = codexSearchEnv(bin, { PATH: 'first', Path: 'second' }, {platform:'win32',isFile:()=>true});
  assert.equal(duplicate.PATH, helper + ';first');
  assert.equal(Object.hasOwn(duplicate, 'Path'), false);
});

test('bare, relative, standalone, missing-helper and non-Codex paths cannot introduce cwd tools', () => {
  const env = { PATH: 'unchanged' };
  for (const [bin, platform] of [['codex','linux'], ['./bin/codex','linux'], ['/tmp/other/bin/program','linux'], ['/opt/codex','linux'], ['C:\\bin\\codex.cmd','win32']]) {
    assert.deepEqual(codexSearchEnv(bin, env, {platform,isFile:()=>true}), env);
  }
  assert.deepEqual(codexSearchEnv('C:\\Install\\bin\\codex.exe', env, {platform:'win32',isFile:()=>false}), env);
  assert.deepEqual(codexSearchEnv('C:\\bad;directory\\bin\\codex.exe', env, {platform:'win32',isFile:()=>true}), env);
});

test('POSIX layouts use PATH and colon while preserving unrelated case-sensitive variables', () => {
  const env = { PATH: '/usr/bin:/opt/install/codex-path:/bin', Path: 'not-the-posix-path' };
  assert.deepEqual(codexSearchEnv('/opt/install/bin/codex', env, {platform:'linux',isFile:()=>true}), {
    PATH: '/opt/install/codex-path:/usr/bin:/bin', Path: 'not-the-posix-path',
  });
});

test('direct native Codex and local-agent children discover adjacent search tools without parent PATH edits', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-codex-path-'));
  const install = path.join(root, 'install with spaces');
  const binDir = path.join(install, 'bin');
  const helperDir = path.join(install, 'codex-path');
  const cwd = path.join(root, 'workspace');
  for (const dir of [binDir, helperDir, cwd]) mkdirSync(dir, { recursive: true });
  const win = process.platform === 'win32';
  const bin = path.join(binDir, win ? 'codex.exe' : 'codex');
  const rg = path.join(helperDir, win ? 'rg.exe' : 'rg');
  // Known native Node binaries are stand-ins, never real Codex or ripgrep.
  for (const file of [bin, rg]) { copyFileSync(process.execPath, file); if (!win) chmodSync(file, 0o755); }
  writeFileSync(path.join(cwd, 'exec'), `
    const fs = require('node:fs'); const cp = require('node:child_process');
    const args = process.argv.slice(2);
    const result = cp.spawnSync(${JSON.stringify(win ? 'rg.exe' : 'rg')}, ['--version'], {encoding:'utf8', windowsHide:true});
    fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify({code:result.status, out:result.stdout || '', path:process.env.PATH}));
  `);
  const originalPath = process.env.PATH;
  const originalCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = path.join(root, 'cache');
  try {
    for (const adapter of [new CodexAdapter({ bin }), new LocalAgentAdapter({ bin, model: 'synthetic' })]) {
      const result = await adapter.run('reviewer', 'synthetic', '', {cwd});
      assert.equal(result.ok, true, result.error);
      const seen = JSON.parse(result.text);
      assert.equal(seen.code, 0, 'adjacent search-tool stand-in was not found');
      assert.match(seen.out, /^v\d+\./);
      assert.equal(seen.path.split(path.delimiter)[0], helperDir);
    }
    assert.equal(process.env.PATH, originalPath);
  } finally {
    if (originalCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = originalCache;
    rmSync(root, {recursive:true,force:true});
  }
});
