# Task 6: Council round & report

This task puts the members together into one **council round** and turns its findings into the **council report**. The report is written for the operator, not as a scanner dump. The task also produces the **fix chunk** that carries blocking findings back to the step loop.

- **Members run one after another and independently.** Each interpreter prompt carries only that member's findings. The one thing shared is hygiene: a file in which Gitleaks found a possible secret introduced by this change is hidden from the diff shown in **every** later council prompt.
- **The round's result is saved in `state.council`** (round number, the commit it reviewed, the fix count at the time, and blocking keys per round). That way "fixed during the review" can be worked out, and a resume after a crash or pause re-runs only the unfinished round. A round re-run on the same commit with the same fix count (a crash after the save but before the fix step was queued, or during the council escalation) keeps its number and replaces its history entry (index Review Focus 4).
- **What "already there" needs is worked out here** (index Ruling 5): the lines this change added (`git diff -U0 baseSha..HEAD`, read by Task 2's `addedLines`) go into the input, and when the tests fail, the test command is run once on the starting commit and the answer saved in `state.council.baseTests`.
- **Secrets.** `state.council.secretSeen` is set once any round sees a possible secret introduced by this change. Task 7 uses it to combine the run's commits before the gate (index Ruling 10).

**Files:**
- Create: `src/council/report.js`, `src/council/index.js`
- Test: `test/council-report.test.js`, `test/council-round.test.js` (new)

**Interfaces:**
- Consumes:
  - Task 1: `makeFinding`, `findingKey`, `tally`, `MEMBER_LABEL`, `TOOL_LABEL`, `resolveTool`;
  - Tasks 2–4: `SECURITY`, `LEGAL`, `CORRECTNESS`;
  - Task 5: `interpretMember`;
  - Task 2: `addedLines`, `unquoteGitPath`;
  - `git` (`src/workspace.js`), `ws.head`, `ws.ignoredPaths`, `ws.resetHard`, `ws.runTests`;
  - `clip`.
- Produces: `councilVerdict`, `buildReport`, `reportText`, `fixChunk`, `hideFiles`, `MEMBERS_V1`, `runCouncilRound`, `validateCouncilOptions`, `councilToolStatus`, `state.council`, and the `council-*` events, all as in the index.
  - `hideFiles(diff, files: Set<string>) -> string` is exported from `src/council/index.js`.
  - `buildReport`'s `by` is a string (interpreter names joined with `, `) or null.

- [ ] **Step 1: Write the failing tests**

Create `test/council-report.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { councilVerdict, buildReport, reportText, fixChunk } from '../src/council/report.js';
import { makeFinding, findingKey } from '../src/council/findings.js';

const F = (o) => Object.assign(makeFinding({ tool: 'semgrep', grade: 'warning', ...o }), o.extra ?? {});
const evalF = F({ member: 'security', grade: 'blocking', title: 'Untrusted input reaches eval()', file: 'src/a.js', line: 4, detail: 'rule js.eval',
  extra: { why: 'anyone could run code on the server', fix: 'parse the value with JSON.parse instead' } });
const testsF = F({ member: 'correctness', tool: 'tests', grade: 'blocking', locked: true, title: 'The tests fail (exit code 1)', detail: 'not ok 3' });
const oldF = F({ member: 'security', grade: 'warning', title: 'old eval', file: 'old.js', line: 2, preExisting: true });
const noteF = F({ member: 'legal', tool: null, grade: 'note', title: 'licence file looks fine' });
const fpF = F({ member: 'security', grade: 'warning', title: 'key in fixture', file: 'test/x.js', extra: { dismissed: true, why: 'it is a test fixture' } });
const RUNS = [
  { tool: 'gitleaks', status: 'missing', note: 'Gitleaks (secret scanner) is not installed, so this check did not run.' },
  { tool: 'semgrep', status: 'ran', note: null },
  { tool: 'tests', status: 'skipped', note: null },   // no test command: its note finding says so; no empty line here
];

test('councilVerdict: any blocking blocks; set-aside findings do not count', () => {
  assert.equal(councilVerdict([evalF, oldF]), 'blocked');
  assert.equal(councilVerdict([oldF, fpF]), 'approved-with-warnings');
  assert.equal(councilVerdict([noteF, { ...evalF, dismissed: true }]), 'approved');
});

test('the report reads as plain English for the operator', () => {
  const r = buildReport({ round: 2, findings: [testsF, evalF, oldF, noteF, fpF], toolRuns: RUNS, by: 'codex',
    history: [{ round: 1, blocking: [{ key: 'security|semgrep|src/b.js|SQL built from user input', title: 'SQL built from user input', member: 'security' }] }] });
  assert.equal(r.verdict, 'blocked');
  assert.deepEqual(r.resolved, ['[Security] SQL built from user input']);
  assert.equal(r.text, [
    'Council report: NOT approved: 2 blocking problems remain',
    '  Round 2 · checked by codex',
    'Fixed during the review (1):',
    '  - [Security] SQL built from user input',
    'Still blocking (2):',
    '  - [Security] Untrusted input reaches eval(): anyone could run code on the server (found by Semgrep (code scanner), src/a.js:4)',
    '  - [Correctness] The tests fail (exit code 1) (found by the test command)',
    'Warnings (1):',
    '  - [Security] old eval (found by Semgrep (code scanner), old.js:2) — already there before this change',
    'Notes (1):',
    '  - [Legal] licence file looks fine',
    'Set aside as false alarms (1):',
    '  - [Security] key in fixture: it is a test fixture (found by Semgrep (code scanner), test/x.js)',
    'Checks that did not run:',
    '  - Gitleaks (secret scanner) is not installed, so this check did not run.',
  ].join('\n'));
  assert.equal(reportText({ ...r, overridden: true }).split('\n')[0], 'Council report: NOT approved: 2 blocking problems remain, and you chose to continue');
  assert.deepEqual(r.toolNotes, ['Gitleaks (secret scanner) is not installed, so this check did not run.']);
  assert.doesNotMatch(r.text, /null/);
});

test('approved headings, the tools-only line, and long sections are capped', () => {
  assert.equal(buildReport({ round: 1, findings: [], toolRuns: [], by: null }).text, 'Council report: approved, nothing to fix\n  Round 1 · checked by the tools only');
  assert.equal(buildReport({ round: 1, findings: [oldF], toolRuns: [], by: 'codex' }).text.split('\n')[0], 'Council report: approved, with 1 warning to read');
  const many = Array.from({ length: 25 }, (_, i) => F({ member: 'security', title: `w${i}` }));
  const text = buildReport({ round: 1, findings: many, toolRuns: [], by: 'codex' }).text;
  assert.match(text, /^Warnings \(25\):$/m);
  assert.match(text, /^ {2}… and 5 more \(see the run log\)$/m);
});

test('a problem that blocked earlier and still blocks is not "fixed"', () => {
  const r = buildReport({ round: 2, findings: [evalF], toolRuns: [], by: 'codex', history: [{ round: 1, blocking: [{ key: findingKey(evalF), title: evalF.title, member: 'security' }] }] });
  assert.deepEqual(r.resolved, []);
});

test('fixChunk carries every blocking finding with its evidence, and nothing else', () => {
  const r = buildReport({ round: 1, findings: [evalF, testsF, oldF], toolRuns: [], by: 'codex' });
  const c = fixChunk(r, 1);
  assert.equal(c.title, 'Council fixes, round 1');
  assert.equal(c.councilFix, 1, 'marks a council fix step in the plan');
  assert.match(c.instructions, /^The review council found problems that must be fixed before this change can ship\./);
  assert.match(c.instructions, /1\. \[Security\] Untrusted input reaches eval\(\) — src\/a\.js:4\n {3}Evidence \(Semgrep \(code scanner\)\): rule js\.eval\n {3}Why it matters: anyone could run code on the server\n {3}Suggested fix: parse the value with JSON\.parse instead/);
  assert.match(c.instructions, /2\. \[Correctness\] The tests fail \(exit code 1\)\n {3}Evidence \(the test command\): not ok 3/);
  assert.doesNotMatch(c.instructions, /old eval/);
  const huge = buildReport({ round: 1, findings: Array.from({ length: 60 }, (_, i) => F({ member: 'security', grade: 'blocking', title: `b${i}`, detail: 'x'.repeat(2000) })), toolRuns: [], by: null });
  assert.ok(fixChunk(huge, 2).instructions.length <= 7100);
});
```

Create `test/council-round.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCouncilRound, hideFiles, validateCouncilOptions, councilToolStatus, MEMBERS_V1 } from '../src/council/index.js';
import { SECURITY } from '../src/council/security.js';
import { CORRECTNESS } from '../src/council/correctness.js';
import { makeFinding } from '../src/council/findings.js';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { fakeParticipant, makeCtx } from './helpers/fakes.js';
import { councilStubs, GITLEAKS_AKIA } from './helpers/councilStubs.js';

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```';
const member = (name, titles, alwaysInterpret = false) => ({
  member: name, label: name[0].toUpperCase() + name.slice(1), alwaysInterpret,
  collect: async () => [{ tool: 'semgrep', label: 'Semgrep (code scanner)', status: 'ran', note: null,
    findings: titles.map((t) => makeFinding({ member: name, tool: 'semgrep', grade: 'blocking', title: t, file: 'a.js' })) }],
});

async function ctxWith(reviewerScript = () => ({ text: fence({ findings: [] }) }), options = {}) {
  const events = [];
  const team = {
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: () => ({ text: 'x' }) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: reviewerScript }),
    local: fakeParticipant({ name: 'local', kind: 'local-agent', roles: ['grunt'], script: () => ({ text: 'x' }) }),
  };
  const ctx = await makeCtx({ team, hooks: { onEvent: (e) => events.push(e) }, options: { council: true, ...options } });
  ctx.state.plan = { summary: 'S', chunks: [{ title: 'One', instructions: 'i' }] };
  return { ctx, events };
}

