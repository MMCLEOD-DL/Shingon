import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseSmokeLog, runSmoke, pushCommit, cleanSmoke, SMOKE_STEPS, SmokeError } from '../src/council/smoke.js';
import { fakeMachine, fakeSsh } from './helpers/councilFull.js';
import { makeRepo } from './helpers/gitRepo.js';
import { stubDockerPath } from './helpers/stubDocker.js';

const log = (f) => readFileSync(new URL(`./fixtures/council-full/${f}`, import.meta.url), 'utf8');
const REMOTE = '/srv/hf-factory/runs/acme-r1/smoke-app';

test('a passing smoke: every step ok, in order', () => {
  const r = parseSmokeLog(log('smoke-passed.log'), 0);
  assert.equal(r.passed, true);
  assert.deepEqual(r.steps.map((s) => [s.n, s.ok]), [['1', true], ['2', true], ['3', true], ['4', true], ['5', true], ['6', true], ['6a', true], ['7', true], ['8', true], ['9', true], ['secrets', true], ['10', false]]);
  assert.equal(SMOKE_STEPS['7'], 'stop the app: an alert is sent, then Fixed');
});

test('a failed step: which one, and the FAILED line', () => {
  const r = parseSmokeLog(log('smoke-failed-step5.log'), 1);
  assert.deepEqual([r.passed, r.failedStep, r.failure, r.refused], [false, '5', 'restore-test: Restore test failed: 2 tables differ', null]);
  assert.match(r.tail, /SMOKE FAILED during: step 5/);
});

test('a refusal (exit 2 before any step) is not a failure of the app', () => {
  const r = parseSmokeLog(log('smoke-refused-images.log'), 2);
  assert.equal(r.failedStep, null);
  assert.match(r.refused, /^This machine already has highland\/app or highland\/ops images/);
});

test('timed out, or a failure with no FAILED line', () => {
  const t = parseSmokeLog('== Step 1: build\n', 124, { timedOut: true });
  assert.deepEqual([t.passed, t.timedOut, t.failedStep], [false, true, '1']);
  const u = parseSmokeLog('== Step 3: make the bundle\nsomething odd\n', 1);
  assert.deepEqual([u.failedStep, u.failure], ['3', 'the step stopped without saying why (exit code 1)']);
});

test('the secrets step can be the one that failed', () => {
  const r = parseSmokeLog('== Secrets: none\n   FAILED: DB_PASSWORD appears in the alerts or logs\nSMOKE FAILED during: secrets check (exit 1). Cleaning up.\n', 1);
  assert.deepEqual([r.failedStep, r.failure], ['secrets', 'DB_PASSWORD appears in the alerts or logs']);
});

