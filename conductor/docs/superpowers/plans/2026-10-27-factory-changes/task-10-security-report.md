# Task 10: Security-behind report

Spec §5: "The factory tells the operator which live apps are behind on a security fix." `conductor foundation-upgrade --check` prints, for every project under `projectsRoot`:
- **the code**: the foundation tag recorded in `project.json` (what the next ship would carry);
- **each deployment**: the `foundation` field Plan 10 records in `deployments/<name>.json` after every install or update, read through Plan 10's `listDeployments(projectsRoot)` (what is actually live). Plan 10's `deploymentStatus` is not used: it probes each box over ssh, and this report must work offline and without a terminal.

For each, it lists the `[security]` fixes in the foundation's newest release that are newer than what it is on. It reads the foundation's `CHANGELOG.md` at the newest release tag (`releaseTags` + `readChangelogAt`, Task 2), once per foundation repo, and uses Plan 10's `parseChangelog` and `securityFixesSince` from the same `foundationLog.js`.

It fails closed (index Ruling 10): anything it cannot read becomes "could not check: …" for that row, never "up to date". It never uses the app's `foundation.json` (Ruling 11).

**Files:**
- Create: `src/factory/change/behind.js`
- Test: `test/factory-change-behind.test.js`

**Interfaces:**
- Consumes: `releaseTags`, `readChangelogAt` (Task 2); `parseChangelog`, `securityFixesSince` (Plan 10); `loadProject` (Plan 7); `deps.listDeployments` (Plan 10, via seams); `makeFoundation`, `makeProject`, `stubDeps` (Task 1).
- Produces:
  - `securityBehind({ projectsRoot, deps, read = { releaseTags, readChangelogAt } }) -> Promise<Row[]>` (`read` lets a test count foundation reads), rows ordered by project slug, then `code` first, then deployments by name;
  - `behindText(rows) -> string`;
  - `Row = { slug, where, on, latest, behind: [{ version, lines }], problem }`.

- [ ] **Step 1: Write the failing tests**

```js
test('code and each deployment are checked separately against the newest foundation release', async () => {
  // foundation v0.1.0, v0.1.1 (security), v0.1.2 (no security), v0.2.0 (security: 'Uploads are scanned for type.')
  // project acme: code on v0.2.0 (upgrade merged), deployment acme-office on v0.1.0, acme-cloud on v0.2.0
  const rows = await securityBehind({ projectsRoot, deps });
  assert.deepEqual(rows.map((r) => [r.slug, r.where, r.on, r.behind.map((b) => b.version), r.problem]), [
    ['acme', 'code', 'v0.2.0', [], null],
    ['acme', 'acme-cloud', 'v0.2.0', [], null],
    ['acme', 'acme-office', 'v0.1.0', ['0.2.0', '0.1.1'], null],
  ]);
});

test('behindText: plain lines, the fixes named, and what to do', () => {
  assert.equal(behindText(rows), [
    'Newest foundation release: v0.2.0.',
    '',
    'acme',
    '  code: up to date (v0.2.0)',
    '  acme-cloud: up to date (v0.2.0)',
    '  acme-office: on v0.1.0, missing 2 security fixes:',
    '    - Uploads are scanned for type. (0.2.0)',
    '    - Sessions now expire after 12 hours. (0.1.1)',
    '',
    'To fix: if the code is behind, run "conductor foundation-upgrade <slug> --to v0.2.0". If only deployments are behind, the upgrade is already in the code: finish or resume the change that ships it (conductor change <slug> --resume).',
  ].join('\n'));
});

test('a project whose foundation repo cannot be read says "could not check", never up to date', ...)
  // project.json foundation.repo points at a missing folder → row problem /could not check: The foundation repository at .* could not be read/
test('a changelog heading that is not understood makes every row of that foundation "could not check"', ...)
  // foundation v0.1.1 CHANGELOG has '## [0.1.1] - 2026-1-2' → problem quotes the foundation's heading message
test('a deployment with no foundation recorded, or one Plan 10 could not read, says so', ...)
  // listDeployments entry with deployment.foundation null → problem 'could not check: this deployment does not record which foundation release it runs.'
  // entry { deployment: null, problem: 'the deployment file is damaged' } → problem 'could not check: the deployment file is damaged'
test('a tag recorded in project.json that is not a release name is a "could not check"', ...)   // 'main' → /is not a foundation release name/
test('projects with no deployments show only the code row; an empty projects root says there are no projects', ...)
test('the foundation repo is read once per repo, however many projects use it', ...)    // pass read: { releaseTags, readChangelogAt: counting wrapper }; two projects on one repo → 1 call
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-change-behind.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/factory/change/behind.js`**

- List the project folders under `projectsRoot` that contain `project.json`; a damaged one gives a single row `{ slug: <folder>, where: 'code', problem: 'could not check: its project.json could not be read.' }`.
- Per foundation repo (`project.foundation.repo`), cache `{ latest, text } | { problem }`: `releaseTags(repo).at(-1)` (none → problem `the foundation has no releases yet.`), `readChangelogAt(repo, latest)`, and a trial `parseChangelog(text)` so a bad heading is caught once.
- Code row: `on = project.foundation.tag`; must match `^v\d+\.\d+\.\d+$` else problem `` `could not check: "${tag}" is not a foundation release name.` ``; `behind = securityFixesSince(text, on.slice(1))`. Any throw → `could not check: <message>`.
- Deployment rows: from `deps.listDeployments(projectsRoot)` filtered by slug, sorted by name; `on = entry.deployment.foundation`; an entry `problem` from Plan 10 is carried as `could not check: <problem>`; `foundation` missing → the sentence in the test. A deployment whose setup is not finished is still listed (it may hold a live app).
- `behindText`: as in the test. When nothing is behind and nothing failed, end with `Every project and deployment has every security fix in the newest foundation release.` instead of the "To fix" line. When any row could not be checked, add `Some rows could not be checked, so do not assume they are up to date.` before the "To fix" line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-change-behind.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/change/behind.js test/factory-change-behind.test.js
git commit -m "feat(change): report which projects and deployments are behind on foundation security fixes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
