# Task 3: Council workspace and log

A project round runs outside `drive`, in its own throwaway workspace (index Architecture, "One round per call").

**`openCouncilWorkspace`** makes a real `Workspace`, so `callAgent`'s git-directory guard (`ws.guardGitDir`) protects it exactly as it protects a normal run:
1. `mkdtemp` under `baseDir` (default `defaultBaseDir()`, so outside the project folder, as Plan 8 Ruling 8 requires);
2. `git clone --quiet --no-hardlinks <appDir> .`;
3. `git checkout -q -b conductor-council/<runId> <sha>`;
4. `git remote remove origin`.

It then works out the base (index Ruling 3):
- `foundation.commit` if `git cat-file -e <commit>^{commit}` succeeds;
- else `git rev-parse --verify --quiet <tag>^{commit}`;
- else `git merge-base <sha> main`, with `problem = 'Conductor could not find foundation release <tag>, so the council reviewed only this build\'s own changes'`;
- if even that fails, the round cannot be based on anything, so it throws `The council could not find where this build started.`

Then `new Workspace(dir, branch, baseSha)`, `mkdirSync(ws.metaDir)`, `ws.sealConfig()`. `remove()` deletes the folder and its `.conductor` meta folder, and never throws.

**`openCouncilLog`** opens `new RunLog(<buildDir>/council, { onEvent })`. It reads `<buildDir>/council/state.json` if present (a JSON error starts fresh, with the event `council-state-reset`). Otherwise it starts from `{ version: 1, request: null, plan: null, notes: [], warnings: [], council: { round: 0, fixRounds: 0, secretSeen: false, history: [] } }`. `log.saveState(state)` (atomic, as `RunLog` already does) persists round numbers, history and cached evidence across hook calls (Review Focus 5).

**Files:**
- Create: `src/council/councilWorkspace.js`
- Test: `test/council-workspace.test.js` (new)

**Interfaces:**
- Consumes: `Workspace`, `git`, `defaultBaseDir` (`src/workspace.js`); `RunLog` (`src/runlog.js`); `makeRepo` (`test/helpers/gitRepo.js`).
- Produces:
  - `openCouncilWorkspace({ appDir, sha, foundation, runId, baseDir }) -> Promise<{ ws, baseSha, problem, remove }>`;
  - `openCouncilLog(buildDir, { onEvent } = {}) -> { log, state }`.

- [ ] **Step 1: Write the failing tests**

Create `test/council-workspace.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
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
  await git(repo, ['tag', 'v0.1.0']);
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

test('an unknown foundation commit falls back to the tag, then to the merge base with a plain problem', async () => {
  const { repo, foundation, sha } = await app();
  const byTag = await openCouncilWorkspace({ appDir: repo, sha, foundation: { tag: 'v0.1.0', commit: 'deadbeef' }, runId: 'r1', baseDir: tmp('cw-') });
  assert.equal(byTag.baseSha, foundation);
  byTag.remove();
  const byBase = await openCouncilWorkspace({ appDir: repo, sha, foundation: { tag: 'v9.9.9', commit: 'deadbeef' }, runId: 'r1', baseDir: tmp('cw-') });
  assert.equal(byBase.baseSha, foundation);   // merge-base of build/r1 and main
  assert.equal(byBase.problem, "Conductor could not find foundation release v9.9.9, so the council reviewed only this build's own changes");
  byBase.remove();
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-workspace.test.js`
Expected: FAIL with `Cannot find module '../src/council/councilWorkspace.js'`.

- [ ] **Step 3: Implement `src/council/councilWorkspace.js`** as described. On any error after the `mkdtemp`, remove the folder before rethrowing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/council-workspace.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/councilWorkspace.js test/council-workspace.test.js
git commit -m "feat(council): a guarded throwaway workspace at the build commit, and a council log that persists across rounds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
