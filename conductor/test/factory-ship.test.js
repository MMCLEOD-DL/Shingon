// test/factory-ship.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fakeSsh } from './helpers/fakeSsh.js';
import { scriptedAsk } from './helpers/scriptedAsk.js';
import { makeShipProject, fakeProvider, shipRules, releaseNext, TEST_BRIEF, RUN_ID } from './helpers/shipProject.js';
import { shipProject, updateDeployment, NO_TTY_FIRST, interruptShip, saveLostContact, UPDATE_OUTCOMES } from '../src/factory/ship/index.js';
import { shipCommand } from '../src/cli/factoryShip.js';
import { factoryConfig } from '../src/factory/config.js';
import { loadDeployment, saveDeployment, lockDeployment, listDeployments } from '../src/factory/deployments/store.js';
import { forgetRememberedSecrets } from '../src/secrets.js';
import { deploymentStatus } from '../src/factory/ship/status.js';

const PW = 'Zq3-backup-password-from-ops-init_xyz';
const SECRETS = [PW, 'mailpass-9!', 'syt_matrix_token_1', 'kuma-push-token-77', 'cf-tunnel-token-value-88', 'tok_one_time_123'];
const FIRST_ANSWERS = [
  'acme-box', '', '', '', 't', 'https://staff.acme.co.uk', 'f',                                      // basics
  'smtp://u:mailpass-9!@smtp.acme.co.uk:587', 'hr@acme.co.uk', 'sftp:bk@backup.acme.co.uk:/srv/hf', true, // mail, backup
  'm', '', '', 'syt_matrix_token_1', '', 'https://kuma.example.org/api/push/kuma-push-token-77', 'cf-tunnel-token-value-88',
  'saved', true, 'jo@acme.co.uk', 'Jo Bloggs',
];
const factoryFor = (p) => {
  const f = factoryConfig({ factory: { projectsRoot: p.projectsRoot, alerts: { matrix: { homeserver: 'https://m.example.org', roomId: '!a:example.org' } } } }, { env: {}, home: p.projectsRoot });
  return { ...f, ship: { ...f.ship, pollMs: 1, startTimeoutMs: 1000, updateTimeoutMs: 5000 } };
};

function ship(p, f, answers, extra = {}) {
  const ask = extra.ask ?? scriptedAsk(answers);
  let out = '';
  ask.say = ask.sayOnce = (t) => { out += `${t}\n`; };
  const provider = extra.provider ?? fakeProvider();
  return shipProject({ factory: factoryFor(p), slug: 'acme', name: 'acme-office', ask, env: f.env(), runId: extra.runId ?? RUN_ID,
    sleep: async () => {}, state: {}, deps: { provider, loadBrief: async () => TEST_BRIEF } })
    .then((r) => ({ ...r, out, provider }));
}

test('a first ship sets the box up end to end and no secret reaches any file or command line', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  const r = await ship(p, f, FIRST_ANSWERS);
  assert.equal(r.exit, 0, r.text);
  const dep = loadDeployment(p.projectDir, 'acme-office');
  assert.equal(dep.setup.step, 'done');
  assert.equal(dep.currentVersion, '0.1.3');
  assert.equal(dep.foundation, 'v0.1.0'); // from project.json.foundation.tag
  assert.equal(JSON.parse(readFileSync(path.join(p.projectDir, 'project.json'), 'utf8')).status, 'shipped'); // Contract 7.5: at least one deployment installed
  assert.equal(r.provider.released(), 1);
  assert.equal(r.provider.acquired()[0].purpose, 'ship');
  const files = [path.join(p.projectDir, 'deployments', 'acme-office.json'),
    ...readdirSync(path.join(p.projectDir, 'deployments', 'logs')).map((n) => path.join(p.projectDir, 'deployments', 'logs', n))];
  assert.ok(files.some((file) => file.endsWith(`acme-office-${RUN_ID}.txt`)));
  for (const file of files) for (const s of SECRETS) assert.ok(!readFileSync(file, 'utf8').includes(s), `${s} in ${file}`);
  for (const c of f.calls()) for (const s of SECRETS) assert.ok(!c.argv.join('\u0000').includes(s), `${s} in argv`);
  assert.equal(r.out.split(PW).length - 1, 1);
  assert.equal(r.out.split('tok_one_time_123').length - 1, 1);
  for (const s of SECRETS.slice(1, 5)) assert.ok(!r.out.includes(s), `${s} on screen`);
});

