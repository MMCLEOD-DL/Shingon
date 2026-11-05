import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { Workspace, git } from '../src/workspace.js';
import { makeRepo, refsOf } from './helpers/gitRepo.js';

test('broken workspace HEAD cannot fall through to an enclosing repository; the workspace is poisoned', async () => {
  const outer = await makeRepo({ 'outer.txt': 'Enclosing repository, not the task source.\n' });
  const source = await makeRepo();
  let ws;
  try {
    const outerHead = (await git(outer, ['rev-parse', 'HEAD'])).stdout.trim();
    const outerRefs = await refsOf(outer);
    const sourceRefs = await refsOf(source);
    ws = await Workspace.create({ repoDir: source, baseDir: path.join(outer, 'workspaces'), taskId: 'fallthrough' });
    assert.notEqual(ws.baseSha, outerHead);
    rmSync(path.join(ws.dir, '.git', 'HEAD'));
    assert.equal(lstatSync(path.join(ws.dir, '.git')).isDirectory(), true);
    // Reproduce Git's upward search with harmless synthetic repositories. The
    // real-directory/config checks alone cannot distinguish this from our clone.
    const common = await git(ws.dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    assert.equal(common.code, 0);
    assert.equal(realpathSync.native(common.stdout.trim()), realpathSync.native(path.join(outer, '.git')));
    assert.equal((await git(ws.dir, ['rev-parse', 'HEAD'])).stdout.trim(), outerHead);

    await assert.rejects(ws.guardGitDir(), /git-common-dir is/);
    await assert.rejects(ws.head(), /tampered workspace/);
    const refused = await git(ws.dir, ['rev-parse', 'HEAD']);
    assert.equal(refused.code, -1);
    assert.match(refused.stderr, /tampered workspace/);
    assert.equal(await refsOf(outer), outerRefs);
    assert.equal(await refsOf(source), sourceRefs);
  } finally {
    ws?.remove();
    rmSync(outer, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});
