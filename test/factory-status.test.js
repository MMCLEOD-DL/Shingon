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
