import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, cpSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { openCouncilLog } from '../src/council/councilWorkspace.js';
import { collectEvidence, reuseChecks, reportFiles, mergeGates } from '../src/council/evidence.js';
import { MachineError } from '../src/factory/machines/index.js';
import { fakeGatesRun, fakeMachine, fakeProvider, fakeSsh } from './helpers/councilFull.js';
import { makeRepo } from './helpers/gitRepo.js';

const FX = new URL('./fixtures/council-full/gates-out/', import.meta.url).pathname;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'evidence-'));
const log = (f) => readFileSync(new URL(`./fixtures/council-full/${f}`, import.meta.url), 'utf8');
const okChecks = { browsersInstalled: () => ({ ok: true, why: '' }), testDatabaseProblem: () => null };
const NO_DB = "TEST_DATABASE_URL is not set, so the foundation's tests cannot reach a database.";
const noDb = { browsersInstalled: () => ({ ok: true, why: '' }), testDatabaseProblem: () => NO_DB };
const acquires = (calls) => calls.filter((c) => c.kind === 'acquire').map((c) => c.opts);

function readEvents(ctx) {
  return readFileSync(ctx.log.transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const events = (ctx, type) => readEvents(ctx).filter((e) => e.type === type);
const stages = (ctx) => events(ctx, 'council-evidence').map((x) => `${x.stage}:${x.status}`);

// Each test gets its own build folder and its own council workspace (a real git repo, so pushCommit can archive head).
let project;
let head;
async function ctxFor({ councilTools = { axe: false }, files = { 'README.md': 'app\n' } } = {}) {
  const buildDir = path.join(tmp(), 'builds', 'r1');
  mkdirSync(buildDir, { recursive: true });
  const dir = await makeRepo(files);
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  project = { slug: 'acme', runId: 'r1', buildDir, factory: {}, checks: null };
  const { log: runLog, state } = openCouncilLog(buildDir);
  return { ws: { dir }, log: runLog, state, options: { ...DEFAULT_OPTIONS, councilTools } };
}

// Plan 8's reports for this commit, in builds/<runId>/reports/.
function buildChecks() {
  const reports = path.join(project.buildDir, 'reports');
  mkdirSync(reports, { recursive: true });
  for (const f of ['vitest.json', 'playwright.json', 'crossing.json', 'screenshots']) cpSync(path.join(FX, f), path.join(reports, f), { recursive: true });
  return {
    verify: { status: 'failed', summary: 'The tests fail.', output: '…' },
    browser: { status: 'failed', summary: 'A page check fails.', output: '' },
    reports: ['vitest.json', 'playwright.json', 'crossing.json', 'screenshots'].map((f) => path.join(reports, f)),
  };
}

function axeFile() {
  const axe = path.join(tmp(), 'axe.min.js');
  writeFileSync(axe, '/*! axe v4.10.3\n * Mozilla Public License, v. 2.0 */');
  return axe;
}

const passingSsh = () => fakeSsh([{ match: 'tar -x' }, { match: 'run-smoke.sh', stdout: log('smoke-passed.log') }, { match: 'rm -rf' }]);

test('a full round: gates locally, then the smoke on one machine, cleaned and released; saved by commit', async () => {
  const machine = fakeMachine({ id: 'ct111' });
  const { provider, calls } = fakeProvider({ machine });
  const { ssh, calls: sshCalls } = passingSsh();
  const ctx = await ctxFor();
  const e = await collectEvidence(ctx, { project, head, round: 2, deps: { run: fakeGatesRun({ codes: { vitest: 1 } }).run, helpers: okChecks, getMachineProvider: () => provider, createSsh: () => ssh } });
  assert.equal(e.gates.steps.vitest, 1);
  assert.deepEqual(e.gates.source, { verify: 'council', browser: 'council', a11y: null });
  assert.equal(e.smoke.passed, true);
  assert.deepEqual([e.smokeStatus, e.machine, e.smokeNote], ['ran', 'ct111', null]);
  assert.deepEqual(acquires(calls), [{ purpose: 'council', projectSlug: 'acme', runId: 'r1' }]);
  assert.equal(machine.released, 1);
  assert.equal(e.shotsDir, path.join(project.buildDir, 'council', 'round-2', 'screenshots'));
  assert.ok(existsSync(path.join(e.shotsDir, 'notes-mobile-webkit.png')));
  assert.deepEqual(sshCalls.map((c) => c.kind), ['upload', 'exec', 'exec', 'exec']);
  assert.equal(sshCalls[0].remotePath, '/srv/hf-factory/runs/acme-r1/smoke-app.tar');
  assert.equal(ctx.state.council.evidence.sha, head);
  const saved = JSON.parse(readFileSync(ctx.log.statePath, 'utf8'));
  assert.equal(saved.council.evidence.sha, head);
  assert.deepEqual(stages(ctx),
    ['gates:start', 'gates:ok', 'acquire:start', 'acquire:ok', 'push:start', 'push:ok', 'smoke:start', 'smoke:ok', 'cleanup:ok', 'release:ok']);
  const withMachine = events(ctx, 'council-evidence').filter((x) => x.machine);
  assert.ok(withMachine.every((x) => x.machine === 'ct111'));
  // Ruling R7: gate output is cleaned out of the workspace, the screenshots stay.
  assert.equal(existsSync(path.join(ctx.ws.dir, '.council')), false);
  assert.ok(existsSync(path.join(ctx.ws.dir, 'reports', 'screenshots', 'notes-mobile-webkit.png')));
});

test('Plan 8\'s checks for this commit are reused: no verify or browser run, only the axe pass', async () => {
  const ctx = await ctxFor({ councilTools: { axe: axeFile() } });
  const fake = fakeGatesRun();
  // Ruling R8: the foundation's global set-up deletes reports/screenshots when Playwright starts, so the
  // build's screenshots must be copied in after the gates.
  const run = async (o) => { rmSync(path.join(o.cwd, 'reports', 'screenshots'), { recursive: true, force: true }); return fake.run(o); };
  const e = await collectEvidence(ctx, { project: { ...project, checks: buildChecks() }, head, round: 1, deps: { run, helpers: okChecks, getMachineProvider: () => null, createSsh: () => fakeSsh([]).ssh } });
  assert.deepEqual(e.gates.source, { verify: 'build', browser: 'build', a11y: 'council' });
  assert.equal(e.gates.verify.status, 'failed');
  assert.equal(e.gates.tests.length, 4);
  assert.equal(e.gates.browser.length > 0, true);
  assert.equal(e.gates.crossing.routes, 31);
  assert.equal(e.gates.a11y.length, 2);
  assert.deepEqual(fake.calls.map((c) => c.step), ['npm-ci', 'build', 'a11y']);
  assert.ok(existsSync(path.join(ctx.ws.dir, 'reports', 'screenshots', 'notes-mobile-webkit.png')));
  assert.deepEqual(e.gates.screenshots.map((x) => x.file).sort(), ['reports/screenshots/notes-mobile-webkit.png', 'reports/screenshots/people-mobile-chromium.png']);
  assert.deepEqual(e.gates.screenshots.find((x) => x.page === 'notes'), { page: 'notes', project: 'mobile-webkit', file: 'reports/screenshots/notes-mobile-webkit.png' });
  assert.ok(existsSync(path.join(e.shotsDir, 'people-mobile-chromium.png')));
  assert.deepEqual(stages(ctx).slice(0, 3), ['reuse:ok', 'gates:start', 'gates:ok']);
});

test('reused verify and browser with axe off: no own gates and no gates events', async () => {
  const ctx = await ctxFor();
  const { run, calls } = fakeGatesRun();
  const e = await collectEvidence(ctx, { project: { ...project, checks: buildChecks() }, head, round: 1, deps: { run, helpers: okChecks, getMachineProvider: () => null, createSsh: () => fakeSsh([]).ssh } });
  assert.equal(calls.length, 0);
  assert.deepEqual(e.gates.source, { verify: 'build', browser: 'build', a11y: null });
  assert.equal(e.gates.axe.status, 'off');
  assert.equal(e.gatesNote, null);
  assert.deepEqual(stages(ctx), ['reuse:ok']);
});

test('reuseChecks: a passed verify with no test report is not reused; a failed one is; an unreadable report is missing', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'playwright.json'), 'not json');
  assert.equal(reuseChecks({ verify: { status: 'passed', summary: '', output: '' }, browser: { status: 'passed' }, reports: [] }).verify, null);
  assert.equal(reuseChecks({ verify: { status: 'failed', summary: 'The lint check fails.', output: 'x' }, browser: { status: 'skipped' }, reports: [] }).verify.status, 'failed');
  assert.equal(reuseChecks({ verify: { status: 'failed' }, browser: { status: 'failed' }, reports: [path.join(dir, 'playwright.json')] }).browser, null);
  assert.deepEqual(reportFiles(null), { vitest: null, playwright: null, crossing: null, screenshots: null });
  // a passed verify with its vitest report is reused, with the cases
  cpSync(path.join(FX, 'vitest.json'), path.join(dir, 'vitest.json'));
  const r = reuseChecks({ verify: { status: 'passed', summary: '', output: '' }, browser: { status: 'missing' }, reports: [path.join(dir, 'vitest.json')] });
  assert.equal(r.verify.status, 'passed');
  assert.equal(r.tests.length, 4);
  assert.equal(reuseChecks({ verify: { status: 'skipped' }, browser: { status: 'skipped' }, reports: [path.join(dir, 'vitest.json')] }).verify, null);
  assert.deepEqual(reuseChecks(null), { verify: null, tests: null, browser: null, crossing: null, screenshotsDir: null });
});