test('without a terminal a first ship refuses before any SSH call, machine or release', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d, { released: false });
  const f = fakeSsh(d, shipRules(d));
  const ask = scriptedAsk([]); ask.isTTY = false;
  const r = await ship(p, f, [], { ask });
  assert.deepEqual([r.exit, r.text], [1, NO_TTY_FIRST]);
  assert.equal(f.calls().length, 0);
  assert.equal(r.provider.acquired().length, 0);
  assert.equal(execFileSync('git', ['-C', p.appDir, 'tag', '--list', 'v1.0.0'], { encoding: 'utf8' }), '');
});

test('a later ship goes through the safe update', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  assert.equal((await ship(p, f, FIRST_ANSWERS)).exit, 0);
  releaseNext(p, '0.1.4');
  f.setRules([...shipRules(d, { version: '0.1.4' }),
    { match: 'exit=running', stdout: 'exit=0\n[Acme Ltd] Updated from 0.1.3 to 0.1.4. A backup (1a2b3c4d) was taken first.\n' },
    { match: 'for f in compose.yaml Caddyfile', stdout: 'same=compose.yaml\nsame=Caddyfile\n' }]);
  const r = await ship(p, f, [], { runId: '20261027-110000-b2c3' });
  assert.equal(r.exit, 0, r.text);
  assert.match(r.text, /acme-office is now on 0\.1\.4/);
  assert.ok(f.calls().some((c) => c.command.includes('updater update --to')));
  assert.equal(loadDeployment(p.projectDir, 'acme-office').currentVersion, '0.1.4');
});

test('updateDeployment: the safe update for Plan 11, and its refusals', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  assert.equal((await ship(p, f, FIRST_ANSWERS)).exit, 0);
  const ctx = { factory: factoryFor(p), provider: fakeProvider(), env: f.env(), sleep: async () => {} };
  const args = { projectDir: p.projectDir, name: 'acme-office', foundation: 'v0.1.1', runId: '20261027-120000-c3d4' };
  assert.deepEqual(await updateDeployment({ ...args, version: '0.1.3' }, ctx), { outcome: 'already-on', message: 'acme-office is already on 0.1.3. Nothing was done.' });
  assert.match((await updateDeployment({ ...args, version: '0.1.9' }, ctx)).message, /There is no release v0\.1\.9 on the app's main branch/);
  assert.equal((await updateDeployment({ ...args, version: '0.1.4', runId: 'change-1' }, ctx)).outcome, 'refused');
  releaseNext(p, '0.1.4');
  f.setRules([...shipRules(d, { version: '0.1.4' }),
    { match: 'exit=running', stdout: 'exit=0\n[Acme Ltd] Updated from 0.1.3 to 0.1.4. A backup (1a2b3c4d) was taken first.\n' },
    { match: 'for f in compose.yaml Caddyfile', stdout: 'same=compose.yaml\nsame=Caddyfile\n' }]);
  const r = await updateDeployment({ ...args, version: '0.1.4' }, ctx);
  assert.equal(r.outcome, 'updated', r.message);
  const dep = loadDeployment(p.projectDir, 'acme-office');
  assert.deepEqual([dep.currentVersion, dep.foundation, dep.history.at(-1).outcome], ['0.1.4', 'v0.1.1', 'updated']);
});

