// Plan 11 Task 10: the security-behind report.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { securityBehind, behindText } from '../src/factory/change/behind.js';
import { releaseTags, readChangelogAt } from '../src/factory/foundationLog.js';
import { git } from '../src/workspace.js';
import { makeFoundation, makeProject, stubDeps } from './helpers/changeFixtures.js';

const cleanup = [];
after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

// v0.1.0, v0.1.1 (security), v0.1.2 (none), v0.2.0 (security)
async function foundationWithSecurity() {
  const f = await makeFoundation({ versions: ['0.1.0', '0.1.1', '0.1.2'] });
  const text = (await git(f.dir, ['show', 'v0.1.2:CHANGELOG.md'])).stdout
    .replace('## [0.1.2]', '## [0.2.0] - 2026-10-14\n- **[security]** Uploads are scanned for type.\n\n## [0.1.2]');
  writeFileSync(path.join(f.dir, 'CHANGELOG.md'), text);
  writeFileSync(path.join(f.dir, 'foundation.json'), '{"name":"highland-foundation","version":"0.2.0","commit":"v0.2.0"}\n');
  await git(f.dir, ['add', '-A']);
  await git(f.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'release: v0.2.0']);
  await git(f.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'tag', '-a', 'v0.2.0', '-m', 'v0.2.0']);
  cleanup.push(f.dir);
  return f;
}
async function setup(deployments) {
  const f = await foundationWithSecurity();
  const p = await makeProject({ foundation: f, tag: 'v0.2.0', deployments });
  cleanup.push(p.projectsRoot);
  return { f, p };
}

test('code and each deployment are checked separately against the newest foundation release', async () => {
  const { p } = await setup([{ name: 'acme-office', foundation: 'v0.1.0' }, { name: 'acme-cloud', foundation: 'v0.2.0' }]);
  const rows = await securityBehind({ projectsRoot: p.projectsRoot, deps: stubDeps() });
  assert.deepEqual(rows.map((r) => [r.slug, r.where, r.on, r.behind.map((b) => b.version), r.problem]), [
    ['acme', 'code', 'v0.2.0', [], null],
    ['acme', 'acme-cloud', 'v0.2.0', [], null],
    ['acme', 'acme-office', 'v0.1.0', ['0.2.0', '0.1.1'], null],
  ]);
});

test('behindText: plain lines, the fixes named, and what to do', async () => {
  const { p } = await setup([{ name: 'acme-office', foundation: 'v0.1.0' }, { name: 'acme-cloud', foundation: 'v0.2.0' }]);
  const rows = await securityBehind({ projectsRoot: p.projectsRoot, deps: stubDeps() });
  assert.equal(behindText(rows), [
    'Newest foundation release: v0.2.0.',
    '',
    'acme',
    '  code: up to date (v0.2.0)',
    '  acme-cloud: up to date (v0.2.0)',
    '  acme-office: on v0.1.0, missing 2 security fixes:',
    '    - Uploads are scanned for type. (0.2.0)',
    '    - Sessions now expire after 12 hours. (0.1.1)',
    '',
    'To fix: if the code is behind, run "conductor foundation-upgrade <slug> --to v0.2.0". If only deployments are behind, the upgrade is already in the code: finish or resume the change that ships it (conductor change <slug> --resume).',
  ].join('\n'));
});

test('behindText: everything current, and rows that could not be checked', async () => {
  const { p } = await setup([{ name: 'acme-cloud', foundation: 'v0.2.0' }]);
  const rows = await securityBehind({ projectsRoot: p.projectsRoot, deps: stubDeps() });
  assert.match(behindText(rows), /\nEvery project and deployment has every security fix in the newest foundation release\.$/);
  const bad = [{ slug: 'x', where: 'code', on: null, latest: null, behind: [], problem: 'could not check: nope.' }];
  const t = behindText(bad);
  assert.match(t, /x\n {2}code: could not check: nope\./);
  assert.match(t, /Some rows could not be checked, so do not assume they are up to date\.$/);
  assert.doesNotMatch(t, /up to date \(/);
});

test('a project whose foundation repo cannot be read says "could not check", never up to date', async () => {
  const { p } = await setup([]);
  const file = path.join(p.projectDir, 'project.json');
  const j = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'));
  j.foundation.repo = path.join(tmpdir(), 'conductor-no-such-foundation-dir');
  writeFileSync(file, JSON.stringify(j));
  const rows = await securityBehind({ projectsRoot: p.projectsRoot, deps: stubDeps() });
  assert.equal(rows.length, 1);
  assert.match(rows[0].problem, /^could not check: The foundation repository at .* could not be read/);
});

test('a changelog heading that is not understood makes every row of that foundation "could not check"', async () => {
  const f = await makeFoundation({ versions: ['0.1.0', '0.1.1'] });
  cleanup.push(f.dir);
  const txt = (await git(f.dir, ['show', 'v0.1.1:CHANGELOG.md'])).stdout.replace('## [0.1.1] - 2026-10-11', '## [0.1.1] - 2026-1-2');
  writeFileSync(path.join(f.dir, 'CHANGELOG.md'), txt);
  await git(f.dir, ['add', '-A']);
  await git(f.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'bad']);
  await git(f.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'tag', '-f', '-a', 'v0.1.1', '-m', 'v0.1.1']);
  const p = await makeProject({ foundation: f, tag: 'v0.1.0', deployments: [{ name: 'acme-office', foundation: 'v0.1.0' }] });
  cleanup.push(p.projectsRoot);
  const rows = await securityBehind({ projectsRoot: p.projectsRoot, deps: stubDeps() });
  assert.equal(rows.length, 2);
  for (const r of rows) assert.match(r.problem, /^could not check: CHANGELOG\.md has a heading that is not in the expected form: "## \[0\.1\.1\] - 2026-1-2"/);
});

