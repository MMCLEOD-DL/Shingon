// test/factory-status.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeSsh } from './helpers/fakeSsh.js';
import { deploymentStatus, statusText, listText, latestFoundation } from '../src/factory/ship/status.js';
import { securityFixesSince } from '../src/factory/foundationLog.js';
import { newDeployment, withStep, saveDeployment, loadDeployment, listDeployments, lockDeployment } from '../src/factory/deployments/store.js';

const CL = '## [0.1.1] - 2026-11-02\n- **[security]** Reset links could be reused. Fixed.\n\n## [0.1.0] - 2026-10-26\n- First.\n';
const FOUNDATION = { ok: true, version: '0.1.1', changelog: CL };
const RUNS = JSON.stringify({ backup: { at: '2026-10-27T02:31:00Z', ok: true, detail: 'ok' }, backupOk: '2026-10-27T02:31:00Z',
  restore: { at: '2026-10-26T04:31:00Z', ok: true, detail: 'ok' }, restoreOk: '2026-10-26T04:31:00Z' });
// The box's foundation field is deliberately the app version (foundation v0.1.0's release script stamps it): status must ignore it.
const version = (app) => JSON.stringify({ version: { app, foundation: app, commit: 'c' }, ready: { status: 'ok', checks: [] } });

function setup(rules, depPatch = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'st-'));
  const projectDir = path.join(root, 'acme'); mkdirSync(projectDir);
  const dep = { ...withStep(newDeployment({ name: 'acme-office', project: 'acme', host: 'acme-box', ssh: { user: 'highland', port: null, keyPath: null },
    bundleDir: '/opt/highland/acme', hosting: 'client-box', imageDelivery: 'tar', registry: null, access: 'cloudflare-tunnel',
    origin: 'https://staff.acme.co.uk', site: ':80', alerts: { matrix: null, webhook: true, heartbeat: true } }), 'done', 't'),
    currentVersion: '0.1.3', foundation: 'v0.1.0', ...depPatch };
  saveDeployment(projectDir, dep);
  const f = fakeSsh(root, rules);
  return { root, projectDir, f, entry: listDeployments(root)[0] };
}
const opts = (f) => ({ foundation: FOUNDATION, env: f.env(), now: () => '2026-10-27T12:00:00.000Z' });

test('a healthy box on the newest foundation is all ticks', async () => {
  const s = setup([{ match: 'entrypoint node ops', stdout: version('0.1.3') }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }], { foundation: 'v0.1.1' });
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.deepEqual(r.lines, ['Running 0.1.3 on foundation v0.1.1.', 'Health: every check passes.', 'Last backup: 27 Oct 2026, 02:31, worked.',
    'Last restore test: 26 Oct 2026, 04:31, worked.', 'Security fixes: up to date with foundation 0.1.1.']);
  assert.equal(loadDeployment(s.projectDir, 'acme-office').lastStatus.ok, true);
});

test('a box behind on foundation security fixes is listed with the fixes', async () => {
  const s = setup([{ match: 'entrypoint node ops', stdout: version('0.1.3') }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }]); // record: v0.1.0
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes('Behind on foundation security fixes (the newest foundation is 0.1.1):'));
  assert.ok(r.lines.includes('  - 0.1.1: Reset links could be reused. Fixed.'));
  assert.ok(r.lines.includes('  Bring them in with: conductor foundation-upgrade acme --to v0.1.1, then ship.'));
});

test('a pending check is cleared once the box is seen healthy', async () => {
  const s = setup([{ match: 'entrypoint node ops', stdout: version('0.1.4') }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }],
    { pendingCheck: { since: 't', version: '0.1.4', foundation: 'v0.1.1', why: 'lost-contact' } });
  const r = await deploymentStatus(s.entry, opts(s.f));
  const dep = loadDeployment(s.projectDir, 'acme-office');
  assert.equal(dep.pendingCheck, null);
  assert.equal(dep.currentVersion, '0.1.4');
  assert.equal(dep.foundation, 'v0.1.1');
  assert.equal(dep.history.at(-1).outcome, 'confirmed');
  assert.ok(r.lines.some((l) => /Shipping to it is allowed again/.test(l)));
});

