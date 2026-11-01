import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performProbe } from '../../src/service/probe-worker.js';

function fixture(stdout, adapter = 'local-agent') {
  const commands = []; let modelCalls = 0;
  const participant = {name:'synthetic', adapter: {kind:adapter, bin:'synthetic', run: async (_role, prompt) => {
    modelCalls++;
    return {ok:true, text:prompt.match(/[a-f0-9-]{36}/)?.[0] ?? 'OK'};
  }}};
  const command = async spec => {commands.push(spec.cmd); return {code:0, stdout, stderr:''};};
  return {run: kind => performProbe({participant, kind, command}), commands, modelCalls: () => modelCalls};
}

test('old local Codex versions are refused before Git or model work for every check kind', async () => {
  for (const kind of ['installation', 'authenticated', 'agentic']) {
    const f = fixture('codex-cli 0.122.0\n');
    const result = await f.run(kind);
    assert.equal(result.executable, 'found');
    assert.equal(result.reason, 'version-skew');
    assert.match(result.action, /0\.163\.0/);
    assert.equal(result.endpoint, 'unknown');
    assert.equal(result.agenticExecution, 'unknown');
    assert.equal(f.modelCalls(), 0);
    assert.deepEqual(f.commands, ['synthetic']);
  }
});

test('stable baseline and higher versions pass installation only, without claiming model readiness', async () => {
  for (const version of ['codex-cli 0.163.0\r\n', 'codex-cli 0.163.1', 'codex-cli 0.164.0', 'codex-cli 1.0.0', 'codex-cli 0.163.0+build.1', 'codex 0.163.0', 'OpenAI Codex v0.163.0']) {
    const f = fixture(version);
    const result = await f.run('installation');
    assert.equal(result.reason, null, version);
    assert.equal(result.executable, 'found');
    assert.equal(result.endpoint, 'unknown');
    assert.equal(f.modelCalls(), 0);
  }
});

test('unknown, prerelease and malformed versions get safe guidance without diagnostic reflection or calls', async () => {
  for (const version of ['', 'node v24.12.0', 'codex-cli 0.162.99', 'codex-cli 0.163.0-alpha.1', 'codex-cli 00.163.0', 'codex-cli\n0.163.0', 'codex-cli 0.163.0+bad..build', 'codex-cli 0.163.0\nSYNTHETIC_PRIVATE_TOKEN', 'codex-cli 999999999999999999999.0.0']) {
    const f = fixture(version);
    const result = await f.run('authenticated');
    assert.equal(result.reason, 'version-skew', version);
    assert.match(result.action, /Codex/);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_TOKEN|node v24/);
    assert.equal(f.modelCalls(), 0);
    assert.deepEqual(f.commands, ['synthetic']);
  }
});

test('a supported version still requires the fresh authenticated challenge', async () => {
  const f = fixture('codex-cli 0.163.0');
  const result = await f.run('authenticated');
  assert.equal(result.endpoint, 'reachable');
  assert.equal(result.authentication, 'not-applicable');
  assert.equal(f.modelCalls(), 1);
  assert.deepEqual(f.commands, ['synthetic', 'git']);
});

test('the local-agent baseline does not impose a new version policy on frontier CLIs', async () => {
  for (const adapter of ['codex', 'claude-code']) {
    const f = fixture('different vendor version', adapter);
    const result = await f.run('installation');
    assert.equal(result.reason, null);
    assert.equal(result.executable, 'found');
  }
});
