import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performProbe } from '../../src/service/probe-worker.js';

const command = async () => ({ code: 0, stdout: '', stderr: '' });
const participant = run => ({ name: 'synthetic', adapter: { kind: 'codex', bin: 'synthetic', run } });
const probe = (run, kind = 'agentic') => performProbe({ participant: participant(run), kind, command });

test('a successful CLI that creates no verification file gets an actionable write diagnostic', async () => {
  const result = await probe(async () => ({ok:true,text:'I could not write the file: private model output'}));
  assert.equal(result.agenticExecution, 'unknown');
  assert.match(result.action, /verification file/);
  assert.match(result.action, /sandbox/);
  assert.doesNotMatch(JSON.stringify(result), /private model output/);
});

test('wrong file contents and wrong challenge replies are distinct failures', async () => {
  const wrongFile = await probe(async (_role, prompt, _ctx, opts) => {
    writeFileSync(path.join(opts.cwd, /create (probe-[a-f0-9-]+\.txt)/.exec(prompt)[1]), 'wrong contents');
    return {ok:true,text:'OK'};
  });
  assert.match(wrongFile.action, /unexpected contents/);
  const wrongReply = await probe(async () => ({ok:true,text:'not the challenge'}), 'authenticated');
  assert.match(wrongReply.action, /expected check response/);
  assert.equal(wrongReply.authentication, 'unknown');
});

test('known CLI failures get fixed explanations without leaking diagnostic payloads', async () => {
  const privateText = 'SYNTHETIC_PRIVATE_TOKEN https://private.example/x?token=hidden\n<script>private</script>';
  for (const [answer, pattern] of [
    [{ok:false,failure:'timeout',error:privateText}, /time limit/],
    [{ok:false,error:'401 unauthorized '+privateText}, /sign.in/],
    [{ok:false,error:'429 rate limit '+privateText}, /usage or rate limit/],
    [{ok:false,error:'unknown field '+privateText}, /configuration option/],
    [{ok:false,error:'Windows sandbox not configured '+privateText}, /sandbox setup/],
    [{ok:false,error:'workspace is read-only '+privateText}, /read.only/],
    [{ok:false,error:privateText}, /did not complete/],
  ]) {
    const result = await probe(async () => answer);
    assert.match(result.action, pattern);
    assert.ok(result.action.length <= 500);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_TOKEN|private\.example|<script>|token=hidden/);
  }
});

test('a version-check timeout remains unknown and never calls a model', async () => {
  const result = await performProbe({participant:participant(() => assert.fail('no model call')),kind:'installation',command:async()=>({code:-1,timedOut:true})});
  assert.equal(result.executable, 'unknown');
  assert.equal(result.reason, 'timeout');
  assert.match(result.action, /installation check/);
});

test('Codex authentication guidance points to its dedicated home; Claude keeps its supported login flow', async () => {
  const run = async () => ({ok:false, error:'401 unauthorized'});
  const codex = await probe(run, 'authenticated');
  assert.match(codex.action, /dedicated Conductor Codex home/);
  const p = participant(run); p.adapter.kind = 'claude-code';
  const claude = await performProbe({participant:p, kind:'authenticated', command});
  assert.match(claude.action, /supported login flow/);
  assert.doesNotMatch(claude.action, /Codex home/);
});

test('adapter exceptions become safe diagnostics rather than raw worker failures', async () => {
  const result = await probe(async () => {throw new Error('Private local Codex home is busy or unavailable; SYNTHETIC_PRIVATE_TOKEN');});
  assert.match(result.action, /settings.*busy or unavailable/);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_TOKEN/);
});

test('an unreadable verification path is diagnosed without exposing its name', async () => {
  let filename;
  const result = await probe(async (_role, prompt, _ctx, opts) => {
    filename = /create (probe-[a-f0-9-]+\.txt)/.exec(prompt)[1];
    mkdirSync(path.join(opts.cwd, filename));
    return {ok:true,text:'OK'};
  });
  assert.match(result.action, /could not be read/);
  assert.ok(!JSON.stringify(result).includes(filename));
});

test('successful challenge and file verification keep their original statuses with no diagnostic', async () => {
  const authenticated = await probe(async (_role, prompt) => ({ok:true,text:prompt.match(/[a-f0-9-]{36}/)[0]}), 'authenticated');
  assert.equal(authenticated.authentication, 'verified');
  assert.equal(authenticated.action, null);
  const agentic = await probe(async (_role, prompt, _ctx, opts) => {
    writeFileSync(path.join(opts.cwd, /create (probe-[a-f0-9-]+\.txt)/.exec(prompt)[1]), /exactly ([a-f0-9-]{36})/.exec(prompt)[1]);
    return {ok:true,text:'401 sandbox failed is untrusted model text'};
  });
  assert.equal(agentic.agenticExecution, 'verified');
  assert.equal(agentic.action, null);
  assert.equal(agentic.reason, null);
});
