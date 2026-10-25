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
  assert.equal(byName.get('local').wake.method, 'warn');
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

test('buildAdapter forwards baseUrl and contextWindow to the local agent home config', () => {
  const l = buildAdapter({ name: 'l', adapter: 'local-agent', model: 'm', baseUrl: 'http://h:1/v1', contextWindow: 4096 });
  assert.equal(l.baseUrl, 'http://h:1/v1');
  assert.match(l._codex.homeConfig, /^model_context_window = 4096$/m);
  assert.match(l._codex.homeConfig, /^base_url = "http:\/\/h:1\/v1"$/m);
  assert.equal(buildAdapter({ name: 'c', adapter: 'codex' }).homeConfig, null);
});

import { writeFileSync as writeCfg, mkdtempSync as mkCfgDir } from 'node:fs';
import { tmpdir as cfgTmp } from 'node:os';
import cfgPath from 'node:path';

const cfgFile = (obj) => {
  const f = cfgPath.join(mkCfgDir(cfgPath.join(cfgTmp(), 'cfg-')), 'c.json');
  writeCfg(f, JSON.stringify(obj));
  return f;
};
const API_P = { name: 'claude-api', adapter: 'anthropic-api', model: 'm', roles: ['author', 'reviewer'] };

test('buildAdapter builds the API adapters', () => {
  const a = buildAdapter({ ...API_P, envKey: 'K1', baseUrl: 'http://x', maxTokens: 10, prices: { inputPerMTok: 1, outputPerMTok: 2 } });
  assert.equal(a.kind, 'anthropic-api');
  assert.equal(a.envKey, 'K1');
  assert.equal(a.baseUrl, 'http://x');
  assert.equal(buildAdapter({ name: 'o', adapter: 'openai-api', model: 'm' }).kind, 'openai-api');
});

test('loadConfig returns routing and options, and rejects unknown options', () => {
  const ok = loadConfig(cfgFile({ participants: [API_P], routing: { allowApi: true }, options: { testCommand: 'npm test' } }));
  assert.deepEqual(ok.routing, { allowApi: true });
  assert.deepEqual(ok.options, { testCommand: 'npm test' });
  const bare = loadConfig(cfgFile({ participants: [API_P] }));
  assert.deepEqual(bare.routing, {});
  assert.deepEqual(bare.options, {});
  assert.throws(() => loadConfig(cfgFile({ participants: [API_P], options: { testComand: 'x' } })), /Unknown option "testComand"/);
});

test('API participants cannot edit files or be the local executor', () => {
  assert.throws(() => loadConfig(cfgFile({ participants: [{ ...API_P, capabilities: { can_edit_files: true } }] })), /cannot edit files/);
  assert.throws(() => loadConfig(cfgFile({ participants: [{ ...API_P, roles: ['grunt'] }] })), /cannot be the local executor/);
});

test('routing.allowApi and routing.preferTwoVendors must be true or false (I4)', () => {
  for (const key of ['allowApi', 'preferTwoVendors']) {
    for (const v of ['false', 1, null]) {
      assert.throws(() => loadConfig(cfgFile({ participants: [API_P], routing: { [key]: v } })), new RegExp(`routing\\.${key} must be true or false`));
    }
    assert.equal(loadConfig(cfgFile({ participants: [API_P], routing: { [key]: false } })).routing[key], false);
  }
});

test('every participant gets a normalized wake; localDown is validated', () => {
  const f = writeConfig({ participants: [
    { name: 'claude', adapter: 'claude-code', roles: ['author', 'reviewer'] },
    { name: 'local', adapter: 'local-agent', model: 'm', roles: ['grunt'], wake: { method: 'wol', mac: '00:11:22:33:44:55', hint: 'Turn on the desktop PC.' } },
  ], routing: { localDown: 'ask' } });
  const { byName } = loadConfig(f);
  assert.equal(byName.get('claude').wake.method, 'warn');
  assert.equal(byName.get('local').wake.mac, '00:11:22:33:44:55');
  for (const v of ['frontiers', true, 'ASK']) {
    const g = writeConfig({ participants: [{ name: 'c', adapter: 'claude-code', roles: ['author'] }], routing: { localDown: v } });
    assert.throws(() => loadConfig(g), /routing\.localDown must be "ask", "frontier" or "pause", but the config has/, String(v));
  }
  const h = writeConfig({ participants: [{ name: 'l', adapter: 'local-agent', model: 'm', roles: ['grunt'], wake: { method: 'nope' } }] });
  assert.throws(() => loadConfig(h), /Participant l: wake\.method/);
});

test('wake.env names are scrubbed from every other child and their values redacted (final review 1)', async () => {
  const { childEnv, redact, REDACTED } = await import('../src/secrets.js');
  const { runWakeCommand } = await import('../src/wake.js');
  const f = writeConfig({ participants: [
    { name: 'local', adapter: 'local-agent', model: 'm', roles: ['grunt'], wake: { method: 'command', cmd: 'wake-it', env: ['WAKE_HOST_FR1'] } },
  ] });
  const env = { ...process.env, WAKE_HOST_FR1: '192.168.1.109' };
  const { byName } = loadConfig(f);
  assert.equal(childEnv({ env }).WAKE_HOST_FR1, undefined, 'agents and tests never inherit it');
  let seen = null;
  await runWakeCommand(byName.get('local').wake, { env, run: async (o) => { seen = o.env; return { code: 0, stdout: '', stderr: '' }; } });
  assert.equal(seen.WAKE_HOST_FR1, '192.168.1.109', 'the wake command still gets it');
  const saved = process.env.WAKE_HOST_FR1;
  process.env.WAKE_HOST_FR1 = '192.168.1.109';
  try {
    assert.equal(redact('ssh wake@192.168.1.109'), `ssh wake@${REDACTED}`);
  } finally {
    if (saved === undefined) delete process.env.WAKE_HOST_FR1; else process.env.WAKE_HOST_FR1 = saved;
  }
});