test('mergeGates: a browser step that exits 0 with no report is "could not read", never clean (Ruling R20)', () => {
  const steps = { 'npm-ci': 0, lint: null, typecheck: null, licences: null, vitest: null, build: 0, browser: 0, a11y: null };
  const own = { steps, verify: null, tests: null, browser: null, a11y: null, crossing: null, screenshots: [], logs: {}, axe: { status: 'ok' }, note: null, source: {} };
  const g = mergeGates({ verify: { status: 'failed', summary: '', output: '' }, tests: null, browser: null, crossing: null, screenshotsDir: null }, own);
  assert.equal(g.browser, null);
  assert.equal(g.source.browser, 'council');
  assert.match(g.note, /could not read the page check results/);
  assert.match(g.note, /could not read the accessibility scan results/);
});

test('Plan 8 report paths outside the build folder are ignored', async () => {
  const ctx = await ctxFor();
  const elsewhere = tmp();
  cpSync(path.join(FX, 'playwright.json'), path.join(elsewhere, 'playwright.json'));
  const { run, calls } = fakeGatesRun();
  const checks = { verify: { status: 'failed', summary: '', output: '' }, browser: { status: 'failed', summary: '', output: '' }, reports: [path.join(elsewhere, 'playwright.json')] };
  const e = await collectEvidence(ctx, { project: { ...project, checks }, head, round: 1, deps: { run, helpers: okChecks, getMachineProvider: () => null, createSsh: () => fakeSsh([]).ssh } });
  assert.deepEqual(calls.map((c) => c.step), ['npm-ci', 'build', 'browser']);
  assert.deepEqual(e.gates.source, { verify: 'build', browser: 'council', a11y: null });
});

