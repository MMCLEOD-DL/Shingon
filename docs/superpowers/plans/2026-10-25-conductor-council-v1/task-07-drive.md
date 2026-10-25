# Task 7: Bounce-back loop, escalation & gate

This task wires the council into the run (spec §4.3 bounce-back, §4.4 gate). With `options.council`, `drive` now goes:

1. final review;
2. **council round**;
   - **blocked, fix rounds left:** add a `Council fixes, round N` chunk to the plan, go back to the chunks phase (the normal local → frontier → chunk-review loop), then repeat the final review and a **full** council round;
   - **blocked, no fix rounds left:** plain-English escalation (`askUser`, kind `council`). Approve → continue to the gate with the report marked overridden. Anything else → `stopped`;
3. **if any round saw a possible secret introduced by this change** (`state.council.secretSeen`), combine the run's commits into one commit on `baseSha` with exactly the same files, so the secret removed by a fix step is not in the history `land()` fetches (index Ruling 10);
4. gate. The summary carries the council report text, and `approveResult` gets the report object.

Pause and resume work like the rest of the run:
- An interpreter with no model left pauses the run.
- Resume re-runs only the unfinished round.
- A queued fix chunk is simply the next chunk.
- `state.council.fixRounds` survives, so the cap holds across resumes (Review Focus 4).
- A crash after a round was saved but before its fix step was queued re-runs that round with the same number (Task 6), then queues the fix.

`runChunk` now also returns the `vendor` that wrote the step. `drive` records the vendors of council fix steps in `state.council.fixVendors`, so the interpreter's same-vendor check (Task 5) covers a fix that fell back to the reviewer's vendor.

With the council off, nothing changes. The gate's `council` is `null`.

**Files:**
- Modify: `src/conductor.js`, `src/escalation.js`, `src/chunkPhase.js`
- Test: `test/council-drive.test.js` (new), `test/escalation.test.js` (append), `test/chunkPhase.test.js` (one existing `deepEqual` gains `vendor`)

**Interfaces:**
- Consumes:
  - `runCouncilRound`, `validateCouncilOptions` (Task 6, `src/council/index.js`);
  - `fixChunk`, `reportText` (Task 6, `src/council/report.js`);
  - `MEMBER_LABEL` (Task 1);
  - `git` (`src/workspace.js`), `ws.squashSince`;
  - `askUser`;
  - stub helpers (Tasks 2–3).
- Produces:
  - event `council-fix { round, title, blocking }`;
  - escalation kind `council` with situation `stuck`;
  - `buildSummary({ …, council })`;
  - `approveResult` argument gains `council`;
  - outcome `stopped` with `COUNCIL_STOPPED`;
  - event `council-squash { from, to, steps }` and the note `COUNCIL_SQUASHED`;
  - `runChunk`'s `done` result gains `vendor`;
  - `state.council.fixVendors`, `state.council.squashedAt`.

- [ ] **Step 1: Write the failing tests**

Append to `test/escalation.test.js`:

```js
test('the council escalation and the council section of the summary', () => {
  const e = buildEscalation({ kind: 'council', title: 'the council review', situation: 'stuck', reason: 'Security: Untrusted input reaches eval()', recommendation: 'Reject.' });
  assert.match(e.message, /What happened: The council of specialist reviewers still found problems that must be fixed, after every allowed round of fixes\./);
  const s = buildSummary({ request: 'r', plan: { chunks: [] }, warnings: ['W'], notes: ['N'], council: 'Council report: approved, nothing to fix\n  Round 1 · checked by codex' });
  assert.match(s, /W\nCouncil report: approved, nothing to fix\n {2}Round 1 · checked by codex\nNotes:/);
  assert.doesNotMatch(buildSummary({ request: 'r', plan: { chunks: [] } }), /Council report/);
});
```

(`buildEscalation` and `buildSummary` are already imported there.)

In `test/chunkPhase.test.js`, test `an approved chunk that changed nothing returns sha null and no commit`, change the `deepEqual` to:

```js
  assert.deepEqual(r, { status: 'done', sha: null, note: null, tests: { ran: false, passed: null, code: null, output: '' }, vendor: 'local' });
```

