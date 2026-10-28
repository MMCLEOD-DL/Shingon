import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { changesBetween, releaseTags, readChangelogAt } from '../src/factory/foundationLog.js';
import { git } from '../src/workspace.js';
import { makeFoundation } from './helpers/changeFixtures.js';
import { refsOf } from './helpers/gitRepo.js';

const LOG = `# Changelog

## [Unreleased]
- **[security]** not released yet

## [0.2.0] - 2026-11-20
- New reports page.

## [0.1.1] - 2026-11-02
- **[security]** Sessions now expire after 12 hours.
- Tidier audit page.

## [0.1.0] - 2026-10-26
- First foundation release.
`;

test('changesBetween returns the sections after from, up to and including to, oldest first, never Unreleased', () => {
  assert.deepEqual(changesBetween(LOG, '0.1.0', '0.2.0').map((s) => s.version), ['0.1.1', '0.2.0']);
  assert.deepEqual(changesBetween(LOG, '0.1.1', '0.1.1'), []);
  assert.deepEqual(changesBetween(LOG, '0.0.1', '0.1.0').map((s) => s.version), ['0.1.0']);
});

test('changesBetween throws Plan 10\'s message on a heading that is not understood', () => {
  assert.throws(() => changesBetween('## [0.1.1] - 2026-1-2\n- x\n', '0.1.0', '0.1.1'), /not in the expected form/);
});

test('changesBetween refuses a version that is not a version number', () => {
  assert.throws(() => changesBetween(LOG, 'v0.1.0', '0.2.0'), /is not a version number/);
  assert.throws(() => changesBetween(LOG, '0.1.0', 'latest'), /is not a version number/);
});

test('releaseTags lists only vX.Y.Z tags in version order; readChangelogAt reads the file at a tag without touching the repo', async () => {
  const f = await makeFoundation({ versions: ['0.1.0', '0.1.1', '0.1.10'] });
  try {
    await git(f.dir, ['tag', 'v0.2.0-rc.1']);
    await git(f.dir, ['tag', 'nightly']);
    const before = await refsOf(f.dir);
    assert.deepEqual(await releaseTags(f.dir), ['v0.1.0', 'v0.1.1', 'v0.1.10']);
    assert.match(await readChangelogAt(f.dir, 'v0.1.1'), /\[security\]\*\* Sessions now expire/);
    assert.equal(await refsOf(f.dir), before);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a git directory in the environment does not redirect the foundation reads', async () => {
  const f = await makeFoundation({ versions: ['0.1.0'] });
  const other = mkdtempSync(path.join(tmpdir(), 'cond-fl-'));
  const saved = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = path.join(other, 'nope');
    assert.deepEqual(await releaseTags(f.dir), ['v0.1.0']);
    assert.match(await readChangelogAt(f.dir, 'v0.1.0'), /0\.1\.0/);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    rmSync(f.dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true });
  }
});

test('releaseTags on a folder that is not a git repo throws a plain sentence naming the folder', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cond-fl-'));
  try {
    await assert.rejects(releaseTags(dir), (e) => e.message.includes(dir) && /The foundation repository at .* could not be read/.test(e.message));
    await assert.rejects(releaseTags(path.join(dir, 'missing')), /The foundation repository at .* could not be read/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readChangelogAt refuses a tag that is not a release name before running git, and reports a missing tag plainly', async () => {
  for (const bad of ['main', '-x', 'v0.1.1~1', 'v0.1.1:x', '', undefined]) {
    await assert.rejects(readChangelogAt('/nonexistent-foundation-dir', bad), /could not be read/);
  }
  const f = await makeFoundation({ versions: ['0.1.0'] });
  try { await assert.rejects(readChangelogAt(f.dir, 'v9.9.9'), /CHANGELOG\.md at v9\.9\.9 could not be read/); }
  finally { rmSync(f.dir, { recursive: true, force: true }); }
});
