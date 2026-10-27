# Task 9: Final checks, council hook and the operator's gate

When every feature is merged, `runFinal` finishes the build (spec §4.2–§4.4):
1. **Whole-app checks** on the build branch's tip (`runAppChecks`, with the browser gate when `factory.build.browserGate`). Saved with the sha they ran on, so a resume does not run them twice.
2. **Red checks** become a fix unit (`Make the whole-app checks pass again`) and the build goes back to the features phase, at most `factory.build.fixRounds` times (default 2). After that a red `verify` stops the build; a red browser gate goes to the operator (approve to continue to the gate with a warning, reject to stop).
3. **The council hook** (`hooks.council`, Plan 9; Contract 7 §7.7). Without it, the summary says the full council is not part of this version yet. With it:
   - it gets the same-`sha` `checks`, so Plan 9 reuses their reports;
   - `blocked` plus a `fix` becomes a fix unit, capped by its **own** counter against `factory.build.councilFixRounds` (default 3, spec §4.3). It does not share the red-checks cap;
   - `blocked` at the cap goes to the operator;
   - `paused` pauses the build;
   - `secretSeen: true` (sticky for the build) makes the whole `build/<runId>` branch one commit before the gate (Plan 5 Ruling 10).
4. **The operator's gate** (`hooks.approveBuild`):
   - **approve:** `main` moves to the build's tip by compare-and-swap. `project.json` records `approved = { sha, at, runId, briefVersion }` and `builtFromBrief`, and `status` becomes `ready` (Contract 7 §7.5, §7.6). **No release is cut**: Plan 10's `releaseApp` does that when the app is first shipped;
   - **feedback** (a note): becomes a fix unit `Operator feedback`, and the build goes back to the features phase. This is not capped: the operator decides;
   - **reject:** `rejected`, and `main` is unchanged.

**Files:**
- Create: `src/factory/buildFinal.js`, `test/helpers/buildHarness.js` (the `UNITS`, `json`, `PLAN`, `team`, `setup` and `log` helpers moved out of `test/factory-build.test.js`, which now imports them)
- Test: `test/factory-build-final.test.js`

**Interfaces:**
- Consumes: `bctx` (Task 8), `runAppChecks`, `checksLine` (Task 6), `saveProject` (`src/factory/projects.js`, Plan 7), `git` (`src/workspace.js`), `clip` (`src/text.js`), `redact`.
- Produces:
  - `runFinal(bctx) -> Promise<{ next: 'features' } | BuildOutcome>`
  - `fixUnit({ build, title, instructions, prefix }) -> Unit` (`id` = `<prefix>-<n>`, `kind: 'fix'`, empty `covers`/`acceptance`/`dependsOn`); `prefix` is `fix` or `feedback`. It also appends the matching feature record.
  - `buildSummaryText({ build, project, checks, councilText, slug }) -> string`
  - `NO_COUNCIL_YET = 'The full council review is not part of this version of Conductor yet, so only the checks above were run.'`
  - `squashBuild({ appDir, branch, sha, onto, message, git }) -> Promise<sha>`: one commit holding `sha`'s tree on parent `onto` (the `main` tip). The branch moves by compare-and-swap from `sha`; the tree is checked to be identical. Re-entrant: a branch already at a one-commit squash with the same tree returns that commit.
  - The council hook contract (Contract 7 §7.7, index Shared Interfaces): `hooks.council({ projectDir, appDir, sha, brief, policy, runId, slug, team, factory, onEvent, checks })` → `{ status, text, fix?, reason?, secretSeen? }`.

- [ ] **Step 1: Write the failing tests**

