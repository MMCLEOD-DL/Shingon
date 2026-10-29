# Task 5: The Foundation rules council member

A new deterministic council member, **Foundation rules**, checks the parts of BUILDING-ON's mandatory checklist that a computer can check, plus the acceptance-test rules (index Rulings 3 and 5). Its findings are locked facts: the interpreter can explain them but never clear them. Feature runs use a two-member council, `['foundation', 'correctness']`, so Plan 5's bounce-back loop turns a broken rule or a red `verify` into a fix step. Ordinary repo runs are unchanged: with `councilMembers: null` the council is still `MEMBERS_V1`.

| Check | Finding | Grade (all locked) |
|---|---|---|
| A path in `PROTECTED_PATHS` changed | `<path> belongs to the foundation and must not be changed` | blocking |
| `scripts.lint`, `typecheck`, `licences`, `test` or `verify` in `package.json` differs from the starting commit | `The checks that npm run verify runs were changed in package.json` | blocking |
| A feature tag `[id]` appears in no test file of the finished tree | `The worked example [<id>] has no test` | blocking |
| A test-file line holding a tag also holds `.skip(`, `.only(`, `.todo(`, `xit(`, `xtest(` or `xdescribe(` | `The test for [<id>] is skipped or focused` | blocking |
| An added line in a test file holds `.only(` | `A test was focused with .only, which stops the other tests running` | blocking |
| The first commit after the starting commit changed a non-test file, or lacks a tag | `The acceptance tests were not written first` | warning |
| A new file in `apps/server/src/db/schema/` (other than `index.ts`) without a new or changed file in `apps/server/drizzle/`, a new file in `apps/server/src/seed/seeders/` and a new file in `apps/server/test/crossing/resources/` | `A new table <file> has no migration` / `… no demo seeder` / `… no crossing resource seeder` | blocking |
| An added line with `defineRoute(` in a non-test file under `apps/server/src/` while `apps/server/test/crossing/cases.ts` is unchanged | `New routes were added without crossing cases` | blocking |
| `apps/web/src/appPaths.ts` changed while `apps/web/e2e/pages.ts` is unchanged | `A new page was added without a PAGES entry, so it is never screenshot` | blocking |

`PROTECTED_PATHS` (foundation v0.1.0 layout): `foundation.json`, `apps/server/test/crossing/harness.ts`, `apps/server/test/crossing/world.ts`, `apps/server/test/crossing/report.ts`, `apps/server/test/crossing/crossing.test.ts`, `apps/server/test/crossing/harness-self-test.test.ts`, `apps/web/e2e/registry.spec.ts`, `apps/web/e2e/responsive.spec.ts`, `scripts/check-licences.ts`, `licence-exceptions.json`, `eslint.config.js`, `vitest.config.ts`, `tsconfig.base.json`.

**Files:**
- Create: `src/council/foundationRules.js`
- Modify: `src/council/findings.js` (`MEMBER_LABEL.foundation = 'Foundation rules'`), `src/council/tools.js` (`TOOL_LABEL['foundation-rules'] = 'foundation rules check'`), `src/prompts.js` (`FOCUS.foundation`), `src/council/index.js` (`MEMBERS`, `membersFor`, `FEATURE_COUNCIL`, option validation), `src/options.js` (`councilMembers: null`, `factoryFeature: null`), `src/conductor.js` (pass `members: membersFor(options.councilMembers)`)
- Test: `test/council-foundation.test.js` (new), `test/council-findings.test.js` (the `MEMBER_LABEL` `deepEqual` gains `foundation: 'Foundation rules'`)

