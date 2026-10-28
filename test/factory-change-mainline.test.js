// Plan 11, Task 7: the changelog commit, the compare-and-swap move of the app's main, and the release check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/workspace.js';
import { makeProject, makeFoundation } from './helpers/changeFixtures.js';
import { refsOf } from './helpers/gitRepo.js';
import {
  RELEASE_FILES, nextVersion, appMain, appCheckoutProblem, appVersionAt, addChangelogLines, commitChangelog, advanceMain, releaseProblem,
  MAIN_MOVED, APP_FOLDER_EDITED, NO_MAIN, RELEASE_TOUCHED_CODE, RELEASE_VERSION_DIFFERS, RELEASE_NOT_ON_MAIN,
} from '../src/factory/change/mainline.js';

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const LINE = '- Change (brief v3): added Mileage claims.';
const out = async (dir, args) => {
  const r = await git(dir, args);
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
async function commitFiles(dir, files, message) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  await out(dir, ['add', '-A']);
  await out(dir, [...ID, 'commit', '-q', '-m', message]);
  return out(dir, ['rev-parse', 'HEAD']);
}

// An app as Task 4 leaves it after an approved change build: build/<runId> holds the approved commit, main is checked out.
async function approvedApp() {
  const foundation = await makeFoundation();
  const { appDir, projectDir } = await makeProject({ foundation });
  const mainAtStart = await out(appDir, ['rev-parse', 'refs/heads/main']);
  await out(appDir, ['checkout', '-q', '-b', 'build/20261027-143205-0a0b']);
  const approved = await commitFiles(appDir, { 'apps/server/src/mileage.ts': 'export const mileage = 1;\n' }, 'Add mileage claims');
  await out(appDir, ['checkout', '-q', 'main']);
  const scratchDir = path.join(projectDir, 'builds', '20261027-143205-0a0b', 'changelog');
  return { appDir, projectDir, mainAtStart, approved, scratchDir };
}

async function changelogApp() {
  const a = await approvedApp();
  const sha = await commitChangelog({ appDir: a.appDir, sha: a.approved, lines: [LINE], scratchDir: a.scratchDir, message: 'changelog: brief v3' });
  return { ...a, sha };
}

// What the foundation's release script does: raise the version in package.json, package-lock.json and foundation.json,
// move Unreleased under a version heading, commit "release: v<version>" and tag it; then main moves to it.
async function simulateRelease(appDir, from, version, { extra = {}, tagAt = 'release', moveMain = true, tag = true } = {}) {
  const worktree = mkdtempSync(path.join(tmpdir(), 'release-wt-'));
  await out(appDir, ['worktree', 'add', '-q', '--detach', path.join(worktree, 'w'), from]);
  const w = path.join(worktree, 'w');
  const bump = (file) => {
    const j = JSON.parse(readFileSync(path.join(w, file), 'utf8'));
    j.version = version;
    if (j.packages?.['']) j.packages[''].version = version;
    return JSON.stringify(j, null, 2) + '\n';
  };
  const changelog = readFileSync(path.join(w, 'CHANGELOG.md'), 'utf8').replace('## [Unreleased]\n', `## [Unreleased]\n\n## [${version}] - 2026-10-28\n`);
  const rel = await commitFiles(w, { 'package.json': bump('package.json'), 'package-lock.json': bump('package-lock.json'), 'foundation.json': bump('foundation.json'), 'CHANGELOG.md': changelog, ...extra }, `release: v${version}`);
  await out(appDir, ['worktree', 'remove', '--force', w]);
  if (tag) await out(appDir, [...ID, 'tag', '-a', `v${version}`, '-m', `v${version}`, tagAt === 'release' ? rel : tagAt]);
  if (moveMain) await out(appDir, ['update-ref', 'refs/heads/main', rel]);
  return rel;
}

test('RELEASE_FILES is Plan 10\'s S20 set', () => {
  assert.deepEqual(RELEASE_FILES, ['CHANGELOG.md', 'package.json', 'package-lock.json', 'foundation.json']);
  assert.throws(() => RELEASE_FILES.push('x'));
});

