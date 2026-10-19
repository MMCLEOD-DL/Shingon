// test/secrets.test.js — C1: keys are scrubbed at the source and redacted at every exit.
// Fake keys only; never a real credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { childEnv, redact, secretValues, SCRUB_ENV, REDACTED } from '../src/secrets.js';
import { writeStubCli } from './helpers/stubCli.js';
import { LocalAgentAdapter } from '../src/adapters/localAgent.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { ClaudeCodeAdapter } from '../src/adapters/claudeCode.js';
import { Workspace } from '../src/workspace.js';
import { runCommand } from '../src/exec.js';
import { makeRepo } from './helpers/gitRepo.js';

const LOCAL_KEY = 'sk-test-local-0123456789';
const X_KEY = 'sk-test-0123456789';
process.env.LOCALAI_API_KEY = LOCAL_KEY;
process.env.X_API_KEY = X_KEY;
process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic-0123456789';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'sec-'));

test('childEnv drops LOCALAI_API_KEY unless allowed, and keeps frontier keys', () => {
  assert.ok(SCRUB_ENV.includes('LOCALAI_API_KEY'));
  const env = childEnv();
  assert.equal(env.LOCALAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-test-anthropic-0123456789');
  assert.equal(env.X_API_KEY, X_KEY); // only the explicit list is scrubbed
  assert.equal(childEnv({ allow: ['LOCALAI_API_KEY'] }).LOCALAI_API_KEY, LOCAL_KEY);
  assert.equal(process.env.LOCALAI_API_KEY, LOCAL_KEY); // the parent env is not mutated
});

test('secretValues picks secret-looking names with long values, longest first', () => {
  const v = secretValues({ A_TOKEN: 'short', B_SECRET: 'abcdefgh', C_KEY: 'abcdefghijkl', PATH: '/usr/bin:/bin' });
  assert.deepEqual(v, ['abcdefghijkl', 'abcdefgh']);
});

test('redact deep-walks strings, arrays and plain objects', () => {
  const out = redact({ a: `x ${X_KEY} y`, b: [X_KEY, { c: LOCAL_KEY }], n: 5, z: null });
  assert.deepEqual(out, { a: `x ${REDACTED} y`, b: [REDACTED, { c: REDACTED }], n: 5, z: null });
  assert.equal(redact('nothing here'), 'nothing here');
});

test('runCommand and runTests do not pass LOCALAI_API_KEY to children', async () => {
  const r = await runCommand({ cmd: 'sh', args: ['-c', 'echo "[$LOCALAI_API_KEY]"'] });
  assert.equal(r.stdout.trim(), '[]');
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: tmp(), taskId: 't' });
  const t = await ws.runTests('echo "local=[$LOCALAI_API_KEY] x=$X_API_KEY"');
  assert.match(t.output, /local=\[\]/);
  assert.ok(!t.output.includes(X_KEY));
  assert.ok(t.output.includes(REDACTED));
});

// A stub that reports the env var it sees in its final message.
const ENV_STUB = `
  const fs = require('node:fs');
  const oi = args.indexOf('-o');
  const msg = 'local=' + (process.env.LOCALAI_API_KEY ? 'SET' : 'UNSET') + ' ' + args.join(' ');
  if (oi >= 0) fs.writeFileSync(args[oi + 1], msg);
  else process.stdout.write(JSON.stringify({ result: msg, is_error: false }));
`;

test('only the local adapter gets the provider key; its shell commands are told to exclude keys', async () => {
  const dir = tmp();
  const codexBin = writeStubCli(dir, 'codex', ENV_STUB);
  const claudeBin = writeStubCli(dir, 'claude', ENV_STUB);
  const local = await new LocalAgentAdapter({ bin: codexBin, model: 'm' }).run('grunt', 't', '', { write: true });
  assert.match(local.text, /^local=SET /);
  assert.match(local.text, /-c shell_environment_policy\.exclude=\["\*KEY\*","\*TOKEN\*","\*SECRET\*"/);
  const codex = await new CodexAdapter({ bin: codexBin }).run('reviewer', 't');
  assert.match(codex.text, /^local=UNSET /);
  const claude = await new ClaudeCodeAdapter({ bin: claudeBin }).run('reviewer', 't');
  assert.match(claude.text, /^local=UNSET /);
});

test('a custom local envKey is scrubbed from every other child', async () => {
  process.env.MY_LOCAL_PROVIDER_KEY = 'sk-test-custom-0123456789';
  // eslint-disable-next-line no-new
  new LocalAgentAdapter({ model: 'm', envKey: 'MY_LOCAL_PROVIDER_KEY' });
  assert.equal(childEnv().MY_LOCAL_PROVIDER_KEY, undefined);
  assert.equal(childEnv({ allow: ['MY_LOCAL_PROVIDER_KEY'] }).MY_LOCAL_PROVIDER_KEY, 'sk-test-custom-0123456789');
  const r = await runCommand({ cmd: 'sh', args: ['-c', 'echo "[$MY_LOCAL_PROVIDER_KEY]"'] });
  assert.equal(r.stdout.trim(), '[]');
});

test('the transcript never stores a key an agent printed', async () => {
  const { RunLog, callRole } = await import('../src/runlog.js');
  const { fakeParticipant } = await import('./helpers/fakes.js');
  const d = tmp();
  const log = new RunLog(d);
  const p = fakeParticipant({ name: 'x', script: () => ({ text: `env says X_API_KEY=${X_KEY}`, ok: false, error: `boom ${X_KEY}` }) });
  await callRole(log, p, 'author', `task with ${X_KEY}`, `ctx ${LOCAL_KEY}`);
  assert.ok(!p.calls[0].task.includes(X_KEY));
  assert.ok(!p.calls[0].context.includes(LOCAL_KEY));
  const raw = readFileSync(log.transcript, 'utf8');
  assert.ok(!raw.includes(X_KEY));
  assert.ok(raw.includes(REDACTED));
});
