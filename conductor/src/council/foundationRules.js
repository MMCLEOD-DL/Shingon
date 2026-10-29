// src/council/foundationRules.js
// Foundation rules member: the parts of the foundation's BUILDING-ON checklist that code can check,
// plus the acceptance-test rules. Every finding is a locked fact: the interpreter may explain it
// but never clear or lower it. Runs only on factory feature builds (options.factoryFeature).
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { git } from '../workspace.js';
import { testTag } from '../factory/acceptance.js';
import { makeFinding } from './findings.js';
import { TEST_FILE } from './correctness.js';
import { TOOL_LABEL } from './tools.js';

// Foundation v0.1.0 layout: files a client build must never change.
export const PROTECTED_PATHS = Object.freeze([
  'foundation.json',
  'apps/server/test/crossing/harness.ts',
  'apps/server/test/crossing/world.ts',
  'apps/server/test/crossing/report.ts',
  'apps/server/test/crossing/crossing.test.ts',
  'apps/server/test/crossing/harness-self-test.test.ts',
  'apps/web/e2e/registry.spec.ts',
  'apps/web/e2e/responsive.spec.ts',
  'scripts/check-licences.ts',
  'licence-exceptions.json',
  'eslint.config.js',
  'vitest.config.ts',
  'tsconfig.base.json',
  // Ruling Q23: the per-workspace test configs that decide what verify runs.
  'apps/server/vitest.config.ts',
  'apps/web/vitest.config.ts',
  'ops/vitest.config.ts',
  'deploy/vitest.config.ts',
  'apps/web/playwright.config.ts',
  // The reliability test the council runs on a test machine (every file in deploy/smoke at v0.1.0).
  'deploy/smoke/run-smoke.sh',
  'deploy/smoke/catcher.mjs',
  'deploy/smoke/RESULT.md',
]);

// Ruling Q23: the package.json files whose verify-type scripts must not change (plus any apps/<x>/package.json).
const PACKAGE_FILES = ['package.json', 'apps/server/package.json', 'apps/web/package.json', 'ops/package.json', 'deploy/package.json'];
const APP_PACKAGE = /^apps\/[^/]+\/package\.json$/;