test('a pending check stays while the box is unhealthy', async () => {
  const s = setup([{ match: 'entrypoint node ops', stdout: version('0.1.3') }, { match: 'ops check', code: 1, stdout: '✗ update-record: The update to 0.1.4 stopped part-way\n' }, { match: 'psql', stdout: RUNS }],
    { pendingCheck: { since: 't', version: '0.1.4', foundation: 'v0.1.1', why: 'urgent' } });
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.equal(r.ok, false);
  assert.ok(loadDeployment(s.projectDir, 'acme-office').pendingCheck);
});

test('an unfinished setup is reported without contacting the box', async () => {
  const s = setup([], { setup: { step: 'configured', at: 't' } });
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.deepEqual(r.lines, ['First-time setup is not finished (stopped after: configured). Run: conductor ship acme --to acme-office']);
  assert.equal(s.f.calls().length, 0);
});

test('unreachable boxes, unreadable records and an unknown foundation all fail closed', async () => {
  const s = setup([{ match: '.', code: 255, stderr: 'ssh: connect to host acme-box port 22: Connection timed out\n' }]);
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^Could not reach acme-office over SSH/);
  const bad = await deploymentStatus({ slug: 'bobs', name: 'shop', deployment: null, problem: 'The deployment record x could not be read (y). Fix or remove it.' }, opts(s.f));
  assert.equal(bad.ok, false);
  const s2 = setup([{ match: 'entrypoint node ops', stdout: version('0.1.3') }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }]);
  const r2 = await deploymentStatus(s2.entry, { ...opts(s2.f), foundation: { ok: false, problem: 'The foundation repository at /x could not be read' } });
  assert.equal(r2.ok, false);
  assert.ok(r2.lines.some((l) => l.startsWith('Security fixes: could not tell (The foundation repository at /x could not be read')));
  assert.match(statusText([r, bad, r2]), /3 of 3 deployments need attention\.$/);
});

test('no foundation on record is "could not tell", never "up to date"', async () => {
  const s = setup([{ match: 'entrypoint node ops', stdout: version('0.1.3') }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }], { foundation: null });
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes('Security fixes: could not tell (Conductor has no record of which foundation this app is built on).'));
});

test('latestFoundation reads CHANGELOG.md at the highest release tag, not the working tree', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fnd-'));
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  git('init', '-q');
  writeFileSync(path.join(dir, 'CHANGELOG.md'), '## [0.1.0] - 2026-10-26\n- First.\n'); git('add', '.'); git('commit', '-qm', 'a'); git('tag', 'v0.1.0');
  writeFileSync(path.join(dir, 'CHANGELOG.md'), CL); git('commit', '-qam', 'b'); git('tag', '-a', 'v0.1.1', '-m', 'v0.1.1');
  writeFileSync(path.join(dir, 'CHANGELOG.md'), '## [9.9.9] - 2026-12-01\n- wip\n'); git('commit', '-qam', 'c');
  git('tag', 'v0.1.10-rc.1'); // a pre-release tag: ignored
  const r = await latestFoundation(dir);
  assert.equal(r.ok, true);
  assert.equal(r.version, '0.1.1');
  assert.deepEqual(securityFixesSince(r.changelog, '0.1.0'), [{ version: '0.1.1', lines: ['Reset links could be reused. Fixed.'] }]);
  const missing = await latestFoundation(path.join(dir, 'nope'));
  assert.equal(missing.ok, false);
  assert.match(missing.problem, /^The foundation repository at .* could not be read/);
});

test('listText reads records only', () => {
  const s = setup([]);
  const text = listText(listDeployments(s.root));
  assert.match(text, /^acme\/acme-office +0\.1\.3 on foundation v0\.1\.0 +client box, Cloudflare tunnel/);
  assert.equal(listText([]), 'No deployments yet. Ship one with: conductor ship <project> --to <deployment>');
  assert.equal(s.f.calls().length, 0);
});

test('a lock held by a running ship means the record is not saved, and a pending check is not cleared', async () => {
  const s = setup([{ match: 'entrypoint node ops', stdout: version('0.1.4') }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }],
    { pendingCheck: { since: 't', version: '0.1.4', foundation: 'v0.1.1', why: 'in-progress' } });
  const lock = lockDeployment(s.projectDir, 'acme-office', { pid: 4242 });
  assert.ok(lock);
  const r = await deploymentStatus(s.entry, { ...opts(s.f), isAlive: () => true });
  assert.ok(r.lines.includes('A ship to this box is running, so its record was not updated.'));
  const dep = loadDeployment(s.projectDir, 'acme-office');
  assert.ok(dep.pendingCheck);
  assert.equal(dep.lastStatus, null);
  assert.equal(r.ok, false);
});

