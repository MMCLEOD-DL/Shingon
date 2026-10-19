import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync, chmodSync, rmSync, symlinkSync, lstatSync, readdirSync } from 'node:fs';
import { runCommand } from '../src/exec.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace, git, slugify, defaultBaseDir } from '../src/workspace.js';
import { makeRepo, refsOf } from './helpers/gitRepo.js';

const base = () => mkdtempSync(path.join(tmpdir(), 'wsbase-'));

test('slugify', () => {
  assert.equal(slugify('Add CSV Export!'), 'add-csv-export');
  assert.equal(slugify('***'), 'task');
  assert.equal(slugify('x'.repeat(100)).length, 40);
});

test('create clones HEAD onto a conductor branch with no remotes, real repo untouched', async () => {
  const repo = await makeRepo();
  const before = await refsOf(repo);
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 'Add CSV' });
  assert.equal(ws.branch, 'conductor/add-csv');
  assert.equal(readFileSync(path.join(ws.dir, 'README.md'), 'utf8'), 'hello\n');
  assert.equal((await git(ws.dir, ['remote'])).stdout.trim(), '');
  assert.equal(ws.baseSha, await ws.head());
  assert.equal(await refsOf(repo), before);
});

test('create rejects a directory that is not a git repo with a commit', async () => {
  await assert.rejects(Workspace.create({ repoDir: base(), baseDir: base(), taskId: 't' }), /not a git repository/);
});

test('open restores branch and baseSha', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a');
  await ws.commitAll('a');
  const again = await Workspace.open(ws.dir);
  assert.equal(again.branch, ws.branch);
  assert.equal(again.baseSha, ws.baseSha);
});

test('commitAll returns null when clean, a sha when dirty', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  assert.equal(await ws.commitAll('nothing'), null);
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a');
  const sha = await ws.commitAll('add a');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(sha, await ws.head());
});

test('diff and listFiles include committed, modified and untracked changes', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  const b = await ws.head();
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a\n');
  await ws.commitAll('a');
  writeFileSync(path.join(ws.dir, 'README.md'), 'changed\n');
  writeFileSync(path.join(ws.dir, 'new.txt'), 'new\n');
  const d = await ws.diff(b);
  assert.match(d, /\+a/);
  assert.match(d, /\+changed/);
  assert.match(d, /\+new/);
  assert.deepEqual((await ws.listFiles(b)).sort(), ['README.md', 'a.txt', 'new.txt']);
});

test('squashSince collapses everything since base into one commit', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  const b = await ws.head();
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a');
  await ws.commitAll('one');
  writeFileSync(path.join(ws.dir, 'b.txt'), 'b');
  await ws.commitAll('two');
  writeFileSync(path.join(ws.dir, 'c.txt'), 'c');
  const sha = await ws.squashSince(b, 'chunk 1');
  assert.equal((await git(ws.dir, ['rev-list', '--count', `${b}..HEAD`])).stdout.trim(), '1');
  assert.equal((await git(ws.dir, ['log', '-1', '--format=%s'])).stdout.trim(), 'chunk 1');
  assert.equal(sha, await ws.head());
  for (const f of ['a.txt', 'b.txt', 'c.txt']) assert.ok(existsSync(path.join(ws.dir, f)));
});

test('squashSince returns null when nothing changed', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  assert.equal(await ws.squashSince(await ws.head(), 'empty'), null);
});

test('resetHard drops commits, edits and untracked files', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  const b = await ws.head();
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a');
  await ws.commitAll('a');
  writeFileSync(path.join(ws.dir, 'README.md'), 'junk');
  writeFileSync(path.join(ws.dir, 'stray.txt'), 'x');
  await ws.resetHard(b);
  assert.equal(await ws.head(), b);
  assert.equal(readFileSync(path.join(ws.dir, 'README.md'), 'utf8'), 'hello\n');
  assert.ok(!existsSync(path.join(ws.dir, 'a.txt')));
  assert.ok(!existsSync(path.join(ws.dir, 'stray.txt')));
});

test('resetHard removes an agent-created nested git repo but keeps ignored files', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo({ '.gitignore': 'keep.log\n' }), baseDir: base(), taskId: 't' });
  const b = await ws.head();
  const sub = path.join(ws.dir, 'vendor');
  mkdirSync(sub);
  await git(sub, ['init', '-q']);
  writeFileSync(path.join(sub, 'lib.js'), 'x');
  writeFileSync(path.join(ws.dir, 'keep.log'), 'ignored');
  await ws.resetHard(b);
  assert.ok(!existsSync(sub));
  assert.ok(existsSync(path.join(ws.dir, 'keep.log')));
  assert.equal((await git(ws.dir, ['status', '--porcelain'])).stdout.trim(), '');
});

