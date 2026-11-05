import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.js';
import { makeRepo } from './helpers/gitRepo.js';

test('native Windows profile workspace retains its Git identity through packaged-app redirection', {
  skip: process.platform !== 'win32' || !process.env.LOCALAPPDATA,
}, async (t) => {
  const root = mkdtempSync(path.join(process.env.LOCALAPPDATA, 'conductor-identity-test-'));
  const repo = await makeRepo();
  let ws;
  try {
    ws = await Workspace.create({ repoDir: repo, baseDir: root, taskId: 'profile-identity' });
    const gitDir = path.join(ws.dir, '.git');
    t.diagnostic(`profile redirection observed: ${realpathSync(gitDir) !== realpathSync.native(gitDir)}`);
    assert.deepEqual(await ws.guardGitDir(), { gitdir: null, config: null });
    assert.equal(await ws.head(), ws.baseSha);
  } finally {
    ws?.remove();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('workspace parent aliases resolve to the same Git directory; a linked .git is still refused and poisoned', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-identity-test-'));
  const repo = await makeRepo();
  let ws;
  try {
    const physical = path.join(root, 'physical');
    const alias = path.join(root, 'alias');
    mkdirSync(physical);
    symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    ws = await Workspace.create({ repoDir: repo, baseDir: alias, taskId: 'alias-identity' });
    assert.deepEqual(await ws.guardGitDir(), { gitdir: null, config: null });
    const gitDir = path.join(ws.dir, '.git');
    const original = path.join(root, 'original-git');
    renameSync(gitDir, original);
    symlinkSync(original, gitDir, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(ws.guardGitDir(), /no longer a real directory/);
    await assert.rejects(ws.head(), /tampered workspace/);
  } finally {
    ws?.remove();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('unresolvable native Git identity fails closed even when both input paths are equal', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-identity-test-'));
  const repo = await makeRepo();
  let ws;
  try {
    ws = await Workspace.create({ repoDir: repo, baseDir: root, taskId: 'unreadable-identity' });
    t.mock.method(realpathSync, 'native', () => { throw new Error('native resolution unavailable'); });
    await assert.rejects(ws.guardGitDir(), /workspace git directory was tampered with/);
    await assert.rejects(ws.head(), /tampered workspace/);
  } finally {
    t.mock.restoreAll();
    ws?.remove();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