test('refusals that touch nothing: already on, pending check', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  assert.equal((await ship(p, f, FIRST_ANSWERS)).exit, 0);
  const n = f.calls().length;
  const again = await ship(p, f, []);
  assert.deepEqual([again.exit, again.text], [1, 'acme-office is already on 0.1.3. There is nothing new to ship.']);
  const dep = loadDeployment(p.projectDir, 'acme-office');
  saveDeployment(p.projectDir, { ...dep, pendingCheck: { since: 't', version: '0.1.4', foundation: 'v0.1.0', why: 'lost-contact' } });
  releaseNext(p, '0.1.4');
  assert.match((await ship(p, f, [])).text, /^The last update to acme-office \(0\.1\.4\) ended without Conductor seeing the result\. Run conductor deployments status first/);
  assert.equal(f.calls().length, n);
});

test('a box of a different architecture is refused after the build, and the build machine is cleaned up', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, [{ host: 'acme-box', match: 'uname -m', stdout: 'arch=aarch64\ndocker=yes\ncompose=yes\ndir=no\nfreekb=99999999\n' }, ...shipRules(d)]);
  const r = await ship(p, f, FIRST_ANSWERS);
  assert.equal(r.exit, 1);
  assert.equal(r.text, 'The box is aarch64 but the app was built for x86_64. Conductor cannot ship to this box.');
  assert.equal(r.provider.released(), 1);
  assert.ok(f.calls().some((c) => c.host === 'hf-build' && c.command.startsWith("docker rmi 'highland/app:0.1.3' 'highland/ops:0.1.3'")));
});

// ---- Task 10 additions beyond the brief's tests ----

test('a later ship unpacks the new bundle on the box before the update, so refreshBundleFiles finds it', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  assert.equal((await ship(p, f, FIRST_ANSWERS)).exit, 0);
  releaseNext(p, '0.1.4');
  f.setRules([...shipRules(d, { version: '0.1.4' }),
    { match: 'exit=running', stdout: 'exit=0\n[Acme Ltd] Updated from 0.1.3 to 0.1.4. A backup (1a2b3c4d) was taken first.\n' },
    { match: 'for f in compose.yaml Caddyfile', stdout: 'same=compose.yaml\nsame=Caddyfile\n' }]);
  const n = f.calls().length;
  const runId = '20261027-110000-b2c3';
  const r = await ship(p, f, [], { runId });
  assert.equal(r.exit, 0, r.text);
  const cmds = f.calls().slice(n).map((c) => c.command);
  const unpack = cmds.findIndex((c) => c.includes("tar -xzf '/opt/highland/acme/.conductor/highland-bundle-0.1.4.tar.gz' -C '/opt/highland/acme/.conductor/bundle-0.1.4'"));
  const start = cmds.findIndex((c) => c.includes('setsid nohup sh -c'));
  const refresh = cmds.findIndex((c) => c.includes('for f in compose.yaml Caddyfile'));
  assert.ok(unpack >= 0 && unpack < start && start < refresh, `order: unpack ${unpack}, start ${start}, refresh ${refresh}`);
  const log = readFileSync(path.join(p.projectDir, 'deployments', 'logs', `acme-office-${runId}.txt`), 'utf8');
  assert.match(log, /^Shipping 0\.1\.4 of acme to acme-office \(run 20261027-110000-b2c3\)\.$/m);
  assert.match(log, /acme-office is now on 0\.1\.4/);
  assert.equal(r.provider.released(), 1);
});

