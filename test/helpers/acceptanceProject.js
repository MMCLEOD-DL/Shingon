// A good, fictional project folder for the acceptance checker (Plan 12 Task 11), built with the owners' own
// writers (Plan 7's saveApprovedBrief and saveProject, Plan 8's newBuild/saveBuild, Plan 9's writeCouncilReport,
// Plan 10's deployment store), so the fixture cannot drift from their validators. Each MUTATIONS entry breaks one thing.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { saveProject } from '../../src/factory/projects.js';
import { saveApprovedBrief } from '../../src/factory/brief.js';
import { newBuild, saveBuild, buildDirOf, loadBuild } from '../../src/factory/buildState.js';
import { writeCouncilReport } from '../../src/council/reportFile.js';
import { newDeployment, addHistory, saveDeployment, loadDeployment } from '../../src/factory/deployments/store.js';
import { approvedBrief } from './briefFixtures.js';

export const SLUG = 'acme-expenses';
// Real run ids: Plan 11's readCouncilReport reads only a report whose run id Conductor could have made.
export const RUNS = Object.freeze({ build: '20261028-090000-b001', change: '20261028-140000-c001' });
const SHA = 'a'.repeat(40);

const writeJson = (file, obj) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`); };
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const EXPENSE_ENTRY = {
  id: 'expense-entry', title: 'Enter an expense', story: 'A member of staff photographs a receipt and checks the amount, VAT and category.',
  roles: ['Staff'], data: ['Claim'],
  acceptance: [
    { id: 'expense-entry#1', given: 'Alice is signed in as Staff', when: 'she enters a £12.40 taxi receipt with £2.07 VAT dated 3 March 2026', then: 'her claims list shows Travel £12.40 dated 3 March 2026' },
    { id: 'expense-entry#2', given: 'Alice is signed in as Staff', when: 'she enters an amount of £0.00', then: 'she sees "The amount must be more than £0"' },
  ],
};
const MONTHLY_REPORT = {
  id: 'monthly-report', title: 'Monthly expenses report', story: 'Finance downloads approved claims for one month as a PDF and a spreadsheet.',
  roles: ['Finance'], data: ['Claim'],
  acceptance: [{ id: 'monthly-report#1', given: "Jamie's £45.00 fuel (VAT £7.50) and £8.75 lunch (VAT £1.46) were approved in March 2026", when: 'Finance downloads the March 2026 report', then: 'Jamie\'s total shows £53.75, VAT £8.96' }],
};
const MILEAGE = {
  id: 'mileage', title: 'Claim mileage', story: 'A member of staff claims business miles driven in their own car.',
  roles: ['Staff'], data: ['Claim'],
  acceptance: [{ id: 'mileage#1', given: 'Alice is signed in as Staff', when: 'she claims 10 miles on 4 March 2026', then: 'her claims list shows Mileage £4.50 dated 4 March 2026' }],
};

const vitest = (titles, failed = []) => ({
  numTotalTests: titles.length + failed.length, success: failed.length === 0,
  testResults: [{
    name: '/app/apps/server/test/accept.test.ts', status: failed.length ? 'failed' : 'passed',
    assertionResults: [
      ...titles.map((t) => ({ ancestorTitles: ['acceptance'], fullName: `acceptance ${t}`, title: t, status: 'passed' })),
      ...failed.map((t) => ({ ancestorTitles: ['acceptance'], fullName: `acceptance ${t}`, title: t, status: 'failed' })),
    ],
  }],
});

const BASE_TESTS = ['an expense is saved [expense-entry#1]', 'a zero amount is refused [expense-entry#2]', 'the March report totals [monthly-report#1]'];
const PAGES = [{ page: 'claims', path: '/claims' }, { page: 'receipt-check', path: '/receipts/check' }];
const SIZES = { 'desktop-chromium': [1280, 800], 'mobile-chromium': [390, 844], 'mobile-webkit': [390, 844] };

async function writeRun(projectDir, runId, { kind, tests, verdict, warnings }) {
  const dir = buildDirOf(projectDir, runId);
  const reports = path.join(dir, 'reports');
  writeJson(path.join(reports, 'vitest.json'), vitest(tests));
  writeJson(path.join(reports, 'crossing.json'), { generatedAt: '2026-10-28T09:30:00.000Z', routes: 34, checks: 136, failures: [] });
  writeJson(path.join(reports, 'screenshots', 'manifest.json'), PAGES.flatMap((p) => Object.entries(SIZES).map(([project, [width, height]]) => ({
    page: p.page, path: p.path, project, width, height, file: `${p.page}-${project}.png`,
  }))));
  const build = newBuild({ runId, slug: SLUG, client: 'Acme Expenses Ltd', briefHash: 'f'.repeat(64), briefVersion: kind === 'change' ? 2 : 1,
    foundation: { repo: '/root/highland-foundation', tag: 'v0.2.0', commit: SHA }, now: new Date('2026-10-28T09:00:00Z'), kind });
  saveBuild(dir, {
    ...build, phase: 'done', status: 'approved', approvedSha: SHA,
    checks: { sha: SHA, verify: { status: 'passed', summary: 'ok' }, browser: { status: 'passed', summary: 'ok' },
      reports: ['vitest.json', 'crossing.json', 'screenshots'].map((n) => path.join(reports, n)) },
    council: { status: verdict, overridden: false, sha: SHA },
  });
  await writeCouncilReport(dir, { round: 1, verdict, blocking: [], warnings, notes: [], overridden: false, text: `Council report: ${verdict}`,
    checked: ['correctness', 'legal'], coverage: null, files: [] }, { sha: SHA, runId });
}

export async function makeAcceptanceProject(root, { mutate } = {}) {
  const projectDir = path.join(root, SLUG);
  mkdirSync(projectDir, { recursive: true });
  saveProject(projectDir, {
    schema: 1, slug: SLUG, client: 'Acme Expenses Ltd', createdAt: '2026-10-28T08:00:00.000Z', status: 'shipped',
    foundation: { repo: '/root/highland-foundation', tag: 'v0.2.0', commit: SHA },
    approved: { sha: SHA, at: '2026-10-28T15:00:00.000Z', runId: RUNS.change, briefVersion: 2 }, builtFromBrief: 2,
  });

  const v1 = approvedBrief({
    client: 'Acme Expenses Ltd', slug: SLUG, features: [EXPENSE_ENTRY, MONTHLY_REPORT], exampleSeq: { 'expense-entry': 2, 'monthly-report': 1 },
    modules: ['ocr', 'xlsx-export', 'pdf-export'],
    outputs: [{ name: 'Monthly expenses report', format: 'pdf', roles: ['Finance'], description: 'Approved claims for one month, totals per person' }],
  });
  saveApprovedBrief(projectDir, v1);
  saveApprovedBrief(projectDir, { ...v1, version: 2, revisedFrom: 1, features: [EXPENSE_ENTRY, MONTHLY_REPORT, MILEAGE],
    exampleSeq: { ...v1.exampleSeq, mileage: 1 }, createdAt: '2026-10-28T12:00:00.000Z', approvedAt: '2026-10-28T12:30:00.000Z' });

  const correctness = { member: 'correctness', tool: 'ai', title: 'A long merchant name may wrap on a phone', grade: 'warning' };
  await writeRun(projectDir, RUNS.build, { kind: 'build', tests: BASE_TESTS, verdict: 'approved-with-warnings', warnings: [correctness] });
  await writeRun(projectDir, RUNS.change, { kind: 'change', tests: [...BASE_TESTS, 'miles are paid at 45p [mileage#1]'], verdict: 'approved', warnings: [] });

  writeJson(path.join(projectDir, 'app', 'app-profile.json'), { schema: 1, modules: ['ocr', 'xlsx-export', 'pdf-export'], policy: { outbound: [], residency: 'uk' } });
  writeJson(path.join(projectDir, 'app', 'licence-exceptions.json'), {});

  let dep = newDeployment({
    name: 'test-box', project: SLUG, host: '192.168.1.111', ssh: { user: 'hf', port: null, keyPath: null }, bundleDir: '/opt/acme',
    hosting: 'client-box', imageDelivery: 'tar', access: 'ssh', origin: 'http://192.168.1.111:8080', site: ':8080',
  });
  dep = addHistory(dep, { version: '1.0.0', outcome: 'installed', detail: 'first release', at: '2026-10-28T10:00:00.000Z' });
  dep = addHistory(dep, { version: '1.1.0', from: '1.0.0', outcome: 'updated', detail: 'minor release', at: '2026-10-28T16:00:00.000Z' });
  saveDeployment(projectDir, { ...dep, setup: { step: 'done', at: '2026-10-28T10:00:00.000Z' }, currentVersion: '1.1.0', foundation: 'v0.2.0' });

  if (mutate) await mutate(projectDir);
  return projectDir;
}

// Small editors over the fixture's files.
const runFile = (projectDir, runId, ...rel) => path.join(buildDirOf(projectDir, runId), ...rel);
const edit = (file, fn) => { const o = readJson(file); fn(o); writeJson(file, o); };
const editTests = (projectDir, runId, fn) => edit(runFile(projectDir, runId, 'reports', 'vitest.json'), (v) => { v.testResults[0].assertionResults = fn(v.testResults[0].assertionResults); });
const editDeployment = (projectDir, fn) => saveDeployment(projectDir, fn(loadDeployment(projectDir, 'test-box')));

export const MUTATIONS = {
  crossing: (d) => edit(runFile(d, RUNS.build, 'reports', 'crossing.json'), (c) => {
    c.failures = [{ sentence: 'A member could read another member\'s receipt at GET /api/receipts/:id.' }];
  }),
  'council-blocked': (d) => edit(runFile(d, RUNS.build, 'council-report.json'), (r) => {
    r.verdict = 'blocked'; r.blocking = [{ member: 'security', tool: 'ai', title: 'Receipts are served without a sign-in check', grade: 'blocking' }];
  }),
  'council-overridden': (d) => {
    const dir = buildDirOf(d, RUNS.build);
    const b = loadBuild(dir);
    saveBuild(dir, { ...b, council: { ...b.council, overridden: true } });
  },
  'example-failed': (d) => {
    for (const runId of [RUNS.build, RUNS.change]) {
      editTests(d, runId, (tests) => tests.map((t) => (t.title.includes('[monthly-report#1]') ? { ...t, status: 'failed' } : t)));
    }
  },
  'example-missing': (d) => editTests(d, RUNS.change, (tests) => tests.filter((t) => !t.title.includes('[mileage#1]'))),
  'no-vitest-report': (d) => {
    const dir = buildDirOf(d, RUNS.build);
    const b = loadBuild(dir);
    saveBuild(dir, { ...b, checks: { ...b.checks, reports: b.checks.reports.filter((p) => path.basename(p) !== 'vitest.json') } });
  },
  'no-webkit': (d) => edit(runFile(d, RUNS.build, 'reports', 'screenshots', 'manifest.json'), (m) => {
    m.splice(m.findIndex((e) => e.page === 'receipt-check' && e.project === 'mobile-webkit'), 1);
  }),
  outbound: (d) => edit(path.join(d, 'app', 'app-profile.json'), (p) => { p.policy.outbound = ['azure-document-intelligence']; }),
  licence: (d) => edit(runFile(d, RUNS.build, 'council-report.json'), (r) => {
    r.warnings.push({ member: 'legal', tool: 'licences', title: 'some-lib@1.0.0 is under the LGPL-3.0 licence', grade: 'warning' });
  }),
  'rolled-back': (d) => editDeployment(d, (dep) => ({
    ...addHistory(dep, { version: '1.1.0', from: '1.0.0', outcome: 'rolled-back', detail: 'the health check failed', at: '2026-10-28T17:00:00.000Z' }),
    currentVersion: '1.0.0',
  })),
  'wrong-tag': (d) => edit(path.join(d, 'project.json'), (p) => { p.foundation.tag = 'v0.1.0'; }),
};
