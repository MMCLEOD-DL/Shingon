// Plan 11 Task 6: the git side of a foundation upgrade (merge in a scratch clone, mechanical rules, create-only landing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/workspace.js';
import { refsOf, makeRepo } from './helpers/gitRepo.js';
import { makeFoundation, makeProject } from './helpers/changeFixtures.js';
import { MAX_INSTRUCTIONS } from '../src/factory/split.js';
import {
  MAX_CONFLICT_FILES, NOT_FROM_FOUNDATION, upgradeTargetProblem, resolveVersionHunks, prepareUpgradeMerge, upgradeUnit, upgradeChangelogLines,
} from '../src/factory/change/upgradeMerge.js';

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const RUN_ID = '20261027-143205-a1b2';

function writeFiles(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    if (body === null) { rmSync(p, { force: true }); continue; }
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
}

async function commitAll(dir, message) {
  await git(dir, ['add', '-A']);
  const r = await git(dir, [...ID, 'commit', '-q', '-m', message]);
  assert.equal(r.code, 0, r.stderr);
}

const pkg = (v) => JSON.stringify({ name: 'highland-foundation', version: v, private: true }, null, 2) + '\n';
const lock = (v) => JSON.stringify({ name: 'highland-foundation', version: v, lockfileVersion: 3, packages: { '': { name: 'highland-foundation', version: v } } }, null, 2) + '\n';
const fjson = (v) => JSON.stringify({ name: 'highland-foundation', version: v, commit: `v${v}` }, null, 2) + '\n';

// A foundation whose v0.1.0 also holds `base`, and whose v0.1.1 makes the `next` changes (null deletes a file).
async function foundationWith(base, next) {
  const f = await makeFoundation({ versions: ['0.1.0'] });
  writeFiles(f.dir, base);
  await commitAll(f.dir, 'more of v0.1.0');
  await git(f.dir, [...ID, 'tag', '-f', '-a', 'v0.1.0', '-m', 'v0.1.0']);
  writeFiles(f.dir, {
    ...next, 'foundation.json': fjson('0.1.1'), 'package.json': pkg('0.1.1'), 'package-lock.json': lock('0.1.1'),
    'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n## [0.1.1] - 2026-10-11\n- **[security]** Sessions now expire after 12 hours.\n\n## [0.1.0] - 2026-10-10\n- Release 0.1.0.\n',
  });
  await commitAll(f.dir, 'release: v0.1.1');
  await git(f.dir, [...ID, 'tag', '-a', 'v0.1.1', '-m', 'v0.1.1']);
  return f;
}

// The app's own history: a feature file and its own 0.2.0 release (so the version and changelog conflicts are real).
async function appWithHistory(f, extra = {}) {
  const p = await makeProject({ foundation: f, tag: 'v0.1.0' });
  writeFiles(p.appDir, { 'apps/server/src/feature.ts': 'export const feature = 1;\n', ...extra });
  await commitAll(p.appDir, 'feat: the app feature');
  writeFiles(p.appDir, {
    'foundation.json': fjson('0.2.0'), 'package.json': pkg('0.2.0'), 'package-lock.json': lock('0.2.0'),
    'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-20\n- The app feature.\n\n## [0.1.0] - 2026-10-10\n- Release 0.1.0.\n',
  });
  await commitAll(p.appDir, 'release: v0.2.0');
  return { ...p, scratchDir: path.join(p.projectDir, 'builds', RUN_ID, 'merge') };
}

const prepare = (f, p, over = {}) => prepareUpgradeMerge({ appDir: p.appDir, foundationRepo: f.dir, fromTag: 'v0.1.0', toTag: 'v0.1.1', runId: RUN_ID, scratchDir: p.scratchDir, ...over });
const head = async (dir, ref) => (await git(dir, ['rev-parse', ref])).stdout.trim();