test('same commit again: the saved evidence, no gates and no machine; a new commit runs again', async () => {
  const machine = fakeMachine({ id: 'ct111' });
  const { provider, calls } = fakeProvider({ machine });
  const ctx = await ctxFor();
  const first = await collectEvidence(ctx, { project, head, round: 1, deps: { run: fakeGatesRun().run, helpers: okChecks, getMachineProvider: () => provider, createSsh: () => passingSsh().ssh } });
  assert.equal(acquires(calls).length, 1);

  // A new council workspace for the same commit (the hook clones afresh each call).
  const sha1 = head;
  const again = { ...ctx, ws: { dir: await makeRepo({ 'README.md': 'app\n' }) } };
  const fake = fakeGatesRun();
  const second = await collectEvidence(again, { project, head: sha1, round: 1, deps: { run: fake.run, helpers: okChecks, getMachineProvider: () => provider, createSsh: () => passingSsh().ssh } });
  assert.deepEqual(second, first);
  assert.equal(acquires(calls).length, 1);
  assert.equal(fake.calls.length, 0);
  assert.equal(events(ctx, 'council-evidence').filter((x) => x.stage === 'cached').length, 1);
  // Ruling R6: the saved screenshots are copied back into the new workspace for the Design reviewer.
  assert.ok(existsSync(path.join(again.ws.dir, 'reports', 'screenshots', 'notes-mobile-webkit.png')));

  const next = await ctxFor({ files: { 'README.md': 'app, after a fix\n' } });
  next.log = ctx.log; next.state = ctx.state;
  const third = await collectEvidence(next, { project, head, round: 2, deps: { run: fakeGatesRun().run, helpers: okChecks, getMachineProvider: () => provider, createSsh: () => passingSsh().ssh } });
  assert.notEqual(head, sha1);
  assert.equal(acquires(calls).length, 2);
  assert.equal(ctx.state.council.evidence.sha, head);
  assert.equal(third.shotsDir, path.join(project.buildDir, 'council', 'round-2', 'screenshots'));
});