test('a round: members one by one, independent prompts, no AI call when a member found nothing', async () => {
  const { ctx, events } = await ctxWith();
  const head = await ctx.ws.head();
  const out = await runCouncilRound(ctx, { files: ['a.js'], tests: null, diff: '+x', members: [member('security', ['SEC-ONLY']), member('legal', []), member('correctness', ['COR-ONLY'], true)] });
  assert.equal(out.status, 'ok');
  assert.equal(out.report.verdict, 'blocked');
  const tasks = ctx.team.reviewer.calls.map((c) => c.task);
  assert.equal(tasks.length, 2, 'legal found nothing and is not alwaysInterpret');
  assert.match(tasks[0], /SEC-ONLY/);
  assert.doesNotMatch(tasks[1], /SEC-ONLY/, 'members never see each other\'s findings');
  assert.deepEqual(events.filter((e) => e.type.startsWith('council')).map((e) => `${e.type}:${e.member ?? ''}:${e.stage ?? e.verdict ?? ''}`), [
    'council-start::', 'council-member:security:tools', 'council-tool:security:', 'council-member:security:interpreting', 'council-member-done:security:',
    'council-member:legal:tools', 'council-tool:legal:', 'council-member-done:legal:',
    'council-member:correctness:tools', 'council-tool:correctness:', 'council-member:correctness:interpreting', 'council-member-done:correctness:',
    'council-finding:security:', 'council-finding:correctness:', 'council-verdict::blocked',
  ]);
  assert.deepEqual(ctx.state.council, { round: 1, fixRounds: 0, secretSeen: false, history: [{ round: 1, sha: head, fixRounds: 0, blocking: [
    { key: 'security|semgrep|a.js|SEC-ONLY', title: 'SEC-ONLY', member: 'security' },
    { key: 'correctness|semgrep|a.js|COR-ONLY', title: 'COR-ONLY', member: 'correctness' },
  ] }] });
  assert.equal(JSON.parse(readFileSync(path.join(ctx.ws.metaDir, 'state.json'), 'utf8')).council.round, 1, 'saved');
  assert.equal(out.report.by, 'codex');
});

