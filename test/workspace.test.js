import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace, git, slugify } from '../src/workspace.js';
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
  const r = await ws.land({ repoDir: repo, branch: 'conductor/result' });
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
  await ws.commitAll('a');
  const r = await ws.land({ repoDir: repo, branch: 'taken' });
  assert.equal(r.ok, false);
  assert.match(r.error, /already exists/);
  assert.equal(await refsOf(repo), before);
});

test('land rejects an invalid branch name', async () => {
  const repo = await makeRepo();
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't' });
  const r = await ws.land({ repoDir: repo, branch: 'bad..name' });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid branch name/);
});
