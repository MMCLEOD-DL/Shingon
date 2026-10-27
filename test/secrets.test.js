// test/secrets.test.js — C1: keys are scrubbed at the source and redacted at every exit.
// Fake keys only; never a real credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { childEnv, redact, secretValues, SCRUB_ENV, REDACTED, rememberSecret, forgetRememberedSecrets } from '../src/secrets.js';
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
  const t = await ws.runTests('echo "local=[$LOCALAI_API_KEY] x=[$X_API_KEY]"', {});
  assert.match(t.output, /local=\[\]/);
  assert.match(t.output, /x=\[\]/); // N2: every secret-named var is dropped from the test env
  assert.ok(!t.output.includes(X_KEY));
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

test('a local envKey that is a frontier auth key is never scrubbed (frontier CLIs keep working)', () => {
  process.env.OPENAI_API_KEY = 'sk-test-openai-0123456789';
  // eslint-disable-next-line no-new
  new LocalAgentAdapter({ model: 'm', envKey: 'OPENAI_API_KEY' });
  assert.ok(!SCRUB_ENV.includes('OPENAI_API_KEY'));
  assert.equal(childEnv().OPENAI_API_KEY, 'sk-test-openai-0123456789');
});

test('the test command gets no secret-named vars; frontier CLIs keep their keys (N2)', async () => {
  process.env.GH_TOKEN = 'ghp_test0123456789';
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: tmp(), taskId: 't' });
  await ws.runTests('printf "%s" "$ANTHROPIC_API_KEY" > leaked.txt; printf "%s" "$GH_TOKEN" >> leaked.txt', {});
  const { readFileSync: rf } = await import('node:fs');
  const leaked = rf(path.join(ws.dir, 'leaked.txt'), 'utf8');
  assert.ok(!leaked.includes('sk-test-anthropic-0123456789'));
  assert.equal(leaked, '');
  assert.equal(childEnv().ANTHROPIC_API_KEY, 'sk-test-anthropic-0123456789');
  const { strictChildEnv } = await import('../src/secrets.js');
  assert.equal(strictChildEnv().ANTHROPIC_API_KEY, undefined);
  assert.equal(strictChildEnv().LOCALAI_API_KEY, undefined);
  assert.ok(strictChildEnv().PATH);
});

test('final-fix 2: TEST_DATABASE_URL and its password are redacted, but the test command still gets the URL', async () => {
  const { strictChildEnv } = await import('../src/secrets.js');
  const url = 'postgres://hf_test:p%40ss-w0rd-long@127.0.0.1/postgres';
  const values = secretValues({ TEST_DATABASE_URL: url });
  assert.ok(values.includes(url));
  assert.ok(values.includes('p@ss-w0rd-long'), 'the decoded password');
  assert.ok(values.includes('p%40ss-w0rd-long'), 'the password as written in the URL');
  assert.deepEqual(secretValues({ TEST_DATABASE_URL: 'postgres://hf_test:short@127.0.0.1/postgres' }), ['postgres://hf_test:short@127.0.0.1/postgres'], 'a short password is not a secret value on its own');
  assert.deepEqual(secretValues({ TEST_DATABASE_URL: 'not a url but long enough' }), ['not a url but long enough']);
  const before = process.env.TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = url;
  try {
    assert.equal(strictChildEnv().TEST_DATABASE_URL, url, 'the tests need the URL');
    const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: tmp(), taskId: 'db' });
    const r = await ws.runTests('echo "connect failed $TEST_DATABASE_URL"; echo "password p@ss-w0rd-long"; exit 1');
    assert.equal(r.passed, false);
    assert.ok(!r.output.includes('p@ss-w0rd-long'), r.output);
    assert.ok(!r.output.includes('p%40ss-w0rd-long'), r.output);
    assert.match(r.output, /connect failed \[redacted\]/);
  } finally {
    if (before === undefined) delete process.env.TEST_DATABASE_URL; else process.env.TEST_DATABASE_URL = before;
  }
});

test('a remembered secret is redacted everywhere, whatever env var it came from', () => {
  rememberSecret('hunter2-matrix-token');
  rememberSecret('abc'); // too short to redact safely: ignored
  rememberSecret('short12'); // under MIN_SECRET_LENGTH (8): ignored
  try {
    assert.equal(redact('token=hunter2-matrix-token'), 'token=[redacted]');
    assert.ok(secretValues({}).includes('hunter2-matrix-token'));
    assert.ok(!secretValues({}).includes('abc'));
    assert.ok(!secretValues({}).includes('short12'));
  } finally { forgetRememberedSecrets(); }
  assert.equal(redact('hunter2-matrix-token', secretValues({})), 'hunter2-matrix-token');
});
