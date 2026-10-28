// Plan 12 Task 11 Step 0: Plan 8's refusal of a brief with optional modules is lifted for foundation v0.2.0 and later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { briefProblems, MODULES_SINCE } from '../src/factory/split.js';
import { runBuild } from '../src/factory/build.js';
import { factoryConfig } from '../src/factory/config.js';
import { saveProject, loadProject } from '../src/factory/projects.js';
import { sampleBrief, makeFoundationRepo, makeProject } from './helpers/factoryFixtures.js';
import { team, setup } from './helpers/buildHarness.js';

const green = { verify: { status: 'passed', summary: 'ok', output: '' }, browser: { status: 'passed', summary: 'ok', output: '' }, reports: [] };
const splitCalls = (t) => t.author.calls.filter((c) => /Split this approved brief/.test(c.task)).length;

test('modules are refused before foundation v0.2.0 and accepted from it on', () => {
  const b = sampleBrief({ modules: ['ocr', 'xlsx-export'] });
  assert.equal(MODULES_SINCE, 'v0.2.0');
  assert.match(briefProblems(b).join('\n'), /needs optional modules \(ocr, xlsx-export\)/);                       // no tag: Plan 8's behaviour
  assert.match(briefProblems(b, { foundationTag: 'v0.1.0' }).join('\n'), /needs optional modules/);
  assert.deepEqual(briefProblems(b, { foundationTag: 'v0.2.0' }), []);
  assert.deepEqual(briefProblems(b, { foundationTag: 'v0.10.0' }), []);
  for (const odd of ['main', '0.2.0', 'v0.2', '']) assert.match(briefProblems(b, { foundationTag: odd }).join('\n'), /needs optional modules/, odd);
});

test('the lift changes no other refusal', () => {
  const b = sampleBrief({ modules: ['ocr'], kind: 'mobile-app' });
  assert.deepEqual(briefProblems(b, { foundationTag: 'v0.2.0' }), ['This brief is for "mobile-app", and the factory only builds web apps.']);
});

// A first build on a fake foundation tagged at `tag`, with factory.foundation.tag set to it.
async function firstBuild(tag) {
  const version = tag.slice(1);
  const repo = await makeFoundationRepo({ tag, extra: { 'foundation.json': `{"name":"highland-foundation","version":"${version}","commit":"${tag}"}\n` } });
  const { projectsRoot, slug } = makeProject();
  const factory = factoryConfig({ factory: { projectsRoot, foundation: { repo, tag }, build: { testCommand: 'node -e "process.exit(0)"', browserGate: false } } }, { env: {} });
  const finals = [];
  const deps = {
    loadBrief: () => sampleBrief({ modules: ['ocr'] }), renderBrief: (b) => `# ${b.client}`,
    currentBriefInfo: () => ({ version: 1, approvedAt: '2026-10-27T10:00:00Z', approvedBy: 'operator' }),
    runAppChecks: async () => green,
    runFinal: async (bctx) => { finals.push(bctx); return { status: 'ready', runId: bctx.build.runId, buildDir: bctx.buildDir }; },
  };
  const t = team();
  const out = await runBuild({ factory, slug, team: t, hooks: { escalate: async () => 'reject', approveBuild: async () => true },
    deps, baseDir: mkdtempSync(path.join(tmpdir(), 'build-ws-')), env: {} });
  return { out, t };
}

test('runBuild: a brief with modules is built on foundation v0.2.0 and refused on v0.1.0', async () => {
  const on2 = await firstBuild('v0.2.0');
  assert.doesNotMatch(on2.out.reason ?? '', /optional modules/);
  assert.equal(splitCalls(on2.t), 1, 'it reached the split');
  const on1 = await firstBuild('v0.1.0');
  assert.equal(on1.out.status, 'failed');
  assert.match(on1.out.reason, /The brief needs optional modules \(ocr\) that the foundation does not have yet/);
  assert.equal(on1.t.author.calls.length, 0);
});

test('runBuild in change mode: a v0.1.0 app upgrading to v0.2.0 may take a brief with modules', async () => {
  const s = await setup();
  const first = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(first.status, 'ready');
  saveProject(s.projectDir, { ...loadProject(s.projectDir), status: 'shipped' });
  assert.equal(loadProject(s.projectDir).foundation.tag, 'v0.1.0');
  const unit = { id: 'report-by-team', title: 'Monthly report by team', covers: ['monthly-report'], acceptance: ['monthly-report#1'],
    instructions: 'Add team totals to the monthly report.', dependsOn: [], kind: 'feature', change: 'added', retire: [] };
  const change = (over) => ({ runId: '20261028-101500-a1b2', baseRef: 'main', units: [unit], profile: null, ...over });
  const run = (c) => runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(),
    hooks: { ...s.hooks, council: async () => ({ status: 'approved', text: 'ok' }), approveBuild: async () => false },
    deps: { ...s.deps, loadBrief: () => sampleBrief({ modules: ['ocr'] }), runAppChecks: async () => green }, options: { change: c }, env: {} });
  const stays = await run(change());   // no foundation upgrade: still on v0.1.0
  assert.equal(stays.status, 'failed');
  assert.match(stays.reason, /optional modules \(ocr\)/);
  const upgrade = await run(change({ runId: '20261028-101600-a1b3', foundation: { tag: 'v0.2.0', commit: 'b'.repeat(40) } }));
  assert.doesNotMatch(upgrade.reason ?? '', /optional modules/);
  assert.equal(upgrade.status, 'rejected', 'it was built and reached the gate');
});