test('updateDeployment refuses plainly: busy, missing, unfinished setup, no build machine configured', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  const base = { projectDir: p.projectDir, version: '0.1.4', foundation: 'v0.1.0', runId: '20261027-120000-c3d4' };
  const ctx = { factory: factoryFor(p), provider: fakeProvider(), env: f.env(), sleep: async () => {} };
  assert.deepEqual(await updateDeployment({ ...base, name: 'acme-office' }, ctx),
    { outcome: 'refused', message: 'There is no deployment called acme-office for this project.' });
  assert.equal((await updateDeployment({ ...base, name: 'Acme Office' }, ctx)).outcome, 'refused');
  assert.equal((await updateDeployment({ ...base, name: 'acme-office', version: '0.1.4-rc.1' }, ctx)).outcome, 'refused');
  assert.equal((await updateDeployment({ ...base, name: 'acme-office', foundation: '0.1.0' }, ctx)).outcome, 'refused');
  assert.equal((await ship(p, f, FIRST_ANSWERS)).exit, 0);
  const held = lockDeployment(p.projectDir, 'acme-office');
  assert.deepEqual(await updateDeployment({ ...base, name: 'acme-office' }, ctx), { outcome: 'busy', message: 'Another ship to acme-office is already running.' });
  held.release();
  const dep = loadDeployment(p.projectDir, 'acme-office');
  saveDeployment(p.projectDir, { ...dep, setup: { step: 'configured', at: 't' } });
  assert.match((await updateDeployment({ ...base, name: 'acme-office' }, ctx)).message,
    /^First-time setup of acme-office is not finished, so it cannot be updated\. Run: conductor ship acme --to acme-office$/);
  saveDeployment(p.projectDir, dep);
  releaseNext(p, '0.1.4');
  // Ruling S8: no provider passed and no machines configured → a plain refusal, nothing recorded, the box untouched by an update.
  const noMachines = { ...ctx, provider: undefined };
  const r = await updateDeployment({ ...base, name: 'acme-office' }, noMachines);
  assert.equal(r.outcome, 'refused');
  assert.match(r.message, /No factory machines are set up/);
  assert.equal(loadDeployment(p.projectDir, 'acme-office').history.length, dep.history.length);
  assert.ok(!f.calls().some((c) => c.command.includes('updater update')));
  assert.ok(UPDATE_OUTCOMES.includes('refused') && UPDATE_OUTCOMES.length === 9);
});

test('interruptShip records a pending check only while updating, and always lets go of the lock', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const lock = lockDeployment(p.projectDir, 'acme-office');
  const state = { phase: 'building', projectDir: p.projectDir, lock, dep: null, version: '0.1.4', foundation: 'v0.1.0' };
  assert.equal(interruptShip(state), 'Stopped. Steps already finished on the box are recorded; run the same command to carry on.');
  const again = lockDeployment(p.projectDir, 'acme-office');
  assert.ok(again, 'the lock was released');
  const live = { schema: 1, name: 'acme-office', project: 'acme', host: 'acme-box', ssh: { user: 'highland', port: null, keyPath: null },
    bundleDir: '/opt/highland/acme', hosting: 'client-box', imageDelivery: 'tar', registry: null, access: 'cloudflare-tunnel',
    origin: 'https://staff.acme.co.uk', site: ':80', alerts: { matrix: null, webhook: false, heartbeat: false },
    setup: { step: 'done', at: 't' }, currentVersion: '0.1.3', foundation: 'v0.1.0', bundleVersion: '0.1.3', pendingCheck: null, lastStatus: null, history: [] };
  saveDeployment(p.projectDir, live);
  const s2 = { phase: 'updating', projectDir: p.projectDir, lock: again, dep: live, version: '0.1.4', foundation: 'v0.1.1' };
  assert.equal(interruptShip(s2), 'Stopped watching. The update carries on by itself on the box. Run conductor deployments status to see how it ended.');
  const pc = loadDeployment(p.projectDir, 'acme-office').pendingCheck;
  assert.deepEqual([pc.version, pc.foundation, pc.why], ['0.1.4', 'v0.1.1', 'interrupted']);
  assert.ok(lockDeployment(p.projectDir, 'acme-office'), 'the lock was released');
});

test('conductor ship: without a terminal the CLI prints the refusal itself, and Ctrl-C ends with 130', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  let out = '';
  let handler = null;
  let exited = null;
  const ctx = { stdin: new PassThrough(), stdout: { write: (s) => { out += s; } }, isTTY: false, env: f.env(),
    onSignal: (h) => { handler = h; }, exit: (c) => { exited = c; }, factory: factoryFor(p), config: null,
    deps: { ship: { provider: fakeProvider(), loadBrief: async () => TEST_BRIEF } } };
  const code = await shipCommand({ command: 'ship', slug: 'acme', to: 'acme-office', flags: {} }, ctx);
  assert.equal(code, 1);
  assert.equal(out, `${NO_TTY_FIRST}\n`);
  assert.equal(f.calls().length, 0);
  handler();
  assert.equal(exited, 130);
  assert.match(out, /Stopped\. Steps already finished on the box are recorded/);
});

