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
  assert.match(byId(r).C3.evidence, new RegExp(`builds/${RUNS.build} has no Vitest report in its checks\\. Re-run the build's checks, or pass --tests <file> made with: npx vitest run --reporter=json --outputFile=<file>`));
});

test('--tests replaces the build\'s own Vitest report', async () => {
  const dir = await fx('no-vitest-report');
  const tests = path.join(buildDirOf(dir, RUNS.build), 'reports', 'vitest.json');
  const r = await checkAcceptance(dir, { build: RUNS.build, tests, deps: { loadBrief: () => approvedBrief() } });
  assert.match(byId(r).C3.evidence, /upload-receipt#1: no test carries \[upload-receipt#1\]/);
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