test('a pending check with an unknown version stays pending', async () => {
  const s = setup([{ match: 'entrypoint node ops', code: 1, stderr: 'boom' }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }],
    { pendingCheck: { since: 't', version: '0.1.4', foundation: 'v0.1.1', why: 'lost-contact' } });
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.equal(r.ok, false);
  assert.ok(loadDeployment(s.projectDir, 'acme-office').pendingCheck);
});

test('a box that reports a different version corrects the record', async () => {
  const s = setup([{ match: 'entrypoint node ops', stdout: version('0.1.4') }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }], { foundation: 'v0.1.1' });
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.ok(r.lines.includes("The box runs 0.1.4, but Conductor's record said 0.1.3. The record has been corrected."));
  assert.equal(loadDeployment(s.projectDir, 'acme-office').currentVersion, '0.1.4');
});

test('failing checks, a failed backup and a missing restore test are all reported', async () => {
  const runs = JSON.stringify({ backup: { at: '2026-10-27T02:31:00Z', ok: false, detail: 'disk full' }, backupOk: null, restore: null, restoreOk: null });
  const s = setup([{ match: 'entrypoint node ops', stdout: version('0.1.3') }, { match: 'ops check', code: 1, stdout: '✓ app\n✗ db: down\n' }, { match: 'psql', stdout: runs }], { foundation: 'v0.1.1' });
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes('Health: problems found:'));
  assert.ok(r.lines.includes('  - db: down'));
  assert.ok(r.lines.includes('Last backup: 27 Oct 2026, 02:31, failed: disk full'));
  assert.ok(r.lines.includes('Last restore test: none yet.'));
});

test('listText shows unfinished, pending and unreadable entries', () => {
  const s = setup([], { setup: { step: 'configured', at: 't' } });
  assert.match(listText(listDeployments(s.root)), /^acme\/acme-office +first-time setup not finished \(stopped after: configured\)$/);
  const s2 = setup([], { pendingCheck: { since: 't', version: '0.1.4', foundation: 'v0.1.1', why: 'urgent' } });
  assert.match(listText(listDeployments(s2.root)), /result of the last update unknown: run conductor deployments status$/);
  assert.equal(listText([{ slug: 'bobs', name: 'shop', deployment: null, problem: 'broken' }]), 'bobs/shop  broken');
});

test('deploymentsCommand lists without ssh, and status checks every box and exits 1 when one needs attention', async () => {
  const { deploymentsCommand } = await import('../src/factory/ship/status.js');
  const s = setup([{ match: 'entrypoint node ops', stdout: version('0.1.3') }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }]);
  const out = [];
  const ctx = { factory: { projectsRoot: s.root, foundation: { repo: '/nonexistent-foundation' } }, env: s.f.env(), stdout: { write: (t) => out.push(t) } };
  assert.equal(await deploymentsCommand({ slug: null, status: false }, ctx), 0);
  assert.equal(s.f.calls().length, 0);
  assert.equal(await deploymentsCommand({ slug: null, status: true }, ctx), 1);
  assert.match(out.join(''), /Security fixes: could not tell \(The foundation repository at \/nonexistent-foundation could not be read/);
  assert.match(out.join(''), /1 of 1 deployments need attention\.$/m);
});

// ---- Final-wave fixes (Ruling S21, items 6 and 9) ----

const RUN = '20261027-100000-a1b2';
const ROLLED_BACK = '[Acme Ltd] Update to 0.1.4 failed (the database update failed), so it was undone automatically. The app is back on 0.1.3 with its data exactly as it was before the update. (The monitor did not restart; run: docker compose up -d ops)\n';
const healthyNew = [{ match: 'entrypoint node ops', stdout: version('0.1.4') }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }];
const healthyOld = [{ match: 'entrypoint node ops', stdout: version('0.1.3') }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }];

