// test/factory-release.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeShipProject, fakeNpm, approve, RUN_ID } from './helpers/shipProject.js';
import { releaseApp, approvedRelease, findRelease } from '../src/factory/ship/release.js';
import { runCommand } from '../src/exec.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'rel-'));
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

test('the first release renames the package, notes the foundation, runs the app\'s own release as major, and moves main', async () => {
  const d = tmp();
  const p = makeShipProject(d, { released: false });
  const npm = fakeNpm(d);
  const before = git(p.appDir, 'rev-parse', 'main');
  const r = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() });
  assert.deepEqual(r, { ok: true, version: '1.0.0', sha: git(p.appDir, 'rev-parse', 'main'), tag: 'v1.0.0' });
  assert.equal(git(p.appDir, 'rev-parse', 'v1.0.0^{commit}'), r.sha);
  assert.equal(git(p.appDir, 'merge-base', '--is-ancestor', before, r.sha), '');
  assert.equal(JSON.parse(git(p.appDir, 'show', 'main:package.json')).name, 'acme');
  assert.match(git(p.appDir, 'show', 'main:CHANGELOG.md'), /First release of the Acme Ltd app, built on highland-foundation v0\.1\.0\./);
  assert.deepEqual(npm.calls().map((c) => c.join(' ')), ['ci --no-audit --no-fund --loglevel=error', 'run release -- major']);
  assert.equal(git(p.appDir, 'for-each-ref', 'refs/conductor'), '');
  // Ruling S1: the scratch clone's placeholder tag never reaches the app repo; only the new release tag does.
  assert.equal(git(p.appDir, 'tag', '--list'), 'v1.0.0');
  assert.equal(git(p.appDir, 'status', '--porcelain'), '');
  assert.equal(git(p.appDir, 'rev-parse', 'HEAD'), r.sha);
});

test('the fake npm refuses a release when the clone has no v* tags, as the foundation does (Ruling S1)', () => {
  const d = tmp();
  const p = makeShipProject(d, { released: false });
  const npm = fakeNpm(d);
  let err;
  try { execFileSync('npm', ['run', 'release', '--', 'major'], { cwd: p.appDir, env: npm.env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { err = e; }
  assert.equal(err?.status, 1);
  assert.match(err.stderr, /^No release has been made yet\. Make the first one with: npm run release -- first$/m);
});

test('a release that already happened is adopted, without running npm again', async () => {
  const d = tmp();
  const p = makeShipProject(d, { released: false });
  const npm = fakeNpm(d);
  const first = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() });
  git(p.appDir, 'tag', '-d', 'v1.0.0'); // a crash between moving main and adding the tag
  const again = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() });
  assert.deepEqual(again, first);
  assert.equal(npm.calls().length, 2);
  assert.equal(git(p.appDir, 'rev-parse', 'v1.0.0^{commit}'), first.sha);
  // Ruling S5: with the tag present, nothing is adopted; the ordinary refusal comes back.
  assert.match((await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() })).reason, /already had its first release/);
});

test('main moving during the release adds nothing', async () => {
  const d = tmp();
  const p = makeShipProject(d, { released: false });
  const npm = fakeNpm(d, { mainBump: p.appDir }); // the stub commits to the real app's main while "releasing"
  const r = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /main branch moved while the release was being made/);
  assert.equal(git(p.appDir, 'tag', '--list', 'v1.0.0'), '');
  assert.equal(git(p.appDir, 'for-each-ref', 'refs/conductor'), '');
});