test('runTests reports pass, fail, and not-configured', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  assert.deepEqual(await ws.runTests(null), { ran: false, passed: null, code: null, output: '' });
  const ok = await ws.runTests('echo fine');
  assert.equal(ok.passed, true);
  assert.match(ok.output, /fine/);
  const bad = await ws.runTests('echo broken >&2; exit 4');
  assert.equal(bad.passed, false);
  assert.equal(bad.code, 4);
  assert.match(bad.output, /broken/);
});

test('runTests timeout counts as failure', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  const r = await ws.runTests('sleep 10', { timeoutMs: 300 });
  assert.equal(r.passed, false);
});

test('land creates a new branch in the real repo without touching its checkout', async () => {
  const repo = await makeRepo();
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't' });
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a');
  const sha = await ws.commitAll('a');
  const r = await ws.land({ repoDir: repo, branch: 'conductor/result', sha });
  assert.deepEqual(r, { ok: true, branch: 'conductor/result', error: null });
  assert.equal((await git(repo, ['rev-parse', 'conductor/result'])).stdout.trim(), sha);
  assert.equal((await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'main');
  assert.ok(!existsSync(path.join(repo, 'a.txt')));
});

test('land refuses an existing branch and leaves it unchanged', async () => {
  const repo = await makeRepo();
  await git(repo, ['branch', 'taken']);
  const before = await refsOf(repo);
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't' });
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a');
  const sha = await ws.commitAll('a');
  const r = await ws.land({ repoDir: repo, branch: 'taken', sha });
  assert.equal(r.ok, false);
  assert.match(r.error, /already exists/);
  assert.equal(await refsOf(repo), before);
});

test('land rejects an invalid branch name', async () => {
  const repo = await makeRepo();
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't' });
  const r = await ws.land({ repoDir: repo, branch: 'bad..name', sha: await ws.head() });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid branch name/);
});

// ---- Final-review fixes: I1 (land the approved sha) and I2 (agent-writable .git) ----

const writeHook = (dir, name, marker) => {
  const f = path.join(dir, name);
  writeFileSync(f, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(f, 0o755);
  return f;
};

// Plants the two payloads the review reproduced: core.fsmonitor and diff.external.
function plantConfig(ws) {
  const d = mkdtempSync(path.join(tmpdir(), 'evil-'));
  const markers = { fs: path.join(d, 'fsmonitor-ran'), ext: path.join(d, 'extdiff-ran') };
  const fsHook = writeHook(d, 'fs.sh', markers.fs);
  const extHook = writeHook(d, 'ext.sh', markers.ext);
  appendFileSync(path.join(ws.dir, '.git', 'config'), `[core]\n\tfsmonitor = ${fsHook}\n[diff]\n\texternal = ${extHook}\n`);
  return markers;
}

test('metadata lives in <ws>.conductor, outside the agents\' cwd', async () => {
  const repo = await makeRepo();
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't' });
  assert.equal(ws.metaDir, `${ws.dir}.conductor`);
  assert.equal(readFileSync(path.join(ws.metaDir, 'base'), 'utf8').trim(), ws.baseSha);
  assert.ok(existsSync(path.join(ws.metaDir, 'git-config')));
  assert.equal(JSON.parse(readFileSync(path.join(ws.metaDir, 'repo.json'), 'utf8')).repoDir, path.resolve(repo));
  assert.ok(!existsSync(path.join(ws.dir, '.git', 'conductor')));
  assert.ok(!ws.metaDir.startsWith(ws.dir + path.sep));
});

