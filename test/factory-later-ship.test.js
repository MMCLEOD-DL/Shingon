// test/factory-later-ship.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeSsh } from './helpers/fakeSsh.js';
import { runLaterShip, startDetachedUpdate, pruneImageFiles } from '../src/factory/ship/update.js';
import { newDeployment, withStep } from '../src/factory/deployments/store.js';

const T = { host: 'acme-box', user: 'highland', port: null, keyPath: null, label: 'acme-office' };
const UPDATED = '[Acme Ltd] Updated from 0.1.3 to 0.1.4. A backup (1a2b3c4d) was taken first.';
const ROLLED = '[Acme Ltd] Update to 0.1.4 failed (the database update failed), so it was undone automatically. The app is back on 0.1.3 with its data exactly as it was before the update.';
const live = () => ({ ...withStep(newDeployment({ name: 'acme-office', project: 'acme', host: 'acme-box', ssh: { user: 'highland', port: null, keyPath: null },
  bundleDir: '/opt/highland/acme', hosting: 'client-box', imageDelivery: 'tar', registry: null, access: 'cloudflare-tunnel',
  origin: 'https://staff.acme.co.uk', site: ':80', alerts: { matrix: null, webhook: true, heartbeat: true } }), 'done', 't'),
  currentVersion: '0.1.3', foundation: 'v0.1.0', bundleVersion: '0.1.3' });

function go(rules, { clockStep = 0, timeout = 60000, dep = live(), version = '0.1.4', imagesFile = 'images-0.1.4.tar', runId = '20261027-100000-a1b2' } = {}) {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'ls-')), rules);
  let t0 = 0; const said = []; const saved = [];
  return runLaterShip({ dep, target: T, version, foundation: 'v0.1.1', imagesFile, runId,
    say: (s) => said.push(s), save: (d) => { saved.push(d); return d; }, env: f.env(), now: () => '2026-10-27T10:00:00.000Z',
    opts: { updateTimeoutMs: timeout, pollMs: 1, sleep: async () => {}, clock: () => (t0 += clockStep) } })
    .then((r) => ({ ...r, f, said: said.join('\n'), saved }));
}

test('a good update runs detached, passes progress on, refreshes the bundle files and records the new version', async () => {
  const r = await go([
    { match: 'setsid nohup sh -c' },
    { match: 'exit=running', once: true, stdout: 'exit=running\nStopping the app and the monitor.\n' },
    { match: 'exit=running', stdout: `exit=0\nStopping the app and the monitor.\n${UPDATED}\n` },
    { match: 'for f in compose.yaml Caddyfile', stdout: 'replaced=compose.yaml\nsame=Caddyfile\n' },
  ]);
  assert.equal(r.outcome, 'updated', r.text);
  const cmds = r.f.calls().map((c) => c.command);
  const start = cmds.find((c) => c.includes('setsid nohup sh -c'));
  assert.ok(start.includes('updater update --to') && start.includes('images-0.1.4.tar') && start.includes('.conductor/update-20261027-100000-a1b2.exit'));
  assert.equal(r.said.split('box: Stopping the app and the monitor.').length - 1, 1); // each line said once
  assert.ok(cmds.some((c) => c.endsWith("docker compose pull db proxy tunnel")));
  assert.ok(cmds.some((c) => c.includes('for f in images-*.tar')));
  assert.equal(r.dep.currentVersion, '0.1.4');
  assert.equal(r.dep.foundation, 'v0.1.1');
  assert.equal(r.dep.bundleVersion, '0.1.4');
  assert.deepEqual(r.dep.history.at(-1), { at: '2026-10-27T10:00:00.000Z', version: '0.1.4', from: '0.1.3', outcome: 'updated',
    detail: 'acme-office is now on 0.1.4 (it was on 0.1.3). The box took a backup (1a2b3c4d) first.' });
});