test('a deployment with no foundation recorded, or one Plan 10 could not read, says so', async () => {
  const { p } = await setup([{ name: 'acme-office', foundation: 'v0.1.0' }]);
  const stub = (list) => stubDeps({ listDeployments: () => list });
  const base = { slug: 'acme', projectDir: p.projectDir };
  let rows = await securityBehind({ projectsRoot: p.projectsRoot, deps: stub([{ ...base, name: 'old', deployment: { foundation: null }, problem: null }]) });
  assert.equal(rows[1].problem, 'could not check: this deployment does not record which foundation release it runs.');
  rows = await securityBehind({ projectsRoot: p.projectsRoot, deps: stub([{ ...base, name: 'broken', deployment: null, problem: 'the deployment file is damaged' }]) });
  assert.equal(rows[1].where, 'broken');
  assert.equal(rows[1].problem, 'could not check: the deployment file is damaged');
});

test('a tag recorded in project.json that is not a release name is a "could not check"', async () => {
  const { p } = await setup([]);
  const file = path.join(p.projectDir, 'project.json');
  const j = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'));
  j.foundation.tag = 'main';
  writeFileSync(file, JSON.stringify(j));
  const rows = await securityBehind({ projectsRoot: p.projectsRoot, deps: stubDeps() });
  assert.match(rows[0].problem, /is not a foundation release name/);
});

test('a damaged project.json gives one could-not-check row; projects with no deployments show only code; empty root says no projects', async () => {
  const { p } = await setup([]);
  const root = mkdtempSync(path.join(tmpdir(), 'projects-'));
  cleanup.push(root);
  assert.equal(behindText(await securityBehind({ projectsRoot: root, deps: stubDeps() })), 'There are no projects to check.');
  assert.equal((await securityBehind({ projectsRoot: p.projectsRoot, deps: stubDeps() })).length, 1);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(path.join(root, 'broken'));
  writeFileSync(path.join(root, 'broken', 'project.json'), '{ nope');
  const rows = await securityBehind({ projectsRoot: root, deps: stubDeps() });
  assert.deepEqual(rows.map((r) => [r.slug, r.where, r.problem]), [['broken', 'code', 'could not check: its project.json could not be read.']]);
});

test('the foundation repo is read once per repo, however many projects use it', async () => {
  const { f, p } = await setup([{ name: 'acme-office', foundation: 'v0.1.0' }]);
  const { cpSync } = await import('node:fs');
  cpSync(p.projectDir, path.join(p.projectsRoot, 'beta'), { recursive: true });
  const bj = path.join(p.projectsRoot, 'beta', 'project.json');
  const j = JSON.parse((await import('node:fs')).readFileSync(bj, 'utf8'));
  j.slug = 'beta';
  writeFileSync(bj, JSON.stringify(j));
  const calls = { tags: 0, changelog: 0 };
  const read = {
    releaseTags: (r) => { calls.tags++; return releaseTags(r); },
    readChangelogAt: (r, t) => { calls.changelog++; return readChangelogAt(r, t); },
  };
  const rows = await securityBehind({ projectsRoot: p.projectsRoot, deps: stubDeps(), read });
  assert.deepEqual([...new Set(rows.map((r) => r.slug))], ['acme', 'beta']);
  assert.deepEqual(calls, { tags: 1, changelog: 1 });
  assert.ok(f.dir);
});