test('an agent-written core.fsmonitor / diff.external never runs inside Conductor\'s git calls', async () => {
  const repo = await makeRepo();
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't' });
  const markers = plantConfig(ws);
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a\n');
  writeFileSync(path.join(ws.dir, 'README.md'), 'changed\n');
  await ws.head();
  await ws.isClean();
  assert.match(await ws.diff(ws.baseSha), /\+changed/);
  await ws.listFiles(ws.baseSha);
  const sha = await ws.commitAll('one');
  await ws.diffRange(ws.baseSha, sha);
  await ws.filesRange(ws.baseSha, sha);
  writeFileSync(path.join(ws.dir, 'b.txt'), 'b\n');
  const squashed = await ws.squashSince(ws.baseSha, 'squash');
  await ws.resetHard(squashed);
  assert.equal((await ws.land({ repoDir: repo, branch: 'conductor/evil', sha: squashed })).ok, true);
  assert.ok(!existsSync(markers.fs), 'core.fsmonitor ran');
  assert.ok(!existsSync(markers.ext), 'diff.external ran');
  // Sanity: the same payload does fire for a plain git call, so the test is meaningful.
  await runCommand({ cmd: 'git', args: ['diff', ws.baseSha], cwd: ws.dir });
  assert.ok(existsSync(markers.fs) || existsSync(markers.ext), 'payload should fire without the flags');
});

test('restoreConfigIfTampered restores the sealed config, even through a planted symlink', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  const cfg = path.join(ws.dir, '.git', 'config');
  const pristine = readFileSync(cfg, 'utf8');
  assert.equal(ws.restoreConfigIfTampered(), null);
  plantConfig(ws);
  const t = ws.restoreConfigIfTampered();
  assert.match(t.expected, /^[0-9a-f]{64}$/);
  assert.notEqual(t.found, t.expected);
  assert.equal(readFileSync(cfg, 'utf8'), pristine);
  const elsewhere = path.join(mkdtempSync(path.join(tmpdir(), 'tgt-')), 'target');
  writeFileSync(elsewhere, 'untouched');
  rmSync(cfg);
  symlinkSync(elsewhere, cfg);
  assert.ok(ws.restoreConfigIfTampered());
  assert.equal(readFileSync(elsewhere, 'utf8'), 'untouched');
  assert.equal(readFileSync(cfg, 'utf8'), pristine);
  assert.ok(!lstatSync(cfg).isSymbolicLink());
});

test('checkRepo accepts the original repo and refuses any other', async () => {
  const repo = await makeRepo();
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't' });
  assert.equal(await ws.checkRepo(repo), null);
  assert.match(await ws.checkRepo(await makeRepo()), /belongs to/);
});

test('land ships exactly the given sha and refuses when the workspace branch moved', async () => {
  const repo = await makeRepo();
  const before = await refsOf(repo);
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't' });
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a');
  const approved = await ws.commitAll('a');
  writeFileSync(path.join(ws.dir, 'extra.txt'), 'sneaky');
  await ws.commitAll('moved after approval');
  const r = await ws.land({ repoDir: repo, branch: 'conductor/result', sha: approved });
  assert.equal(r.ok, false);
  assert.match(r.error, /no longer holds the approved result/);
  assert.equal(await refsOf(repo), before); // no branch, and the temp incoming ref is gone
  assert.equal((await ws.land({ repoDir: repo, branch: 'conductor/result', sha: 'nope' })).ok, false);
});

test('land leaves no temporary refs and rejects @{-1}-style names', async () => {
  const repo = await makeRepo();
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't' });
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a');
  const sha = await ws.commitAll('a');
  assert.equal((await ws.land({ repoDir: repo, branch: '@{-1}', sha })).ok, false);
  assert.equal((await ws.land({ repoDir: repo, branch: 'conductor/ok', sha })).ok, true);
  assert.equal((await git(repo, ['for-each-ref', 'refs/conductor'])).stdout, '');
  assert.ok(!existsSync(path.join(repo, '.git', 'FETCH_HEAD')));
});

test('findBranchAt finds a branch already at the sha', async () => {
  const repo = await makeRepo();
  const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(repo, ['branch', 'conductor/x-2']);
  assert.equal(await Workspace.findBranchAt(repo, ['conductor/x', 'conductor/x-2'], head), 'conductor/x-2');
  assert.equal(await Workspace.findBranchAt(repo, ['conductor/x'], head), null);
});

// ---- Final-review fixes: Task 2 / Task 8 ledger minors, m4, m5 ----