test('the release script\'s own refusal comes back plainly, and minor/patch need a first release', async () => {
  const d = tmp();
  const p = makeShipProject(d); // released 0.1.3, nothing under Unreleased
  const npm = fakeNpm(d);
  const r = await releaseApp({ projectDir: p.projectDir, bump: 'minor', runId: RUN_ID }, { env: npm.env() });
  assert.deepEqual(r, { ok: false, reason: 'The app\'s release script stopped: There is nothing under "Unreleased" in CHANGELOG.md, so there is nothing to release.' });
  assert.equal(git(p.appDir, 'rev-parse', 'main'), git(p.appDir, 'rev-parse', 'v0.1.3^{commit}'));
  assert.match((await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() })).reason, /already had its first release/);
  const fresh = makeShipProject(tmp(), { released: false });
  assert.match((await releaseApp({ projectDir: fresh.projectDir, bump: 'patch', runId: RUN_ID }, { env: npm.env() })).reason, /has not had its first release yet/);
  assert.match((await releaseApp({ projectDir: fresh.projectDir, bump: 'major', runId: RUN_ID }, { env: npm.env() })).reason, /is not a kind of release Conductor makes/);
  assert.deepEqual(await releaseApp({ projectDir: fresh.projectDir, bump: 'first', runId: 'nope' }, { env: npm.env() }), { ok: false, reason: '"nope" is not a run id.' });
  assert.deepEqual(await releaseApp({ projectDir: fresh.projectDir, bump: 'first', runId: RUN_ID }, { env: { ...npm.env(), PATH: npm.binDir } }),
    { ok: false, reason: 'Conductor needs git on this machine to make a release, and it is not installed.' });
});

test('a later release keeps the package name and moves the change\'s Unreleased entries into it', async () => {
  const d = tmp();
  const p = makeShipProject(d);
  const changelog = git(p.appDir, 'show', 'main:CHANGELOG.md').replace('## [Unreleased]\n', '## [Unreleased]\n- A new report.\n');
  execFileSync('sh', ['-c', 'cat > CHANGELOG.md'], { cwd: p.appDir, input: changelog + '\n' });
  git(p.appDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'A change');
  const r = await releaseApp({ projectDir: p.projectDir, bump: 'minor', runId: RUN_ID }, { env: fakeNpm(d).env() });
  assert.deepEqual(r, { ok: true, version: '0.2.0', sha: git(p.appDir, 'rev-parse', 'main'), tag: 'v0.2.0' });
  assert.equal(JSON.parse(git(p.appDir, 'show', 'main:package.json')).name, 'acme');
  assert.match(git(p.appDir, 'show', 'main:CHANGELOG.md'), /## \[0\.2\.0\] - 2026-10-27\n- A new report\./);
});

test('findRelease ignores the foundation\'s tags and picks the newest release on or after the build', async () => {
  const d = tmp();
  const p = makeShipProject(d, { released: false });
  // a stray foundation tag below the approved build (createApp removes these; still never chosen)
  git(p.appDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0', `${p.sha}~1`);
  assert.equal(await findRelease(p.appDir, p.sha), null);
  const done = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: fakeNpm(d).env() });
  assert.deepEqual(await findRelease(p.appDir, p.sha), { sha: done.sha, version: '1.0.0', tag: 'v1.0.0' });
});

test('approvedRelease finds an existing release, cuts the first one, and refuses the rest plainly', async () => {
  const a = makeShipProject(tmp());
  assert.deepEqual(await approvedRelease(a.projectDir, { runId: RUN_ID }), { ok: true, sha: git(a.appDir, 'rev-parse', 'v0.1.3^{commit}'), version: '0.1.3', tag: 'v0.1.3', cut: false });
  const d = tmp();
  const b = makeShipProject(d, { released: false });
  const cut = await approvedRelease(b.projectDir, { runId: RUN_ID, env: fakeNpm(d).env() });
  assert.deepEqual([cut.ok, cut.version, cut.cut], [true, '1.0.0', true]);
  assert.equal(cut.sha, git(b.appDir, 'rev-parse', 'v1.0.0^{commit}'));
  assert.match(cut.sha, /^[0-9a-f]{40}$/);
  assert.match((await approvedRelease(makeShipProject(tmp(), { approve: false }).projectDir, { runId: RUN_ID })).problem, /no approved build yet/);
  const c = makeShipProject(tmp());
  git(c.appDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'A change');
  approve(c, git(c.appDir, 'rev-parse', 'main'));
  assert.match((await approvedRelease(c.projectDir, { runId: RUN_ID })).problem, /has no release yet\. Finish it with: conductor change acme --resume$/);
});