Create `test/council-drive.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTask, resume } from '../src/conductor.js';
import { fakeParticipant, approve } from './helpers/fakes.js';
import { makeRepo, refsOf } from './helpers/gitRepo.js';
import { councilStubs, SEMGREP_EVAL, GITLEAKS_AKIA } from './helpers/councilStubs.js';
import { git } from '../src/workspace.js';

const PLAN = { summary: 'S', chunks: [{ title: 'Add parser', instructions: 'write app.js' }] };
const planReply = { text: '```json\n' + JSON.stringify(PLAN) + '\n```' };
const isCouncil = (task) => /member of a review council/.test(task);
const keepAll = () => ({ text: '```json\n{"findings":[]}\n```' });
const EVAL = 'export const run = (s) => eval(s);\n';
const SAFE = 'export const run = (s) => JSON.parse(s);\n';
// The local model writes eval() (plus a test file) for the step; a council fix step writes the safe version unless stubborn.
const writeApp = (stubborn = false) => (role, task, c, opts) => {
  writeFileSync(path.join(opts.cwd, 'app.js'), !stubborn && /Council fixes, round/.test(task) ? SAFE : EVAL);
  writeFileSync(path.join(opts.cwd, 'app.test.js'), '// covered\n');
  return { text: 'ok' };
};

function team({ local = writeApp(), council = keepAll } = {}) {
  return {
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role) => (role === 'reviewer' ? approve() : planReply) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: (role, task) => (isCouncil(task) ? council(task) : approve()) }),
    local: fakeParticipant({ name: 'local', kind: 'local-agent', roles: ['grunt'], script: local }),
  };
}
function hooks(over = {}) {
  const calls = [];
  const rec = (name, ret) => async (arg) => { calls.push({ name, arg }); return ret; };
  return { calls, escalate: rec('escalate', 'reject'), approveResult: rec('approveResult', true), approveChunk: rec('approveChunk', true), ...over };
}
const base = () => mkdtempSync(path.join(tmpdir(), 'cdrv-'));
const opts = (over = {}, tools = { semgrep: SEMGREP_EVAL }) => ({
  council: true, testCommand: 'node -e "process.exit(0)"', councilTools: councilStubs(base(), tools), ...over,
});
const types = (events, t) => events.filter((e) => e.type === t);

test('council off (the default): no council events, no report, the gate gets council: null', async () => {
  const h = hooks();
  const events = [];
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: team(), hooks: { ...h, onEvent: (e) => events.push(e) }, baseDir: base() });
  assert.equal(out.status, 'landed');
  assert.equal(events.some((e) => e.type.startsWith('council')), false);
  const gate = h.calls.find((c) => c.name === 'approveResult').arg;
  assert.equal(gate.council, null);
  assert.doesNotMatch(gate.summary, /Council report/);
});

test('blocking → a fix step through the normal loop → final review and full council again → landed', async () => {
  const h = hooks();
  const events = [];
  const t = team();
  const repo = await makeRepo();
  const out = await runTask({ repoDir: repo, request: 'Add a parser', team: t, hooks: { ...h, onEvent: (e) => events.push(e) }, baseDir: base(), options: opts() });
  assert.equal(out.status, 'landed');
  const fix = types(events, 'council-fix');
  assert.deepEqual(fix.map((e) => [e.round, e.title, e.blocking]), [[1, 'Council fixes, round 1', 1]]);
  assert.equal(types(events, 'council-verdict').length, 2);
  assert.equal(types(events, 'phase').filter((e) => e.name === 'final').length, 2, 'the final review runs again after the fix');
  const fixTask = t.local.calls.find((c) => /Council fixes, round 1/.test(c.task)).task;
  assert.match(fixTask, /Untrusted input reaches eval\(\) — app\.js:1/);
  const gate = h.calls.find((c) => c.name === 'approveResult').arg;
  assert.equal(gate.council.verdict, 'approved');
  assert.match(gate.summary, /2\. Council fixes, round 1/);
  assert.match(gate.summary, /Council report: approved, nothing to fix\n {2}Round 2 · checked by codex\nFixed during the review \(1\):\n {2}- \[Security\] Untrusted input reaches eval\(\)/);
  assert.equal(readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8').trim(), 'ref: refs/heads/main', 'checkout untouched');
});

test('still blocking after the cap: the operator is asked in plain words; reject stops, approve lands with the report marked', async () => {
  const repo = await makeRepo();
  const before = await refsOf(repo);
  const h = hooks();
  const out = await runTask({ repoDir: repo, request: 'x', team: team({ local: writeApp(true) }), hooks: h, baseDir: base(), options: opts({ councilFixRounds: 1 }) });
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, 'You stopped the run because the council still found problems that must be fixed. Your repository is unchanged.');
  assert.equal(await refsOf(repo), before);
  const esc = h.calls.find((c) => c.name === 'escalate').arg;
  assert.equal(esc.kind, 'council');
  assert.match(esc.message, /still found problems that must be fixed, after every allowed round of fixes/);
  assert.match(esc.message, /The concern: Security: Untrusted input reaches eval\(\)/);

  const ok = hooks({ escalate: async () => 'approve' });
  const landed = await runTask({ repoDir: repo, request: 'y', team: team({ local: writeApp(true) }), hooks: ok, baseDir: base(), options: opts({ councilFixRounds: 0 }) });
  assert.equal(landed.status, 'landed');
  const gate = ok.calls.find((c) => c.name === 'approveResult').arg;
  assert.equal(gate.council.overridden, true);
  assert.match(gate.summary, /Council report: NOT approved: 1 blocking problem remains, and you chose to continue/);
});

test('old problems never bounce, even in a file the change touched (Review Focus 2)', async () => {
  const events = [];
  const h = hooks();
  // The step adds a line to old.js; the old eval() on line 1 is not one of the lines it added.
  const local = (r, t, c, o) => {
    writeFileSync(path.join(o.cwd, 'app.js'), SAFE);
    writeFileSync(path.join(o.cwd, 'old.js'), 'eval(x)\n// touched by this change\n');
    return { text: 'ok' };
  };
  const out = await runTask({ repoDir: await makeRepo({ 'old.js': 'eval(x)\n' }), request: 'x', team: team({ local }),
    hooks: { ...h, onEvent: (e) => events.push(e) }, baseDir: base(), options: opts() });
  assert.equal(out.status, 'landed');
  assert.equal(types(events, 'council-fix').length, 0);
  assert.match(h.calls.find((c) => c.name === 'approveResult').arg.summary, /old\.js:1\) — already there before this change/);
});

test('a missing tool and a broken tool never stop the run (Review Focus 1)', async () => {
  const h = hooks();
  const tools = councilStubs(base(), { gitleaks: `console.log('gitleaks: please upgrade'); process.exit(3);` });
  tools.semgrep = '/nonexistent/semgrep';
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: team({ local: (r, t, c, o) => { writeFileSync(path.join(o.cwd, 'app.js'), SAFE); return { text: 'ok' }; } }),
    hooks: h, baseDir: base(), options: { council: true, testCommand: 'node -e "process.exit(0)"', councilTools: tools } });
  assert.equal(out.status, 'landed');
  const summary = h.calls.find((c) => c.name === 'approveResult').arg.summary;
  assert.match(summary, /Semgrep \(code scanner\) is not installed, so this check did not run\./);
  assert.match(summary, /Gitleaks \(secret scanner\) did not finish \(.+\), so this check gave no answer\./);
  assert.match(summary, /- \[Security\] Gitleaks \(secret scanner\) could not run/);
});

test('paused in the middle of round 2: resume finishes the round without redoing the fix or resetting the cap (Review Focus 4)', async () => {
  let councilCalls = 0;
  // Round 1 = security (1 finding) + correctness (always) = 2 calls; the 3rd council call finds no model.
  const flaky = () => (++councilCalls === 3 ? { ok: false, failure: 'no-participant', error: 'no AI model is available for codex (codex: rate-limited)' } : keepAll());
  const repo = await makeRepo();
  const baseDir = base();
  const options = opts({ councilFixRounds: 1 });
  const paused = await runTask({ repoDir: repo, request: 'x', team: team({ council: flaky }), hooks: hooks(), baseDir, options });
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /no AI model is available for codex/);

  const t = team();
  const h = hooks();
  const out = await resume({ workspaceDir: paused.workspaceDir, repoDir: repo, team: t, hooks: h });
  assert.equal(out.status, 'landed');
  assert.equal(t.local.calls.length, 0, 'the fix step was already done');
  const transcript = readFileSync(out.transcript, 'utf8');
  assert.equal(transcript.match(/"type":"council-fix"/g).length, 1);
  assert.match(h.calls.find((c) => c.name === 'approveResult').arg.summary, /Round 2 · checked by codex\nFixed during the review \(1\)/);
});

test('a secret removed by a fix step never reaches your repository\'s history (Review Focus 5, Ruling 10)', async () => {
  const KEY = 'AKIAZXCVBNMASDFGHJKL';
  const local = (r, task, c, o) => {
    writeFileSync(path.join(o.cwd, 'cfg.js'), /Council fixes, round/.test(task) ? 'export const k = process.env.AWS_KEY;\n' : `export const k = "${KEY}";\n`);
    writeFileSync(path.join(o.cwd, 'cfg.test.js'), '// covered\n');
    return { text: 'ok' };
  };
  const repo = await makeRepo();
  const h = hooks();
  const events = [];
  const out = await runTask({ repoDir: repo, request: 'Add config', team: team({ local }), hooks: { ...h, onEvent: (e) => events.push(e) }, baseDir: base(), options: opts({}, { gitleaks: GITLEAKS_AKIA }) });
  assert.equal(out.status, 'landed');
  assert.equal(types(events, 'council-fix').length, 1);
  assert.equal(types(events, 'council-squash').length, 1);
  assert.equal((await git(repo, ['rev-list', '--count', `main..${out.branch}`])).stdout.trim(), '1', 'the two step commits were combined');
  assert.doesNotMatch((await git(repo, ['log', '-p', `main..${out.branch}`])).stdout, new RegExp(KEY));
  assert.match((await git(repo, ['show', `${out.branch}:cfg.js`])).stdout, /process\.env\.AWS_KEY/, 'the approved files are exactly what landed');
  const gate = h.calls.find((c) => c.name === 'approveResult').arg;
  assert.match(gate.summary, /combined into one commit, because the council found a possible secret/);
  assert.doesNotMatch(gate.summary + gate.council.text, new RegExp(KEY));
});

test('without a secret the steps keep their own commits', async () => {
  const repo = await makeRepo();
  const out = await runTask({ repoDir: repo, request: 'Add a parser', team: team(), hooks: hooks(), baseDir: base(), options: opts() });
  assert.equal(out.status, 'landed');
  assert.equal((await git(repo, ['rev-list', '--count', `main..${out.branch}`])).stdout.trim(), '2');
});

test('bad council settings are refused before anything starts', async () => {
  await assert.rejects(runTask({ repoDir: await makeRepo(), request: 'x', team: team(), hooks: hooks(), baseDir: base(), options: { council: true, councilFixRounds: -1 } }), /councilFixRounds must be a whole number from 0 to 10/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-drive.test.js test/escalation.test.js`