test('a rolled-back update keeps the old version and touches no files', async () => {
  const r = await go([{ match: 'setsid' }, { match: 'exit=running', stdout: `exit=1\n${ROLLED}\n` }]);
  assert.equal(r.outcome, 'rolled-back');
  assert.equal(r.dep.currentVersion, '0.1.3');
  assert.ok(!r.f.calls().some((c) => /compose\.yaml Caddyfile|images-\*\.tar|pull db/.test(c.command)));
});

test('losing contact leaves the update running and blocks further ships until status has looked', async () => {
  const r = await go([{ match: 'setsid' }, { match: 'exit=running', code: 255, stderr: 'Connection reset\n' }], { clockStep: 20000, timeout: 60000 });
  assert.equal(r.outcome, 'lost-contact');
  assert.deepEqual(r.dep.pendingCheck, { since: '2026-10-27T10:00:00.000Z', version: '0.1.4', foundation: 'v0.1.1', why: 'lost-contact', runId: '20261027-100000-a1b2' });
  assert.match(r.text, /carries on by itself on the box; Conductor will not ship to acme-office again until conductor deployments status/);
  assert.equal(r.dep.currentVersion, '0.1.3');
});

test('a hand-edited compose.yaml is left alone, with a note', async () => {
  const r = await go([{ match: 'setsid' }, { match: 'exit=running', stdout: `exit=0\n${UPDATED}\n` },
    { match: 'for f in compose.yaml Caddyfile', stdout: 'hand=compose.yaml\nsame=Caddyfile\n' }]);
  assert.equal(r.outcome, 'updated');
  assert.match(r.text, /Note: compose\.yaml on the box was changed by hand, so Conductor left it alone\. The new one is at \/opt\/highland\/acme\/\.conductor\/bundle-0\.1\.4\/compose\.yaml/);
  assert.ok(!r.f.calls().some((c) => c.command.includes('pull db proxy')));
});

test('an update that could not start changes nothing', async () => {
  const r = await go([{ match: 'setsid', code: 1 }]); // cd/mkdir/rm failed: no launch marker
  assert.equal(r.outcome, 'cancelled');
  assert.match(r.text, /^The update could not be started on acme-office \(code 1\)\. Nothing was changed\./);
  assert.equal(r.dep.pendingCheck, null);
  assert.equal(r.saved[0].pendingCheck.why, 'in-progress'); // saved before the box was touched
});

test('an update that was launched but never wrote its log is unsure, never "nothing changed"', async () => {
  const r = await go([{ match: 'setsid', code: 1, stdout: 'launched\n' }]);
  assert.equal(r.outcome, 'lost-contact');
  assert.deepEqual(r.dep.pendingCheck, { since: '2026-10-27T10:00:00.000Z', version: '0.1.4', foundation: 'v0.1.1', why: 'lost-contact', runId: '20261027-100000-a1b2' });
  assert.match(r.text, /^Conductor started the update on acme-office but could not see it begin; check the box\./);
  assert.doesNotMatch(r.text, /Nothing was changed/);
});

test('a crash while polling leaves the in-progress pending check in place', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'ls-')), [{ match: 'setsid', stdout: 'launched\n' }, { match: 'exit=running', stdout: 'exit=running\nStopping the app.\n' }]);
  const saved = [];
  await assert.rejects(runLaterShip({ dep: live(), target: T, version: '0.1.4', foundation: 'v0.1.1', imagesFile: 'images-0.1.4.tar', runId: '20261027-100000-a1b2',
    say: (s) => { if (s.startsWith('  box:')) throw new Error('interrupted'); }, save: (d) => { saved.push(d); return d; }, env: f.env(),
    now: () => 'now', opts: { pollMs: 1, sleep: async () => {} } }), /interrupted/);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].pendingCheck, { since: 'now', version: '0.1.4', foundation: 'v0.1.1', why: 'in-progress', runId: '20261027-100000-a1b2' });
});

test('every recorded outcome replaces the in-progress check', async () => {
  const r = await go([{ match: 'setsid' }, { match: 'exit=running', stdout: `exit=1\n${ROLLED}\n` }]);
  assert.equal(r.dep.pendingCheck, null);
  assert.equal(r.saved.at(-1).pendingCheck, null);
});