test('no machine provider: the gates still run; the smoke is "missing" with a plain note', async () => {
  const e = await collectEvidence(await ctxFor(), { project, head, round: 1, deps: { run: fakeGatesRun().run, helpers: okChecks, getMachineProvider: () => null, createSsh: () => fakeSsh([]).ssh } });
  assert.ok(e.gates);
  assert.deepEqual([e.smoke, e.smokeStatus, e.smokeNote, e.machine], [null, 'missing', 'No test machine is set up (factory.machines in the config), so the reliability test did not run.', null]);
});

test('a provider config error is "missing", with its plain message; ssh is made from factory.machines (Ruling R15)', async () => {
  const seen = [];
  const deps = {
    run: fakeGatesRun().run, helpers: okChecks,
    getMachineProvider: (factory, { ssh }) => { seen.push(ssh); throw new MachineError('config', 'No factory machines are set up.'); },
    createSsh: (machines) => { seen.push(machines); return { tag: 'ssh' }; },
  };
  const ctx = await ctxFor();
  const e = await collectEvidence(ctx, { project: { ...project, factory: { machines: { sshBin: '/opt/ssh' } } }, head, round: 1, deps });
  assert.deepEqual(seen, [{ sshBin: '/opt/ssh' }, { tag: 'ssh' }]);
  assert.deepEqual([e.smokeStatus, e.smokeNote], ['missing', 'No test machine is set up (factory.machines in the config), so the reliability test did not run. No factory machines are set up.']);
});

test('SSH drops during the smoke: error, and the machine is still cleaned and released', async () => {
  const machine = fakeMachine({ id: 'ct111' });
  const { ssh, calls } = fakeSsh([{ match: 'tar -x' }, { match: 'run-smoke.sh', code: 255, stderr: 'Connection reset' }, { match: 'rm -rf' }]);
  const ctx = await ctxFor();
  const e = await collectEvidence(ctx, { project, head, round: 1, deps: { run: fakeGatesRun().run, helpers: okChecks, getMachineProvider: () => fakeProvider({ machine }).provider, createSsh: () => ssh } });
  assert.deepEqual([e.smoke, e.smokeStatus], [null, 'error']);
  assert.match(e.smokeNote, /could not reach the test machine/);
  assert.equal(machine.released, 1);
  assert.equal(calls.at(-1).kind, 'exec');
  assert.match(calls.at(-1).script, /rm -rf '\/srv\/hf-factory\/runs\/acme-r1\/smoke-app'/);
  assert.ok(stages(ctx).includes('smoke:error'));
});

test('the push fails: no smoke run, the machine is still cleaned and released', async () => {
  const machine = fakeMachine({ id: 'ct111' });
  const { ssh, calls } = fakeSsh([{ match: 'tar -x', code: 2, stderr: 'tar: short read' }]);
  const ctx = await ctxFor();
  const e = await collectEvidence(ctx, { project, head, round: 1, deps: { run: fakeGatesRun().run, helpers: okChecks, getMachineProvider: () => fakeProvider({ machine }).provider, createSsh: () => ssh } });
  assert.deepEqual([e.smoke, e.smokeStatus, e.smokeNote], [null, 'error', 'The app could not be copied to the test machine 192.168.1.111.']);
  assert.equal(calls.filter((c) => c.kind === 'exec').length, 2);
  assert.equal(machine.released, 1);
  assert.deepEqual(stages(ctx).slice(2), ['acquire:start', 'acquire:ok', 'push:start', 'push:error', 'cleanup:ok', 'release:ok']);
});

