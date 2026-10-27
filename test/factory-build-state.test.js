import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildDirOf, newBuild, saveBuild, loadBuild, latestBuild, hashBrief, appendBuildLog, mergeFeature, archiveFeatureRun, readRunState } from '../src/factory/buildState.js';
import { git, metaDirOf } from '../src/workspace.js';
import { makeFoundationRepo, sampleBrief } from './helpers/factoryFixtures.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const out = async (d, a) => (await git(d, a)).stdout.trim();

test('build.json round-trips atomically; the newest build is found; a corrupt file is a plain error', () => {
  const projectDir = tmp('proj-');
  const a = newBuild({ runId: '20261027-100000-aaaa', slug: 'acme-ltd', client: 'Acme Ltd', briefHash: 'h', briefVersion: 1, foundation: { repo: 'r', tag: 'v0.1.0', commit: 'c' } });
  assert.deepEqual([a.kind, a.briefVersion, a.fixRounds, a.councilFixRounds, a.secretSeen, a.squashedSha], ['build', 1, 0, 0, false, null]);
  const b = { ...a, runId: '20261027-110000-bbbb' };
  saveBuild(buildDirOf(projectDir, a.runId), a);
  saveBuild(buildDirOf(projectDir, b.runId), b);
  assert.deepEqual(loadBuild(buildDirOf(projectDir, a.runId)), a);
  assert.equal(latestBuild(projectDir).runId, b.runId);
  assert.deepEqual(readdirSync(buildDirOf(projectDir, a.runId)).filter((n) => n.includes('.tmp')), []);
  writeFileSync(path.join(buildDirOf(projectDir, a.runId), 'build.json'), '{oops');
  assert.throws(() => loadBuild(buildDirOf(projectDir, a.runId)), /The saved state of build 20261027-100000-aaaa cannot be read/);
  assert.equal(loadBuild(buildDirOf(projectDir, 'none')), null);
  assert.equal(a.branch, 'build/20261027-100000-aaaa');
  assert.equal(latestBuild(tmp('empty-')), null);
});