test('upgradeTargetProblem: not a release name, missing, same, older; null for a newer release', () => {
  const tags = ['v0.1.0', 'v0.1.1', 'v0.2.0'];
  assert.match(upgradeTargetProblem({ fromTag: 'v0.1.0', toTag: '0.1.1', tags }), /not a foundation release name/);
  assert.match(upgradeTargetProblem({ fromTag: 'v0.1.0', toTag: 'v0.3.0', tags }), /no release called v0\.3\.0\. Releases available: v0\.1\.0, v0\.1\.1, v0\.2\.0\./);
  assert.match(upgradeTargetProblem({ fromTag: 'v0.1.1', toTag: 'v0.1.1', tags }), /already on/);
  assert.match(upgradeTargetProblem({ fromTag: 'v0.2.0', toTag: 'v0.1.1', tags }), /older than/);
  assert.equal(upgradeTargetProblem({ fromTag: 'v0.1.0', toTag: 'v0.1.1', tags }), null);
});

test('resolveVersionHunks keeps the app side of a hunk that is only the version line, and leaves any other hunk', () => {
  const text = '{\n<<<<<<< HEAD\n  "version": "0.2.0",\n=======\n  "version": "0.1.1",\n>>>>>>> v0.1.1\n  "x": 1,\n<<<<<<< HEAD\n  "a": 1\n=======\n  "b": 2\n>>>>>>> v0.1.1\n}\n';
  const r = resolveVersionHunks(text);
  assert.equal(r.remaining, 1);
  assert.match(r.text, /^\{\n  "version": "0\.2\.0",\n  "x": 1,\n<<<<<<< HEAD/);
  assert.deepEqual(resolveVersionHunks('{\n  "a": 1\n}\n'), { text: '{\n  "a": 1\n}\n', remaining: 0 });
});

test('a clean upgrade with only mechanical conflicts: merge committed on a new branch, no conflicts left, app main untouched', async () => {
  const f = await makeFoundation({ versions: ['0.1.0', '0.1.1'] });
  const p = await appWithHistory(f);
  const { appDir } = p;
  const before = await head(appDir, 'main');
  const r = await prepare(f, p);
  assert.equal(r.status, 'ready', r.reason);
  assert.equal(r.branch, 'factory/upgrade-v0.1.1-20261027-143205-a1b2');
  assert.equal(r.tagSha, f.tagSha('v0.1.1'));
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.autoResolved.sort(), ['CHANGELOG.md', 'foundation.json', 'package-lock.json', 'package.json']);
  assert.equal(r.mainAtStart, before);
  assert.equal(await head(appDir, 'main'), before);
  assert.equal(await head(appDir, `refs/heads/${r.branch}`), r.mergeSha);
  const show = (q) => git(appDir, ['show', `${r.mergeSha}:${q}`]).then((x) => x.stdout);
  assert.equal(JSON.parse(await show('package.json')).version, '0.2.0', 'the app keeps its own version');
  assert.equal(JSON.parse(await show('package-lock.json')).version, '0.2.0');
  // Ruling C1: the app's foundation.json is kept (the foundation's release script needs it to match package.json).
  assert.equal(JSON.parse(await show('foundation.json')).version, '0.2.0', 'foundation.json keeps the app\'s copy');
  assert.match(await show('CHANGELOG.md'), /## \[0\.2\.0\]/);
  assert.equal(await head(appDir, `${r.mergeSha}^1`), before, 'first parent is the app main');
  assert.equal(await head(appDir, `${r.mergeSha}^2`), f.tagSha('v0.1.1'));
  // Ruling C8: the release is kept as refs/foundation/<tag> at the peeled commit, never as a tag.
  assert.equal(await head(appDir, 'refs/foundation/v0.1.1'), f.tagSha('v0.1.1'));
  assert.equal((await git(appDir, ['cat-file', '-t', 'refs/foundation/v0.1.1'])).stdout.trim(), 'commit');
  assert.equal((await git(appDir, ['for-each-ref', 'refs/tags'])).stdout, '');
  assert.equal((await git(appDir, ['for-each-ref', 'refs/conductor'])).stdout, '', 'no temporary refs are left');
  assert.equal(existsSync(p.scratchDir), false, 'the scratch clone is removed');
  assert.equal((await git(appDir, ['status', '--porcelain'])).stdout, '', 'the app checkout is untouched');
});

test('an existing refs/foundation/<tag> is left as it is (created only if missing)', async () => {
  const f = await makeFoundation({ versions: ['0.1.0', '0.1.1'] });
  const p = await appWithHistory(f);
  const marker = f.tagSha('v0.1.0');
  await git(p.appDir, ['update-ref', 'refs/foundation/v0.1.1', marker]);
  const r = await prepare(f, p);
  assert.equal(r.status, 'ready', r.reason);
  assert.equal(await head(p.appDir, 'refs/foundation/v0.1.1'), marker);
});

test('a real code conflict is committed with its markers and named for the loop', async () => {
  const f = await foundationWith({ 'apps/server/src/app.ts': 'export const timeout = 10;\n' }, { 'apps/server/src/app.ts': 'export const timeout = 12;\n' });
  const p = await appWithHistory(f, { 'apps/server/src/app.ts': 'export const timeout = 30;\n' });
  const r = await prepare(f, p);
  assert.equal(r.status, 'ready', r.reason);
  assert.deepEqual(r.conflicts, ['apps/server/src/app.ts']);
  assert.ok(!r.autoResolved.includes('apps/server/src/app.ts'));
  const text = (await git(p.appDir, ['show', `${r.mergeSha}:apps/server/src/app.ts`])).stdout;
  assert.ok(text.includes('<<<<<<< ') && text.includes('>>>>>>> '), text);
  const msg = (await git(p.appDir, ['log', '-1', '--format=%s', r.mergeSha])).stdout.trim();
  assert.equal(msg, 'foundation: merge v0.1.1 (1 files need their conflicts resolved: apps/server/src/app.ts)');
  assert.equal(await head(p.appDir, `${r.mergeSha}^2`), f.tagSha('v0.1.1'));
});

test('delete-versus-edit stops with a plain list and changes nothing in the app', async () => {
  const f = await foundationWith({ 'docs/RUNBOOK.md': 'Run it.\n' }, { 'docs/RUNBOOK.md': 'Run it carefully.\n' });
  const p = await appWithHistory(f, { 'docs/RUNBOOK.md': null });
  const refs = await refsOf(p.appDir);
  const r = await prepare(f, p);
  assert.equal(r.status, 'stopped');
  assert.match(r.reason, /docs\/RUNBOOK\.md: the app deleted it but the foundation changed it\./);
  assert.match(r.reason, /nothing was changed in the app\.$/);
  assert.equal(await refsOf(p.appDir), refs);
  assert.equal(existsSync(p.scratchDir), false);
});

test('the foundation deleting a file the app changed stops the same way', async () => {
  const f = await foundationWith({ 'docs/OLD.md': 'Old.\n' }, { 'docs/OLD.md': null });
  const p = await appWithHistory(f, { 'docs/OLD.md': 'Old, but the app changed it.\n' });
  const refs = await refsOf(p.appDir);
  const r = await prepare(f, p);
  assert.equal(r.status, 'stopped');
  assert.match(r.reason, /docs\/OLD\.md: the foundation deleted it but the app changed it\./);
  assert.equal(await refsOf(p.appDir), refs);
});

test('a binary file changed on both sides stops the same way', async () => {
  const bin = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, n, 0, 1, 2, 3]);
  const f = await foundationWith({ 'apps/web/public/logo.png': bin(1) }, { 'apps/web/public/logo.png': bin(2) });
  const p = await appWithHistory(f, { 'apps/web/public/logo.png': bin(3) });
  const refs = await refsOf(p.appDir);
  const r = await prepare(f, p);
  assert.equal(r.status, 'stopped');
  assert.match(r.reason, /^The foundation release cannot be merged automatically\. apps\/web\/public\/logo\.png: both changed this file and it is not text\. A person needs to decide/);
  assert.equal(await refsOf(p.appDir), refs);
});

