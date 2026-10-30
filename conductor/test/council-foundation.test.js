import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FOUNDATION, isTestPath } from '../src/council/foundationRules.js';
import { membersFor, validateCouncilOptions, FEATURE_COUNCIL } from '../src/council/index.js';
import { addedLines } from '../src/council/security.js';
import { git } from '../src/workspace.js';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { makeFoundationRepo } from './helpers/factoryFixtures.js';

const put = (dir, file, body) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), body); };
const commit = async (dir, msg) => { await git(dir, ['add', '-A']); await git(dir, ['commit', '-q', '-m', msg]); };
const TAGS = ['submit-expense#1', 'submit-expense#2'];

async function scenario(steps, { extra = {}, over = {} } = {}) {
  const dir = await makeFoundationRepo({ extra });
  const baseSha = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  for (const files of steps) { for (const [f, b] of Object.entries(files)) { if (b === null) rmSync(path.join(dir, f)); else put(dir, f, b); } await commit(dir, 'step'); }
  const head = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  const changed = (await git(dir, ['diff', '--name-only', baseSha, head])).stdout.split('\n').filter(Boolean);
  const u0 = (await git(dir, ['diff', '--no-ext-diff', '--no-color', '-U0', '--src-prefix=a/', '--dst-prefix=b/', baseSha, head])).stdout;
  const wholeFiles = new Set((await git(dir, ['diff', '--name-only', '--diff-filter=A', baseSha, head])).stdout.split('\n').filter(Boolean));
  const input = { dir, files: changed, changed: new Set(changed), added: addedLines(u0), wholeFiles, baseSha,
    options: { ...DEFAULT_OPTIONS, factoryFeature: { id: 'expenses', tags: TAGS } }, ...over };
  const [run] = await FOUNDATION.collect(input);
  return run.findings.map((f) => `${f.grade}${f.locked ? '!' : ''} ${f.title}`);
}
const TESTS = `it('[submit-expense#1] lists it', () => {});\nit('[submit-expense#2] refuses negatives', () => {});\n`;

test('a clean feature: tests first, then code, every tag present: nothing to report', async () => {
  assert.deepEqual(await scenario([{ 'apps/server/test/expenses/expenses.test.ts': TESTS }, { 'apps/server/src/expenses/repo.ts': 'export {};\n' }]), []);
});

test('a missing tag, a skipped tagged test and a focused test all block, locked', async () => {
  const f = await scenario([{ 'apps/server/test/expenses/a.test.ts': "it.skip('[submit-expense#1] x', () => {});\nit.only('other', () => {});\n" }]);
  assert.ok(f.includes('blocking! The worked example [submit-expense#2] has no test'));
  assert.ok(f.includes('blocking! The test for [submit-expense#1] is skipped or focused'));
  assert.ok(f.includes('blocking! A test was focused with .only, which stops the other tests running'));
});

test('protected foundation files and the verify script may not change', async () => {
  const pkg = JSON.stringify({ name: 'highland-foundation', version: '0.1.0', scripts: { verify: 'echo ok', test: 'node -e 0', lint: 'node -e 0' } });
  const f = await scenario([{ 'apps/server/test/expenses/a.test.ts': TESTS }, { 'apps/server/test/crossing/harness.ts': '// weakened\n', 'package.json': pkg }]);
  assert.ok(f.includes('blocking! apps/server/test/crossing/harness.ts belongs to the foundation and must not be changed'));
  assert.ok(f.includes('blocking! The checks that npm run verify runs were changed in package.json'));
});

test('tests not written first is a locked warning, never a block', async () => {
  const f = await scenario([{ 'apps/server/test/expenses/a.test.ts': TESTS, 'apps/server/src/expenses/repo.ts': 'export {};\n' }]);
  assert.deepEqual(f, ['warning! The acceptance tests were not written first']);
});

test('a new table needs its migration and seeders; new routes need crossing cases; new pages need a PAGES entry', async () => {
  const f = await scenario([{ 'apps/server/test/expenses/a.test.ts': TESTS }, {
    'apps/server/src/db/schema/expenses.ts': 'export const expenses = 1;\n',
    'apps/server/src/expenses/routes.ts': "defineRoute({ method: 'GET' });\n",
    'apps/web/src/appPaths.ts': "export const APP_PATHS = ['/expenses'];\n",
  }]);
  for (const t of ['A new table apps/server/src/db/schema/expenses.ts has no migration', 'A new table apps/server/src/db/schema/expenses.ts has no demo seeder',
    'A new table apps/server/src/db/schema/expenses.ts has no crossing resource seeder', 'New routes were added without crossing cases',
    'A new page was added without a PAGES entry, so it is never screenshot']) assert.ok(f.includes(`blocking! ${t}`), t);
});

test('not a factory feature: the member skips itself', async () => {
  const [run] = await FOUNDATION.collect({ dir: mkdtempSync(path.join(tmpdir(), 'fr-')), files: [], changed: new Set(), options: DEFAULT_OPTIONS });
  assert.equal(run.status, 'skipped');
});