**Interfaces:**
- Consumes: `testTag` (`src/factory/acceptance.js`, Plan 7), `makeFinding` (`src/council/findings.js`), `TEST_FILE` (`src/council/correctness.js`), `addedLines` (`src/council/security.js`), `git` (`src/workspace.js`), CouncilInput (Plan 5: `{ dir, files, changed, added, wholeFiles, baseSha, options, … }`), `makeFoundationRepo` (Task 1), `fakeParticipant`, `approve` (`test/helpers/fakes.js`).
- Produces: `FOUNDATION`, `PROTECTED_PATHS`, `isTestPath(p)`; `MEMBERS`, `membersFor(names) -> Member[]`, `FEATURE_COUNCIL = ['foundation', 'correctness']`; options `councilMembers`, `factoryFeature: { id, tags: string[] }`.

- [ ] **Step 1: Write the failing tests**

Create `test/council-foundation.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FOUNDATION, isTestPath } from '../src/council/foundationRules.js';
import { membersFor, validateCouncilOptions } from '../src/council/index.js';
import { addedLines } from '../src/council/security.js';
import { git } from '../src/workspace.js';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { makeFoundationRepo } from './helpers/factoryFixtures.js';

const put = (dir, file, body) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), body); };
const commit = async (dir, msg) => { await git(dir, ['add', '-A']); await git(dir, ['commit', '-q', '-m', msg]); };
const TAGS = ['submit-expense#1', 'submit-expense#2'];

async function scenario(steps) {
  const dir = await makeFoundationRepo();
  const baseSha = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  for (const files of steps) { for (const [f, b] of Object.entries(files)) put(dir, f, b); await commit(dir, 'step'); }
  const head = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  const changed = (await git(dir, ['diff', '--name-only', baseSha, head])).stdout.split('\n').filter(Boolean);
  const u0 = (await git(dir, ['diff', '--no-color', '-U0', '--src-prefix=a/', '--dst-prefix=b/', baseSha, head])).stdout;
  const wholeFiles = new Set((await git(dir, ['diff', '--name-only', '--diff-filter=A', baseSha, head])).stdout.split('\n').filter(Boolean));
  const input = { dir, files: changed, changed: new Set(changed), added: addedLines(u0), wholeFiles, baseSha,
    options: { ...DEFAULT_OPTIONS, factoryFeature: { id: 'expenses', tags: TAGS } } };
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
  assert.equal(isTestPath('apps/web/e2e/pages.ts'), false);
  assert.equal(isTestPath('apps/server/test/expenses/a.test.ts'), true);
});
```

Append to `test/council-drive.test.js` (its helpers `team`, `hooks`, `base`, `types` are already there):

```js
test('councilMembers: a feature council of Foundation rules bounces a missing acceptance test back as a fix step', async () => {
  const events = [];
  const writeTests = (role, task, c, opts) => {
    writeFileSync(path.join(opts.cwd, 'app.test.js'), /Council fixes, round/.test(task) ? "it('[f#1] ok', () => {});\n" : '// none\n');
    return { text: 'ok' };
  };
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: team({ local: writeTests }), hooks: { ...hooks(), onEvent: (e) => events.push(e) },
    baseDir: base(), options: { council: true, councilMembers: ['foundation'], factoryFeature: { id: 'f', tags: ['f#1'] }, testCommand: 'node -e "process.exit(0)"' } });
  assert.equal(out.status, 'landed');
  assert.deepEqual(types(events, 'council-start').map((e) => e.members), [['foundation'], ['foundation']]);
  assert.equal(types(events, 'council-fix').length, 1);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/council-foundation.test.js test/council-drive.test.js`
Expected: FAIL (module missing; the drive test sees the default members).

- [ ] **Step 3: Register the member's labels and options**

- `MEMBER_LABEL` gains `foundation: 'Foundation rules'` (and update the `deepEqual` in `test/council-findings.test.js`).
- `TOOL_LABEL` gains `'foundation-rules': 'foundation rules check'`.
- `FOCUS.foundation` in `src/prompts.js`: `'Check the foundation rule findings below. Code found them and they are facts: explain each one in plain English and say exactly how to fix it without weakening, skipping or editing any check.'`
- `src/options.js`: `councilMembers: null, // e.g. ["foundation", "correctness"]; null = Security, Legal and Correctness` and `factoryFeature: null, // { id, tags }: set by conductor build for each feature`.

