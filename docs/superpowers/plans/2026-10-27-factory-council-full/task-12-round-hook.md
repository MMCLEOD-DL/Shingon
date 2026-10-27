# Task 12: The project round, the report and the hook

This task connects the pieces.

**`runCouncilRound(ctx, { files, tests, diff, members, env, project = null })`.** With `project === null` it is the Plan 5 round, unchanged (index Ruling 1, Review Focus 2). With a project:
1. `input` gains `project`, `brief`, `briefText` (`project.briefText`), `policy`, and `evidence = await collectEvidence(ctx, { project, head, round, deps: project.deps })` (Task 6), worked out before any member runs.
2. When `project.problem` is set, a locked warning with that title (member `correctness`, no tool) is added to the findings.
3. Each member's interpreter gets `context` and `attach` from **its own** ToolRuns only (Task 7).
4. `buildReport` gets `checked`, `coverage` and `files`, and `writeCouncilReport(project.buildDir, report)` saves the report. Event `council-report-saved { md }`.

`files` and `diff` come from the caller. The hook passes the whole-app range. `ws.baseSha` is already the foundation commit (Task 3), so the `-U0` diff, `addedFiles` and the lockfile delta all measure from the foundation.

**Report text** changes, used only when `report.checked` is set:
- after the heading lines: `What was checked:`, then one line per member, `  - <Label>: <labels of its ToolRuns that ran, joined by ", ">`, or `  - <Label>: nothing could run`;
- `  Worked examples proven: <p> of <t>` when `coverage` is set;
- the warnings list puts the "not proven / not checked" locked warnings first (titles starting `Reliability was not proven`, `Brief coverage was not proven` or `The pages were not checked`);
- last: `  Full report: <md>` and, when `files.screenshots` is set, `  Screenshots: <dir>`.

`report.files` is set before the text is rendered, so the text names the file. `council-report.json` is the report minus `text`, redacted. Both files are written with `writeAtomic` (temp file in the same folder, `fsync`, `rename`).

**`runProjectCouncil(args, { options = {}, deps = {} } = {})`** is the `hooks.council` implementation (index A1):
1. `project = await projectContext(args, deps)` (Task 1). Add `factory: args.factory ?? {}` and `deps`.
2. `{ log, state } = openCouncilLog(project.buildDir, { onEvent: args.onEvent })` (Task 3). `state.request ??= `Build the client app for ${project.client} described in the approved brief.``.
3. `opened = await openCouncilWorkspace({ appDir, sha, foundation, runId, baseDir: deps.baseDir })`. `project.problem = opened.problem`.
4. `ctx = { ws: opened.ws, log, state, team: args.team, options: { ...DEFAULT_OPTIONS, ...options, council: true } }`. `validateCouncilOptions(ctx.options)`.
5. `project.briefText = (deps.renderBrief ?? renderBrief from src/factory/brief.js)(args.brief)`.
6. `files = await ws.filesRange(ws.baseSha, sha)` and `diff = await ws.diffRange(ws.baseSha, sha)`.
7. `r = await runCouncilRound(ctx, { files, tests: null, diff, members: membersFor(PROJECT_COUNCIL), project })`.
8. Result:
   - `paused` → `{ status: 'paused', reason }`;
   - otherwise `{ status: report.verdict, text: report.text }`, plus, when blocked, `fix: { title, instructions }` from `fixChunk(report, state.council.round)`.
9. `finally`: `opened.remove()`.
10. Any unexpected error → `{ status: 'paused', reason: 'The council hit a problem it could not get past (<plain message>), so the build paused. Run "conductor build <slug>" to try again.' }`. The hook never throws (Plan 8 would treat a throw as a crash).

**Member registry** (index A4): `MEMBERS` gains `design: DESIGN` and `reliability: RELIABILITY`. Add `PROJECT_COUNCIL = Object.freeze(['security', 'legal', 'correctness', 'design', 'reliability'])`. `validateCouncilOptions`' `councilMembers` check then accepts the two new names automatically.

**Files:**
- Create: `src/council/reportFile.js`, `src/council/projectCouncil.js`
- Modify: `src/council/index.js` (`MEMBERS`, `PROJECT_COUNCIL`, `runCouncilRound`), `src/council/report.js` (`buildReport`, `reportText`)
- Test: `test/council-round.test.js` (append), `test/council-report.test.js` (append), `test/council-hook.test.js` (new)

**Interfaces:**
- Consumes: Tasks 1, 3, 6–11; Plan 5's round, `fixChunk`, `buildReport`; Plan 8's `MEMBERS` and `membersFor` (index A4).
- Produces: as in the index (`PROJECT_COUNCIL`, `runCouncilRound(… project)`, `CouncilReport.checked`/`coverage`/`files`, `writeCouncilReport`, `writeAtomic`, `runProjectCouncil`, event `council-report-saved`).

- [ ] **Step 1: Write the failing tests**

Append to `test/council-round.test.js`:

```js
test('ordinary repo: the Plan 5 round exactly — no evidence, no project sections, no files written', async () => {
  const ctx = await roundCtx();                     // the existing helper in this file
  const r = await runCouncilRound(ctx, { files: ['a.js'], tests: { ran: true, passed: true, code: 0, output: '' }, diff: 'd' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(events(ctx, 'council-start')[0].members, ['security', 'legal', 'correctness']);
  assert.equal(events(ctx, 'council-evidence').length, 0);
  assert.equal(r.report.checked, undefined);
  assert.doesNotMatch(r.report.text, /What was checked|Full report/);
  assert.equal(events(ctx, 'council-report-saved').length, 0);
});
```