test('urgent sets a pending check', async () => {
  const r = await go([{ match: 'setsid' }, { match: 'exit=running', stdout: 'exit=3\n[Acme Ltd] URGENT: update to 0.1.4 failed (x) and the automatic undo also failed (y).\n' }]);
  assert.equal(r.outcome, 'urgent');
  assert.equal(r.dep.pendingCheck.why, 'urgent');
});

// ---- beyond the brief's tests ----

test('the start command backgrounds only the update, then checks the log inside the bundle folder', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'ls-')), [{ match: 'setsid' }]);
  const r = await startDetachedUpdate(T, { dir: '/opt/highland/acme', version: '0.1.4', imagesFile: 'images-0.1.4.tar', runId: '20261027-100000-a1b2', registry: false, env: f.env() });
  assert.deepEqual(r, { ok: true, problem: null, unsure: false });
  const cmd = f.calls()[0].command;
  assert.match(cmd, /^cd '\/opt\/highland\/acme' && mkdir -p \.conductor && rm -f \.conductor\/update-20261027-100000-a1b2\.exit \.conductor\/update-20261027-100000-a1b2\.log && \{ setsid nohup sh -c '.*' >\/dev\/null 2>&1 <\/dev\/null & \} && echo launched && \{ i=0; while \[ ! -f \.conductor\/update-20261027-100000-a1b2\.log \] && \[ "\$i" -lt 5 \]; do sleep 1; i=\$\(\(i\+1\)\); done; \[ -f \.conductor\/update-20261027-100000-a1b2\.log \]; \}$/s);
  assert.ok(cmd.includes("docker compose run --rm -T updater update --to '\\''0.1.4'\\'' --image-file '\\''images-0.1.4.tar'\\'' > .conductor/update-20261027-100000-a1b2.log 2>&1; echo $? > .conductor/update-20261027-100000-a1b2.exit"));
  assert.ok(!cmd.includes('DOCKER_CONFIG'));
});

test('registry delivery signs the updater in through the bundle folder and sends no image file', async () => {
  const dep = { ...live(), imageDelivery: 'registry', registry: { host: 'reg.example', namespace: 'highland-acme', user: 'bot' } };
  const r = await go([{ match: 'setsid' }, { match: 'exit=running', stdout: `exit=0\n${UPDATED}\n` },
    { match: 'for f in compose.yaml Caddyfile', stdout: 'same=compose.yaml\nsame=Caddyfile\n' }], { dep, imagesFile: null });
  assert.equal(r.outcome, 'updated');
  const start = r.f.calls().map((c) => c.command).find((c) => c.includes('setsid'));
  assert.ok(start.includes('DOCKER_CONFIG="$PWD/.docker" docker compose run --rm -T updater update --to'));
  assert.ok(!start.includes('--image-file'));
});

test('losing contact while starting is never read as "nothing changed"', async () => {
  const r = await go([{ match: 'setsid', code: 255, stderr: 'Connection reset by peer\n' }]);
  assert.equal(r.outcome, 'lost-contact');
  assert.equal(r.dep.pendingCheck.why, 'lost-contact');
  assert.doesNotMatch(r.text, /Nothing was changed/);
  assert.match(r.text, /cannot tell whether the update started/);
});

test('an update still running when the time is up is lost contact, not success', async () => {
  const r = await go([{ match: 'setsid' }, { match: 'exit=running', stdout: 'exit=running\nTaking a backup.\n' }], { clockStep: 30000, timeout: 60000 });
  assert.equal(r.outcome, 'lost-contact');
  assert.ok(r.dep.pendingCheck);
  assert.match(r.said, /box: Taking a backup\./);
});

test('box text is cleaned of terminal control codes before it is said', async () => {
  const r = await go([{ match: 'setsid' }, { match: 'exit=running', stdout: `exit=1\n\x1b[31mred\x1b[0m line\n${ROLLED}\n` }]);
  assert.match(r.said, /box: red line/);
  assert.ok(!r.said.includes('\x1b'));
});