Expected: FAIL. The off test fails on `gate.council` being `undefined` instead of `null`, there are no `council-fix` events, and the summary has no council section.

- [ ] **Step 3: Implement `src/escalation.js`**

- Add to `WHAT_HAPPENED`:

  ```js
  council: {
    stuck: 'The council of specialist reviewers still found problems that must be fixed, after every allowed round of fixes.',
    disagree: 'The council of specialist reviewers found problems that must be fixed.',
  },
  ```

- `buildSummary` gains the parameter `council = null`. After `lines.push(...warnings);` add `if (council) lines.push(council);`.

- [ ] **Step 4: Implement the loop in `src/conductor.js` and the vendor in `src/chunkPhase.js`**

- `src/chunkPhase.js`: the final return of `runChunkFrom` becomes `return { status: 'done', sha, note, tests: loop.artifact?.tests ?? null, vendor: loop.artifact?.vendor ?? null };` (the artifact already carries `vendor`).
- Add `git` to the existing `./workspace.js` import: `import { Workspace, isUnderTmp, git } from './workspace.js';`.
- Imports:

  ```js
  import { runCouncilRound, validateCouncilOptions } from './council/index.js';
  import { fixChunk, reportText } from './council/report.js';
  import { MEMBER_LABEL } from './council/findings.js';
  import { askUser } from './askUser.js';
  ```