Append to `test/council-report.test.js`:
- `buildReport` with `checked: ['Security: Semgrep (code scanner)', 'Reliability: nothing could run']`, `coverage: { proven: 2, total: 3 }`, `files: { md: '/p/builds/r1/council-report.md', json: '/p/builds/r1/council-report.json', screenshots: '/p/builds/r1/council/round-1/screenshots' }`, and two warnings, the second titled `Reliability was not proven: no machine`;
- its text contains `What was checked:\n  - Security: Semgrep (code scanner)\n  - Reliability: nothing could run` and `  Worked examples proven: 2 of 3`;
- the "not proven" warning comes before the other warning;
- the text ends with `  Full report: /p/builds/r1/council-report.md\n  Screenshots: /p/builds/r1/council/round-1/screenshots`;
- `writeCouncilReport(tmp, report)` writes both files, the JSON parses with `verdict` and no `text` key, and no temp file is left in the folder.

Create `test/council-hook.test.js`, the hook end to end, everything stubbed:
- **App repo.** The first commit holds `foundation.json` and `old.ts` (with `https://old-vendor.co.uk/api`, which was already there, so it must not be checked) and is the foundation commit. Branch `build/r1` then adds:
  - `apps/server/src/claims/total.ts`, with `const total = miles * 0.45;` and `fetch('https://vision.googleapis.com/v1')`;
  - `apps/server/src/db/schema/claims.ts`, with `pgTable('claims'` and a `claimant_name` column.
  `appDir` is left on `main`.
- **`deps`:**
  - `loadProject` returns `foundation: { repo: '/f', tag: 'v0.1.0', commit: <first sha> }`;
  - `renderBrief` returns `'# Acme Ltd'`;
  - `run: fakeGatesRun({ codes: { vitest: 1, browser: 1 } }).run`;
  - `checks: okChecks`;
  - `getMachineProvider` returns `fakeProvider({ machine })`;
  - `createSsh` returns `fakeSsh` answering `run-smoke.sh` with `smoke-failed-step5.log`;
  - `baseDir` is a temp folder.
  Other council tools are turned off (`options.councilTools` from `councilStubs(tmp, {})`, plus `axe: false`).
- **Team.** The reviewer is a fake that records every prompt and replies `VERDICT: APPROVE` with no JSON, so every tool finding stands as graded.

```js
test('the hook: whole app, five members, blocked with a fix, report saved, appDir untouched', async () => {
  const before = (await git(appDir, ['for-each-ref'])).stdout;
  const r = await runProjectCouncil({ projectDir, appDir, sha: buildSha, brief: BRIEF, policy: BRIEF.policy, runId: 'r1', slug: 'acme', team, factory: {}, onEvent: (e) => seen.push(e) },
    { options, deps });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(seen.find((e) => e.type === 'council-start').members, ['security', 'legal', 'correctness', 'design', 'reliability']);
  for (const t of ['The app connects to vision.googleapis.com, which the data policy does not allow', 'The tests fail',
    'Worked example mileage-claims#1 fails its test', 'A user journey fails in the browser: a member adds a note with a photo (desktop)',
    'The notes page scrolls sideways on a phone (Safari)', 'The reliability test failed at: back up, then test a restore']) assert.match(r.text, new RegExp(escape(t)));
  assert.doesNotMatch(r.text, /old-vendor/);
  assert.match(r.text, /Worked examples proven: 1 of 3/);
  assert.equal(r.fix.title, 'Council fixes, round 1');
  assert.match(r.fix.instructions, /The reliability test failed at: back up, then test a restore/);
  assert.equal(readFileSync(path.join(projectDir, 'builds', 'r1', 'council-report.md'), 'utf8'), r.text);
  assert.equal(machine.released, 1);
  assert.equal((await git(appDir, ['for-each-ref'])).stdout, before);
  assert.equal(prompts.filter((p) => p.includes('reports/screenshots/')).length, 1);          // Design only
  assert.ok(prompts.some((p) => p.includes("The client's approved brief:\n# Acme Ltd")));
});

test('the hook again on a fixed commit: round 2, fresh evidence, "Fixed during the review"', async () => {
  // a second commit on build/r1 removes the URL; the smoke now passes; call the hook with the new sha
  const r2 = await runProjectCouncil({ ...args, sha: fixedSha }, { options, deps: { ...deps, createSsh: () => fakeSsh([{ match: 'tar -x' }, { match: 'run-smoke.sh', stdout: log('smoke-passed.log') }, { match: 'rm -rf' }]).ssh } });
  assert.match(r2.text, /Round 2/);
  assert.match(r2.text, /Fixed during the review[\s\S]*The reliability test failed at: back up, then test a restore/);
});

test('the hook on the same commit after a pause: no second machine, no second gate run', async () => {
  // first call: the Design interpreter's participant is missing → { status: 'paused' }; second call with the same sha → acquire count 1, fake run calls unchanged
});

test('the hook never throws: an unexpected error pauses the build with a plain reason', async () => {
  const r = await runProjectCouncil({ ...args }, { options, deps: { ...deps, loadProject: async () => { throw new Error('The project file could not be read.'); } } });
  assert.deepEqual(r, { status: 'paused', reason: 'The council hit a problem it could not get past (The project file could not be read.), so the build paused. Run "conductor build acme" to try again.' });
});
```

Fill in the sketched pause test in the same style (`team` gives `failure: 'no-participant'` once).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-round.test.js test/council-report.test.js test/council-hook.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** the changes above. Keep every Plan 5 line for `project === null` byte for byte. Put the project-only steps in `if (project)` blocks.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS, including every existing council round, report and drive test, unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/council/index.js src/council/report.js src/council/reportFile.js src/council/projectCouncil.js test/council-round.test.js test/council-report.test.js test/council-hook.test.js
git commit -m "feat(council): the full council hook for client builds (whole app, five members, report saved in the build folder)"
```