test('a paused interpreter leaves the round unfinished, so resume runs it again', async () => {
  const { ctx } = await ctxWith(() => ({ ok: false, failure: 'no-participant', error: 'no AI model is available for codex (codex: rate-limited)' }));
  const out = await runCouncilRound(ctx, { files: [], tests: null, diff: '', members: [member('security', ['x'])] });
  assert.deepEqual(out, { status: 'paused', reason: 'no AI model is available for codex (codex: rate-limited)' });
  assert.equal(ctx.state.council.round, 0);
});

test('a round re-run on the same commit with the same fix count keeps its number (Review Focus 4)', async () => {
  const { ctx } = await ctxWith();
  const members = [member('security', ['x'])];
  await runCouncilRound(ctx, { files: [], tests: null, diff: '', members });
  // A crash after the save, before the fix step was queued (or during the escalation): resume runs it again.
  const again = await runCouncilRound(ctx, { files: [], tests: null, diff: '', members });
  assert.equal(again.report.round, 1);
  assert.equal(ctx.state.council.history.length, 1, 'replaced, not duplicated');
  ctx.state.council.fixRounds = 1;   // a fix step ran, even one that changed nothing
  const next = await runCouncilRound(ctx, { files: [], tests: null, diff: '', members });
  assert.equal(next.report.round, 2);
  assert.deepEqual(next.report.resolved, [], 'still blocking, so not "fixed"');
  assert.equal(ctx.state.council.history.length, 2);
});