test('an app with no shared history with the foundation is refused', async () => {
  const f = await makeFoundation({ versions: ['0.1.0', '0.1.1'] });
  const appDir = await makeRepo({ 'README.md': 'unrelated\n' });
  const scratchDir = path.join(mkdtempSync(path.join(tmpdir(), 'upgrade-')), 'merge');
  const refs = await refsOf(appDir);
  const r = await prepareUpgradeMerge({ appDir, foundationRepo: f.dir, fromTag: 'v0.1.0', toTag: 'v0.1.1', runId: RUN_ID, scratchDir });
  assert.deepEqual(r, { status: 'stopped', reason: NOT_FROM_FOUNDATION });
  assert.equal(await refsOf(appDir), refs);
  assert.equal(existsSync(scratchDir), false);
});

test('a branch that already exists in the app stops without changing anything', async () => {
  const f = await makeFoundation({ versions: ['0.1.0', '0.1.1'] });
  const p = await appWithHistory(f);
  await git(p.appDir, ['branch', `factory/upgrade-v0.1.1-${RUN_ID}`]);
  const refs = await refsOf(p.appDir);
  const r = await prepare(f, p);
  assert.equal(r.status, 'stopped');
  assert.match(r.reason, /^Conductor could not add the foundation merge to the app: .*\. Nothing else was changed\.$/);
  assert.equal(await refsOf(p.appDir), refs);
});