test('member registry and option checks', () => {
  assert.deepEqual(membersFor(null).map((m) => m.member), ['security', 'legal', 'correctness']);
  assert.deepEqual(membersFor(['foundation', 'correctness']).map((m) => m.member), ['foundation', 'correctness']);
  const base = { ...DEFAULT_OPTIONS, council: true };
  assert.throws(() => validateCouncilOptions({ ...base, councilMembers: ['marketing'] }), /councilMembers: unknown member "marketing"/);
  assert.throws(() => validateCouncilOptions({ ...base, councilMembers: [] }), /councilMembers must list at least one member/);
  assert.throws(() => validateCouncilOptions({ ...base, factoryFeature: { id: 'x', tags: 'a' } }), /factoryFeature needs an id and a list of tags/);
  assert.throws(() => validateCouncilOptions({ ...base, councilMembers: ['foundation', 'foundation'] }), /councilMembers must not name a member twice/);
  assert.throws(() => validateCouncilOptions({ ...base, factoryFeature: { id: 'x', tags: ['not an id'] } }), /factoryFeature needs an id and a list of tags/);
  assert.doesNotThrow(() => validateCouncilOptions({ ...base, councilMembers: [...FEATURE_COUNCIL], factoryFeature: { id: 'x', tags: TAGS } }));
  assert.equal(isTestPath('apps/web/e2e/pages.ts'), false);
  assert.equal(isTestPath('apps/server/test/expenses/a.test.ts'), true);
});

test('a protected file renamed away is still caught (git diff --name-only shows only the new name)', async () => {
  const body = 'export default [\n  { rules: { semi: "error" } },\n];\n';
  const f = await scenario([{ 'apps/server/test/expenses/a.test.ts': TESTS }, { 'eslint.config.js': null, 'eslint.config.mjs': body }],
    { extra: { 'eslint.config.js': body } });
  assert.ok(f.includes('blocking! eslint.config.js belongs to the foundation and must not be changed'), f.join('\n'));
});

test('per-workspace test configs and workspace verify scripts are protected too (Ruling Q23)', async () => {
  const webPkg = (tc) => JSON.stringify({ name: '@hf/web', scripts: { dev: 'vite', typecheck: tc } }) + '\n';
  const f = await scenario([{ 'apps/server/test/expenses/a.test.ts': TESTS }, {
    'apps/web/vitest.config.ts': 'export default { test: { include: [] } };\n', 'apps/web/package.json': webPkg('true'),
  }], { extra: { 'apps/web/vitest.config.ts': 'export default {};\n', 'apps/web/package.json': webPkg('tsc -p . --noEmit') } });
  assert.ok(f.includes('blocking! apps/web/vitest.config.ts belongs to the foundation and must not be changed'), f.join('\n'));
  assert.ok(f.includes('blocking! The checks that npm run verify runs were changed in apps/web/package.json'), f.join('\n'));
  assert.ok(!f.includes('blocking! The checks that npm run verify runs were changed in package.json'));
});

test('a tagged test disabled by describe.skip or skipIf blocks, locked (Ruling Q24)', async () => {
  const a = await scenario([{ 'apps/server/test/expenses/a.test.ts': "describe.skip('expenses', () => {\n  it('[submit-expense#1] lists it', () => {});\n});\nit('[submit-expense#2] ok', () => {});\n" }]);
  assert.ok(a.includes('blocking! The test for [submit-expense#1] is skipped or focused'), a.join('\n'));
  const b = await scenario([{ 'apps/server/test/expenses/a.test.ts': "it('[submit-expense#1] ok', () => {});\nit.skipIf(true)('[submit-expense#2] refuses negatives', () => {});\n" }]);
  assert.ok(b.includes('blocking! The test for [submit-expense#2] is skipped or focused'), b.join('\n'));
  const c = await scenario([{ 'apps/server/test/expenses/a.test.ts': "it('[submit-expense#1] ok', { skip: true }, () => {});\nit('[submit-expense#2] ok', () => {});\n" }]);
  assert.ok(c.includes('blocking! The test for [submit-expense#1] is skipped or focused'), c.join('\n'));
});

test('when its git checks fail the member blocks with a locked finding instead of throwing (Ruling Q25)', async () => {
  const f = await scenario([{ 'apps/server/test/expenses/a.test.ts': TESTS }], { over: { baseSha: 'f'.repeat(40) } });
  assert.equal(f.length, 1);
  assert.match(f[0], /^blocking! Conductor could not check the foundation rules: /);
});

test('final-fix 5: the browser gate\'s test:e2e and verify:full scripts are protected too', async () => {
  const pkg = (over) => JSON.stringify({ name: 'highland-foundation', version: '0.1.0', scripts: { verify: 'npm run lint', 'test:e2e': 'playwright test', 'verify:full': 'npm run verify && npm run test:e2e', ...over } }) + '\n';
  for (const over of [{ 'test:e2e': 'true' }, { 'verify:full': 'npm run verify' }]) {
    const f = await scenario([{ 'apps/server/test/expenses/a.test.ts': TESTS }, { 'package.json': pkg(over) }], { extra: { 'package.json': pkg({}) } });
    assert.ok(f.includes('blocking! The checks that npm run verify runs were changed in package.json'), `${Object.keys(over)[0]}: ${f.join('\n')}`);
  }
});

