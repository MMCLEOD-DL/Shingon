import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { performProbe } from '../../src/service/probe-worker.js';

const command = async () => ({ code: 0, stdout: 'codex-cli 0.163.0\n', stderr: '' });
const participant = (run, kind = 'codex') => ({ name: 'test', adapter: { kind, bin: 'synthetic', run } });
test('installation check cannot claim authenticated or agentic execution', async () => {
  const r = await performProbe({ participant: participant(() => assert.fail('No model call for installation probe')), kind: 'installation', command });
  assert.equal(r.executable, 'found'); assert.equal(r.authentication, 'unknown'); assert.equal(r.agenticExecution, 'unknown');
});
test('missing executable does not call the model', async () => {
  const r = await performProbe({ participant: participant(() => assert.fail('Not installed')), kind: 'authenticated', command: async () => ({ code: 127 }) });
  assert.equal(r.reason, 'not-installed'); assert.equal(r.authentication, 'unknown');
});
test('authenticated check requires the fresh challenge, not only a zero exit', async () => {
  const r = await performProbe({ participant: participant(async () => ({ ok: true, text: 'irrelevant' })), kind: 'authenticated', command });
  assert.equal(r.authentication, 'unknown'); assert.notEqual(r.reason, null);
});
test('authenticated challenge success is distinct from file-writing capability', async () => {
  const r = await performProbe({ participant: participant(async (_role, prompt) => ({ ok: true, text: prompt.match(/[a-f0-9-]{36}/)[0] })), kind: 'authenticated', command });
  assert.equal(r.authentication, 'verified'); assert.equal(r.agenticExecution, 'unknown');
});
test('agentic local probe requires the actual nonce file', async () => {
  const r = await performProbe({ participant: participant(async (_role, prompt, _ctx, opts) => {
    const filename = /create (probe-[a-f0-9-]+\.txt)/.exec(prompt)[1];
    const nonce = /exactly ([a-f0-9-]{36})/.exec(prompt)[1];
    assert.equal(opts.write, true); writeFileSync(path.join(opts.cwd, filename), nonce);
    return { ok: true, text: 'OK' };
  }, 'local-agent'), kind: 'agentic', command });
  assert.equal(r.endpoint, 'reachable'); assert.equal(r.agenticExecution, 'verified'); assert.equal(r.authentication, 'not-applicable');
});

test('file-writing checks give every coding adapter execution instructions rather than a review assignment', async () => {
  for (const adapter of ['local-agent', 'codex', 'claude-code']) {
    const roles = [];
    const r = await performProbe({participant:participant(async (role, prompt, _context, opts) => {
      roles.push(role);
      // Reproduce the live local model following the review assignment: it
      // inspects an empty repository instead of implementing the requested file.
      if (role === 'reviewer') return {ok:true,text:'There is no work to review. VERDICT: BLOCK - no implementation.'};
      const filename = /create (probe-[a-f0-9-]+\.txt)/.exec(prompt)[1];
      const nonce = /exactly ([a-f0-9-]{36})/.exec(prompt)[1];
      assert.equal(opts.write, true);
      writeFileSync(path.join(opts.cwd, filename), nonce);
      return {ok:true,text:'OK'};
    },adapter),kind:'agentic',command});
    assert.equal(r.agenticExecution, 'verified', adapter);
    assert.deepEqual(roles, ['grunt']);
  }
});
test('signed-out and timeout checks remain failures with no raw model output', async () => {
  const r = await performProbe({ participant: participant(async () => ({ ok: false, error: 'please run /login secret detail' })), kind: 'authenticated', command });
  assert.equal(r.authentication, 'required'); assert.equal(r.reason, 'unauthorized'); assert.doesNotMatch(JSON.stringify(r), /secret detail/);
});