test('a failed restart after new files are in place is a note with the command to run', async () => {
  const r = await go([{ match: 'setsid' }, { match: 'exit=running', stdout: `exit=0\n${UPDATED}\n` },
    { match: 'for f in compose.yaml Caddyfile', stdout: 'replaced=compose.yaml\nreplaced=Caddyfile\n' },
    { match: 'pull db proxy', code: 1, stderr: 'pull access denied\n' }]);
  assert.equal(r.outcome, 'updated');
  assert.match(r.text, /Note: The new compose\.yaml and Caddyfile are in place, but the box could not restart with them \(pull access denied\)\. On the box run: docker compose up -d/);
  assert.ok(!r.f.calls().some((c) => c.command.endsWith('docker compose up -d')));
});

test('already on the version brings the record up to date and changes no files', async () => {
  const r = await go([{ match: 'setsid' }, { match: 'exit=running', stdout: 'exit=1\n[Acme Ltd] Already on 0.1.4.\n' }]);
  assert.equal(r.outcome, 'already-on');
  assert.equal(r.dep.currentVersion, '0.1.4');
  assert.equal(r.dep.foundation, 'v0.1.1');
  assert.equal(r.dep.bundleVersion, '0.1.3');
  assert.ok(!r.f.calls().some((c) => /compose\.yaml Caddyfile|images-\*\.tar/.test(c.command)));
});

test('prune keeps the new and previous image files, and skips anything not plain x.y.z', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'ls-')), []);
  assert.equal((await pruneImageFiles(T, { dir: '/opt/highland/acme', version: '0.1.4', from: '0.1.3', env: f.env() })).ok, true);
  assert.equal(f.calls()[0].command, "cd '/opt/highland/acme' && for f in images-*.tar; do case \"$f\" in images-0.1.4.tar|images-0.1.3.tar) ;; *) rm -f -- \"$f\" ;; esac; done");
  for (const [version, from] of [['0.1.4', '0.1.3-rc.1'], ['0.1.4+b1', '0.1.3'], ['0.1.4', null]]) {
    const r = await pruneImageFiles(T, { dir: '/opt/highland/acme', version, from, env: f.env() });
    assert.deepEqual(r, { ok: true, skipped: true, problem: null });
  }
  assert.equal(f.calls().length, 1);
});

test('bad inputs are refused before the box is touched', async () => {
  await assert.rejects(go([], { runId: '../x' }), /run id/);
  await assert.rejects(go([], { imagesFile: 'images-0.1.5.tar' }), /images file/);
  await assert.rejects(go([], { version: "0.1.4'; rm -rf /" }), /release version/);
  await assert.rejects(go([], { dep: { ...live(), pendingCheck: { since: 't', version: '0.1.4', foundation: 'v0.1.1', why: 'urgent' } } }), /deployments status/);
});

test('readUpdateExit reads the exit file only when it holds a code (Ruling S21)', async () => {
  const { readUpdateExit } = await import('../src/factory/ship/update.js');
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'ls-')), [{ match: 'update-20261027-100000-a1b2\\.exit', once: true, stdout: 'exit=3\n' },
    { match: 'update-20261027-100000-a1b2\\.exit', once: true, stdout: 'exit=\n' }, { match: 'update-20261027-100000-a1b2\\.exit', code: 255 }]);
  const args = { dir: '/opt/highland/acme', runId: '20261027-100000-a1b2', env: f.env() };
  assert.deepEqual(await readUpdateExit(T, args), { read: true, code: 3 });
  assert.deepEqual(await readUpdateExit(T, args), { read: false, code: null }); // an empty file: still being written
  assert.deepEqual(await readUpdateExit(T, args), { read: false, code: null }); // the box did not answer
  assert.deepEqual(await readUpdateExit(T, { ...args, runId: undefined }), { read: false, code: null });
  assert.equal(f.calls().length, 3);
  assert.match(f.calls()[0].command, /^cd '\/opt\/highland\/acme' && if \[ -f \.conductor\/update-20261027-100000-a1b2\.exit \]/);
});
