# Task 4: Core — start from a branch, and the gate knows the commit

Two small additions to the core, both needed by the change path whatever Plan 8's loop looks like inside:

1. **Start a run from a named branch.** Today `Workspace.create` clones the repository's checked-out commit. A change must start from the app's `main` even if someone left the app folder on another branch, and a foundation upgrade must start from the upgrade branch (Task 6). `Workspace.create` and `runTask` gain `baseRef` (a branch name). Without it, nothing changes.
2. **The gate argument carries `sha` and `workspaceDir`.** Task 5 writes down exactly which commit the operator approved, and later checks that this is what reached `main` and the release. Today the `approveResult` argument has the summary, files, diff and council report, but not the commit. It gains `sha: approvedSha`, the commit `land()` will ship, and `workspaceDir: ws.dir`, so a check can read that commit before it is landed (Task 9's conflict-marker check).

Plan 8's loop must pass both through (Task 1 Step 0 checks it does). These are the only core edits in Plan 11.

**Files:**
- Modify: `src/workspace.js` (`Workspace.create`), `src/conductor.js` (`runTask`, the `approveResult` call in `drive`)
- Test: `test/workspace.test.js` (append), `test/conductor.test.js` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `Workspace.create({ repoDir, baseDir, taskId, baseRef = null })`;
  - `runTask({ …existing, baseRef = null })`, with `state.baseRef` saved (null when not given);
  - the `approveResult` argument gains `sha` and `workspaceDir`;
  - `BASE_REF_MISSING(baseRef, repoDir)` text: `` `There is no branch called ${baseRef} in ${repoDir}, so the run did not start.` ``

- [ ] **Step 1: Write the failing tests**

Append to `test/workspace.test.js`:

```js
test('baseRef: the workspace starts from that branch, whatever the repository has checked out', async () => {
  const repo = await makeRepo({ 'a.txt': 'main\n' });
  await git(repo, ['checkout', '-q', '-b', 'side']);
  writeFileSync(path.join(repo, 'a.txt'), 'side\n');
  await git(repo, ['commit', '-qam', 'side']);
  const mainSha = (await git(repo, ['rev-parse', 'main'])).stdout.trim();
  const before = await refsOf(repo);
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't', baseRef: 'main' });
  assert.equal(ws.baseSha, mainSha);
  assert.equal(readFileSync(path.join(ws.dir, 'a.txt'), 'utf8'), 'main\n');
  assert.equal(ws.source.branch, 'main');
  assert.equal(ws.source.dirty, false, 'dirty describes the checked-out branch only');
  assert.equal(await refsOf(repo), before, 'the real repository is untouched');
  assert.equal((await git(ws.dir, ['remote'])).stdout.trim(), '', 'no remote is left behind');
});
test('baseRef that is not a branch of the repository: refused before anything is created', async () => {
  const repo = await makeRepo();
  const b = base();
  await assert.rejects(Workspace.create({ repoDir: repo, baseDir: b, taskId: 't', baseRef: 'nope' }), { message: BASE_REF_MISSING('nope', repo) });
  assert.deepEqual(readdirSync(b), [], 'no half-made workspace is left');
});
test('baseRef that looks like an option or a revision expression is refused', ...)
  // '-x', 'main~1', 'HEAD@{1}' → rejects /There is no branch called/
```

Append to `test/conductor.test.js`:

```js
test('runTask with baseRef plans and builds on that branch; the gate is told the exact commit it approves', async () => {
  // repo with main and a 'side' branch checked out; runTask({ …, baseRef: 'main' })
  // assert state.baseRef === 'main' in <workspace>.conductor/state.json (keepWorkspace: true)
  // const gate = h.calls.find((c) => c.name === 'approveResult').arg;
  // assert.match(gate.sha, /^[0-9a-f]{40}$/); assert.equal(gate.workspaceDir, out.workspaceDir ?? <the run's workspace>);
  // assert (await git(gate.workspaceDir, ['rev-parse', 'HEAD'])).stdout.trim() === gate.sha
  // assert the landed branch in the repo points at gate.sha
});
test('without baseRef nothing changes: the workspace starts from the checked-out commit', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/workspace.test.js test/conductor.test.js`
Expected: the new tests FAIL; the old ones pass.

- [ ] **Step 3: Implement**

- `Workspace.create`: validate `baseRef` before making any folder: it must pass `git check-ref-format refs/heads/<baseRef>`, not start with `-`, and contain none of `~^:@{`; otherwise throw `BASE_REF_MISSING`. After the clone and **before** `remote remove origin` (removing the remote deletes `refs/remotes/origin/*`), resolve `refs/remotes/origin/<baseRef>^{commit}`; if missing, throw `BASE_REF_MISSING` (the existing `catch` removes the folder). Then `checkout -q -b <branch> <sha>`. `source.branch = baseRef`; `source.dirty` is computed as today only when the repository's checked-out branch is `baseRef`, otherwise `false`.
- `runTask`: accept `baseRef`, pass it to `Workspace.create`, add `baseRef: baseRef ?? null` to the initial state.
- `drive`: add `sha: approvedSha, workspaceDir: ws.dir` to the object passed to `approveResult` (inside the existing `redact({...})`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/workspace.js src/conductor.js test/workspace.test.js test/conductor.test.js
git commit -m "feat(core): runs can start from a named branch; the gate is told the commit it approves and where it is"
```