Move the helpers into `test/helpers/buildHarness.js` (exported unchanged; `setup()` gains an optional `deps` override that is merged over its defaults, and no longer stubs `runFinal`, so the real one runs; `test/factory-build.test.js` keeps passing its own `runFinal` stub in each test, or adds it in a local wrapper). Then create `test/factory-build-final.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runBuild } from '../src/factory/build.js';
import { latestBuild } from '../src/factory/buildState.js';
import { git } from '../src/workspace.js';
import { team, setup } from './helpers/buildHarness.js';

const green = { verify: { status: 'passed', summary: 'ok', output: '' }, browser: { status: 'passed', summary: 'ok', output: '' }, reports: [] };
const rev = async (dir, ref) => (await git(dir, ['rev-parse', ref])).stdout.trim();
const gate = (answers) => { const seen = []; return { seen, approveBuild: async (a) => { seen.push(a.summary); return answers.shift(); } }; };

test('approved: main moves to the build, the project is ready, the summary says what was built and what was not checked', async () => {
  const s = await setup();
  const g = gate([true]);
  const out = await runBuild({ factory: s.factory, slug: s.slug, team: team(), hooks: { ...s.hooks, ...g }, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'ready');
  const appDir = path.join(s.projectDir, 'app');
  const b = latestBuild(s.projectDir);
  assert.equal(await rev(appDir, 'main'), await rev(appDir, b.branch));
  const project = JSON.parse(readFileSync(path.join(s.projectDir, 'project.json'), 'utf8'));
  assert.equal(project.status, 'ready');
  assert.deepEqual(Object.keys(project.approved).sort(), ['at', 'briefVersion', 'runId', 'sha']);
  assert.deepEqual([project.approved.sha, project.approved.runId, project.approved.briefVersion, project.builtFromBrief],
    [await rev(appDir, 'main'), b.runId, 1, 1]);
  assert.equal((await git(appDir, ['tag', '--points-at', 'main'])).stdout.trim(), '', 'the gate does not cut a release');
  const summary = g.seen[0];
  assert.match(summary, /What was built \(2 features\):\n {2}1\. Submit and list expenses: done\n {2}2\. Monthly report: done/);
  assert.match(summary, /All checks pass/);
  assert.match(summary, /The full council review is not part of this version of Conductor yet/);
  assert.match(summary, /See it running: conductor preview acme-ltd/);
});

test('red whole-app checks become one fix feature, then the checks run again on the new tip', async () => {
  const s = await setup();
  const seen = [];
  const checks = async (o) => { seen.push(o); return seen.length === 2 ? { ...green, browser: { status: 'failed', summary: 'x', output: 'phone layout scrolls sideways' } } : green; };
  const t = team();
  const out = await runBuild({ factory: s.factory, slug: s.slug, team: t, hooks: { ...s.hooks, ...gate([true]) }, deps: { ...s.deps, runAppChecks: checks }, env: {} });
  assert.equal(out.status, 'ready');
  const b = latestBuild(s.projectDir);
  assert.deepEqual(b.features.map((f) => f.id), ['expenses', 'report', 'fix-1']);
  assert.ok(t.local.calls.some((c) => /Make the whole-app checks pass again/.test(c.task) && /phone layout scrolls sideways/.test(c.task)));
  assert.equal(seen.length, 3, 'baseline, red final, green final');
  assert.match(seen[0].reportsDir, /baseline$/);
  assert.notEqual(seen[1].sha, seen[2].sha);
  assert.match((await git(path.join(s.projectDir, 'app'), ['log', '-1', '--format=%s', b.branch])).stdout, /^Fix 3\/3: Make the whole-app checks pass again/);
});

test('the council hook: blocked with a fix → fix feature → council again → approved; its text is in the summary', async () => {
  const s = await setup();
  const calls = [];
  const council = async (a) => { calls.push(a); return calls.length === 1
    ? { status: 'blocked', text: 'Council report: blocked', fix: { title: 'Council fixes, round 1', instructions: 'Hide the totals from members.' } }
    : { status: 'approved', text: 'Council report: approved, nothing to fix' }; };
  const g = gate([true]);
  const out = await runBuild({ factory: s.factory, slug: s.slug, team: team(), hooks: { ...s.hooks, ...g, council }, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'ready');
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['appDir', 'brief', 'checks', 'factory', 'onEvent', 'policy', 'projectDir', 'runId', 'sha', 'slug', 'team']);
  assert.equal(calls[0].checks.sha, calls[0].sha, 'the council gets the checks for the same commit');
  assert.equal(calls[0].checks.verify.status, 'passed');
  assert.match(g.seen[0], /Council report: approved, nothing to fix/);
});

test('council fixes have their own cap (factory.build.councilFixRounds), separate from the red-checks cap', async () => {
  const s = await setup();
  const factory = { ...s.factory, build: { ...s.factory.build, fixRounds: 0, councilFixRounds: 2 } };
  let n = 0;
  const council = async () => ({ status: 'blocked', text: `Council report ${++n}: blocked`, fix: { title: `Council fixes, round ${n}`, instructions: 'Hide the totals.' } });
  const escalations = [];
  const hooks = { ...s.hooks, ...gate([true]), council, escalate: async (a) => { escalations.push(a); return 'reject'; } };
  const out = await runBuild({ factory, slug: s.slug, team: team(), hooks, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'stopped');
  const b = latestBuild(s.projectDir);
  assert.deepEqual([b.councilFixRounds, b.fixRounds], [2, 0]);
  assert.deepEqual(b.features.map((f) => f.id), ['expenses', 'report', 'fix-1', 'fix-2']);
  assert.equal(escalations.length, 1, 'blocked at the cap goes to the operator');
  assert.equal(escalations[0].kind, 'council');
});

test('secretSeen: the build branch becomes one commit with the same files before the gate', async () => {
  const s = await setup();
  const council = async () => ({ status: 'approved', text: 'Council report: approved', secretSeen: true });
  const g = gate([true]);
  const out = await runBuild({ factory: s.factory, slug: s.slug, team: team(), hooks: { ...s.hooks, ...g, council }, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'ready');
  const appDir = path.join(s.projectDir, 'app');
  const b = latestBuild(s.projectDir);
  const tag = (await git(appDir, ['rev-parse', 'v0.1.0^{commit}'])).stdout.trim();
  assert.equal((await git(appDir, ['rev-list', '--count', `${tag}..main`])).stdout.trim(), '1');
  assert.equal(b.squashedSha, await rev(appDir, 'main'));
  assert.match(g.seen[0], /combined into one commit/);
});

test('operator feedback becomes a fix feature and the gate is asked again; reject leaves main alone', async () => {
  const s = await setup();
  const g = gate([{ approved: false, note: 'Make the report totals bold.' }, false]);
  const t = team();
  const out = await runBuild({ factory: s.factory, slug: s.slug, team: t, hooks: { ...s.hooks, ...g }, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'rejected');
  assert.equal(g.seen.length, 2);
  assert.ok(t.local.calls.some((c) => /Make the report totals bold\./.test(c.task)));
  const appDir = path.join(s.projectDir, 'app');
  assert.notEqual(await rev(appDir, 'main'), await rev(appDir, latestBuild(s.projectDir).branch));
  const project = JSON.parse(readFileSync(path.join(s.projectDir, 'project.json'), 'utf8'));
  assert.deepEqual([project.status, project.approved], ['building', null]);
  assert.match(out.reason, /You did not approve the build\. The app's main branch is unchanged/);
});

test('a crash after main moved but before the build was saved: the next run finishes without asking again', async () => {
  const s = await setup();
  const pause = async (bctx) => { bctx.build.phase = 'gate'; bctx.build.status = 'paused'; bctx.save(); return { status: 'paused', runId: bctx.build.runId, buildDir: bctx.buildDir, reason: 'p' }; };
  await runBuild({ factory: s.factory, slug: s.slug, team: team(), hooks: s.hooks, deps: { ...s.deps, runFinal: pause }, env: {} });
  const appDir = path.join(s.projectDir, 'app');
  const b = latestBuild(s.projectDir);
  await git(appDir, ['update-ref', 'refs/heads/main', await rev(appDir, b.branch)]);
  const g = gate([]);
  const out = await runBuild({ factory: s.factory, slug: s.slug, team: team(), hooks: { ...s.hooks, ...g }, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'ready');
  assert.equal(g.seen.length, 0);
  assert.equal(JSON.parse(readFileSync(path.join(s.projectDir, 'project.json'), 'utf8')).approved.sha, await rev(appDir, 'main'));
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/factory-build-final.test.js`
Expected: FAIL (`Cannot find module` for `buildFinal.js`, through the dynamic import).