test('the operator texts are exactly as specified', () => {
  assert.equal(MAIN_MOVED, 'The app changed while this change was being built (its main line is no longer where it was when the run started), so the change was not added. The approved work is safe on its own branch in the app; start the change again to build it on top of the newer app.');
  assert.equal(APP_FOLDER_EDITED, 'The app folder has edits that were never committed, so Conductor did not touch it. Commit or remove them, then resume.');
  assert.equal(NO_MAIN, 'The app has no main line (branch "main"), so Conductor cannot tell what is live. See docs/BUILDING-ON.md.');
  assert.equal(RELEASE_TOUCHED_CODE(['a.ts', 'b.ts']), 'The release step changed more than the version and changelog (a.ts, b.ts), so nothing was shipped.');
  assert.equal(RELEASE_VERSION_DIFFERS('0.3.0', '0.3.1'), 'The release came out as version 0.3.1, but you approved 0.3.0, so nothing was shipped.');
  assert.equal(RELEASE_NOT_ON_MAIN, 'The release is not on the app\'s main line, so nothing was shipped.');
});

test('nextVersion: patch and minor bumps; pre-release and junk are refused', () => {
  assert.equal(nextVersion('0.2.3', 'patch'), '0.2.4');
  assert.equal(nextVersion('0.2.3', 'minor'), '0.3.0');
  assert.equal(nextVersion('1.9.9', 'minor'), '1.10.0');
  assert.throws(() => nextVersion('0.2', 'minor'), /is not a version number/);
  assert.throws(() => nextVersion('1.0.0-rc.1', 'patch'), /is not a version number/);
  assert.throws(() => nextVersion('1.0.0+build', 'patch'), /is not a version number/);
  assert.throws(() => nextVersion(undefined, 'patch'), /is not a version number/);
  assert.throws(() => nextVersion('0.2.3', 'major'), /is not a kind of release/);
  assert.throws(() => nextVersion('0.2.3', 'first'), /is not a kind of release/);
});

test('addChangelogLines adds under Unreleased, creates the section if missing, and does not add a line twice', () => {
  const t = '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-20\n- x\n';
  const once = addChangelogLines(t, ['- A.']);
  assert.equal(once, '# Changelog\n\n## [Unreleased]\n- A.\n\n## [0.2.0] - 2026-11-20\n- x\n');
  assert.equal(addChangelogLines(once, ['- A.']), once);
  assert.equal(addChangelogLines('# Changelog\n\n## [0.2.0] - 2026-11-20\n', ['- A.']), '# Changelog\n\n## [Unreleased]\n- A.\n\n## [0.2.0] - 2026-11-20\n');
});

test('addChangelogLines: several lines in order, only the missing ones, a section at the end, no section at all', () => {
  const t = '# Changelog\n\n## [Unreleased]\n- A.\n\n## [0.2.0] - 2026-11-20\n- A.\n';
  assert.equal(addChangelogLines(t, ['- A.', '- B.', '- C.']), '# Changelog\n\n## [Unreleased]\n- B.\n- C.\n- A.\n\n## [0.2.0] - 2026-11-20\n- A.\n');
  // A line present only under an older release still goes into Unreleased.
  assert.equal(addChangelogLines('# Changelog\n\n## [Unreleased]\n\n## [0.2.0]\n- B.\n', ['- B.']), '# Changelog\n\n## [Unreleased]\n- B.\n\n## [0.2.0]\n- B.\n');
  assert.equal(addChangelogLines('# Changelog\n\n## [Unreleased]\n', ['- A.']), '# Changelog\n\n## [Unreleased]\n- A.\n');
  assert.equal(addChangelogLines('# Changelog\n', ['- A.']), '# Changelog\n\n## [Unreleased]\n- A.\n');
  assert.equal(addChangelogLines('# Changelog', ['- A.']), '# Changelog\n\n## [Unreleased]\n- A.\n');
  assert.equal(addChangelogLines(t, []), t);
});