test('appendBuildLog appends one json line per event', () => {
  const dir = tmp('bl-');
  appendBuildLog(dir, 'phase', { phase: 'setup' });
  appendBuildLog(dir, 'done', {});
  const lines = readFileSync(path.join(dir, 'build-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ['phase', 'done']);
  assert.equal(lines[0].phase, 'setup');
});

test('the brief hash ignores key order and changes with content', () => {
  const b = sampleBrief();
  const reordered = Object.fromEntries(Object.entries(b).reverse());
  assert.equal(hashBrief(b), hashBrief(reordered));
  assert.notEqual(hashBrief(b), hashBrief({ ...b, purpose: 'different' }));
});

async function appWithBuildBranch() {
  const appDir = await makeFoundationRepo();
  await git(appDir, ['checkout', '-q', '-b', 'build/r1']);
  const base = await out(appDir, ['rev-parse', 'HEAD']);
  await git(appDir, ['checkout', '-q', '-b', 'conductor/feature', base]);
  for (const n of [1, 2]) { writeFileSync(path.join(appDir, `f${n}.txt`), `${n}\n`); await git(appDir, ['add', '-A']); await git(appDir, ['commit', '-q', '-m', `step ${n}`]); }
  const landedSha = await out(appDir, ['rev-parse', 'HEAD']);
  await git(appDir, ['checkout', '-q', 'build/r1']);
  return { appDir, base, landedSha };
}

test('mergeFeature: one squashed commit with exactly the landed files; the feature branch removed; the checkout follows', async () => {
  const { appDir, base, landedSha } = await appWithBuildBranch();
  const args = { appDir, buildBranch: 'build/r1', landedBranch: 'conductor/feature', landedSha, expectedBase: base, message: 'Feature 1/2: Expenses (expenses)' };
  const sha = await mergeFeature(args);
  assert.equal(await out(appDir, ['rev-parse', `${sha}^`]), base);
  assert.equal(await out(appDir, ['rev-parse', `${sha}^{tree}`]), await out(appDir, ['rev-parse', `${landedSha}^{tree}`]));
  assert.equal(await out(appDir, ['log', '-1', '--format=%s', 'build/r1']), 'Feature 1/2: Expenses (expenses)');
  assert.equal((await git(appDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/conductor/feature'])).code, 1);
  assert.equal(readFileSync(path.join(appDir, 'f2.txt'), 'utf8'), '2\n');
  assert.equal(await mergeFeature(args), sha, 'calling again after a crash changes nothing');
});

test('mergeFeature after a crash between moving the branch and the checkout: finishes the checkout, same commit', async () => {
  const { appDir, base, landedSha } = await appWithBuildBranch();
  const tree = await out(appDir, ['rev-parse', `${landedSha}^{tree}`]);
  const crashed = await out(appDir, ['commit-tree', tree, '-p', base, '-m', 'Feature 1/2']);
  await git(appDir, ['update-ref', 'refs/heads/build/r1', crashed, base]); // crash here: checkout stale, feature branch still there
  const args = { appDir, buildBranch: 'build/r1', landedBranch: 'conductor/feature', landedSha, expectedBase: base, message: 'Feature 1/2' };
  assert.equal(await mergeFeature(args), crashed);
  assert.equal(await out(appDir, ['status', '--porcelain']), '');
  assert.equal(readFileSync(path.join(appDir, 'f2.txt'), 'utf8'), '2\n');
  assert.equal((await git(appDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/conductor/feature'])).code, 1);
  assert.equal(await out(appDir, ['rev-parse', 'build/r1']), crashed, 'never merged twice');
});

test('mergeFeature refuses a moved build branch and a dirty app folder, changing nothing', async () => {
  const { appDir, base, landedSha } = await appWithBuildBranch();
  writeFileSync(path.join(appDir, 'stray.txt'), 'x');
  await assert.rejects(mergeFeature({ appDir, buildBranch: 'build/r1', landedBranch: 'conductor/feature', landedSha, expectedBase: base, message: 'm' }),
    /The app folder has changes Conductor did not make/);
  assert.equal(await out(appDir, ['rev-parse', 'build/r1']), base);
  await assert.rejects(mergeFeature({ appDir, buildBranch: 'build/r1', landedBranch: 'conductor/feature', landedSha, expectedBase: landedSha, message: 'm' }),
    /The build branch build\/r1 is not where Conductor left it/);
});

test('mergeFeature refuses a feature branch that moved off the landed sha', async () => {
  const { appDir, base, landedSha } = await appWithBuildBranch();
  await git(appDir, ['branch', '-f', 'conductor/feature', base]);
  await assert.rejects(mergeFeature({ appDir, buildBranch: 'build/r1', landedBranch: 'conductor/feature', landedSha, expectedBase: base, message: 'm' }),
    /The finished feature is not based on the build branch/);
  assert.equal(await out(appDir, ['rev-parse', 'build/r1']), base);
});

test('archiveFeatureRun keeps the transcript and removes the workspace; readRunState reads state.json', () => {
  const ws = path.join(tmp('wsbase-'), 'conductor-ws-x');
  mkdirSync(ws); mkdirSync(metaDirOf(ws));
  writeFileSync(path.join(metaDirOf(ws), 'transcript.jsonl'), '{"type":"start"}\n');
  writeFileSync(path.join(metaDirOf(ws), 'state.json'), JSON.stringify({ version: 1, status: 'landed', branch: 'conductor/x' }));
  assert.equal(readRunState(ws).branch, 'conductor/x');
  const buildDir = tmp('build-');
  const kept = archiveFeatureRun({ workspaceDir: ws, buildDir, index: 2, id: 'report' });
  assert.equal(kept, path.join(buildDir, 'features', '03-report.jsonl'));
  assert.equal(readFileSync(kept, 'utf8'), '{"type":"start"}\n');
  assert.equal(existsSync(ws) || existsSync(metaDirOf(ws)), false);
  assert.equal(readRunState(ws), null);
});

test('archiveFeatureRun never overwrites an earlier attempt', () => {
  const buildDir = tmp('build-');
  const names = [];
  for (let i = 0; i < 3; i++) {
    const ws = path.join(tmp('wsbase-'), 'ws');
    mkdirSync(ws); mkdirSync(metaDirOf(ws));
    writeFileSync(path.join(metaDirOf(ws), 'transcript.jsonl'), `${i}\n`);
    names.push(path.basename(archiveFeatureRun({ workspaceDir: ws, buildDir, index: 0, id: 'a' })));
  }
  assert.deepEqual(names, ['01-a.jsonl', '01-a-2.jsonl', '01-a-3.jsonl']);
  const none = path.join(tmp('wsbase-'), 'ws'); mkdirSync(none);
  assert.equal(archiveFeatureRun({ workspaceDir: none, buildDir, index: 0, id: 'a' }), null);
});