- Constants:

  ```js
  const COUNCIL_STOPPED = 'You stopped the run because the council still found problems that must be fixed. Your repository is unchanged.';
  const COUNCIL_SQUASHED = "Your steps were combined into one commit, because the council found a possible secret in an earlier step's commit: this keeps it out of your repository's history.";
  ```
- Call `validateCouncilOptions(opts)` right after `validateHooks(hooks, opts)` in `runTask`, and right after `validateHooks(hooks, opts)` in `resume`.
- In `drive`, wrap everything from `if (state.phase === 'chunks') {` down to the final `return finish('failed', … every branch name …)` in `for (;;) { … }`. The body is unchanged, apart from the insertions below and `const approvedSha` becoming `let approvedSha`. The existing `try { … } catch` stays around the whole thing.
- In the chunks loop, right after `if (c.note) state.notes.push(c.note);`, record who wrote a council fix:

  ```js
          if (chunk.councilFix && c.vendor) {
            state.council.fixVendors = [...new Set([...(state.council.fixVendors ?? []), c.vendor])];
          }
  ```
- Directly after `const finalReview = verdictOf(r);`, insert:

  ```js
      // Council v1 (factory spec §4.3, §8 item 2): after the final review, before the gate.
      let council = null;
      if (options.council) {
        const round = await runCouncilRound(ctx, { files, tests, diff });
        if (round.status === 'paused') return finish('paused', { reason: pausedReason(round.reason) });
        council = round.report;
        if (council.verdict === 'blocked') {
          if (state.council.fixRounds < options.councilFixRounds) {
            // Bounce back through the normal step loop, then review everything again.
            state.council.fixRounds += 1;
            const chunk = fixChunk(council, state.council.fixRounds);   // carries councilFix: N
            state.plan.chunks.push(chunk);
            state.phase = 'chunks';
            log.saveState(state);
            log.event('council-fix', { round: state.council.fixRounds, title: chunk.title, blocking: council.blocking.length });
            continue;
          }
          const decision = await askUser(ctx, {
            kind: 'council', title: 'the council review', situation: 'stuck',
            reason: council.blocking.map((f) => `${MEMBER_LABEL[f.member]}: ${f.title}${f.why ? ` (${f.why})` : ''}`).join('; '),
            recommendation: 'Reject, unless you have read each problem above and are sure it is safe to ship anyway.',
          });
          if (decision !== 'approve') return finish('stopped', { reason: COUNCIL_STOPPED });
          council = { ...council, overridden: true };
          council.text = reportText(council);
        }
        // Ruling 10: a possible secret was seen in a step's commit. Land one commit with exactly the approved
        // files, so a secret a fix step removed is not in the history land() fetches into the real repository.
        if (state.council.secretSeen && state.council.squashedAt !== approvedSha && state.chunkShas.length > 1 && files.length) {
          await holdAt(ws, log, approvedSha, 'council-squash-reset');   // drop anything the tests or tools left behind
          const treeOf = async (sha) => (await git(ws.dir, ['rev-parse', `${sha}^{tree}`])).stdout.trim();
          const squashed = await ws.squashSince(ws.baseSha, `conductor: ${clip(state.request.split('\n')[0], 72)} (steps combined)`);
          if (!squashed || (await treeOf(squashed)) !== (await treeOf(approvedSha))) {
            throw new Error('combining the steps into one commit did not keep the files the same');
          }
          log.event('council-squash', { from: approvedSha, to: squashed, steps: state.chunkShas.length });
          // Every completed step now points at the combined commit: stateProblem's ancestor chain still holds on resume.
          state.chunkShas = state.chunkShas.map(() => squashed);
          state.council.squashedAt = squashed;
          if (!state.notes.includes(COUNCIL_SQUASHED)) state.notes.push(COUNCIL_SQUASHED);
          log.saveState(state);
          approvedSha = squashed;   // the gate approves, and land() ships, exactly this commit
        }
      }
  ```

  The combined commit has the same tree, so the diff, the files, the test result and both reviews still describe exactly what lands. It is created **before** the gate, so the MVP rule "what the user approves is exactly approvedSha" holds. A crash after the combine resumes at the combined commit and does not combine again (`squashedAt`).

- Pass `council: council?.text ?? null` to `buildSummary`. Change the gate call to `redact({ summary, files, tests, finalReview: shownReview, diff, council })`.
- The chunks block's `if (state.phase === 'chunks')` and its `const total = state.plan.chunks.length;` are now evaluated on every pass. A fix chunk is just the next index: `stateProblem` and resume need no change.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/council-drive.test.js test/escalation.test.js && npm test`
Expected: all PASS. The existing `conductor.test.js` suite is unchanged and green, because the council is off by default (and without a secret the steps keep their own commits: its `rev-list --count` of 2 still holds).

- [ ] **Step 6: Commit**

```bash
git add src/conductor.js src/escalation.js src/chunkPhase.js test/council-drive.test.js test/escalation.test.js test/chunkPhase.test.js
git commit -m "feat(council): bounce-back loop with a 3-round cap, plain-English escalation, report at the gate"
```
