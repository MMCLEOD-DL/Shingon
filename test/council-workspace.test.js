import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/workspace.js';
import { openCouncilWorkspace, openCouncilLog } from '../src/council/councilWorkspace.js';
import { makeRepo } from './helpers/gitRepo.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const head = async (d) => (await git(d, ['rev-parse', 'HEAD'])).stdout.trim();
async function commitFile(repo, name, body) { writeFileSync(path.join(repo, name), body); await git(repo, ['add', '-A']); await git(repo, ['commit', '-q', '-m', name]); }

async function app() {
  const repo = await makeRepo({ 'foundation.json': '{}' });
  const foundation = await head(repo);
  await git(repo, ['update-ref', 'refs/foundation/v0.1.0', foundation]);   // where Plan 8's createApp keeps the release (Contract 7 §7.11)
  await git(repo, ['checkout', '-q', '-b', 'build/r1']);
  await commitFile(repo, 'claims.ts', 'x');
  const sha = await head(repo);
  await git(repo, ['checkout', '-q', 'main']);   // appDir stays on main: the council must still review the build commit
  return { repo, foundation, sha };
}

test('a guarded clone at the build commit, based on the foundation commit; appDir untouched', async () => {
  const { repo, foundation, sha } = await app();
  const before = (await git(repo, ['for-each-ref'])).stdout;
  const c = await openCouncilWorkspace({ appDir: repo, sha, foundation: { tag: 'v0.1.0', commit: foundation }, runId: 'r1', baseDir: tmp('cw-') });
  assert.equal(await c.ws.head(), sha);
  assert.equal(c.ws.baseSha, foundation);
  assert.equal(c.problem, null);
  assert.deepEqual(await c.ws.filesRange(c.ws.baseSha, sha), ['claims.ts']);
  await c.ws.guardGitDir();                                   // a real Workspace
  c.remove();
  assert.equal(existsSync(c.ws.dir), false);
  assert.equal((await git(repo, ['for-each-ref'])).stdout, before);
});

test('an unknown foundation commit falls back to refs/foundation/<tag>, then to the merge base with a plain problem', async () => {
  const { repo, foundation, sha } = await app();
  const byTag = await openCouncilWorkspace({ appDir: repo, sha, foundation: { tag: 'v0.1.0', commit: 'deadbeef' }, runId: 'r1', baseDir: tmp('cw-') });
  assert.equal(byTag.baseSha, foundation);
  byTag.remove();
  const byBase = await openCouncilWorkspace({ appDir: repo, sha, foundation: { tag: 'v9.9.9', commit: 'deadbeef' }, runId: 'r1', baseDir: tmp('cw-') });
  assert.equal(byBase.baseSha, foundation);   // merge-base of build/r1 and main
  assert.equal(byBase.problem, "Conductor could not find foundation release v9.9.9, so the council reviewed only this build's own changes");
  byBase.remove();
});

test('no base at all throws a plain error and leaves no folder behind', async () => {
  const { repo, sha } = await app();
  await git(repo, ['branch', '-m', 'main', 'trunk']);   // no main: merge-base fails
  const baseDir = tmp('cw-');
  await assert.rejects(
    openCouncilWorkspace({ appDir: repo, sha, foundation: { tag: 'v9.9.9', commit: 'deadbeef' }, runId: 'r1', baseDir }),
    /The council could not find where this build started\./);
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(baseDir), []);
});

test('the council log keeps its state across calls; a broken state file starts fresh', () => {
  const buildDir = tmp('b-');
  const a = openCouncilLog(buildDir);
  assert.deepEqual(a.state.council, { round: 0, fixRounds: 0, secretSeen: false, history: [] });
  a.state.council.round = 2;
  a.log.saveState(a.state);
  assert.equal(openCouncilLog(buildDir).state.council.round, 2);
  writeFileSync(path.join(buildDir, 'council', 'state.json'), '{ broken');
  const events = [];
  const c = openCouncilLog(buildDir, { onEvent: (e) => events.push(e.type) });
  assert.equal(c.state.council.round, 0);
  assert.ok(events.includes('council-state-reset'));
});

test('a valid-JSON state of the wrong shape starts fresh too', () => {
  for (const bad of ['{"council":{}}', '{"council":"x"}', '{"version":1,"notes":[],"warnings":[],"council":{"round":"1","fixRounds":0,"secretSeen":false,"history":[]}}']) {
    const buildDir = tmp('b-');
    mkdirSync(path.join(buildDir, 'council'), { recursive: true });
    writeFileSync(path.join(buildDir, 'council', 'state.json'), bad);
    const events = [];
    const c = openCouncilLog(buildDir, { onEvent: (e) => events.push(e.type) });
    assert.deepEqual(c.state.council, { round: 0, fixRounds: 0, secretSeen: false, history: [] });
    assert.ok(events.includes('council-state-reset'), bad);
  }
});

test('merge-base fallback works when appDir was on another branch, and a missing tag reads plainly', async () => {
  const { repo, sha } = await app();
  await git(repo, ['checkout', '-q', 'build/r1']);   // clone has no local main, only origin/main
  const c = await openCouncilWorkspace({ appDir: repo, sha, foundation: {}, runId: 'r2', baseDir: tmp('cw-') });
  assert.ok(c.baseSha);
  assert.equal(c.problem, "Conductor could not find the foundation release, so the council reviewed only this build's own changes");
  c.remove();
});

test('a failed copy says so plainly', async () => {
  await assert.rejects(
    openCouncilWorkspace({ appDir: tmp('nogit-'), sha: 'abcdef12', foundation: {}, runId: 'r3', baseDir: tmp('cw-') }),
    /^Error: The council could not copy the build to check it\./);
});