test('approvedRelease refuses a missing build, a moved main and a tag that disagrees with package.json', async () => {
  const a = makeShipProject(tmp());
  approve(a, 'f'.repeat(40));
  assert.deepEqual(await approvedRelease(a.projectDir, { runId: RUN_ID }), { ok: false, problem: 'The approved build (fffffff) is not in the project\'s app repository.' });
  const b = makeShipProject(tmp(), { released: false });
  git(b.appDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'Later work');
  const main = git(b.appDir, 'rev-parse', 'main');
  assert.equal((await approvedRelease(b.projectDir, { runId: RUN_ID })).problem,
    `The app's main branch has moved since the build was approved (main is ${main.slice(0, 7)}, the approved build is ${b.sha.slice(0, 7)}), so Conductor will not release it. Approve the build again.`);
  const c = makeShipProject(tmp());
  git(c.appDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-a', 'v0.1.4', '-m', 'v0.1.4', 'main');
  assert.equal((await approvedRelease(c.projectDir, { runId: RUN_ID })).problem, 'The release tag v0.1.4 does not match the version in package.json (0.1.3).');
});

test('a release script that changes more than the release files, or makes extra commits, adds nothing (Ruling S20)', async () => {
  for (const opts of [{ extraFile: 'evil.txt' }, { extraCommit: true }]) {
    const d = tmp();
    const p = makeShipProject(d, { released: false });
    const before = git(p.appDir, 'rev-parse', 'main');
    const r = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: fakeNpm(d, opts).env() });
    assert.equal(r.ok, false);
    if (opts.extraFile) assert.equal(r.reason, 'The app\'s release script changed files a release should not touch (evil.txt), so nothing was added.');
    else assert.equal(r.reason, 'The app\'s release script made more commits than a release needs, so nothing was added.');
    assert.equal(git(p.appDir, 'rev-parse', 'main'), before);
    assert.equal(git(p.appDir, 'tag', '--list'), '');
    assert.equal(git(p.appDir, 'for-each-ref', 'refs/conductor'), '');
  }
  const d = tmp();
  const p = makeShipProject(d);
  const before = git(p.appDir, 'rev-parse', 'main');
  execFileSync('sh', ['-c', 'cat > CHANGELOG.md'], { cwd: p.appDir, input: git(p.appDir, 'show', 'main:CHANGELOG.md').replace('## [Unreleased]\n', '## [Unreleased]\n- A fix.\n') + '\n' });
  git(p.appDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'A change');
  const changed = git(p.appDir, 'rev-parse', 'main');
  const r = await releaseApp({ projectDir: p.projectDir, bump: 'patch', runId: RUN_ID }, { env: fakeNpm(d, { extraFile: 'apps/web/src/sneaky.ts' }).env() });
  assert.match(r.reason, /\(apps\/web\/src\/sneaky\.ts\)/);
  assert.notEqual(changed, before);
  assert.equal(git(p.appDir, 'rev-parse', 'main'), changed);
});