// ---- Final-wave fixes (items 1, 3 and 4) ----

const UPDATE_OK = [{ match: 'exit=running', stdout: 'exit=0\n[Acme Ltd] Updated from 0.1.3 to 0.1.4. A backup (1a2b3c4d) was taken first.\n' },
  { match: 'for f in compose.yaml Caddyfile', stdout: 'same=compose.yaml\nsame=Caddyfile\n' }];

test('an unexpected throw while updating saves a lost-contact pending check with the run id (updateDeployment)', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  assert.equal((await ship(p, f, FIRST_ANSWERS)).exit, 0);
  releaseNext(p, '0.1.4');
  f.setRules([...shipRules(d, { version: '0.1.4' }), ...UPDATE_OK]);
  const runId = '20261027-120000-c3d4';
  const say = (s) => { if (s.startsWith('Updating ')) throw new Error('the terminal went away'); };
  const r = await updateDeployment({ projectDir: p.projectDir, name: 'acme-office', version: '0.1.4', foundation: 'v0.1.1', runId },
    { factory: factoryFor(p), provider: fakeProvider(), env: f.env(), sleep: async () => {}, say });
  assert.equal(r.outcome, 'lost-contact');
  assert.match(r.message, /^Conductor stopped unexpectedly while updating acme-office \(the terminal went away\)\. The update may carry on by itself/);
  const dep = loadDeployment(p.projectDir, 'acme-office');
  assert.deepEqual([dep.pendingCheck.why, dep.pendingCheck.version, dep.pendingCheck.foundation, dep.pendingCheck.runId], ['lost-contact', '0.1.4', 'v0.1.1', runId]);
  assert.equal(dep.history.at(-1).outcome, 'lost-contact');
  assert.equal(dep.currentVersion, '0.1.3');
});

test('an unexpected throw while updating saves a lost-contact pending check (conductor ship)', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  assert.equal((await ship(p, f, FIRST_ANSWERS)).exit, 0);
  releaseNext(p, '0.1.4');
  f.setRules([...shipRules(d, { version: '0.1.4' }), ...UPDATE_OK]);
  const runId = '20261027-110000-b2c3';
  const ask = scriptedAsk([]);
  const r = await shipProject({ factory: factoryFor(p), slug: 'acme', name: 'acme-office', env: f.env(), runId, sleep: async () => {}, state: {},
    ask: { ...ask, say: (s) => { if (s.startsWith('Updating ')) throw new Error('the terminal went away'); }, sayOnce: () => {} },
    deps: { provider: fakeProvider(), loadBrief: async () => TEST_BRIEF } });
  assert.equal(r.exit, 2);
  const pc = loadDeployment(p.projectDir, 'acme-office').pendingCheck;
  assert.deepEqual([pc.why, pc.version, pc.foundation, pc.runId], ['lost-contact', '0.1.4', 'v0.1.0', runId]);
});