// Foundation v0.2.0 (FOLLOW-UPS: "PROTECTED_PATHS for the v0.2.0 layout (modules, app jobs, receipt pages)").
test('v0.2.0: the optional modules and the module pages and routes belong to the foundation, added files included', async () => {
  const f = await scenario([{ 'apps/server/test/expenses/a.test.ts': TESTS }, {
    'modules/ocr/src/pdfWorker.ts': '// weakened\n',
    'apps/server/src/modules/ocr/routes.ts': '// changed\n',
    'apps/web/src/modules/ocr/Extra.tsx': 'export {};\n',
  }]);
  for (const p of ['modules/ocr/src/pdfWorker.ts', 'apps/server/src/modules/ocr/routes.ts', 'apps/web/src/modules/ocr/Extra.tsx']) {
    assert.ok(f.includes(`blocking! ${p} belongs to the foundation and must not be changed`), f.join('\n'));
  }
});

test('v0.2.0: app-profile.json (modules and data policy) changes only through the brief, and says so', async () => {
  const dir = await makeFoundationRepo();
  const baseSha = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  put(dir, 'apps/server/test/expenses/a.test.ts', TESTS); await commit(dir, 'tests');
  put(dir, 'app-profile.json', JSON.stringify({ schema: 1, modules: ['ocr'], policy: { outbound: ['azure-document-intelligence'], residency: 'any' } }));
  await commit(dir, 'widen the policy');
  const [run] = await FOUNDATION.collect({ dir, files: ['app-profile.json'], changed: new Set(['app-profile.json']), baseSha,
    options: { ...DEFAULT_OPTIONS, factoryFeature: { id: 'expenses', tags: TAGS } } });
  const found = run.findings.find((x) => x.file === 'app-profile.json');
  assert.equal(found?.grade, 'blocking');
  assert.equal(found.locked, true);
  assert.match(found.detail, /Do not edit it by hand in a factory-built app/);
});

test('v0.2.0: the job registry, the ops job runner and the shared module, money and receipt code are protected', async () => {
  const files = ['apps/server/src/jobs/registry.ts', 'ops/src/appJobs.ts', 'packages/shared/src/modules.ts', 'packages/shared/src/appProfileFile.ts',
    'packages/shared/src/money.ts', 'packages/shared/src/report.ts', 'packages/shared/src/receipts.ts', 'packages/shared/vitest.config.ts'];
  const f = await scenario([{ 'apps/server/test/expenses/a.test.ts': TESTS }, Object.fromEntries(files.map((p) => [p, '// changed\n']))]);
  for (const p of files) assert.ok(f.includes(`blocking! ${p} belongs to the foundation and must not be changed`), f.join('\n'));
});

test('v0.2.0: what BUILDING-ON tells an app to edit stays open (its own job file and index line, shared schemas and permissions)', async () => {
  const f = await scenario([{ 'apps/server/test/expenses/a.test.ts': TESTS }, {
    'apps/server/src/jobs/monthly-report.ts': "registerAppJob({ name: 'monthly-report' });\n",
    'apps/server/src/jobs/index.ts': "export * from './registry.js';\nimport './monthly-report.js';\n",
    'packages/shared/src/schemas.ts': 'export const CreateExpenseInput = 1;\n',
    'packages/shared/src/access.ts': "export const PERMISSIONS = { 'expenses:approve': ['admin'] };\n",
    'apps/server/src/modulesextra/a.ts': 'export {};\n',
  }]);
  assert.deepEqual(f.filter((x) => x.includes('belongs to the foundation')), []);
});

test('v0.2.0: the shared package\'s verify scripts are protected like the others (Ruling Q23)', async () => {
  const pkg = (test) => JSON.stringify({ name: '@hf/shared', scripts: { test } });
  const f = await scenario([{ 'apps/server/test/expenses/a.test.ts': TESTS }, { 'packages/shared/package.json': pkg('node -e 0') }],
    { extra: { 'packages/shared/package.json': pkg('vitest run') } });
  assert.ok(f.some((x) => /blocking! The checks that npm run verify runs were changed in packages\/shared\/package\.json/.test(x)), f.join('\n'));
});

test('the reliability test (deploy/smoke) belongs to the foundation: a feature or fix run cannot rewrite it', async () => {
  const f = await scenario([{ 'apps/server/test/expenses/a.test.ts': TESTS }, {
    'deploy/smoke/run-smoke.sh': 'echo SMOKE PASSED\n', 'deploy/smoke/catcher.mjs': '// gone\n',
  }], { extra: { 'deploy/smoke/run-smoke.sh': '#!/usr/bin/env bash\n', 'deploy/smoke/catcher.mjs': '// catcher\n' } });
  assert.ok(f.includes('blocking! deploy/smoke/run-smoke.sh belongs to the foundation and must not be changed'), f.join('\n'));
  assert.ok(f.includes('blocking! deploy/smoke/catcher.mjs belongs to the foundation and must not be changed'), f.join('\n'));
});