for (const why of ['in-progress', 'lost-contact', 'interrupted']) {
  test(`S21: an unseen (${why}) check stays pending while the box still runs the old version and no exit file was read`, async () => {
    const s = setup(healthyOld, { pendingCheck: { since: 't', version: '0.1.4', foundation: 'v0.1.1', why, runId: RUN } });
    const r = await deploymentStatus(s.entry, opts(s.f));
    assert.equal(r.ok, false);
    const dep = loadDeployment(s.projectDir, 'acme-office');
    assert.equal(dep.pendingCheck.why, why);
    assert.equal(dep.currentVersion, '0.1.3');
    assert.equal(dep.history.length, 0);
    assert.ok(r.lines.some((l) => /an update may still be running/.test(l)), r.lines.join('\n'));
    assert.ok(s.f.calls().some((c) => c.command.includes(`.conductor/update-${RUN}.exit`)), 'the exit file was looked for');
  });

  // S22 replaces the S21 "exit file read → confirmed" test: a read exit is interpreted, never taken as 'confirmed'.
  test(`S22: an unseen (${why}) check whose run rolled back is recorded as rolled-back and cleared (box on the old version)`, async () => {
    const s = setup([{ match: `update-${RUN}\\.exit`, stdout: `exit=1\n${ROLLED_BACK}` }, ...healthyOld],
      { pendingCheck: { since: 't', version: '0.1.4', foundation: 'v0.1.1', why, runId: RUN } });
    const r = await deploymentStatus(s.entry, opts(s.f));
    const dep = loadDeployment(s.projectDir, 'acme-office');
    assert.equal(dep.pendingCheck, null);
    assert.equal(dep.currentVersion, '0.1.3');
    assert.equal(dep.foundation, 'v0.1.0'); // the update did not land, so the recorded foundation stays
    assert.equal(dep.history.at(-1).outcome, 'rolled-back');
    assert.equal(dep.history.at(-1).from, '0.1.3');
    assert.match(dep.history.at(-1).detail, /^The update to 0\.1\.4 did not work \(.*\), so the box undid it by itself\./);
    assert.ok(r.lines.some((l) => /so the box undid it by itself/.test(l)), r.lines.join('\n'));
    assert.ok(!dep.history.some((h) => h.outcome === 'confirmed'));
    const read = s.f.calls().find((c) => c.command.includes(`.conductor/update-${RUN}.exit`));
    assert.match(read.command, new RegExp(`cat \\.conductor/update-${RUN}\\.log`), 'the log is read in the same call');
  });
}

test('S21: a pending check with no run id and the old version stays pending without looking for an exit file', async () => {
  const s = setup(healthyOld, { pendingCheck: { since: 't', version: '0.1.4', foundation: 'v0.1.1', why: 'lost-contact' } });
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.ok(loadDeployment(s.projectDir, 'acme-office').pendingCheck);
  assert.ok(r.lines.some((l) => /an update may still be running/.test(l)));
  assert.ok(!s.f.calls().some((c) => c.command.includes('.exit')));
});

test('status with no deployments says so, exits 1 and never looks up the foundation', async () => {
  const { deploymentsCommand } = await import('../src/factory/ship/status.js');
  const root = mkdtempSync(path.join(tmpdir(), 'st-'));
  const out = [];
  const ctx = { factory: { projectsRoot: root, foundation: { get repo() { throw new Error('the foundation was looked up'); } } },
    env: process.env, stdout: { write: (t) => out.push(t) } };
  assert.equal(await deploymentsCommand({ slug: null, status: true }, ctx), 1);
  assert.equal(out.join(''), 'No deployments found.\n');
  out.length = 0;
  assert.equal(await deploymentsCommand({ slug: 'acme', status: true }, ctx), 1);
  assert.equal(out.join(''), 'No deployments found for acme.\n');
});

test('latestFoundation runs git without secret-looking variables', async () => {
  const envs = [];
  const run = async ({ env }) => { envs.push(env); return { code: 1, stdout: '', stderr: '' }; };
  const r = await latestFoundation('/f', { env: { PATH: '/usr/bin', MY_SERVICE_TOKEN: 'x', GIT_DIR: '/elsewhere' }, run });
  assert.equal(r.ok, false);
  assert.equal(envs.length, 1);
  assert.equal(envs[0].MY_SERVICE_TOKEN, undefined);
  assert.equal(envs[0].GIT_DIR, undefined);
  assert.equal(envs[0].GIT_TERMINAL_PROMPT, '0');
});

