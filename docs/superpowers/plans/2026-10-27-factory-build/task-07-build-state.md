# Task 7: Build state and squash-merge

The pieces that make a build crash-safe (index Review Focus 1):
- `build.json` in `builds/<runId>/`, written atomically after every step that matters, plus `build-log.jsonl` (the build's own events, redacted);
- the project-level lock is **not** here: it is Plan 7's `lockProject(projectDir, 'build')` (`src/factory/projectLock.js`, Contract 7 §7.1), used by Task 8;
- `mergeFeature`: puts a landed feature onto the build branch as **one** commit (index Ruling 4), and is safe to call again after a crash;
- `archiveFeatureRun`: keeps a feature run's transcript in the build folder and removes its workspace.

**Files:**
- Create: `src/factory/buildState.js`
- Test: `test/factory-build-state.test.js`

**Interfaces:**
- Consumes: `writeJsonAtomic` (`src/factory/fsAtomic.js`, Plan 7), `git`, `metaDirOf` (`src/workspace.js`), `redact` (`src/secrets.js`), `makeFoundationRepo` (Task 1).
- Produces:
  - `buildDirOf(projectDir, runId) -> <projectDir>/builds/<runId>`
  - `newBuild({ runId, slug, client, briefHash, briefVersion, foundation, now = new Date() }) -> Build`. Index shape: `kind: 'build'`, `phase: 'setup'`, `status: 'running'`, `branch: 'build/<runId>'`, `baseSha: null`, empty lists, `fixRounds: 0`, `councilFixRounds: 0`, `secretSeen: false`, `squashedSha: null`, zeroed `usage`.
    - `kind` is `'build'` here. Plan 11's change runs use the same run-id format and keep their record in `change.json` (Contract 7 §7.1, §7.5).
  - `saveBuild(buildDir, build)`, `loadBuild(buildDir) -> Build|null`, `latestBuild(projectDir) -> Build|null`
  - `appendBuildLog(buildDir, type, data)`
  - `hashBrief(brief) -> string` (sha256 of the brief's JSON with keys sorted at every level)
  - `mergeFeature({ appDir, buildBranch, landedBranch, landedSha, expectedBase, message, git = gitFn }) -> Promise<sha>`
  - `readRunState(workspaceDir) -> object|null`
  - `archiveFeatureRun({ workspaceDir, buildDir, index, id }) -> string|null`

- [ ] **Step 1: Write the failing tests**

Create `test/factory-build-state.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildDirOf, newBuild, saveBuild, loadBuild, latestBuild, hashBrief, mergeFeature, archiveFeatureRun, readRunState } from '../src/factory/buildState.js';
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

test('mergeFeature refuses a moved build branch and a dirty app folder, changing nothing', async () => {
  const { appDir, base, landedSha } = await appWithBuildBranch();
  writeFileSync(path.join(appDir, 'stray.txt'), 'x');
  await assert.rejects(mergeFeature({ appDir, buildBranch: 'build/r1', landedBranch: 'conductor/feature', landedSha, expectedBase: base, message: 'm' }),
    /The app folder has changes Conductor did not make/);
  assert.equal(await out(appDir, ['rev-parse', 'build/r1']), base);
  await assert.rejects(mergeFeature({ appDir, buildBranch: 'build/r1', landedBranch: 'conductor/feature', landedSha, expectedBase: landedSha, message: 'm' }),
    /The build branch build\/r1 is not where Conductor left it/);
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/factory-build-state.test.js`
Expected: FAIL (`Cannot find module '../src/factory/buildState.js'`).

- [ ] **Step 3: Implement `src/factory/buildState.js`**

- `saveBuild` writes `redact(build)` with `writeJsonAtomic` to `<buildDir>/build.json` (creating the folder). `loadBuild` returns `null` when the file is missing; unparsable or `schema !== 1` throws `The saved state of build <runId from the folder name> cannot be read (<reason>). It is kept in <file>; start a new build with "conductor build <slug> --new".` (The `--new` flag is added in Task 15.)
- `latestBuild` reads every `builds/*/build.json` it can parse and returns the one with the greatest `runId` (run ids sort by time).
- `appendBuildLog` appends `JSON.stringify(redact({ at: new Date().toISOString(), type, ...data }))` and a newline to `<buildDir>/build-log.jsonl`.
- `mergeFeature` (the order matters for crash safety):
  1. `head = rev-parse refs/heads/<buildBranch>`.
  2. If `head !== expectedBase`: when `rev-parse head^ === expectedBase` and `head^{tree} === landedSha^{tree}`, the merge already happened: delete the landed branch if it still exists and return `head`. Otherwise throw `The build branch <buildBranch> is not where Conductor left it, so it stopped rather than guess. Nothing was changed.`
  3. `merge-base --is-ancestor <expectedBase> <landedSha>` must succeed, and `rev-parse refs/heads/<landedBranch>` must equal `landedSha`; otherwise throw `The finished feature is not based on the build branch, so it was not added. Nothing was changed.`
  4. `status --porcelain` must be empty (else `The app folder has changes Conductor did not make, so it stopped. Nothing was changed.`).
  5. `commit-tree <landedSha^{tree}> -p <expectedBase> -m <message>`, then `update-ref refs/heads/<buildBranch> <new> <expectedBase>`.
  6. When the app's current branch is `buildBranch`: `reset -q --hard <new>`.
  7. `update-ref -d refs/heads/<landedBranch> <landedSha>`. Return the new sha.
- `readRunState(dir)`: parse `<metaDirOf(dir)>/state.json`; `null` when missing or unreadable.
- `archiveFeatureRun`: copy `<metaDirOf(ws)>/transcript.jsonl` (when present) to `<buildDir>/features/<NN>-<id>.jsonl` (`NN` = index + 1, two digits; when that name is taken by an earlier attempt, `<NN>-<id>-2.jsonl`, `-3`, …), then remove the workspace and its metadata folder. Returns the copy's path, or `null` when there was no transcript.

- [ ] **Step 4: Run the tests**

Run: `node --test test/factory-build-state.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/buildState.js test/factory-build-state.test.js
git commit -m "feat(factory): build state and crash-safe feature merge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
