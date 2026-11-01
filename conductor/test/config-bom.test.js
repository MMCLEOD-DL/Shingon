import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { readSetup, appConfig, saveSetup } from '../src/service/config.js';

const config = () => ({participants: [
  {name: 'codex', adapter: 'codex', bin: 'C:\\Outils été\\codex.exe', roles: ['reviewer']},
  {name: 'local', adapter: 'local-agent', model: 'modèle-日本', baseUrl: 'http://localhost:8080/v1', roles: ['grunt']},
], routing: {allowApi: false}, notes: 'embedded \uFEFF stays'});

async function fixture(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'config-bom-'));
  const file = path.join(root, 'config.json');
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(config()), 'utf8')]);
  writeFileSync(file, bytes);
  try { await fn({root, file, bytes}); }
  finally { rmSync(root, {recursive: true, force: true}); }
}

test('CLI and service load PowerShell-style UTF-8 BOM configs without altering Unicode or file bytes', async () => {
  await fixture(({file, bytes}) => {
    const cli = loadConfig(file);
    assert.equal(cli.byName.get('codex').adapter.bin, config().participants[0].bin);
    assert.equal(cli.byName.get('local').adapter.model, 'modèle-日本');
    assert.deepEqual(readSetup(file), config());
    assert.equal(appConfig(file).byName.get('local').adapter.model, 'modèle-日本');
    assert.deepEqual(readFileSync(file), bytes);
  });
});

test('setup edits preserve unrelated Unicode fields and reload the same supported participants', async () => {
  await fixture(({file}) => {
    const result = saveSetup(file, {local: {baseUrl: 'http://localhost:8080/v1', model: 'nouveau-日本'}});
    assert.equal(result.configured, true);
    assert.equal(loadConfig(file).byName.get('local').adapter.model, 'nouveau-日本');
    assert.equal(readSetup(file).notes, 'embedded \uFEFF stays');
    assert.equal(appConfig(file).byName.get('codex').adapter.bin, config().participants[0].bin);
  });
});

test('normal JSON/schema checks still reject damaged and unsupported config inputs', async () => {
  await fixture(({file}) => {
    for (const input of ['\uFEFF{broken', '\uFEFF\uFEFF{}', ' \uFEFF{}']) {
      writeFileSync(file, input, 'utf8');
      assert.throws(() => loadConfig(file), SyntaxError);
      assert.throws(() => readSetup(file), SyntaxError);
    }
    writeFileSync(file, Buffer.from('\uFEFF' + JSON.stringify(config()), 'utf16le'));
    assert.throws(() => loadConfig(file), SyntaxError);
    writeFileSync(file, '\uFEFF' + JSON.stringify({...config(), participants: 'invalid'}));
    assert.throws(() => loadConfig(file), /participants/);
    assert.throws(() => readSetup(file), /invalid/);
    writeFileSync(file, '\uFEFF' + JSON.stringify({...config(), routing: {allowApi: 'yes'}}));
    assert.throws(() => loadConfig(file), /allowApi/);
    const api = {participants: [{name:'api', adapter:'openai-api', roles:['reviewer']}]};
    writeFileSync(file, '\uFEFF' + JSON.stringify(api));
    assert.throws(() => appConfig(file), /Configure the subscription CLIs/);
  });
});

test('offline frontier home preparation accepts BOM config without invoking the absent configured CLI', async () => {
  await fixture(({root, file}) => {
    const prepared = JSON.parse(execFileSync(process.execPath, [path.resolve('bin/conductor-codex-home.js'), '--config', file], {
      encoding: 'utf8', windowsHide: true, env: {...process.env, XDG_CACHE_HOME: path.join(root, 'cache')},
    }));
    assert.equal(prepared.bin, config().participants[0].bin);
    assert.ok(prepared.home.startsWith(path.join(root, 'cache')));
  });
});
