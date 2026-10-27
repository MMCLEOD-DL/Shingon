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
  assert.throws(() => validateCouncilOptions({ ...base, councilMembers: ['design'] }), /councilMembers: unknown member "design"/);
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