test('a crash between moving main and updating the app folder is tidied before the next release looks at it', async () => {
  const d = tmp();
  const p = makeShipProject(d, { released: false });
  const npm = fakeNpm(d);
  const before = git(p.appDir, 'rev-parse', 'main');
  const first = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() });
  // Simulate the crash: main points at the release, but the folder still holds the commit before it.
  git(p.appDir, 'reset', '-q', '--hard', before);
  git(p.appDir, 'update-ref', 'refs/heads/main', first.sha, before);
  git(p.appDir, 'tag', '-d', 'v1.0.0');
  assert.notEqual(git(p.appDir, 'status', '--porcelain'), '');
  assert.deepEqual(await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() }), first);
  assert.equal(git(p.appDir, 'status', '--porcelain'), '');
  // With the tag already there (the crash came after the tag fetch), the folder is still tidied.
  git(p.appDir, 'reset', '-q', '--hard', before);
  git(p.appDir, 'update-ref', 'refs/heads/main', first.sha, before);
  assert.match((await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() })).reason, /already had its first release/);
  assert.equal(git(p.appDir, 'status', '--porcelain'), '');
  // Real changes of the operator's own are never thrown away.
  execFileSync('sh', ['-c', 'echo mine >> CHANGELOG.md'], { cwd: p.appDir });
  await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() });
  assert.match(git(p.appDir, 'status', '--porcelain'), /CHANGELOG\.md/);
});

test('releaseApp refuses when main is not the commit its caller checked, before running anything', async () => {
  const d = tmp();
  const p = makeShipProject(d, { released: false });
  const npm = fakeNpm(d);
  const before = git(p.appDir, 'rev-parse', 'main');
  const r = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID, expectedMain: 'a'.repeat(40) }, { env: npm.env() });
  assert.deepEqual(r, { ok: false, reason: 'The app\'s main branch moved before the release could start, so the release was not made. Run it again.' });
  assert.equal(npm.calls().length, 0);
  assert.equal(git(p.appDir, 'rev-parse', 'main'), before);
  const ok = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID, expectedMain: before }, { env: npm.env() });
  assert.equal(ok.ok, true);
});

test('approvedRelease hands releaseApp the main it checked', async () => {
  const d = tmp();
  const p = makeShipProject(d, { released: false });
  const seen = [];
  const run = async (o) => {
    if (o.args?.includes('clone')) seen.push('clone');
    return runCommand(o);
  };
  // Main moves after approvedRelease's own read of it but before releaseApp's (the second read).
  let reads = 0;
  const racing = async (o) => {
    if (o.args?.includes('rev-parse') && o.args.includes('refs/heads/main') && ++reads === 2) {
      execFileSync('git', ['-C', p.appDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'raced']);
    }
    return run(o);
  };
  const r = await approvedRelease(p.projectDir, { runId: RUN_ID, env: fakeNpm(d).env(), run: racing });
  assert.equal(r.ok, false);
  assert.match(r.problem, /^Conductor could not make the app's first release: The app's main branch moved before the release could start/);
  assert.deepEqual(seen, []);
});

test('git runs without GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE from the caller', async () => {
  const d = tmp();
  const p = makeShipProject(d);
  const bogus = { GIT_DIR: path.join(d, 'nowhere'), GIT_WORK_TREE: path.join(d, 'nowhere'), GIT_INDEX_FILE: path.join(d, 'nowhere', 'index') };
  const envs = [];
  const run = (o) => { envs.push(o.env); return runCommand(o); };
  assert.deepEqual(await findRelease(p.appDir, p.sha, { env: { ...process.env, ...bogus }, run }), { sha: git(p.appDir, 'rev-parse', 'v0.1.3^{commit}'), version: '0.1.3', tag: 'v0.1.3' });
  assert.ok(envs.length > 0 && envs.every((e) => !('GIT_DIR' in e) && !('GIT_WORK_TREE' in e) && !('GIT_INDEX_FILE' in e)));
});

test('a file whose name only looks like a release file after trimming is still refused (Ruling S20)', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'rel-'));
  const p = makeShipProject(d, { released: false });
  const before = execFileSync('git', ['-C', p.appDir, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  const r = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: fakeNpm(d, { extraFile: ' CHANGELOG.md' }).env() });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'The app\'s release script changed files a release should not touch ( CHANGELOG.md), so nothing was added.');
  assert.equal(execFileSync('git', ['-C', p.appDir, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), before);
});