- [ ] **Step 3: Implement `runFinal` in `src/factory/buildFinal.js`**

Order, each step re-entrant:
1. `sha` = tip of `build.branch`. **Approved before a crash:** when `build.phase === 'gate'` and `main` already equals `sha`, go straight to step 8's "approved" branch without asking.
2. Checks: when `build.checks?.sha !== sha`, run `deps.runAppChecks({ appDir, sha, workDir: <buildDir>/check, reportsDir: <buildDir>/reports, testCommand: factory.build.testCommand, browser: factory.build.browserGate, env })`, save as `build.checks = { ...result, sha }`, `emit('build-checks', { verify, browser })`, `progress(checksLine(result))`.
3. Red verify or red browser gate with `build.fixRounds < factory.build.fixRounds` → `build.fixRounds += 1`; `fixUnit({ build, prefix: 'fix', title: 'Make the whole-app checks pass again', instructions })` with instructions `The whole-app checks fail on the finished build. Make them pass without weakening, skipping or editing any check, and without changing what the app does. What failed:\n<clip(failing output, 1500)>`; save; return `{ next: 'features' }`.
4. Still red at the cap: red `verify` → `finish('stopped', 'The whole-app checks still fail after <n> rounds of fixes, so the build cannot be approved. <checksLine>. The build is kept; fix the cause and run "conductor build <slug>" to try again.')`. Red browser gate → `hooks.escalate({ kind: 'build', title: 'the browser checks', options: ['approve', 'reject'], message })` with a plain message naming the first failing line; `approve` adds the warning `The browser checks failed and you approved the build anyway.` to `build.warnings`; anything else → `finish('stopped', 'You stopped the build because the browser checks fail. The build is kept.')`.
5. Council: without `hooks.council`, `councilText = NO_COUNCIL_YET`. With it, when `build.council?.sha !== sha`:
   - call it with exactly the keys in the test: `policy: brief.policy`, `onEvent: emit`, `checks: build.checks` (the same `sha`, with `reports`);
   - save `build.council = { ...r, sha }` and `build.secretSeen = build.secretSeen || r.secretSeen === true`, then `emit('build-council', { status })`.
   - `paused` → `finish('paused', r.reason ?? 'The council paused.')`.
   - `blocked` with `fix` and `build.councilFixRounds < factory.build.councilFixRounds` → `fixUnit({ prefix: 'fix', title: r.fix.title, instructions: r.fix.instructions })`, `build.councilFixRounds += 1`, save, return `{ next: 'features' }`.
   - `blocked` otherwise → escalate (`kind: 'council'`, the council text as the concern). Approve marks `build.council.overridden = true`. Reject → `finish('stopped', 'You stopped the build because the council still found problems that must be fixed. The build is kept.')`.
