// test/factory-release.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeShipProject, fakeNpm, approve, RUN_ID } from './helpers/shipProject.js';
import { releaseApp, approvedRelease, findRelease } from '../src/factory/ship/release.js';

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