test('tests that already failed at the starting commit only warn; the workspace is put back (Ruling 5)', async () => {
  // Fails whenever a.js exists (only after the change), or always.
  const onlyAfter = `node -e "process.exit(require('fs').existsSync('a.js') ? 1 : 0)"`;
  for (const [testCommand, verdict] of [['node -e "process.exit(2)"', 'approved-with-warnings'], [onlyAfter, 'blocked']]) {
    const { ctx, events } = await ctxWith(undefined, { testCommand });
    writeFileSync(path.join(ctx.ws.dir, 'a.js'), 'x\n');
    writeFileSync(path.join(ctx.ws.dir, 'a.test.js'), '// t\n');
    await ctx.ws.commitAll('step');
    const head = await ctx.ws.head();
    const tests = await ctx.ws.runTests(testCommand);
    const out = await runCouncilRound(ctx, { files: ['a.js', 'a.test.js'], tests, diff: '+x', members: [CORRECTNESS] });
    assert.equal(out.report.verdict, verdict, testCommand);
    assert.equal(await ctx.ws.head(), head, 'the workspace is back at the change');
    assert.ok(existsSync(path.join(ctx.ws.dir, 'a.js')));
    assert.equal(events.filter((e) => e.type === 'council-base-tests').length, 1);
    await runCouncilRound(ctx, { files: ['a.js', 'a.test.js'], tests, diff: '+x', members: [CORRECTNESS] });
    assert.equal(events.filter((e) => e.type === 'council-base-tests').length, 1, 'the answer is saved, not asked again');
  }
});

test('a member whose checks throw gives a warning, not a crash', async () => {
  const { ctx } = await ctxWith();
  const broken = { member: 'legal', label: 'Legal', alwaysInterpret: false, collect: async () => { throw new Error('bug'); } };
  const out = await runCouncilRound(ctx, { files: [], tests: null, diff: '', members: [broken] });
  assert.equal(out.report.verdict, 'approved-with-warnings');
  assert.match(out.report.text, /The Legal checks hit a problem \(bug\), so they gave no answer\./);
});

test('a secret found in the change never reaches a prompt, the transcript or the report (Review Focus 5)', async () => {
  const KEY = 'AKIAQWERTYUIOPASDFGH';
  const { ctx } = await ctxWith(undefined, { councilTools: councilStubs(mkdtempSync(path.join(tmpdir(), 'crnd-')), { gitleaks: GITLEAKS_AKIA }) });
  writeFileSync(path.join(ctx.ws.dir, 'cfg.js'), `export const k = "${KEY}";\n`);
  await ctx.ws.commitAll('step'); // committed, so its line counts as added by this change
  const diff = `diff --git a/cfg.js b/cfg.js\n+export const k = "${KEY}";\ndiff --git a/b.js b/b.js\n+ok\n`;
  const out = await runCouncilRound(ctx, { files: ['cfg.js', 'b.js'], tests: null, diff, members: [SECURITY, member('correctness', [], true)] });
  assert.equal(out.report.verdict, 'blocked');
  for (const c of ctx.team.reviewer.calls) assert.doesNotMatch(c.task, new RegExp(KEY));
  assert.match(ctx.team.reviewer.calls[1].task, /changes to cfg\.js hidden: the secret scanner found a possible secret in it/);
  assert.match(ctx.team.reviewer.calls[1].task, /\+ok/);
  assert.doesNotMatch(out.report.text, new RegExp(KEY));
  assert.doesNotMatch(readFileSync(ctx.log.transcript, 'utf8'), new RegExp(KEY));
  assert.equal(ctx.state.council.secretSeen, true, 'Task 7 combines the commits before the gate');
});