6. **Secret seen** (Plan 5 Ruling 10), when `build.secretSeen` and `build.squashedSha !== sha`:
   - `squashed = await squashBuild({ appDir, branch: build.branch, sha, onto: <main tip>, message: \`Build <runId> of <client>'s app (one commit: a possible secret was seen in its history)\` })`;
   - set `build.checks.sha`, `build.council.sha` and `build.squashedSha` to `squashed`. The tree is identical, so the results still hold;
   - add the note `The build's commits were combined into one commit, because the council saw a possible secret in an earlier step.`;
   - best-effort `git reflog expire --expire=now --all` and `git gc --prune=now --quiet` in the app, so the old commits leave its object store. A failure adds a note;
   - save. From here `sha` is `squashed`.
7. `build.phase = 'gate'`; save.
8. Gate: `answer = await hooks.approveBuild({ summary: buildSummaryText(…) })` (a throwing hook counts as `false`).
   - Exactly `true`, or step 1's "approved before a crash":
     1. `git update-ref refs/heads/main <sha> <old main>`: compare-and-swap. The old main must be an ancestor of `sha`, else fail with the "not where Conductor left it" message. Skip this when `main` already equals `sha`.
     2. `git checkout -q main` in the app (clean checkout).
     3. `saveProject(projectDir, { ...project, status: 'ready', approved: { sha, at: now().toISOString(), runId: build.runId, briefVersion: build.briefVersion }, builtFromBrief: build.briefVersion })`.
     4. `build.phase = 'done'`; `finish('ready', null)`.
     - No tag and no release: Plan 10's `releaseApp` cuts the first release at ship time (Contract 7 §7.6).
   - An object with a non-empty `note` → `fixUnit({ prefix: 'feedback', title: 'Operator feedback', instructions: 'The operator looked at the finished build and asked for this change:\n<clip(redact(note), 2000)>' })`; `phase = 'features'`; save; `{ next: 'features' }`.
   - Anything else → `finish('rejected', 'You did not approve the build. The app\'s main branch is unchanged; the build is kept in <buildDir>.')`.

- [ ] **Step 4: Implement `buildSummaryText`**

Lines, in order:
```
Build <runId> of <client>'s app, on foundation <tag>
What was built (<n> features):
  <k>. <title>: done                      ← ": done after <a> tries" when attempts > 1; fix units included
Checks: <checksLine(checks)>
Role-crossing report: <path>              ← when build.checks.reports has crossing.md
Page screenshots: <reportsDir>/screenshots ← when copied
<councilText>
<the squash note, when step 6 ran>
Frontier cost this build: about $<x.xx>, as the subscriptions report it.   ← "not reported" when 0
Paid API use this build: <n> calls, about $<y.yy>.                        ← only when apiCalls > 0
<each build warning>
Notes:                                    ← only when any; feature notes then build notes, as "  - <text>"
See it running: conductor preview <slug>
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/factory-build-final.test.js test/factory-build.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/factory/buildFinal.js test/helpers/buildHarness.js test/factory-build-final.test.js test/factory-build.test.js
git commit -m "feat(factory): whole-app checks, the council hook and the operator's build gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