test('acquire throws, or release throws: plain notes, never a throw', async () => {
  const a = await collectEvidence(await ctxFor(), { project, head, round: 1, deps: { run: fakeGatesRun().run, helpers: okChecks, getMachineProvider: () => fakeProvider({ acquireError: new Error('every host is busy') }).provider, createSsh: () => fakeSsh([]).ssh } });
  assert.deepEqual([a.smokeStatus, a.smokeNote, a.machine], ['error', 'The test machine could not be started (every host is busy).', null]);
  const busy = new MachineError('busy', 'Every factory machine is in use: hf-build (preview of acme).');
  const b0 = await collectEvidence(await ctxFor(), { project, head, round: 1, deps: { run: fakeGatesRun().run, helpers: okChecks, getMachineProvider: () => fakeProvider({ acquireError: busy }).provider, createSsh: () => fakeSsh([]).ssh } });
  assert.deepEqual([b0.smokeStatus, b0.smokeNote], ['error', 'The test machine could not be started (Every factory machine is in use: hf-build (preview of acme)).']);
  const machine = fakeMachine({ id: 'ct111' });
  const ctx = await ctxFor();
  const b = await collectEvidence(ctx, { project, head, round: 1, deps: { run: fakeGatesRun().run, helpers: okChecks, getMachineProvider: () => fakeProvider({ machine, releaseError: new Error('lock busy') }).provider, createSsh: () => passingSsh().ssh } });
  assert.equal(b.smoke.passed, true);
  assert.equal(machine.released, 1);
  assert.match(b.smokeNote, /The test machine ct111 could not be fully cleaned up \(lock busy\); the next run cleans it first\./);
  assert.equal(stages(ctx).at(-1), 'release:error');
});

test('a clean-up problem is noted and the machine is still released', async () => {
  const machine = fakeMachine({ id: 'ct111' });
  const { ssh } = fakeSsh([{ match: 'tar -x' }, { match: 'run-smoke.sh', stdout: log('smoke-passed.log') }, { match: 'rm -rf', code: 1, stderr: 'rm: cannot remove: busy' }]);
  const e = await collectEvidence(await ctxFor(), { project, head, round: 1, deps: { run: fakeGatesRun().run, helpers: okChecks, getMachineProvider: () => fakeProvider({ machine }).provider, createSsh: () => ssh } });
  assert.equal(e.smokeNote, 'The test machine ct111 could not be fully cleaned up (rm: cannot remove: busy); the next run cleans it first.');
  assert.equal(machine.released, 1);
});

test('no test database: gates null with the plain reason; the smoke still runs', async () => {
  const machine = fakeMachine({ id: 'ct111' });
  const ctx = await ctxFor();
  const { run, calls } = fakeGatesRun();
  const e = await collectEvidence(ctx, { project, head, round: 1, deps: { run, helpers: noDb, getMachineProvider: () => fakeProvider({ machine }).provider, createSsh: () => passingSsh().ssh } });
  assert.equal(e.gates, null);
  assert.equal(e.gatesNote, NO_DB);
  assert.equal(calls.length, 0);
  assert.equal(e.smoke.passed, true);
  assert.equal(e.shotsDir, null);
  assert.deepEqual(stages(ctx).slice(0, 2), ['gates:start', 'gates:error']);
});

test('no test database but Plan 8\'s checks present: the reused evidence stands, the note says the axe pass did not run', async () => {
  const ctx = await ctxFor({ councilTools: { axe: axeFile() } });
  const { run, calls } = fakeGatesRun();
  const e = await collectEvidence(ctx, { project: { ...project, checks: buildChecks() }, head, round: 1, deps: { run, helpers: noDb, getMachineProvider: () => null, createSsh: () => fakeSsh([]).ssh } });
  assert.equal(calls.length, 0);
  assert.equal(e.gates.source.verify, 'build');
  assert.equal(e.gates.source.browser, 'build');
  assert.equal(e.gates.source.a11y, null);
  assert.equal(e.gates.a11y, null);
  assert.equal(e.gates.axe.status, 'ok');
  assert.equal(e.gatesNote, NO_DB);
  assert.ok(existsSync(path.join(e.shotsDir, 'notes-mobile-webkit.png')));
});

test('symlinks in the build\'s screenshots are not copied', async () => {
  const ctx = await ctxFor();
  const checks = buildChecks();
  const secret = path.join(tmp(), 'secret.txt');
  writeFileSync(secret, 'not for the council');
  symlinkSync(secret, path.join(project.buildDir, 'reports', 'screenshots', 'leak.png'));
  const e = await collectEvidence(ctx, { project: { ...project, checks }, head, round: 1, deps: { run: fakeGatesRun().run, helpers: okChecks, getMachineProvider: () => null, createSsh: () => fakeSsh([]).ssh } });
  assert.equal(existsSync(path.join(ctx.ws.dir, 'reports', 'screenshots', 'leak.png')), false);
  assert.equal(readdirSync(e.shotsDir).includes('leak.png'), false);
});
