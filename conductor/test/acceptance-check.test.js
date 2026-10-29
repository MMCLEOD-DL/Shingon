// Plan 12 Task 11: the acceptance checker reads a project folder and fills in every automated criterion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkAcceptance, renderResults, CRITERIA, FOUNDATION_V020_ROUTES } from '../spikes/acceptance/check-acceptance.mjs';
import { makeAcceptanceProject, MUTATIONS, RUNS } from './helpers/acceptanceProject.js';
import { approvedBrief } from './helpers/briefFixtures.js';
import { loadDeployment, saveDeployment, addHistory } from '../src/factory/deployments/store.js';
import { buildDirOf } from '../src/factory/buildState.js';

const fx = (name) => makeAcceptanceProject(mkdtempSync(path.join(tmpdir(), 'acc-')), { mutate: name ? MUTATIONS[name] : undefined });
const byId = (r) => Object.fromEntries(r.results.map((x) => [x.id, x]));
const OPTS = { build: RUNS.build, change: RUNS.change, deployment: 'test-box' };

test('every criterion is listed once, C1 to C17, with its spec reference', () => {
  assert.deepEqual(CRITERIA.map((c) => c.id), Array.from({ length: 17 }, (_, i) => `C${i + 1}`));
  assert.ok(CRITERIA.every((c) => c.spec && c.title && ['auto', 'operator'].includes(c.how)));
  assert.equal(FOUNDATION_V020_ROUTES, 31);
});