test('S22: the record left by a throw at "Updating" clears as cancelled once status sees the update never started', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  assert.equal((await ship(p, f, FIRST_ANSWERS)).exit, 0);
  releaseNext(p, '0.1.4');
  f.setRules([...shipRules(d, { version: '0.1.4' }), ...UPDATE_OK]);
  const runId = '20261027-130000-d4e5';
  const say = (s) => { if (s.startsWith('Updating ')) throw new Error('the terminal went away'); };
  await updateDeployment({ projectDir: p.projectDir, name: 'acme-office', version: '0.1.4', foundation: 'v0.1.1', runId },
    { factory: factoryFor(p), provider: fakeProvider(), env: f.env(), sleep: async () => {}, say });
  assert.equal(loadDeployment(p.projectDir, 'acme-office').pendingCheck.why, 'lost-contact');
  const RUNS = JSON.stringify({ backup: { at: '2026-10-27T02:31:00Z', ok: true, detail: 'ok' }, backupOk: '2026-10-27T02:31:00Z',
    restore: { at: '2026-10-26T04:31:00Z', ok: true, detail: 'ok' }, restoreOk: '2026-10-26T04:31:00Z' });
  f.setRules([{ match: `update-${runId}\\.exit`, stdout: 'exit=none\n' },
    { match: 'entrypoint node ops', stdout: JSON.stringify({ version: { app: '0.1.3', foundation: 'v0.1.0', commit: 'c' }, ready: { status: 'ok' } }) },
    { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }]);
  const entry = listDeployments(path.dirname(p.projectDir)).find((e) => e.name === 'acme-office');
  await deploymentStatus(entry, { foundation: { ok: true, version: '0.1.0', changelog: '' }, env: f.env() });
  const dep = loadDeployment(p.projectDir, 'acme-office');
  assert.equal(dep.pendingCheck, null);
  assert.equal(dep.currentVersion, '0.1.3');
  assert.equal(dep.history.at(-1).outcome, 'cancelled');
  assert.match(dep.history.at(-1).detail, /the update never started on the box/);
});

test('S22: saveLostContact never overwrites a check it did not start (no in-progress check for this run on record)', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const live = { schema: 1, name: 'acme-office', project: 'acme', host: 'acme-box', ssh: { user: 'highland', port: null, keyPath: null },
    bundleDir: '/opt/highland/acme', hosting: 'client-box', imageDelivery: 'tar', registry: null, access: 'cloudflare-tunnel',
    origin: 'https://staff.acme.co.uk', site: ':80', alerts: { matrix: null, webhook: false, heartbeat: false },
    setup: { step: 'done', at: 't' }, currentVersion: '0.1.3', foundation: 'v0.1.0', bundleVersion: '0.1.3', pendingCheck: null, lastStatus: null, history: [] };
  const state = { projectDir: p.projectDir, name: 'acme-office', dep: live, version: '0.1.4', foundation: 'v0.1.1', runId: RUN_ID };
  // An urgent check from an earlier run stays exactly as it was.
  const urgent = { since: 't', version: '0.1.4', foundation: 'v0.1.1', why: 'urgent', runId: '20261020-100000-aaaa' };
  saveDeployment(p.projectDir, { ...live, pendingCheck: urgent });
  saveLostContact(state, 'Conductor stopped unexpectedly.');
  assert.deepEqual(loadDeployment(p.projectDir, 'acme-office').pendingCheck, urgent);
  assert.equal(loadDeployment(p.projectDir, 'acme-office').history.length, 0);
  // No check at all (the throw came before the in-progress save): nothing is written.
  saveDeployment(p.projectDir, live);
  saveLostContact(state, 'Conductor stopped unexpectedly.');
  assert.equal(loadDeployment(p.projectDir, 'acme-office').pendingCheck, null);
  // This run's in-progress check: replaced by lost-contact.
  saveDeployment(p.projectDir, { ...live, pendingCheck: { since: 't', version: '0.1.4', foundation: 'v0.1.1', why: 'in-progress', runId: RUN_ID } });
  saveLostContact(state, 'Conductor stopped unexpectedly.');
  const dep = loadDeployment(p.projectDir, 'acme-office');
  assert.deepEqual([dep.pendingCheck.why, dep.pendingCheck.runId], ['lost-contact', RUN_ID]);
  assert.equal(dep.history.at(-1).outcome, 'lost-contact');
});

test('every pending check written while updating carries the run id (interruptShip)', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const live = { schema: 1, name: 'acme-office', project: 'acme', host: 'acme-box', ssh: { user: 'highland', port: null, keyPath: null },
    bundleDir: '/opt/highland/acme', hosting: 'client-box', imageDelivery: 'tar', registry: null, access: 'cloudflare-tunnel',
    origin: 'https://staff.acme.co.uk', site: ':80', alerts: { matrix: null, webhook: false, heartbeat: false },
    setup: { step: 'done', at: 't' }, currentVersion: '0.1.3', foundation: 'v0.1.0', bundleVersion: '0.1.3', pendingCheck: null, lastStatus: null, history: [] };
  saveDeployment(p.projectDir, live);
  interruptShip({ phase: 'updating', projectDir: p.projectDir, lock: null, dep: live, version: '0.1.4', foundation: 'v0.1.1', runId: RUN_ID });
  assert.equal(loadDeployment(p.projectDir, 'acme-office').pendingCheck.runId, RUN_ID);
});