// ---- Ruling S22: status never looks calmer than the box is ----

const exitRule = (body) => ({ match: `update-${RUN}\\.exit`, stdout: body });
const pendingWith = (why = 'lost-contact', extra = {}) => ({ pendingCheck: { since: 't', version: '0.1.4', foundation: 'v0.1.1', why, runId: RUN, ...extra } });
const URGENT_LINE = '[Acme Ltd] URGENT: update to 0.1.4 failed (the database update failed) and the automatic undo also failed (restore stopped). The app may be down. Backup 1a2b3c4d holds the data from before the update.\n';
const NOT_RECOVERED = '[Acme Ltd] Update to 0.1.4 cancelled: an earlier update could not be undone and has not been marked as recovered. Nothing was changed. Recover the box first (see the runbook, section "Recovering from a failed update"), then run: docker compose run --rm updater update --mark-recovered\n';

function assertUrgent(s, r) {
  const dep = loadDeployment(s.projectDir, 'acme-office');
  assert.equal(r.ok, false);
  assert.equal(dep.pendingCheck.why, 'urgent');
  assert.equal(dep.pendingCheck.runId, RUN);
  assert.equal(dep.currentVersion, '0.1.3');
  assert.equal(dep.history.at(-1).outcome, 'urgent');
  assert.ok(!dep.history.some((h) => h.outcome === 'confirmed'));
  assert.ok(r.lines.some((l) => /RUNBOOK\.md/.test(l) && /--mark-recovered/.test(l)), r.lines.join('\n'));
  return dep;
}

test('S22: an exit 3 keeps the box blocked as urgent, with a history entry and the recovery steps', async () => {
  const s = setup([exitRule(`exit=3\n${URGENT_LINE}`), ...healthyOld], pendingWith('lost-contact'));
  const r = await deploymentStatus(s.entry, opts(s.f));
  assertUrgent(s, r);
});

test('S22: an exit 3 stays blocked even when the box already runs the new version', async () => {
  const s = setup([exitRule(`exit=3\n${URGENT_LINE}`), ...healthyNew], pendingWith('in-progress'));
  const r = await deploymentStatus(s.entry, opts(s.f));
  assertUrgent(s, r);
});

test('S22: exit 1 "not marked as recovered" is urgent', async () => {
  const s = setup([exitRule(`exit=1\n${NOT_RECOVERED}`), ...healthyOld], pendingWith('interrupted'));
  const r = await deploymentStatus(s.entry, opts(s.f));
  assertUrgent(s, r);
});

test('S22: an exit whose log cannot be understood stays pending', async () => {
  const s = setup([exitRule('exit=0\nsomething nobody wrote down\n'), ...healthyOld], pendingWith('lost-contact'));
  const r = await deploymentStatus(s.entry, opts(s.f));
  const dep = loadDeployment(s.projectDir, 'acme-office');
  assert.equal(r.ok, false);
  assert.equal(dep.pendingCheck.why, 'lost-contact');
  assert.equal(dep.history.length, 0);
  assert.equal(dep.currentVersion, '0.1.3');
});

test('S22: a log with no exit file means the update may still be running (even on the new version)', async () => {
  for (const healthy of [healthyOld, healthyNew]) {
    const s = setup([exitRule('exit=running\n[Acme Ltd] Taking a backup first\n'), ...healthy], pendingWith('lost-contact'));
    const r = await deploymentStatus(s.entry, opts(s.f));
    const dep = loadDeployment(s.projectDir, 'acme-office');
    assert.equal(r.ok, false);
    assert.equal(dep.pendingCheck.why, 'lost-contact');
    assert.equal(dep.history.length, 0);
    assert.ok(r.lines.some((l) => /an update may still be running/.test(l)), r.lines.join('\n'));
  }
});