test('the foundation repo is never written', async () => {
  const f = await makeFoundation({ versions: ['0.1.0', '0.1.1'] });
  const p = await appWithHistory(f);
  const refs = await refsOf(f.dir);
  const status = (await git(f.dir, ['status', '--porcelain'])).stdout;
  const r = await prepare(f, p);
  assert.equal(r.status, 'ready', r.reason);
  assert.equal(await refsOf(f.dir), refs);
  assert.equal((await git(f.dir, ['status', '--porcelain'])).stdout, status);
});

test('upgradeUnit is a Plan 8 fix unit that names every conflicted file and lists what the foundation changed', () => {
  const item = upgradeUnit({ fromTag: 'v0.1.0', toTag: 'v0.1.1', conflicts: ['apps/server/src/app.ts'], changes: [{ version: '0.1.1', lines: ['**[security]** Sessions now expire after 12 hours.'] }] });
  assert.equal(item.id, 'foundation-upgrade-v0-1-1');
  assert.equal(item.title, 'Upgrade the foundation to v0.1.1');
  assert.equal(item.change, 'foundation-upgrade');
  assert.deepEqual([item.kind, item.covers, item.acceptance, item.dependsOn, item.retire], ['fix', [], [], [], []]);
  assert.ok(item.instructions.length <= MAX_INSTRUCTIONS);
  assert.match(item.instructions, /apps\/server\/src\/app\.ts/);
  assert.match(item.instructions, /Sessions now expire after 12 hours/);
  assert.match(item.instructions, /keep both the foundation's fix and the app's own behaviour/);
  assert.match(item.instructions, /npm run verify/);
  assert.match(item.instructions, /Do not edit the foundation's own files beyond resolving the conflicts/);

  const clean = upgradeUnit({ fromTag: 'v0.1.0', toTag: 'v0.1.1', conflicts: [], changes: [] });
  assert.match(clean.instructions, /The merge had no conflicts: check the app still builds and passes its tests/);
});

test('upgradeUnit clips the foundation changes first and never the file list', () => {
  const conflicts = Array.from({ length: MAX_CONFLICT_FILES }, (_, i) => `apps/server/src/module-${i}.ts`);
  const changes = [{ version: '0.1.1', lines: Array.from({ length: 200 }, (_, i) => `A long foundation change number ${i} that says a lot.`) }];
  const item = upgradeUnit({ fromTag: 'v0.1.0', toTag: 'v0.1.1', conflicts, changes });
  assert.ok(item.instructions.length <= MAX_INSTRUCTIONS, String(item.instructions.length));
  for (const c of conflicts) assert.ok(item.instructions.includes(c), c);
  assert.match(item.instructions, /npm run verify/);
});

test('upgradeChangelogLines: one upgrade line plus each security fix, marked so the app\'s own changelog records it', () => {
  assert.deepEqual(upgradeChangelogLines({ fromTag: 'v0.1.0', toTag: 'v0.1.1', security: [{ version: '0.1.1', lines: ['Sessions now expire after 12 hours.'] }] }), [
    '- Foundation upgraded from v0.1.0 to v0.1.1.',
    '- **[security]** Sessions now expire after 12 hours. (foundation 0.1.1)',
  ]);
});