test('a good project passes every automated criterion and leaves the rest to the operator', async () => {
  const r = await checkAcceptance(await fx(), OPTS);
  const s = byId(r);
  for (const id of ['C1', 'C2', 'C3', 'C6', 'C10', 'C12', 'C13', 'C14', 'C17']) assert.equal(s[id].status, 'pass', `${id}: ${s[id].evidence}`);
  for (const id of ['C4', 'C5', 'C7', 'C8', 'C9', 'C11', 'C15', 'C16']) assert.equal(s[id].status, 'operator');
  assert.equal(r.ok, true);
  assert.match(s.C1.evidence, /34 routes \(foundation 31\), 0 problems/);
  assert.match(s.C3.evidence, /4 of 4 examples proven by passing tests: expense-entry#1, expense-entry#2, monthly-report#1, mileage#1/);
  assert.match(s.C14.evidence, /1 new example \(mileage#1\) proven/);
});

test('each broken thing fails its own criterion, with a plain sentence', async () => {
  const cases = [
    ['crossing', 'C1', /1 problem: /],
    ['council-blocked', 'C2', /blocked, with 1 blocking item/],
    ['council-overridden', 'C2', /the operator overrode the council/],
    ['example-failed', 'C3', /monthly-report#1: its test failed/],
    ['example-missing', 'C14', /mileage#1: no test carries \[mileage#1\]/],
    ['no-webkit', 'C6', /"receipt-check" has no phone screenshot in WebKit/],
    ['outbound', 'C12', /allows azure-document-intelligence, but the brief allows nothing/],
    ['licence', 'C13', /Legal warning about a licence/],
    ['rolled-back', 'C10', /last update was rolled back/],
    ['wrong-tag', 'C17', /built on v0\.1\.0, but this run expects v0\.2\.0/],
  ];
  for (const [name, id, why] of cases) {
    const r = await checkAcceptance(await fx(name), OPTS);
    assert.equal(byId(r)[id].status, 'fail', name);
    assert.match(byId(r)[id].evidence, why, name);
    assert.equal(r.ok, false);
  }
});

test('an example without an id is a fail, never a count', async () => {
  const brief = approvedBrief(); brief.features[0].acceptance[0] = { ...brief.features[0].acceptance[0], id: undefined };
  const r = await checkAcceptance(await fx(), { ...OPTS, deps: { loadBrief: () => brief } });
  assert.equal(byId(r).C3.status, 'fail');
  assert.match(byId(r).C3.evidence, /has no id, so no test can be traced to it/);
});

test('a missing test report is a fail that says which run and how to supply one', async () => {
  // build.json checks.reports without a Vitest JSON entry
  const r = await checkAcceptance(await fx('no-vitest-report'), { build: RUNS.build });
  assert.equal(byId(r).C3.status, 'fail');
  assert.match(byId(r).C3.evidence, new RegExp(`builds/${RUNS.build} has no Vitest report in its checks\\. Leave factory\\.build\\.testCommand unset \\(the factory's own checks write the report\\), then run the build again\\.`));
});

test('a failing run report cannot be replaced by a hand-made one: there is no flag for it', async () => {
  const dir = await fx('example-failed');
  const good = path.join(dir, 'good-vitest.json');
  writeFileSync(good, JSON.stringify({ testResults: [{ assertionResults: ['expense-entry#1', 'expense-entry#2', 'monthly-report#1', 'mileage#1'].map((id) => ({ title: `[${id}]`, fullName: `[${id}]`, status: 'passed' })) }] }));
  const r = await checkAcceptance(dir, { ...OPTS, tests: good, changeTests: good });   // unknown options are ignored
  assert.equal(byId(r).C3.status, 'fail');
  assert.match(byId(r).C3.evidence, /monthly-report#1: its test failed/);
  const cli = new URL('../spikes/acceptance/check-acceptance.mjs', import.meta.url).pathname;
  for (const flag of ['--tests', '--change-tests']) {
    const out = spawnSync(process.execPath, [cli, dir, '--build', RUNS.build, '--change', RUNS.change, flag, good], { encoding: 'utf8' });
    assert.equal(out.status, 2, flag);
    assert.match(out.stderr, /Usage:/, flag);
  }
});

test('a council report that is missing or not this run\'s is a fail', async () => {
  const dir = await fx();
  rmSync(path.join(buildDirOf(dir, RUNS.build), 'council-report.json'));
  const r = await checkAcceptance(dir, OPTS);
  assert.equal(byId(r).C2.status, 'fail');
  assert.match(byId(r).C2.evidence, new RegExp(`builds/${RUNS.build} has no finished council report`));
});

test('without --change and --deployment, C10 and C14 fail and say what to pass', async () => {
  const s = byId(await checkAcceptance(await fx(), { build: RUNS.build }));
  assert.equal(s.C10.status, 'fail');
  assert.match(s.C10.evidence, /--deployment <name>/);
  assert.equal(s.C14.status, 'fail');
  assert.match(s.C14.evidence, /--change <runId>/);
  assert.equal(s.C3.status, 'fail');   // brief v2's mileage#1 is proven only in the change run, so the build's report cannot prove it
  assert.match(s.C3.evidence, /mileage#1: no test carries \[mileage#1\]/);
});

test('C10: a confirmed update passes, trailing already-on is ignored; an update not newer, or none, fails', async () => {
  const history = async (entries, currentVersion) => {
    const dir = await fx();
    const base = loadDeployment(dir, 'test-box');
    let dep = { ...base, history: [] };
    for (const e of entries) dep = addHistory(dep, { at: '2026-10-28T10:00:00.000Z', from: null, detail: '', ...e });
    saveDeployment(dir, { ...dep, currentVersion });
    return byId(await checkAcceptance(dir, OPTS)).C10;
  };
  const confirmed = await history([{ version: '1.0.0', outcome: 'installed' }, { version: '1.1.0', from: '1.0.0', outcome: 'confirmed' }, { version: '1.1.0', outcome: 'already-on' }], '1.1.0');
  assert.equal(confirmed.status, 'pass', confirmed.evidence);
  assert.match(confirmed.evidence, /installed 1\.0\.0, then confirmed 1\.1\.0/);
  const none = await history([{ version: '1.0.0', outcome: 'installed' }], '1.0.0');
  assert.equal(none.status, 'fail');
  assert.match(none.evidence, /no update/);
  const notNewer = await history([{ version: '1.1.0', outcome: 'installed' }, { version: '1.1.0', outcome: 'updated' }], '1.1.0');
  assert.equal(notNewer.status, 'fail');
  assert.match(notNewer.evidence, /not newer than the installed 1\.1\.0/);
  const urgent = await history([{ version: '1.0.0', outcome: 'installed' }, { version: '1.1.0', outcome: 'updated' }, { version: '1.2.0', outcome: 'urgent' }], '1.1.0');
  assert.equal(urgent.status, 'fail');
  assert.match(urgent.evidence, /urgent/);
});

test('a missing deployment record is a fail naming it', async () => {
  const s = byId(await checkAcceptance(await fx(), { ...OPTS, deployment: 'office-box' }));
  assert.equal(s.C10.status, 'fail');
  assert.match(s.C10.evidence, /no deployment called "office-box"/);
});

test('a damaged report file is a fail, never a crash', async () => {
  const dir = await fx();
  writeFileSync(path.join(buildDirOf(dir, RUNS.build), 'reports', 'crossing.json'), '{ not json');
  const s = byId(await checkAcceptance(dir, OPTS));
  assert.equal(s.C1.status, 'fail');
  assert.match(s.C1.evidence, /crossing\.json could not be read/);
});

test('renderResults gives the operator a table with every criterion', async () => {
  const r = await checkAcceptance(await fx(), OPTS);
  const md = renderResults({ slug: 'acme-expenses' }, r.results);
  assert.match(md, /\| C7 \| §2\.3, §2\.5 \|.*\| for the operator \|/);
  assert.equal((md.match(/^\| C\d+ /gm) ?? []).length, 17);
});

test('the CLI exits 2 with usage for bad arguments, 1 on a fail, 0 on a pass', async () => {
  const cli = new URL('../spikes/acceptance/check-acceptance.mjs', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const bad = run(await fx());                                   // no --build
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Usage: node spikes\/acceptance\/check-acceptance\.mjs <projectDir> --build <runId>/);
  assert.equal(run(await fx(), '--build', RUNS.build, '--nonsense').status, 2);
  assert.equal(run(await fx('crossing'), '--build', RUNS.build, '--change', RUNS.change, '--deployment', 'test-box').status, 1);
  const good = await fx(); const out = path.join(good, 'acceptance', 'checker.md');
  assert.equal(run(good, '--build', RUNS.build, '--change', RUNS.change, '--deployment', 'test-box', '--out', out).status, 0);
  assert.match(readFileSync(out, 'utf8'), /^\| C17 /m);
});

// ---- fail closed (review fix round 1) ----

test('a build whose records do not belong together fails, whatever its reports say', async () => {
  const cases = [
    ['build-stopped', 'C2', /was not approved \(its status is stopped\)/],
    ['report-older-commit', 'C2', /reviewed an earlier version/],
    ['stale-checks', 'C1', /final checks ran on a different commit/],
    ['other-run-record', 'C2', /belongs to run 20261027-090000-0001/],
    ['report-outside', 'C1', /lists crossing\.json outside its own reports folder/],
  ];
  for (const [name, id, why] of cases) {
    const r = await checkAcceptance(await fx(name), OPTS);
    assert.equal(byId(r)[id].status, 'fail', name);
    assert.match(byId(r)[id].evidence, why, name);
    assert.equal(r.ok, false, name);
  }
  const swapped = byId(await checkAcceptance(await fx(), { ...OPTS, build: RUNS.change }));
  for (const id of ['C1', 'C2', 'C3', 'C6', 'C13']) assert.equal(swapped[id].status, 'fail', id);
  assert.match(swapped.C2.evidence, /is a change run, not a build run\. Pass it with --change/);
});

test('a named change run that does not load fails every criterion that reads it, with no fallback to the build', async () => {
  const s = byId(await checkAcceptance(await fx(), { ...OPTS, change: '20261028-150000-ffff' }));
  for (const id of ['C1', 'C3', 'C6', 'C12', 'C13', 'C14']) {
    assert.equal(s[id].status, 'fail', id);
    assert.match(s[id].evidence, /builds\/20261028-150000-ffff has no build\.json/, id);
  }
  assert.equal(s.C2.status, 'pass', s.C2.evidence);
});

test('a hand edit to the app\'s profile or licence exceptions fails C12 or C13 (Ruling 9), and C15 notes it', async () => {
  const p = byId(await checkAcceptance(await fx('hand-edited-profile'), OPTS));
  assert.equal(p.C12.status, 'fail');
  assert.match(p.C12.evidence, /app\/app-profile\.json was changed by hand after the approved commit/);
  assert.match(p.C15.evidence, /changes that are not committed \(1 path\)/);
  const e = byId(await checkAcceptance(await fx('hand-edited-exceptions'), OPTS));
  assert.equal(e.C13.status, 'fail');
  assert.match(e.C13.evidence, /app\/licence-exceptions\.json was changed by hand/);
  const good = byId(await checkAcceptance(await fx(), OPTS));
  assert.doesNotMatch(good.C15.evidence, /not committed/);
});

test('C12 reads the profile at the change\'s approved commit and names modules the brief did not ask for', async () => {
  const s = byId(await checkAcceptance(await fx('extra-module'), OPTS));
  assert.equal(s.C12.status, 'pass', s.C12.evidence);
  assert.match(s.C12.evidence, /also on, not in the brief: scheduled-jobs/);
});

test('C6 fails on a missing screenshot file or an overridden browser gate', async () => {
  const png = byId(await checkAcceptance(await fx('missing-png'), OPTS)).C6;
  assert.equal(png.status, 'fail');
  assert.match(png.evidence, /the screenshot "claims-mobile-webkit\.png" of "claims" is missing/);
  const over = byId(await checkAcceptance(await fx('browser-overridden'), OPTS)).C6;
  assert.equal(over.status, 'fail');
  assert.match(over.evidence, /browser checks failed and the build was approved anyway/);
});

test('C10 walks back past outcomes that changed nothing: a bad landing is never made calmer', async () => {
  const history = async (entries, currentVersion) => {
    const dir = await fx();
    let dep = { ...loadDeployment(dir, 'test-box'), history: [] };
    for (const e of entries) dep = addHistory(dep, { at: '2026-10-28T10:00:00.000Z', from: null, detail: '', ...e });
    saveDeployment(dir, { ...dep, currentVersion });
    return byId(await checkAcceptance(dir, OPTS)).C10;
  };
  const start = [{ version: '1.0.0', outcome: 'installed' }, { version: '1.1.0', outcome: 'updated' }];
  for (const [bad, after, why] of [['rolled-back', 'busy', /rolled back/], ['rolled-back', 'cancelled', /rolled back/], ['urgent', 'settings-error', /urgent/], ['lost-contact', 'already-on', /lost contact/]]) {
    const r = await history([...start, { version: '1.2.0', outcome: bad }, { version: '1.2.0', outcome: after }], '1.1.0');
    assert.equal(r.status, 'fail', `${bad} then ${after}`);
    assert.match(r.evidence, why, `${bad} then ${after}`);
  }
  const ok = await history([...start, { version: '1.1.0', outcome: 'busy' }, { version: '1.1.0', outcome: 'already-on' }], '1.1.0');
  assert.equal(ok.status, 'pass', ok.evidence);
});

// ---- final review fixes ----

test('C14 fails when the change brief brings no new worked examples', async () => {
  const dir = await fx();
  const brief = JSON.parse(readFileSync(path.join(dir, 'brief', 'brief-v2.json'), 'utf8'));
  brief.features = brief.features.filter((f) => f.id !== 'mileage');
  const s = byId(await checkAcceptance(dir, { ...OPTS, deps: { loadBrief: () => brief } }));
  assert.equal(s.C14.status, 'fail');
  assert.match(s.C14.evidence, /Brief v2 brings no new worked examples .* so the change has nothing new to prove/);
});

test('C10 names the version the change released and fails when the box is not on it', async () => {
  const good = byId(await checkAcceptance(await fx(), OPTS)).C10;
  assert.match(good.evidence, new RegExp(`current version 1\\.1\\.0, the version builds/${RUNS.change} released`));
  const dir = await fx();
  const run = JSON.parse(readFileSync(path.join(buildDirOf(dir, RUNS.change), 'change.json'), 'utf8'));
  writeFileSync(path.join(buildDirOf(dir, RUNS.change), 'change.json'), JSON.stringify({ ...run, release: { ...run.release, version: '1.2.0', tag: 'v1.2.0' } }));
  const off = byId(await checkAcceptance(dir, OPTS)).C10;
  assert.equal(off.status, 'fail');
  assert.match(off.evidence, /the box is on 1\.1\.0, but the change .* released 1\.2\.0/);
  const none = await fx();
  writeFileSync(path.join(buildDirOf(none, RUNS.change), 'change.json'), JSON.stringify({ ...run, release: undefined }));
  assert.match(byId(await checkAcceptance(none, OPTS)).C10.evidence, /has not released a version yet/);
});

test('C6 fails on a manifest entry with no page, and when no page has a usable screenshot', async () => {
  const dir = await fx();
  const manifest = path.join(buildDirOf(dir, RUNS.build), 'reports', 'screenshots', 'manifest.json');
  const m = JSON.parse(readFileSync(manifest, 'utf8'));
  writeFileSync(manifest, JSON.stringify([...m, { project: 'mobile-webkit', file: 'x.png' }]));
  const one = byId(await checkAcceptance(dir, OPTS)).C6;
  assert.equal(one.status, 'fail');
  assert.match(one.evidence, /an entry in the manifest names no page/);
  writeFileSync(manifest, JSON.stringify(m.map((e) => ({ ...e, file: 'gone.png' }))));
  const none = byId(await checkAcceptance(dir, OPTS)).C6;
  assert.equal(none.status, 'fail');
  assert.match(none.evidence, /no page has a usable screenshot/);
});