test('hideFiles swaps whole file sections of a diff', () => {
  const d = 'diff --git a/x b/x\n+1\ndiff --git a/y b/y\n+2\n';
  assert.equal(hideFiles(d, new Set(['x'])), 'diff --git a/x b/x\n(changes to x hidden: the secret scanner found a possible secret in it)\ndiff --git a/y b/y\n+2\n');
  assert.equal(hideFiles(d, new Set()), d);
});

test('hideFiles finds the path in spaced, quoted and deleted forms', () => {
  const d = 'diff --git a/my file.js b/my file.js\n--- a/my file.js\t\n+++ b/my file.js\t\n@@ -0,0 +1 @@\n+k\n' +
    'diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"\n--- "a/caf\\303\\251.js"\n+++ "b/caf\\303\\251.js"\n@@ -0,0 +1 @@\n+k\n' +
    'diff --git a/gone.js b/gone.js\ndeleted file mode 100644\n--- a/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-k\n' +
    'diff --git a/keep.js b/keep.js\n--- a/keep.js\n+++ b/keep.js\n@@ -0,0 +1 @@\n+visible\n';
  const out = hideFiles(d, new Set(['my file.js', 'café.js', 'gone.js']));
  assert.doesNotMatch(out, /^[+-]k$/m);
  for (const p of ['my file\\.js', 'café\\.js', 'gone\\.js']) assert.match(out, new RegExp(`\\(changes to ${p} hidden`));
  assert.match(out, /^\+visible$/m);
});

test('validateCouncilOptions explains bad settings in plain words; off means unchecked', () => {
  const v = (o) => () => validateCouncilOptions({ ...DEFAULT_OPTIONS, council: true, ...o });
  assert.doesNotThrow(v({}));
  assert.throws(v({ councilFixRounds: 11 }), /councilFixRounds must be a whole number from 0 to 10/);
  assert.throws(v({ councilFixRounds: 1.5 }), /councilFixRounds/);
  assert.throws(v({ councilAcceptLicences: 'GPL' }), /councilAcceptLicences must be a list of licence names/);
  assert.throws(v({ councilTools: { semgrep: 1 } }), /councilTools must map a tool name to a path or false/);
  assert.throws(v({ councilTools: { trivy: false } }), /councilTools: unknown tool "trivy" \(known: semgrep, gitleaks, npm-audit, scancode\)/);
  assert.doesNotThrow(() => validateCouncilOptions({ ...DEFAULT_OPTIONS, councilFixRounds: 99 }));
});