test('a failed clone leaves nothing behind in baseDir (T2)', async () => {
  const repo = await makeRepo({ 'a.txt': 'blob that will vanish\n' });
  const blob = (await git(repo, ['rev-parse', 'HEAD:a.txt'])).stdout.trim();
  rmSync(path.join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const b = base();
  await assert.rejects(Workspace.create({ repoDir: repo, baseDir: b, taskId: 't' }), /git clone failed/);
  assert.deepEqual(readdirSync(b), []);
});

test('open refuses a non-workspace and reports a detached HEAD as branch null (T2)', async () => {
  await assert.rejects(Workspace.open(await makeRepo()), /is not a Conductor workspace/);
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  await git(ws.dir, ['checkout', '-q', '--detach']);
  assert.equal((await Workspace.open(ws.dir)).branch, null);
});

test('diff and listFiles leave the real index untouched (T2)', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  writeFileSync(path.join(ws.dir, 'new.txt'), 'new\n');
  assert.match(await ws.diff(ws.baseSha), /\+new/);
  assert.deepEqual(await ws.listFiles(ws.baseSha), ['new.txt']);
  assert.equal((await git(ws.dir, ['diff', '--cached', '--quiet'])).code, 0);
  assert.match((await git(ws.dir, ['status', '--porcelain'])).stdout, /^\?\? new\.txt/);
  assert.deepEqual(readdirSync(ws.metaDir).filter((n) => n.startsWith('scratch-index')), []);
});

test('diff/listFiles: ignored files are excluded, deleted files are included (T2)', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo({ '.gitignore': '*.log\n', 'gone.txt': 'bye\n' }), baseDir: base(), taskId: 't' });
  writeFileSync(path.join(ws.dir, 'debug.log'), 'noise');
  rmSync(path.join(ws.dir, 'gone.txt'));
  assert.deepEqual(await ws.listFiles(ws.baseSha), ['gone.txt']);
  const d = await ws.diff(ws.baseSha);
  assert.match(d, /deleted file mode/);
  assert.doesNotMatch(d, /debug\.log/);
});

test('a timed-out test run says so in its output (T2)', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  const r = await ws.runTests('sleep 10', { timeoutMs: 300 });
  assert.match(r.output, /timed out/);
});

test('resetHard with keepIgnored removes new ignored paths but keeps the pre-existing ones (T8-M4)', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo({ '.gitignore': 'node_modules/\ndist/\n' }), baseDir: base(), taskId: 't' });
  mkdirSync(path.join(ws.dir, 'node_modules'));
  writeFileSync(path.join(ws.dir, 'node_modules', 'x'), 'dep');
  const keep = await ws.ignoredPaths();
  mkdirSync(path.join(ws.dir, 'dist'));
  writeFileSync(path.join(ws.dir, 'dist', 'new.js'), 'built');
  const outside = mkdtempSync(path.join(tmpdir(), 'outside-'));
  writeFileSync(path.join(outside, 'precious'), 'keep me');
  symlinkSync(outside, path.join(ws.dir, 'dist', 'link'));
  await ws.resetHard(ws.baseSha, { keepIgnored: keep });
  assert.ok(!existsSync(path.join(ws.dir, 'dist')));
  assert.ok(existsSync(path.join(ws.dir, 'node_modules', 'x')));
  assert.ok(existsSync(path.join(outside, 'precious')), 'followed a symlink out of the workspace');
});

test('snapshot commits the worktree without moving HEAD or the index', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a\n');
  const snap = await ws.snapshot();
  assert.equal(await ws.head(), ws.baseSha);
  assert.equal((await git(ws.dir, ['show', '--name-only', '--format=', snap])).stdout.trim(), 'a.txt');
  assert.equal((await git(ws.dir, ['diff', '--cached', '--quiet'])).code, 0);
});

test('defaultBaseDir: $XDG_STATE_HOME/conductor/workspaces, else ~/.conductor/workspaces (m4)', () => {
  assert.equal(defaultBaseDir({ XDG_STATE_HOME: '/x/state', HOME: '/h' }), path.join('/x/state', 'conductor', 'workspaces'));
  assert.equal(defaultBaseDir({ HOME: '/h' }), path.join('/h', '.conductor', 'workspaces'));
});

test('create records the source branch and whether uncommitted work was left out (m5)', async () => {
  const repo = await makeRepo();
  const clean = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't' });
  assert.deepEqual(clean.source, { sha: clean.baseSha, branch: 'main', dirty: false });
  writeFileSync(path.join(repo, 'wip.txt'), 'not committed');
  const dirty = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't' });
  assert.equal(dirty.source.dirty, true);
  assert.ok(!existsSync(path.join(dirty.dir, 'wip.txt')));
  assert.deepEqual((await Workspace.open(dirty.dir)).source, dirty.source);
});