test('pushCommit uploads exactly that commit and unpacks it in the run folder', async () => {
  const repo = await makeRepo({ 'a.txt': 'one\n' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  const { ssh, calls } = fakeSsh([{ match: 'tar -x', stdout: '' }]);
  await pushCommit({ ssh, machine: fakeMachine(), dir: repo, sha, remoteDir: REMOTE, timeoutMs: 5000 });
  assert.deepEqual(calls.map((c) => c.kind), ['upload', 'exec']);
  assert.equal(calls[0].remotePath, '/srv/hf-factory/runs/acme-r1/smoke-app.tar');
  assert.ok(calls[0].bytes > 0);
  assert.equal(existsSync(calls[0].localFile), false, 'the local temp folder is removed');
  assert.match(calls[1].script, /tar -x -C '\/srv\/hf-factory\/runs\/acme-r1\/smoke-app' -f '\/srv\/hf-factory\/runs\/acme-r1\/smoke-app\.tar'/);
  const bad = fakeSsh([{ match: 'tar -x', code: 255, stderr: 'ssh: connect to host 192.168.1.111 port 22: No route to host' }]);
  await assert.rejects(pushCommit({ ssh: bad.ssh, machine: fakeMachine(), dir: repo, sha, remoteDir: REMOTE, timeoutMs: 5000 }),
    (e) => e instanceof SmokeError && e.kind === 'unreachable' && e.message === 'Conductor could not reach the test machine 192.168.1.111 over SSH.');
  const full = fakeSsh([{ match: 'tar -x', code: 2, stderr: 'tar: short read' }]);
  await assert.rejects(pushCommit({ ssh: full.ssh, machine: fakeMachine(), dir: repo, sha, remoteDir: REMOTE, timeoutMs: 5000 }),
    (e) => e.kind === 'failed' && e.message === 'The app could not be copied to the test machine 192.168.1.111.');
  await assert.rejects(pushCommit({ ssh, machine: fakeMachine(), dir: repo, sha: 'nope', remoteDir: REMOTE, timeoutMs: 5000 }), (e) => e.kind === 'failed');
  await assert.rejects(pushCommit({ ssh, machine: fakeMachine(), dir: repo, sha, remoteDir: "/x/$(id)", timeoutMs: 5000 }), /unsafe path/);
});

test('runSmoke: pre-clean, the app\'s own smoke, the exit line; cleanSmoke removes only the run folder', async () => {
  const { ssh, calls } = fakeSsh([{ match: 'run-smoke.sh', stdout: log('smoke-passed.log') }, { match: 'rm -rf', stdout: '' }]);
  const r = await runSmoke({ ssh, machine: fakeMachine(), remoteDir: REMOTE, timeoutMs: 3600000 });
  assert.equal(r.passed, true);
  assert.equal(r.ran, true);
  const script = calls[0].script;
  assert.match(script, /export SMOKE_SECONDS='3300'/);
  assert.match(script, /label=com\.docker\.compose\.project=hfsmoke/);
  assert.match(script, /docker rm -f hf-smoke-rest/);
  assert.match(script, /bash deploy\/smoke\/run-smoke\.sh/);
  assert.equal(await cleanSmoke({ ssh, machine: fakeMachine(), remoteDir: REMOTE }), null);
  assert.match(calls.at(-1).script, /rm -rf '\/srv\/hf-factory\/runs\/acme-r1\/smoke-app'/);
  await assert.rejects(cleanSmoke({ ssh, machine: fakeMachine(), remoteDir: '/etc' }), /outside the machine's run folder/);
  await assert.rejects(cleanSmoke({ ssh, machine: fakeMachine(), remoteDir: '/srv/hf-factory/runs/acme-r1/../x' }), /outside the machine's run folder|unsafe path/);
});

test('runSmoke: SMOKE_SECONDS is the timeout minus 5 minutes, at least 60', async () => {
  const a = fakeSsh([]);
  await runSmoke({ ssh: a.ssh, machine: fakeMachine(), remoteDir: REMOTE, timeoutMs: 120000 });
  assert.match(a.calls[0].script, /export SMOKE_SECONDS='60'/);
});

test('runSmoke: unreachable, refused, timed out', async () => {
  const dead = fakeSsh([{ match: 'run-smoke.sh', code: 255, stderr: 'ssh: connect to host 192.168.1.111 port 22: Connection refused' }]);
  await assert.rejects(runSmoke({ ssh: dead.ssh, machine: fakeMachine(), remoteDir: REMOTE, timeoutMs: 900000 }), (e) => e.kind === 'unreachable');
  const refused = fakeSsh([{ match: 'run-smoke.sh', stdout: 'COUNCIL-REFUSED This app has no deploy/smoke/run-smoke.sh (it was not built from the foundation).\n', code: 3 }]);
  const r = await runSmoke({ ssh: refused.ssh, machine: fakeMachine(), remoteDir: REMOTE, timeoutMs: 900000 });
  assert.deepEqual([r.ran, r.passed, r.refused], [false, false, 'This app has no deploy/smoke/run-smoke.sh (it was not built from the foundation).']);
  const slow = fakeSsh([{ match: 'run-smoke.sh', stdout: '== Step 1: build\n', code: -1 }]);
  const t = await runSmoke({ ssh: slow.ssh, machine: fakeMachine(), remoteDir: REMOTE, timeoutMs: 900000 });
  assert.deepEqual([t.timedOut, t.failedStep, t.passed], [true, '1', false]);
  const t2 = await runSmoke({ ssh: fakeSsh([{ match: 'run-smoke.sh', stdout: '== Step 2: x\nCOUNCIL-SMOKE-EXIT 124\n' }]).ssh, machine: fakeMachine(), remoteDir: REMOTE, timeoutMs: 900000 });
  assert.equal(t2.timedOut, true);
});

// Runs the generated script locally under bash with the stub docker (never real docker or ssh).
function runLocally(script, { ps = '', root }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'smoke-stub-'));
  const { binDir, logFile } = stubDockerPath(path.join(dir, 'bin'), { ps, volumes: 'vol1\n', networks: 'net1\n' });
  const r = spawnSync('bash', ['-s'], { input: script, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }, encoding: 'utf8' });
  return { ...r, docker: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '' };
}

test('the generated script, run locally: cleans only the smoke\'s own names, then runs the app\'s smoke', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'smoke-app-'));
  mkdirSync(path.join(root, 'deploy', 'smoke'), { recursive: true });
  writeFileSync(path.join(root, 'deploy', 'smoke', 'run-smoke.sh'), 'echo "== Step 1: x"; echo "   ok: y"; echo "bind=$HF_SMOKE_BIND"; exit 0\n');
  const { ssh, calls } = fakeSsh([]);
  await runSmoke({ ssh, machine: fakeMachine(), remoteDir: root, timeoutMs: 900000 });
  const r = runLocally(calls[0].script, { ps: 'abc\n', root });
  assert.match(r.stdout, /bind=127\.0\.0\.1/);
  assert.match(r.stdout, /COUNCIL-SMOKE-EXIT 0/);
  assert.match(r.docker, /ps -aq --filter label=com\.docker\.compose\.project=hfsmoke/);
  assert.match(r.docker, /rm -f hf-smoke-rest/);
  assert.doesNotMatch(r.docker, /rmi|prune|system/);
  const parsed = parseSmokeLog(r.stdout, 0);
  assert.equal(parsed.steps[0].ok, true);
});

test('the generated script, run locally: no run-smoke.sh refuses with exit 3', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'smoke-app-'));
  const { ssh, calls } = fakeSsh([]);
  await runSmoke({ ssh, machine: fakeMachine(), remoteDir: root, timeoutMs: 900000 });
  const r = runLocally(calls[0].script, { root });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /^COUNCIL-REFUSED This app has no deploy\/smoke\/run-smoke\.sh/m);
});