test('updateDeployment refuses while a pending check is open, touching nothing', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  assert.equal((await ship(p, f, FIRST_ANSWERS)).exit, 0);
  const dep = loadDeployment(p.projectDir, 'acme-office');
  saveDeployment(p.projectDir, { ...dep, pendingCheck: { since: 't', version: '0.1.4', foundation: 'v0.1.0', why: 'in-progress', runId: RUN_ID } });
  releaseNext(p, '0.1.4');
  const n = f.calls().length;
  const provider = fakeProvider();
  const r = await updateDeployment({ projectDir: p.projectDir, name: 'acme-office', version: '0.1.4', foundation: 'v0.1.0', runId: '20261027-120000-c3d4' },
    { factory: factoryFor(p), provider, env: f.env(), sleep: async () => {} });
  assert.equal(r.outcome, 'refused');
  assert.match(r.message, /^The last update to acme-office \(0\.1\.4\) ended without Conductor seeing the result\. Run conductor deployments status first/);
  assert.equal(f.calls().length, n);
  assert.equal(provider.acquired().length, 0);
  assert.equal(loadDeployment(p.projectDir, 'acme-office').history.length, dep.history.length);
});

test('a project with no foundation on record is refused before any release is cut', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d, { released: false });
  const file = path.join(p.projectDir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8'));
  project.foundation = { repo: null, tag: null }; // as a new project leaves it, before any build
  writeFileSync(file, JSON.stringify(project));
  const main = execFileSync('git', ['-C', p.appDir, 'rev-parse', 'main'], { encoding: 'utf8' });
  const f = fakeSsh(d, shipRules(d));
  const r = await ship(p, f, FIRST_ANSWERS);
  assert.equal(r.exit, 1);
  assert.equal(r.text, 'The project does not record which foundation release it is built on, so it cannot be shipped. Build it first (conductor build acme).');
  assert.equal(execFileSync('git', ['-C', p.appDir, 'tag', '--list'], { encoding: 'utf8' }), '');
  assert.equal(execFileSync('git', ['-C', p.appDir, 'rev-parse', 'main'], { encoding: 'utf8' }), main);
  assert.equal(f.calls().length, 0);
  assert.equal(r.provider.acquired().length, 0);
});

test('a throw after the outcome is recorded never contradicts it (phase finishing)', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  assert.equal((await ship(p, f, FIRST_ANSWERS)).exit, 0);
  releaseNext(p, '0.1.4');
  f.setRules([...shipRules(d, { version: '0.1.4' }), ...UPDATE_OK]);
  // The caller's state object: the throw comes when the phase moves on after runLaterShip has recorded 'updated'.
  const state = {};
  let phase;
  Object.defineProperty(state, 'phase', { enumerable: true, get: () => phase,
    set: (v) => { if (v === 'done') throw new Error('crash after the outcome'); phase = v; } });
  const r = await updateDeployment({ projectDir: p.projectDir, name: 'acme-office', version: '0.1.4', foundation: 'v0.1.1', runId: '20261027-120000-c3d4' },
    { factory: factoryFor(p), provider: fakeProvider(), env: f.env(), sleep: async () => {}, state });
  assert.equal(r.outcome, 'updated');
  assert.match(r.message, /^The update to acme-office ended \(updated\) and is recorded, but Conductor stopped unexpectedly afterwards \(crash after the outcome\)/);
  const dep = loadDeployment(p.projectDir, 'acme-office');
  assert.deepEqual([dep.pendingCheck, dep.currentVersion, dep.history.at(-1).outcome], [null, '0.1.4', 'updated']);
});