// test:e2e and verify:full: the browser gate runs npm run test:e2e.
const VERIFY_SCRIPTS = ['lint', 'typecheck', 'licences', 'test', 'verify', 'test:e2e', 'verify:full'];
const SKIP_OR_FOCUS = /\b(?:x(?:it|test|describe)\s*\(|\.(?:skip|only|todo)\s*(?:\.each\s*)?\()/;
const ONLY = /\.only\s*\(/;
// Ruling Q24: ways to disable a test that need not sit on the tagged line.
const DISABLED_IN_FILE = /\bdescribe\.(?:skip|todo)\s*\(|\bx(?:describe|it|test)\s*\(|\.(?:skipIf|runIf)\s*\(|\b(?:skip|todo)\s*:\s*true\b/;
const MAX_FILE = 1024 * 1024;
const TOOL = 'foundation-rules';

const SCHEMA_DIR = 'apps/server/src/db/schema/';
const MIGRATIONS_DIR = 'apps/server/drizzle/';
const SEEDERS_DIR = 'apps/server/src/seed/seeders/';
const RESOURCES_DIR = 'apps/server/test/crossing/resources/';
const CASES = 'apps/server/test/crossing/cases.ts';
const APP_PATHS = 'apps/web/src/appPaths.ts';
const PAGES = 'apps/web/e2e/pages.ts';

const BUILDING_ON = {
  protected: 'BUILDING-ON: "Resolve any conflicts (they should be rare if the foundation\'s files were left alone)". Put this file back exactly as the foundation has it and make the change in your own files instead.',
  verify: 'BUILDING-ON: "npm run verify: lint, type checks, the licence gate and every unit and integration test (including the role-crossing harness). It must pass at every commit." Put the lint, typecheck, licences, test, verify, test:e2e and verify:full scripts in package.json back as they were.',
  tests: 'Every worked example needs a test whose name carries its tag, written before the code, that runs in npm run verify.',
  migration: 'BUILDING-ON: "A Drizzle schema file in apps/server/src/db/schema/ … then npm -w @hf/server run db:generate to write the migration into apps/server/drizzle, and commit both."',
  seeder: 'BUILDING-ON: "A demo seeder in apps/server/src/seed/seeders/ (one file, plus its import line in seeders/index.ts), using ctx.faker so the same seed gives the same data."',
  resource: 'BUILDING-ON: "a resource seeder in apps/server/test/crossing/resources/ (added to RESOURCE_SEEDERS) that gives each test actor rows carrying their own canary text, so a leak of anyone else\'s data is caught."',
  cases: 'BUILDING-ON: "Crossing cases, written by hand, in apps/server/test/crossing/cases.ts: one case per route (item, list or action), with forbiddenFields listing every field a caller must not set", and EXPECTED_ROLES updated by hand.',
  pages: 'BUILDING-ON: "a PAGES entry in apps/web/e2e/pages.ts, so it is screenshot on desktop and phone and checked for sideways scrolling and small tap targets (the registry test fails while any APP_PATHS entry has no PAGES entry)."',
};

export const isTestPath = (p) => TEST_FILE.test(p);

// A git call the member depends on failed: the checks cannot be trusted, so the member blocks (Ruling Q25).
class CheckFailed extends Error {}
async function mustGit(dir, args, why, ok = [0]) {
  const r = await git(dir, args);
  if (!ok.includes(r.code)) throw new CheckFailed(why);
  return r;
}

const finding = (grade, title, detail, file = null) =>
  makeFinding({ member: 'foundation', tool: TOOL, grade, locked: true, title, detail, file });

function readText(dir, file) {
  try {
    const p = path.join(dir, file);
    if (statSync(p).size > MAX_FILE) return null;
    return readFileSync(p, 'utf8');
  } catch { return null; }
}

// Lines this change added to `file`: from input.added when the diff could be read, otherwise every line.
function addedTextLines(input, file) {
  const text = readText(input.dir, file);
  if (text === null) return [];
  const lines = text.split('\n');
  if (!input.added) return lines;
  const nums = input.added.get(file);
  if (!nums) return [];
  return [...nums].sort((a, b) => a - b).map((n) => lines[n - 1]).filter((l) => l !== undefined);
}

// The member's own diff with renames off: a protected file renamed away shows as deleted.
async function protectedFindings(input) {
  if (!input.baseSha) throw new CheckFailed('the starting commit is not known');
  const r = await mustGit(input.dir, ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', input.baseSha, 'HEAD', '--', ...PROTECTED_PATHS],
    'git could not compare the protected foundation files with the starting commit');
  const touched = new Set(r.stdout.split('\0').filter(Boolean));
  return PROTECTED_PATHS.filter((p) => touched.has(p))
    .map((p) => finding('blocking', `${p} belongs to the foundation and must not be changed`, BUILDING_ON.protected, p));
}

async function fileAt(dir, sha, file) {
  const r = await git(dir, ['cat-file', '-e', `${sha}:${file}`]);
  if (r.code !== 0) return null;
  return (await mustGit(dir, ['show', `${sha}:${file}`], `git could not read ${file} at the starting commit`)).stdout;
}

// Ruling Q3: missing on both sides = unchanged; missing on one side = changed.
async function verifyScriptsChanged(input, file) {
  const before = await fileAt(input.dir, input.baseSha, file);
  const after = readText(input.dir, file);
  if (before === null && after === null) return false;
  if (before === null || after === null) return true;
  if (before === after) return false;
  try {
    const a = JSON.parse(before)?.scripts ?? {};
    const b = JSON.parse(after)?.scripts ?? {};
    return VERIFY_SCRIPTS.some((k) => a?.[k] !== b?.[k]);
  } catch { return true; } // unreadable package.json: fail closed
}

async function verifyScriptsFindings(input) {
  const base = await mustGit(input.dir, ['ls-tree', '-r', '--name-only', '-z', input.baseSha, '--', 'apps'],
    'git could not list the starting commit');
  const files = new Set([...PACKAGE_FILES, ...base.stdout.split('\0').filter((p) => APP_PACKAGE.test(p)),
    ...[...input.changed].filter((p) => APP_PACKAGE.test(p))]);
  const out = [];
  for (const file of files) {
    if (await verifyScriptsChanged(input, file)) {
      out.push(finding('blocking', `The checks that npm run verify runs were changed in ${file}`, BUILDING_ON.verify, file));
    }
  }
  return out;
}

async function treeTestFiles(dir) {
  const r = await mustGit(dir, ['ls-files', '-z'], 'git could not list the files in the working copy');
  return r.stdout.split('\0').filter((p) => p && isTestPath(p))
    .map((p) => ({ file: p, text: readText(dir, p) })).filter((t) => t.text !== null);
}

function tagFindings(tags, testFiles) {
  const out = [];
  for (const id of tags) {
    const tag = testTag(id);
    if (!testFiles.some((t) => t.text.includes(tag))) {
      out.push(finding('blocking', `The worked example ${tag} has no test`,
        `No test file in the finished app contains ${tag}. Write a test named with ${tag} that checks this worked example. ${BUILDING_ON.tests}`));
    }
  }
  for (const id of tags) {
    const tag = testTag(id);
    const mine = testFiles.filter((t) => t.text.includes(tag));
    const line = mine.find((t) => t.text.split('\n').some((l) => l.includes(tag) && SKIP_OR_FOCUS.test(l)));
    const file = line ? null : mine.find((t) => DISABLED_IN_FILE.test(t.text));
    const hit = line ?? file;
    if (hit) {
      const how = line ? `marks the test for ${tag} with skip, only, todo or an x prefix`
        : `holds the test for ${tag} and also skips tests another way (describe.skip, describe.todo, xdescribe, xit, xtest, skipIf, runIf, or skip: true / todo: true), which can switch it off`;
      out.push(finding('blocking', `The test for ${tag} is skipped or focused`,
        `${hit.file} ${how}, so it does not run on its own terms. Make it an ordinary test that runs, and do not skip other tests in that file. ${BUILDING_ON.tests}`, hit.file));
    }
  }
  return out;
}

function onlyFindings(input, changedTests) {
  const files = input.added ? [...input.added.keys()].filter(isTestPath) : changedTests;
  const hits = files.filter((f) => addedTextLines(input, f).some((l) => ONLY.test(l)));
  return hits.length ? [finding('blocking', 'A test was focused with .only, which stops the other tests running',
    `Remove .only from: ${hits.slice(0, 10).join(', ')}`, hits[0])] : [];
}

async function testsFirstFinding(input, tags) {
  if (!tags.length || !input.baseSha) return [];
  const revs = await mustGit(input.dir, ['rev-list', '--reverse', `${input.baseSha}..HEAD`], 'git could not list the commits of this change');
  const first = revs.stdout.split('\n').find(Boolean);
  if (!first) return [];
  const tree = await mustGit(input.dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', first], 'git could not read the first commit of this change');
  const nonTest = tree.stdout.split('\n').filter(Boolean).filter((p) => !isTestPath(p));
  const missing = [];
  for (const id of tags) {
    const tag = testTag(id);
    const g = await mustGit(input.dir, ['grep', '-q', '-F', '-e', tag, first, '--'], 'git could not search the first commit for the acceptance tests', [0, 1]);
    if (g.code !== 0) missing.push(tag);
  }
  if (!nonTest.length && !missing.length) return [];
  const why = [
    nonTest.length ? `The first commit also changed files that are not tests: ${nonTest.slice(0, 10).join(', ')}.` : '',
    missing.length ? `The first commit has no test for: ${missing.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  return [finding('warning', 'The acceptance tests were not written first', `${why} The first step should only add the failing acceptance tests.`)];
}

function tableFindings(input) {
  const changedList = [...input.changed];
  const fresh = input.wholeFiles ? [...input.wholeFiles] : changedList;
  const tables = fresh.filter((p) => p.startsWith(SCHEMA_DIR) && path.posix.basename(p) !== 'index.ts');
  if (!tables.length) return [];
  const migration = changedList.some((p) => p.startsWith(MIGRATIONS_DIR));
  const seeder = fresh.some((p) => p.startsWith(SEEDERS_DIR));
  const resource = fresh.some((p) => p.startsWith(RESOURCES_DIR));
  const out = [];
  for (const t of tables) {
    if (!migration) out.push(finding('blocking', `A new table ${t} has no migration`, BUILDING_ON.migration, t));
    if (!seeder) out.push(finding('blocking', `A new table ${t} has no demo seeder`, BUILDING_ON.seeder, t));
    if (!resource) out.push(finding('blocking', `A new table ${t} has no crossing resource seeder`, BUILDING_ON.resource, t));
  }
  return out;
}

function routeFindings(input) {
  if (input.changed.has(CASES)) return [];
  const files = [...input.changed].filter((p) => p.startsWith('apps/server/src/') && !isTestPath(p));
  const hit = files.find((f) => addedTextLines(input, f).some((l) => l.includes('defineRoute(')));
  return hit ? [finding('blocking', 'New routes were added without crossing cases', BUILDING_ON.cases, hit)] : [];
}

function pageFindings(input) {
  return input.changed.has(APP_PATHS) && !input.changed.has(PAGES)
    ? [finding('blocking', 'A new page was added without a PAGES entry, so it is never screenshot', BUILDING_ON.pages, APP_PATHS)]
    : [];
}

export const FOUNDATION = {
  member: 'foundation',
  label: 'Foundation rules',
  alwaysInterpret: false,
  async collect(input) {
    const label = TOOL_LABEL[TOOL];
    const feature = input.options?.factoryFeature;
    if (!feature) return [{ tool: TOOL, label, status: 'skipped', findings: [], note: 'Foundation rules are checked only on factory builds.' }];
    const tags = Array.isArray(feature.tags) ? feature.tags : [];
    const changed = input.changed ?? new Set(input.files ?? []);
    const ctx = { ...input, changed };
    const changedTests = [...changed].filter(isTestPath);
    try {
      const findings = [...(await protectedFindings(ctx)), ...(await verifyScriptsFindings(ctx))];
      const testFiles = await treeTestFiles(input.dir);
      findings.push(
        ...tagFindings(tags, testFiles),
        ...onlyFindings(ctx, changedTests),
        ...(await testsFirstFinding(ctx, tags)),
        ...tableFindings(ctx),
        ...routeFindings(ctx),
        ...pageFindings(ctx),
      );
      return [{ tool: TOOL, label, status: 'ran', findings, note: null }];
    } catch (e) {
      if (!(e instanceof CheckFailed)) throw e;
      return [{ tool: TOOL, label, status: 'error', note: `The foundation rules could not be checked: ${e.message}.`,
        findings: [finding('blocking', `Conductor could not check the foundation rules: ${e.message}`,
          'Until these checks run, the change cannot be shown to follow the foundation rules. Ask the operator to look at the working copy.')] }];
    }
  },
};