test('S22: neither file and the old version: the update never started, cleared as cancelled', async () => {
  const s = setup([exitRule('exit=none\n'), ...healthyOld], pendingWith('lost-contact'));
  const r = await deploymentStatus(s.entry, opts(s.f));
  const dep = loadDeployment(s.projectDir, 'acme-office');
  assert.equal(dep.pendingCheck, null);
  assert.equal(dep.currentVersion, '0.1.3');
  assert.equal(dep.foundation, 'v0.1.0');
  assert.equal(dep.history.at(-1).outcome, 'cancelled');
  assert.match(dep.history.at(-1).detail, /the update never started on the box/);
  assert.ok(r.lines.some((l) => /the update never started on the box/.test(l)), r.lines.join('\n'));
});

test('S22: an updated exit clears only when the box runs the new version; otherwise the two disagree', async () => {
  const UPDATED = 'exit=0\n[Acme Ltd] Updated from 0.1.3 to 0.1.4. A backup (1a2b3c4d) was taken first.\n';
  const s = setup([exitRule(UPDATED), ...healthyOld], pendingWith('lost-contact'));
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.equal(r.ok, false);
  assert.equal(loadDeployment(s.projectDir, 'acme-office').pendingCheck.why, 'lost-contact');
  assert.ok(r.lines.some((l) => /disagree/.test(l)), r.lines.join('\n'));
  const s2 = setup([exitRule(UPDATED), ...healthyNew], pendingWith('lost-contact'));
  await deploymentStatus(s2.entry, opts(s2.f));
  const dep = loadDeployment(s2.projectDir, 'acme-office');
  assert.equal(dep.pendingCheck, null);
  assert.equal(dep.currentVersion, '0.1.4');
  assert.equal(dep.foundation, 'v0.1.1');
  assert.equal(dep.history.at(-1).outcome, 'updated');
});

test('S22: a rolled-back exit while the box runs the new version stays pending', async () => {
  const s = setup([exitRule(`exit=1\n${ROLLED_BACK}`), ...healthyNew], pendingWith('lost-contact'));
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.equal(r.ok, false);
  assert.equal(loadDeployment(s.projectDir, 'acme-office').pendingCheck.why, 'lost-contact');
  assert.ok(r.lines.some((l) => /disagree/.test(l)), r.lines.join('\n'));
});

// The foundation's own record of an unrecovered update: ops_runs (outstandingUpdate's rule) and /state/update-in-progress.json.
const recorded = ({ outstanding = '0', record = 'no' } = {}) => [{ match: 'outstanding=', stdout: `outstanding=${outstanding}\n` },
  { match: 'update-in-progress\\.json', stdout: `record=${record}\n` }];

test('S22: an urgent check stays blocked on healthy checks alone until the foundation record shows it recovered', async () => {
  // Healthy, but the foundation's record could not be read: blocked.
  const s = setup(healthyOld, pendingWith('urgent'));
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.equal(r.ok, false);
  assert.equal(loadDeployment(s.projectDir, 'acme-office').pendingCheck.why, 'urgent');
  assert.ok(r.lines.some((l) => /--mark-recovered/.test(l)), r.lines.join('\n'));
  // The database still holds an unrecovered update: blocked.
  const s2 = setup([...recorded({ outstanding: '1' }), ...healthyOld], pendingWith('urgent'));
  const r2 = await deploymentStatus(s2.entry, opts(s2.f));
  assert.equal(r2.ok, false);
  assert.equal(loadDeployment(s2.projectDir, 'acme-office').pendingCheck.why, 'urgent');
  // An update record is still in /state: blocked.
  const s3 = setup([...recorded({ record: 'yes' }), ...healthyOld], pendingWith('urgent'));
  await deploymentStatus(s3.entry, opts(s3.f));
  assert.equal(loadDeployment(s3.projectDir, 'acme-office').pendingCheck.why, 'urgent');
  // Marked as recovered on the box: cleared.
  const s4 = setup([...recorded(), ...healthyOld], pendingWith('urgent'));
  const r4 = await deploymentStatus(s4.entry, opts(s4.f));
  const dep = loadDeployment(s4.projectDir, 'acme-office');
  assert.equal(dep.pendingCheck, null, r4.lines.join('\n'));
  assert.equal(dep.currentVersion, '0.1.3');
  assert.match(dep.history.at(-1).detail, /marked as recovered/);
  const q = s4.f.calls().find((c) => c.command.includes('outstanding='));
  assert.match(q.command, /^cd '\/opt\/highland\/acme' && docker compose exec -T db psql/);
  assert.ok(q.command.includes('URGENT: update to'));
});