test('councilToolStatus reports each optional tool for doctor', () => {
  const status = councilToolStatus({ options: { ...DEFAULT_OPTIONS, councilTools: { semgrep: false } }, env: { PATH: '' } });
  assert.deepEqual(status.map((s) => [s.tool, s.ok, s.why]), [
    ['semgrep', false, 'turned off in the config'], ['gitleaks', false, 'not installed'], ['npm-audit', false, 'not installed'], ['scancode', false, 'not installed'],
  ]);
  assert.deepEqual(MEMBERS_V1.map((m) => m.member), ['security', 'legal', 'correctness']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-report.test.js test/council-round.test.js`
Expected: FAIL with `Cannot find module '../src/council/report.js'`.

- [ ] **Step 3: Implement `src/council/report.js`**

- `councilVerdict(findings)`: from `tally`, `blocking > 0` gives `'blocked'`, `warning > 0` gives `'approved-with-warnings'`, else `'approved'`.
- `buildReport({ round, findings, toolRuns, by, history = [], overridden = false })`:
  - `live = findings.filter((f) => !f.dismissed)`. Within each grade, sort stably by member, in the order `security`, `legal`, `correctness`.
  - `blocking`, `warnings` and `notes` are the live findings by grade, and `dismissed` is the rest.
  - `toolNotes` are the `note`s of runs whose status is not `ran`, with null or empty notes dropped (`.filter(Boolean)`): the `tests` run is `skipped` with `note: null` when no test command is set.
  - `resolved` lists `` `[${MEMBER_LABEL[member]}] ${title}` `` for every history blocking entry whose `key` is not among the current blocking keys, deduped by key, oldest first.
  - Finally `text = reportText(report)`.
- `reportText(r)` follows the layout pinned by the test:
  - **Heading:**
    - `approved` → `approved, nothing to fix`;
    - `approved-with-warnings` → `` `approved, with ${n} warning${n === 1 ? '' : 's'} to read` ``;
    - `blocked` → `` `NOT approved: ${n} blocking problem${n === 1 ? ' remains' : 's remain'}` ``, plus `, and you chose to continue` when `overridden`.
  - **Second line:** `` `  Round ${round} · checked by ${by ?? 'the tools only'}` ``.
  - **Sections, in order, each omitted when empty:** `Fixed during the review`, `Still blocking`, `Warnings`, `Notes`, `Set aside as false alarms`, `Checks that did not run` (that last one has no count).
  - Each section shows at most 20 items, then `` `  … and ${n} more (see the run log)` ``.
  - **Item line:**

    ```js
    const where = [f.tool && `found by ${TOOL_LABEL[f.tool] ?? f.tool}`, f.file && (f.line ? `${f.file}:${f.line}` : f.file)].filter(Boolean);
    `  - [${MEMBER_LABEL[f.member]}] ${f.title}${f.why ? `: ${f.why}` : ''}${where.length ? ` (${where.join(', ')})` : ''}${f.preExisting ? ' — already there before this change' : ''}`
    ```

- `fixChunk(report, fixRound)` returns `{ title, instructions, councilFix: fixRound }`:
  - The title is `` `Council fixes, round ${fixRound}` ``.
  - The instructions start with: `The review council found problems that must be fixed before this change can ship. Fix each one below with the smallest change that does it, and add or update tests where that makes sense. Do not change anything else.`
  - Then a blank line and one numbered block per blocking finding:
    - `` `${n}. [${Label}] ${title}${file ? ` — ${file}${line ? `:${line}` : ''}` : ''}` ``;
    - `` `   Evidence (${TOOL_LABEL[tool] ?? 'reviewer'}): ${clip(detail, 800)}` ``, only when there is a detail;
    - `` `   Why it matters: ${why}` ``, only when there is a why;
    - `` `   Suggested fix: ${fix}` ``, only when there is a fix.
  - Stop adding blocks before the text would exceed 7000 characters, and end with `` `(${k} more problems are listed in the council report.)` ``.

- [ ] **Step 4: Implement `src/council/index.js`**

- `MEMBERS_V1 = [SECURITY, LEGAL, CORRECTNESS]` and `COUNCIL_TOOLS = [['semgrep', 'semgrep'], ['gitleaks', 'gitleaks'], ['npm-audit', 'npm'], ['scancode', 'scancode']]`.
- `hideFiles(diff, files)`:
  - Return `diff` unchanged when `files` is empty. Otherwise split on `/^(?=diff --git )/m`.
  - Work out each part's path with `diffPath` below, which handles git's quoted form (non-ASCII, quotes, backslashes), the trailing tab git adds to `---`/`+++` lines for paths with spaces, and deleted files.
  - For every part whose path is in `files`, replace the part with its first line (the `diff --git` header as git wrote it) plus `` `\n(changes to ${p} hidden: the secret scanner found a possible secret in it)\n` ``.

  ```js
  function diffPath(part) {
    const side = (re, prefix) => {
      const m = part.match(re);
      return m && m[1] !== '/dev/null' ? unquoteGitPath(m[1]).replace(prefix, '') : null;
    };
    const head = part.match(/^diff --git (?:"(?:[^"\\]|\\.)*"|a\/.+?) ("(?:[^"\\]|\\.)*"|b\/.+)$/m);
    return side(/^\+\+\+ (.+?)\t?$/m, /^b\//) ?? side(/^--- (.+?)\t?$/m, /^a\//)
      ?? (head ? unquoteGitPath(head[1]).replace(/^b\//, '') : null);
  }
  ```
- `validateCouncilOptions(o)`:
  - Return straight away unless `o.council`.
  - Otherwise throw the exact messages pinned by the test, each ending with ` (got <JSON>)` where a value is shown, except the unknown-tool message.
- `councilToolStatus({ options, env })` maps `COUNCIL_TOOLS` through `resolveTool`:
  - `label` comes from `TOOL_LABEL`;
  - `ok` is `!!path`;
  - `why` is `off ? 'turned off in the config' : path ? '' : 'not installed'`.
- `testsAtBase(ctx, head)` (not exported): the one-off test run on the starting commit (index Ruling 5).

  ```js
  async function testsAtBase({ ws, options }, head) {
    const keep = await ws.ignoredPaths();          // node_modules and caches survive both resets
    try {
      await ws.resetHard(ws.baseSha, { keepIgnored: keep });
      const t = await ws.runTests(options.testCommand, { timeoutMs: options.testTimeoutMs });
      return { ran: t.ran, passed: t.passed, code: t.code };
    } finally {
      await ws.resetHard(head, { keepIgnored: keep }); // back to exactly the change (Task 7's holdAt checks again)
    }
  }
  ```

- `runCouncilRound(ctx, { files, tests, diff, members = MEMBERS_V1, env = process.env })`:
  1. Initialise `const c = (state.council ??= { round: 0, fixRounds: 0, secretSeen: false, history: [] })` and `const head = await ws.head()`.
     - `const last = c.history.at(-1)`; `const rerun = !!last && last.sha === head && last.fixRounds === c.fixRounds`.
     - `round = rerun ? last.round : c.round + 1`, and `earlier = rerun ? c.history.slice(0, -1) : c.history`.
  2. Log `council-start { round, members }`.
  3. When `tests?.ran && tests.passed === false && c.baseTests === undefined`, set `c.baseTests = await testsAtBase(ctx, head)` and log `council-base-tests { passed, code }`.
  4. `const u0 = await git(ws.dir, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', ws.baseSha, head])`; `added = u0.code === 0 ? addedLines(u0.stdout) : null`.
  5. Build `input` as in the index (`baseTests: c.baseTests ?? null`, `added`), with `diff` = `hideFiles(diff, hidden)` where `hidden` starts empty.
  6. For each member, in order:
     - Log `council-member { member, stage: 'tools' }`.
     - `toolRuns = await m.collect(input)`. If that throws, use instead one run `{ tool: m.member, label: `${m.label} checks`, status: 'error', findings: [makeFinding({ member: m.member, grade: 'warning', title: `The ${m.label} checks hit a problem and gave no answer`, detail: msg })], note: `The ${m.label} checks hit a problem (${clip(msg, 200)}), so they gave no answer.` }`.
     - Log one `council-tool` event per run.
     - Add the `file` of every `gitleaks` finding that is not `preExisting` to `hidden`, then recompute `input.diff`.
     - When there are findings or `m.alwaysInterpret`, log `council-member { stage: 'interpreting' }` and call `interpretMember`. A paused result returns `{ status: 'paused', reason }` straight away, without saving anything.
     - Log `council-member-done { member, ...tally, by, interpreted }`.
  7. Log one `council-finding` per finding. Then `buildReport({ round, findings, toolRuns, by: [...names].join(', ') || null, history: earlier })`.
  8. Set `c.round = round`, `c.secretSeen = c.secretSeen || hidden.size > 0`, and `c.history = [...earlier, { round, sha: head, fixRounds: c.fixRounds, blocking: report.blocking.map((f) => ({ key: findingKey(f), title: f.title, member: f.member })) }]`, then call `log.saveState(state)`.
  9. Log `council-verdict { round, verdict, blocking, warning, note }` (counts), and return `{ status: 'ok', report }`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/council-report.test.js test/council-round.test.js && npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/council test/council-report.test.js test/council-round.test.js
git commit -m "feat(council): council round, operator report and fix chunk"
```