- [ ] **Step 4: Implement `src/council/foundationRules.js`**

- `isTestPath = (p) => TEST_FILE.test(p)`.
- `collect(input)`: without `input.options?.factoryFeature`, return `[{ tool: 'foundation-rules', label, status: 'skipped', findings: [], note: 'Foundation rules are checked only on factory builds.' }]`. Otherwise run the checks in the table above, in that order, and return one `ToolRun` with `status: 'ran'`. Every finding is `makeFinding({ member: 'foundation', tool: 'foundation-rules', grade, locked: true, title, detail, file })`.
  - **Test files of the finished tree:** `git ls-files -z` in `input.dir`, filtered by `isTestPath`, read as UTF-8 (skip files over 1 MB). A tag is present when a test file contains the literal `testTag(id)` (`[<id>]`, Plan 7's `src/factory/acceptance.js`, Contract 7 §7.1/§7.4; `id` is the example's stable id).
  - **Skipped or focused:** a line containing `[<id>]` and matching `/\b(?:x(?:it|test|describe)\s*\(|\.(?:skip|only|todo)\s*(?:\.each\s*)?\()/`.
  - **Added `.only(`:** for each test file in `input.added` (a `Map<file, Set<line>>`), read those lines; when `input.added` is `null`, check every line of changed test files.
  - **package.json scripts:** `git show <baseSha>:package.json` and the working file; compare the five script names with `!==` (a missing file on either side counts as changed).
  - **Tests first:** `git rev-list --reverse <baseSha>..HEAD`; for the first commit, `git diff-tree --no-commit-id --name-only -r <sha>`. A non-test path, or a tag that `git grep -q -F -e '[<id>]' <sha> --` cannot find, gives the warning, with `detail` naming the first 10 non-test files or the missing tags. Skipped when `tags` is empty or there are no commits.
  - **New table:** use `input.wholeFiles` (files added by the change) when present, otherwise `input.changed`; a migration counts when any changed path starts with `apps/server/drizzle/`.
  - **Routes:** any added line containing `defineRoute(` in a changed non-test file under `apps/server/src/`.
  - The `detail` of each blocking finding quotes the matching BUILDING-ON checklist item, so the fix step knows what to do (for example `BUILDING-ON: "Crossing cases, written by hand, in apps/server/test/crossing/cases.ts …"`).

- [ ] **Step 5: Implement the registry in `src/council/index.js` and pass members in `drive`**

- `export const MEMBERS = Object.freeze({ security: SECURITY, legal: LEGAL, correctness: CORRECTNESS, foundation: FOUNDATION });`
- `export const FEATURE_COUNCIL = Object.freeze(['foundation', 'correctness']);`
- `export function membersFor(names) { return names == null ? MEMBERS_V1 : names.map((n) => MEMBERS[n]); }`
- `validateCouncilOptions` (only when `o.council`): `councilMembers` is `null` or a non-empty array of known, distinct names (`councilMembers must list at least one member`, `councilMembers: unknown member "<n>" (known: …)`); `factoryFeature` is `null` or `{ id: non-empty string, tags: string[] }` (`factoryFeature needs an id and a list of tags`).
- `src/conductor.js` `drive`: `runCouncilRound(ctx, { files, tests, diff, members: membersFor(options.councilMembers) })`.

- [ ] **Step 6: Run the tests**

Run: `node --test test/council-foundation.test.js test/council-drive.test.js test/council-findings.test.js && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/council/foundationRules.js src/council/findings.js src/council/tools.js src/council/index.js src/prompts.js src/options.js src/conductor.js test/council-foundation.test.js test/council-drive.test.js test/council-findings.test.js
git commit -m "feat(council): Foundation rules member and a per-run choice of council members

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
