// test/config.test.js
import { test } from 'node:test';
import { SHELL_ENV_EXCLUDE } from '../src/adapters/localAgent.js';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, buildAdapter } from '../src/config.js';

function writeConfig(obj) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const f = path.join(dir, 'config.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('loads the example-shaped config into Participants', () => {
  const f = writeConfig({ participants: [
    { name: 'claude', adapter: 'claude-code', roles: ['author', 'reviewer'] },
    { name: 'local', adapter: 'local-agent', model: 'm', roles: ['grunt'] },
  ]});
  const { participants, byName } = loadConfig(f);
  assert.equal(participants.length, 2);
  assert.equal(byName.get('claude').adapter.kind, 'claude-code');
  assert.equal(byName.get('local').adapter.kind, 'local-agent');
});

test('unknown adapter kind throws naming the participant', () => {
  assert.throws(() => buildAdapter({ name: 'bad', adapter: 'telepathy' }), /bad.*telepathy|telepathy.*bad/);
});

test('local-agent without model throws', () => {
  assert.throws(() => buildAdapter({ name: 'local', adapter: 'local-agent' }), /model/);
});

test('config.example.json loads into three Participants', () => {
  const { participants, byName } = loadConfig('config.example.json');
  assert.equal(participants.length, 3);
  assert.ok(byName.get('claude'));
  assert.ok(byName.get('codex'));
  assert.ok(byName.get('local'));
});

test('duplicate participant names throw', () => {
  const f = writeConfig({ participants: [
    { name: 'dup', adapter: 'codex', roles: ['author'] },
    { name: 'dup', adapter: 'claude-code', roles: ['reviewer'] },
  ]});
  assert.throws(() => loadConfig(f), /[Dd]uplicate/);
});

test('non-array participants throws', () => {
  const f = writeConfig({ participants: 'nope' });
  assert.throws(() => loadConfig(f), /participants/);
});

test('buildAdapter forwards timeoutMs, extraConfig and provider', () => {
  const c = buildAdapter({ name: 'c', adapter: 'codex', timeoutMs: 999, extraConfig: ['a=1'] });
  assert.equal(c.timeoutMs, 999);
  assert.deepEqual(c.extraConfig, ['a=1']);
  const l = buildAdapter({ name: 'l', adapter: 'local-agent', model: 'm', provider: 'ollama', extraConfig: ['b=2'], timeoutMs: 5 });
  assert.equal(l.provider, 'ollama');
  assert.deepEqual(l._codex.extraConfig, ['model_provider=ollama', 'model=m', 'b=2', SHELL_ENV_EXCLUDE]);
  assert.equal(l.envKey, 'LOCALAI_API_KEY');
  assert.equal(buildAdapter({ name: 'l2', adapter: 'local-agent', model: 'm', envKey: 'OLLAMA_KEY' }).envKey, 'OLLAMA_KEY');
  assert.equal(l._codex.timeoutMs, 5);
  const k = buildAdapter({ name: 'k', adapter: 'claude-code' });
  assert.equal(k.timeoutMs, 120000);
});