test('commitChangelog: one commit on top of the approved commit, changing only CHANGELOG.md, in the app\'s object store', async () => {
  const { appDir, approved, scratchDir } = await approvedApp();
  const before = await refsOf(appDir);
  const sha = await commitChangelog({ appDir, sha: approved, lines: [LINE], scratchDir, message: 'changelog: brief v3' });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(await out(appDir, ['rev-parse', `${sha}^`]), approved);
  assert.equal(await out(appDir, ['rev-list', '--count', `${approved}..${sha}`]), '1');
  assert.deepEqual((await out(appDir, ['diff', '--name-only', approved, sha])).split('\n'), ['CHANGELOG.md']);
  assert.match(await out(appDir, ['show', `${sha}:CHANGELOG.md`]), /## \[Unreleased\]\n- Change \(brief v3\): added Mileage claims\.\n\n## \[0\.1\.0\]/);
  assert.equal(await out(appDir, ['log', '-1', '--format=%s', sha]), 'changelog: brief v3');
  assert.equal(existsSync(scratchDir), false, 'the scratch clone is removed');
  assert.equal(await refsOf(appDir), before, 'no ref in the app was added or moved');
});

test('commitChangelog is repeatable: the same approved commit and lines give the same commit; lines already there give the approved commit', async () => {
  const { appDir, approved, scratchDir } = await approvedApp();
  const a = await commitChangelog({ appDir, sha: approved, lines: [LINE], scratchDir, message: 'changelog: brief v3' });
  const b = await commitChangelog({ appDir, sha: approved, lines: [LINE], scratchDir, message: 'changelog: brief v3' });
  assert.equal(a, b);
  assert.equal(await commitChangelog({ appDir, sha: a, lines: [LINE], scratchDir, message: 'changelog: brief v3' }), a);
});

test('commitChangelog clears a scratch folder left by a crash', async () => {
  const { appDir, approved, scratchDir } = await approvedApp();
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(path.join(scratchDir, 'leftover'), 'x');
  const sha = await commitChangelog({ appDir, sha: approved, lines: [LINE], scratchDir, message: 'm' });
  assert.equal(await out(appDir, ['rev-parse', `${sha}^`]), approved);
  assert.equal(existsSync(scratchDir), false);
});

test('commitChangelog refuses bad input with plain reasons and leaves the app alone', async () => {
  const { appDir, approved, scratchDir, projectDir } = await approvedApp();
  const before = await refsOf(appDir);
  const base = { appDir, sha: approved, lines: [LINE], scratchDir, message: 'm' };
  await assert.rejects(commitChangelog({ ...base, sha: '--upload-pack=x' }), /is not a commit/);
  await assert.rejects(commitChangelog({ ...base, sha: approved.slice(0, 12) }), /is not a commit/);
  await assert.rejects(commitChangelog({ ...base, sha: 'f'.repeat(40) }), /is not in the app/);
  await assert.rejects(commitChangelog({ ...base, lines: [] }), /no changelog lines/);
  await assert.rejects(commitChangelog({ ...base, lines: ['- a\n## [9.9.9]'] }), /changelog line/);
  await assert.rejects(commitChangelog({ ...base, lines: ['   '] }), /changelog line/);
  await assert.rejects(commitChangelog({ ...base, message: '' }), /commit message/);
  await assert.rejects(commitChangelog({ ...base, scratchDir: 'relative/dir' }), /scratch folder/);
  const target = mkdtempSync(path.join(tmpdir(), 'elsewhere-'));
  writeFileSync(path.join(target, 'keep'), 'x');
  const link = path.join(projectDir, 'builds', 'link');
  symlinkSync(target, link);
  await assert.rejects(commitChangelog({ ...base, scratchDir: link }), /scratch folder/);
  assert.equal(existsSync(path.join(target, 'keep')), true, 'a linked folder is never emptied');
  assert.equal(await refsOf(appDir), before);
});

test('commitChangelog refuses an approved commit with no CHANGELOG.md, with a plain reason and no git text', async () => {
  const { appDir, scratchDir } = await approvedApp();
  await out(appDir, ['checkout', '-q', '-b', 'nolog']);
  await out(appDir, ['rm', '-q', 'CHANGELOG.md']);
  await out(appDir, [...ID, 'commit', '-q', '-m', 'drop changelog']);
  const sha = await out(appDir, ['rev-parse', 'HEAD']);
  await assert.rejects(commitChangelog({ appDir, sha, lines: [LINE], scratchDir, message: 'm' }), (e) => {
    assert.match(e.message, /CHANGELOG\.md/);
    assert.doesNotMatch(e.message, /fatal|error:/);
    return true;
  });
  assert.equal(existsSync(scratchDir), false);
});

test('advanceMain moves main from exactly the recorded commit; with main checked out and clean the files follow', async () => {
  const { appDir, mainAtStart, sha } = await changelogApp();
  assert.equal(await out(appDir, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
  const r = await advanceMain({ appDir, from: mainAtStart, to: sha });
  assert.deepEqual(r, { ok: true });
  assert.equal(await appMain(appDir), sha);
  assert.equal((await git(appDir, ['status', '--porcelain'])).stdout, '');
  assert.match(readFileSync(path.join(appDir, 'CHANGELOG.md'), 'utf8'), /Mileage claims/);
  assert.equal(existsSync(path.join(appDir, 'apps/server/src/mileage.ts')), true);
});

test('advanceMain refuses when main moved since the run started, and changes nothing', async () => {
  const { appDir, mainAtStart, sha } = await changelogApp();
  const movedSha = await commitFiles(appDir, { 'other.txt': 'someone else\n' }, 'someone else');
  const before = await refsOf(appDir);
  assert.deepEqual(await advanceMain({ appDir, from: mainAtStart, to: sha }), { ok: false, reason: MAIN_MOVED });
  assert.equal(await appMain(appDir), movedSha);
  assert.equal(await refsOf(appDir), before);
  assert.equal(existsSync(path.join(appDir, 'other.txt')), true);
});

test('advanceMain refuses a target that does not build on the recorded commit', async () => {
  const { appDir, mainAtStart } = await changelogApp();
  // A commit off an older point: not a descendant of mainAtStart.
  const older = await out(appDir, ['rev-parse', 'refs/heads/main^']);
  await out(appDir, ['checkout', '-q', '-b', 'side', older]);
  const side = await commitFiles(appDir, { 'side.txt': 's\n' }, 'side');
  await out(appDir, ['checkout', '-q', 'main']);
  assert.deepEqual(await advanceMain({ appDir, from: mainAtStart, to: side }), { ok: false, reason: MAIN_MOVED });
  assert.equal(await appMain(appDir), mainAtStart);
});

test('advanceMain with another branch checked out moves main without touching the files on disk', async () => {
  const { appDir, mainAtStart, sha } = await changelogApp();
  await out(appDir, ['checkout', '-q', 'build/20261027-143205-0a0b']);
  const diskBefore = readFileSync(path.join(appDir, 'CHANGELOG.md'), 'utf8');
  assert.deepEqual(await advanceMain({ appDir, from: mainAtStart, to: sha }), { ok: true });
  assert.equal(await appMain(appDir), sha);
  assert.equal(await out(appDir, ['symbolic-ref', 'HEAD']), 'refs/heads/build/20261027-143205-0a0b');
  assert.equal(readFileSync(path.join(appDir, 'CHANGELOG.md'), 'utf8'), diskBefore);
  assert.equal((await git(appDir, ['status', '--porcelain'])).stdout, '');
});

test('advanceMain refuses uncommitted edits with main checked out, and changes nothing', async () => {
  const { appDir, mainAtStart, sha } = await changelogApp();
  writeFileSync(path.join(appDir, 'README.md'), 'edited\n');
  assert.deepEqual(await advanceMain({ appDir, from: mainAtStart, to: sha }), { ok: false, reason: APP_FOLDER_EDITED });
  assert.equal(await appMain(appDir), mainAtStart);
  assert.equal(readFileSync(path.join(appDir, 'README.md'), 'utf8'), 'edited\n');
});

test('advanceMain with main checked out: if the files cannot follow (an ignored file in the way), main goes back and nothing changes', async () => {
  const { appDir, mainAtStart, sha } = await changelogApp();
  writeFileSync(path.join(appDir, '.git', 'info', 'exclude'), 'apps/\n');
  mkdirSync(path.join(appDir, 'apps/server/src'), { recursive: true });
  writeFileSync(path.join(appDir, 'apps/server/src/mileage.ts'), 'mine\n');
  const r = await advanceMain({ appDir, from: mainAtStart, to: sha });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not bring the files in the app folder up to date/);
  assert.doesNotMatch(r.reason, /fatal|error:|overwritten/);
  assert.equal(await appMain(appDir), mainAtStart);
  assert.equal(readFileSync(path.join(appDir, 'apps/server/src/mileage.ts'), 'utf8'), 'mine\n');
  assert.equal(readFileSync(path.join(appDir, 'CHANGELOG.md'), 'utf8'), await out(appDir, ['show', `${mainAtStart}:CHANGELOG.md`]) + '\n');
  assert.equal((await git(appDir, ['status', '--porcelain'])).stdout, '');
});

test('advanceMain with main checked out: if updating the files fails after main moved, main is put back', async () => {
  const { appDir, mainAtStart, sha } = await changelogApp();
  const lock = path.join(appDir, '.git', 'index.lock');
  writeFileSync(lock, ''); // another git process holds the index
  const r = await advanceMain({ appDir, from: mainAtStart, to: sha });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not bring the files in the app folder up to date/);
  assert.equal(await appMain(appDir), mainAtStart);
  assert.match(await out(appDir, ['log', '-g', '--format=%gs', 'refs/heads/main']), /conductor: put main back\nconductor: add the approved change/);
  rmSync(lock);
  assert.equal((await git(appDir, ['status', '--porcelain'])).stdout, '');
  assert.deepEqual(await advanceMain({ appDir, from: mainAtStart, to: sha }), { ok: true });
});

test('advanceMain refuses bad commits without running git on them', async () => {
  const { appDir, mainAtStart, sha } = await changelogApp();
  for (const [from, to] of [['--all', sha], [mainAtStart, '-q'], [mainAtStart, 'main'], [mainAtStart, sha.toUpperCase()], [null, sha]]) {
    const r = await advanceMain({ appDir, from, to });
    assert.equal(r.ok, false);
    assert.match(r.reason, /is not a commit/);
  }
  assert.equal(await appMain(appDir), mainAtStart);
});

test('advanceMain is safe to repeat: main already at the target is ok', async () => {
  const { appDir, mainAtStart, sha } = await changelogApp();
  assert.deepEqual(await advanceMain({ appDir, from: mainAtStart, to: sha }), { ok: true });
  assert.deepEqual(await advanceMain({ appDir, from: mainAtStart, to: sha }), { ok: true });
  assert.equal(await appMain(appDir), sha);
});

test('advanceMain with no main → NO_MAIN', async () => {
  const { appDir, mainAtStart, sha } = await changelogApp();
  await out(appDir, ['checkout', '-q', 'build/20261027-143205-0a0b']);
  await out(appDir, ['branch', '-q', '-D', 'main']);
  assert.deepEqual(await advanceMain({ appDir, from: mainAtStart, to: sha }), { ok: false, reason: NO_MAIN });
});

test('appCheckoutProblem: uncommitted edits on main → APP_FOLDER_EDITED; no main → NO_MAIN; clean → null', async () => {
  const { appDir } = await approvedApp();
  assert.equal(await appCheckoutProblem(appDir), null);
  writeFileSync(path.join(appDir, 'new-file.txt'), 'untracked\n');
  assert.equal(await appCheckoutProblem(appDir), APP_FOLDER_EDITED, 'an untracked file counts');
  await out(appDir, ['add', 'new-file.txt']);
  assert.equal(await appCheckoutProblem(appDir), APP_FOLDER_EDITED, 'a staged file counts');
  await out(appDir, ['reset', '-q', '--hard']);
  await out(appDir, ['clean', '-fdq']);
  assert.equal(await appCheckoutProblem(appDir), null);
  await out(appDir, ['checkout', '-q', 'build/20261027-143205-0a0b']);
  await out(appDir, ['branch', '-q', '-D', 'main']);
  assert.equal(await appCheckoutProblem(appDir), NO_MAIN);
  await assert.rejects(appMain(appDir), (e) => e.message === NO_MAIN);
});

test('appCheckoutProblem with the build branch checked out (left by a rejected or stopped build): null, clean or edited, since main\'s files are not on disk', async () => {
  const { appDir } = await approvedApp();
  await out(appDir, ['checkout', '-q', 'build/20261027-143205-0a0b']);
  assert.equal(await appCheckoutProblem(appDir), null);
  writeFileSync(path.join(appDir, 'README.md'), 'edited on the build branch\n');
  assert.equal(await appCheckoutProblem(appDir), null);
  // The same holds with the app's HEAD detached.
  await out(appDir, ['checkout', '-q', '--detach']);
  assert.equal(await appCheckoutProblem(appDir), null);
});

test('appVersionAt reads package.json at a commit; refuses bad commits and unreadable files plainly', async () => {
  const { appDir, mainAtStart } = await approvedApp();
  assert.equal(await appVersionAt(appDir, mainAtStart), '0.1.0');
  await assert.rejects(appVersionAt(appDir, '--output=/tmp/x'), /is not a commit/);
  await assert.rejects(appVersionAt(appDir, 'e'.repeat(40)), /package\.json/);
  await out(appDir, ['checkout', '-q', '-b', 'broken']);
  const bad = await commitFiles(appDir, { 'package.json': '{not json' }, 'break');
  await assert.rejects(appVersionAt(appDir, bad), (e) => /package\.json/.test(e.message) && !/JSON at position|Unexpected/.test(e.message));
  const noVersion = await commitFiles(appDir, { 'package.json': '{"name":"x"}' }, 'no version');
  await assert.rejects(appVersionAt(appDir, noVersion), /version/);
});

async function releasedApp(opts = {}) {
  const a = await changelogApp();
  assert.deepEqual(await advanceMain({ appDir: a.appDir, from: a.mainAtStart, to: a.sha }), { ok: true });
  const rel = await simulateRelease(a.appDir, a.sha, opts.version ?? '0.3.0', opts);
  return { ...a, rel };
}

test('releaseProblem accepts a release commit that changed only release files, tagged, on main, with the expected version', async () => {
  const { appDir, sha: changelogSha, rel } = await releasedApp();
  assert.equal(await releaseProblem({ appDir, from: changelogSha, release: { version: '0.3.0', sha: rel, tag: 'v0.3.0' }, expectedVersion: '0.3.0' }), null);
});

test('releaseProblem refuses: code changed, other version, not on main, tag missing or elsewhere', async () => {
  {
    const { appDir, sha, rel } = await releasedApp({ extra: { 'apps/server/src/app.ts': 'sneaky\n' } });
    assert.equal(await releaseProblem({ appDir, from: sha, release: { version: '0.3.0', sha: rel, tag: 'v0.3.0' }, expectedVersion: '0.3.0' }), RELEASE_TOUCHED_CODE(['apps/server/src/app.ts']));
  }
  {
    // A rename out of a code file shows both names (no rename detection).
    const a = await changelogApp();
    await advanceMain({ appDir: a.appDir, from: a.mainAtStart, to: a.sha });
    const wt = path.join(mkdtempSync(path.join(tmpdir(), 'rn-')), 'w');
    await out(a.appDir, ['worktree', 'add', '-q', '--detach', wt, a.sha]);
    await out(wt, ['mv', 'app-profile.json', 'foundation.json.new']);
    await out(wt, ['rm', '-q', 'foundation.json']);
    await out(wt, ['mv', 'foundation.json.new', 'foundation.json']);
    await out(wt, [...ID, 'commit', '-q', '-m', 'release: v0.3.0']);
    const rel = await out(wt, ['rev-parse', 'HEAD']);
    await out(a.appDir, ['worktree', 'remove', '--force', wt]);
    await out(a.appDir, [...ID, 'tag', '-a', 'v0.3.0', '-m', 'v0.3.0', rel]);
    await out(a.appDir, ['update-ref', 'refs/heads/main', rel]);
    await out(a.appDir, ['tag', '-d', 'v0.3.0']);
    await out(a.appDir, [...ID, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0', rel]);
    assert.equal(await releaseProblem({ appDir: a.appDir, from: a.sha, release: { version: '0.1.0', sha: rel, tag: 'v0.1.0' }, expectedVersion: '0.1.0' }), RELEASE_TOUCHED_CODE(['app-profile.json']));
  }
  {
    const { appDir, sha, rel } = await releasedApp({ version: '0.3.1' });
    assert.equal(await releaseProblem({ appDir, from: sha, release: { version: '0.3.1', sha: rel, tag: 'v0.3.1' }, expectedVersion: '0.3.0' }), RELEASE_VERSION_DIFFERS('0.3.0', '0.3.1'));
    // The release says 0.3.0 but package.json at the commit says 0.3.1.
    assert.equal(await releaseProblem({ appDir, from: sha, release: { version: '0.3.0', sha: rel, tag: 'v0.3.0' }, expectedVersion: '0.3.0' }), RELEASE_VERSION_DIFFERS('0.3.0', '0.3.1'));
  }
  {
    const { appDir, sha, rel } = await releasedApp({ moveMain: false });
    assert.equal(await releaseProblem({ appDir, from: sha, release: { version: '0.3.0', sha: rel, tag: 'v0.3.0' }, expectedVersion: '0.3.0' }), RELEASE_NOT_ON_MAIN);
  }
  const TAG = /The release tag v0\.3\.0 is not on the release/;
  {
    const { appDir, sha, rel } = await releasedApp({ tag: false });
    assert.match(await releaseProblem({ appDir, from: sha, release: { version: '0.3.0', sha: rel, tag: 'v0.3.0' }, expectedVersion: '0.3.0' }), TAG);
  }
  {
    const a = await changelogApp();
    await advanceMain({ appDir: a.appDir, from: a.mainAtStart, to: a.sha });
    const rel = await simulateRelease(a.appDir, a.sha, '0.3.0', { tagAt: a.sha });
    assert.match(await releaseProblem({ appDir: a.appDir, from: a.sha, release: { version: '0.3.0', sha: rel, tag: 'v0.3.0' }, expectedVersion: '0.3.0' }), TAG);
  }
  {
    const { appDir, sha, rel } = await releasedApp();
    assert.match(await releaseProblem({ appDir, from: sha, release: { version: '0.3.0', sha: rel, tag: '0.3.0' }, expectedVersion: '0.3.0' }), TAG);
    assert.match(await releaseProblem({ appDir, from: sha, release: { version: '0.3.0', sha: rel, tag: 'v0.3.0^{}' }, expectedVersion: '0.3.0' }), TAG);
  }
  {
    // A release that is not a descendant of the changelog commit.
    const { appDir, mainAtStart, rel } = await releasedApp();
    const wt = path.join(mkdtempSync(path.join(tmpdir(), 'side-')), 'w');
    await out(appDir, ['worktree', 'add', '-q', '--detach', wt, mainAtStart]);
    const side = await commitFiles(wt, { 'side.txt': 's\n' }, 'side');
    await out(appDir, ['worktree', 'remove', '--force', wt]);
    assert.equal(await releaseProblem({ appDir, from: side, release: { version: '0.3.0', sha: rel, tag: 'v0.3.0' }, expectedVersion: '0.3.0' }), RELEASE_NOT_ON_MAIN);
  }
  {
    // Ruling C4: the release commit's parent must be the changelog commit (not merely a descendant of it).
    const a = await changelogApp();
    await advanceMain({ appDir: a.appDir, from: a.mainAtStart, to: a.sha });
    const wt = path.join(mkdtempSync(path.join(tmpdir(), 'mid-')), 'w');
    await out(a.appDir, ['worktree', 'add', '-q', '--detach', wt, a.sha]);
    const mid = await commitFiles(wt, { 'CHANGELOG.md': readFileSync(path.join(wt, 'CHANGELOG.md'), 'utf8') + '\n' }, 'in between');
    await out(a.appDir, ['worktree', 'remove', '--force', wt]);
    const rel = await simulateRelease(a.appDir, mid, '0.3.0');
    assert.equal(await releaseProblem({ appDir: a.appDir, from: a.sha, release: { version: '0.3.0', sha: rel, tag: 'v0.3.0' }, expectedVersion: '0.3.0' }), RELEASE_NOT_ON_MAIN);
  }
});

test('releaseProblem refuses malformed input plainly, without running git on it', async () => {
  const { appDir, sha, rel } = await releasedApp();
  const ok = { appDir, from: sha, release: { version: '0.3.0', sha: rel, tag: 'v0.3.0' }, expectedVersion: '0.3.0' };
  assert.notEqual(await releaseProblem({ ...ok, from: '--all' }), null);
  assert.notEqual(await releaseProblem({ ...ok, release: { ...ok.release, sha: '-q' } }), null);
  assert.notEqual(await releaseProblem({ ...ok, release: null }), null);
  assert.notEqual(await releaseProblem({ ...ok, expectedVersion: '0.3' }), null);
  assert.equal(await releaseProblem(ok), null);
});
