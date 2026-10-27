// test/factory-probe.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeSsh } from './helpers/fakeSsh.js';
import { composeCmd, preflight, probeBox, VERSION_PROBE } from '../src/factory/ship/probe.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'probe-'));
const T = { host: 'acme-box', user: 'highland', port: null, keyPath: null, label: 'acme-office' };
const DEP = { bundleDir: '/opt/highland/acme', imageDelivery: 'tar' };
const VERSION_OK = JSON.stringify({ version: { app: '0.1.3', foundation: '0.1.0', commit: 'abc1234' }, ready: { status: 'ok', checks: [] } });
const RUNS_OK = JSON.stringify({ backup: { at: '2026-10-27T02:31:00+00:00', ok: true, detail: 'Backup 1a2b3c4d saved' }, backupOk: '2026-10-27T02:31:00+00:00',
  restore: { at: '2026-10-26T04:32:00+00:00', ok: false, detail: 'The newest backup is 40 hours old' }, restoreOk: '2026-10-19T04:31:00+00:00' });

test('composeCmd adds the registry sign-in folder only for registry boxes', () => {
  assert.equal(composeCmd(DEP, 'ps'), "cd '/opt/highland/acme' && docker compose ps");
  assert.equal(composeCmd({ ...DEP, imageDelivery: 'registry' }, 'ps'), `cd '/opt/highland/acme' && DOCKER_CONFIG="$PWD/.docker" docker compose ps`);
});

test('preflight explains what is missing on the box', async () => {
  const f = fakeSsh(tmp(), [{ match: 'uname -m', stdout: 'arch=x86_64\ndocker=no\ncompose=no\nmissing=setsid\ndir=yes\nwritable=no\nenv=yes\nfreekb=2202009\n' }]);
  const r = await preflight(T, { bundleDir: '/opt/highland/acme', env: f.env() });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, [
    'Docker is not working on acme-office for the user highland. Install Docker Engine, and add highland to the docker group.',
    'The Docker Compose plugin is missing on acme-office.',
    'setsid is missing on acme-office.',
    'The bundle folder /opt/highland/acme on acme-office is not writable by highland.',
    'acme-office has only 2.1 GB free where the bundle folder lives; a ship needs at least 4 GB.',
  ]);
  assert.deepEqual(r.facts, { arch: 'x86_64', freeKb: 2202009, hasDir: true, hasEnv: true, hasCompose: false });
  assert.ok(f.calls()[0].command.includes('for t in setsid sha256sum tar awk mktemp cmp; do')); // cmp: a later ship's bundle refresh
});

test('probeBox reads version, checks and backup runs; the health token never appears in any command', async () => {
  const f = fakeSsh(tmp(), [
    { match: 'entrypoint node ops', stdout: `Creating container\n${VERSION_OK}\n` },
    { match: 'run --rm -T ops check', code: 1, stdout: '✓ app\n✗ app:restore-test: The last restore test failed: The newest backup is 40 hours old\n' },
    { match: 'psql', stdout: `${RUNS_OK}\n` },
  ]);
  const s = await probeBox(T, DEP, { env: f.env() });
  assert.equal(s.reachable, true);
  assert.deepEqual(s.version, { app: '0.1.3', foundation: '0.1.0', commit: 'abc1234' });
  assert.deepEqual(s.checks, { ok: false, failing: ['app:restore-test: The last restore test failed: The newest backup is 40 hours old'] });
  assert.equal(s.runs.backup.last.ok, true);
  assert.equal(s.runs.restoreTest.lastOk.at, '2026-10-19T04:31:00+00:00');
  assert.deepEqual(s.notes, []);
  const calls = f.calls();
  assert.equal(calls[0].stdin, VERSION_PROBE);
  for (const c of calls) assert.doesNotMatch(c.command, /HEALTH_TOKEN|x-health-token/);
});

test('a broken box is reported part by part, never thrown', async () => {
  const f = fakeSsh(tmp(), [
    { match: 'entrypoint node ops', code: 1, stderr: 'Error response from daemon: No such image: highland/ops:0.1.3\n' },
    { match: 'ops check', code: 1, stderr: 'No such image' , stdout: '' },
    { match: 'psql', code: 1, stderr: 'service "db" is not running' },
  ]);
  const s = await probeBox(T, DEP, { env: f.env() });
  assert.equal(s.reachable, true);
  assert.equal(s.version, null);
  assert.equal(s.runs, null);
  assert.match(s.notes[0], /^The app's version could not be read on the box \(the ops container did not run: Error response from daemon: No such image/);
  assert.ok(s.notes.some((n) => /backup records could not be read/.test(n)));
});

test('no foundation version (health token missing) is a note', async () => {
  const f = fakeSsh(tmp(), [{ match: 'entrypoint node ops', stdout: JSON.stringify({ version: { app: '0.1.3' }, ready: { status: 'degraded' } }) }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS_OK }]);
  const s = await probeBox(T, DEP, { env: f.env() });
  assert.deepEqual(s.version, { app: '0.1.3', foundation: null, commit: null });
  assert.ok(s.notes.some((n) => /did not give its full version details/.test(n)));
});

test('an unreachable box stops after the first call', async () => {
  const f = fakeSsh(tmp(), [{ match: '.', code: 255, stderr: 'ssh: Could not resolve hostname acme-box\n' }]);
  const s = await probeBox(T, DEP, { env: f.env() });
  assert.equal(s.reachable, false);
  assert.match(s.problem, /^Could not reach acme-office over SSH/);
  assert.equal(f.calls().length, 1);
});

test('preflight reports an unreachable box alone, and unreadable free space as a problem', async () => {
  const f = fakeSsh(tmp(), [{ match: '.', code: 255, stderr: 'ssh: connect refused\n' }]);
  const r = await preflight(T, { bundleDir: '/opt/highland/acme', env: f.env() });
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^Could not reach acme-office/);
  const g = fakeSsh(tmp(), [{ match: 'uname -m', stdout: 'arch=aarch64\ndocker=yes\ncompose=yes\ndir=no\n' }]);
  const r2 = await preflight(T, { bundleDir: '/opt/highland/acme', env: g.env() });
  assert.equal(r2.ok, false);
  assert.match(r2.problems[0], /did not say how much disk space/);
});

test('registry boxes get the sign-in folder on every compose call; unsafe paths are refused', async () => {
  const f = fakeSsh(tmp(), [{ match: 'entrypoint node ops', stdout: VERSION_OK }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS_OK }]);
  await probeBox(T, { ...DEP, imageDelivery: 'registry' }, { env: f.env() });
  for (const c of f.calls()) assert.match(c.command, /DOCKER_CONFIG="\$PWD\/\.docker" docker compose/);
  assert.throws(() => composeCmd({ ...DEP, bundleDir: "/opt/x'; rm -rf /" }, 'ps'), /unsafe path/);
});

test('a check run that printed nothing is unknown, not healthy', async () => {
  const f = fakeSsh(tmp(), [{ match: 'entrypoint node ops', stdout: VERSION_OK }, { match: 'ops check', code: 1, stderr: 'boom' }, { match: 'psql', stdout: RUNS_OK }]);
  const s = await probeBox(T, DEP, { env: f.env() });
  assert.equal(s.checks, null);
  assert.ok(s.notes.some((n) => /checks could not run \(code 1\)/.test(n)));
});
