# Task 4: Splitting the brief into features

A whole app is too big for one plan (spec §4.2). The author (frontier seat) reads the approved brief once and proposes an ordered list of **build features** ("units"), each small enough for the local model and the reviewers. The reviewer seat reviews the list, exactly as a plan is reviewed. Code checks every rule a computer can check (index Ruling 2), and a list that breaks one goes back to the author as a failed round with the reasons.

**Files:**
- Create: `src/factory/split.js`
- Test: `test/factory-split.test.js`

**Interfaces:**
- Consumes: `reviewLoop` (`src/review.js`), `callRole` (`src/runlog.js`), `askUser` (`src/askUser.js`), `extractJson` (`src/plan.js`, exported by Plan 7), `acceptanceIds` (`src/factory/acceptance.js`, Plan 7, Contract 7 §7.1), `featureRequest` and `REQUEST_BUDGET` (Task 3), `renderBrief` (Plan 7, passed in), `sampleBrief` (Task 1), `fakeParticipant`, `approve`, `block` (`test/helpers/fakes.js`).
- Produces: `parseSplit(text)`, `validateSplit(units, brief)`, `runSplit(sctx, brief)`, `MAX_UNITS = 30`, `MAX_EXAMPLES_PER_UNIT = 6`, `MAX_INSTRUCTIONS = 2000`, `briefProblems(brief) -> string[]` (the build-time refusals of Ruling 10 that depend on the brief).
  - `sctx = { team, hooks, log, cwd, options, usage, renderBrief }`. `log` is a `RunLog`; `usage` is the build's `{ costUsd, apiCostUsd, apiCalls }`, added to in place; `options.planRounds` and `options.agentTimeoutMs` apply.

- [ ] **Step 1: Write the failing tests**

Create `test/factory-split.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSplit, validateSplit, runSplit, briefProblems } from '../src/factory/split.js';
import { RunLog } from '../src/runlog.js';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { fakeParticipant, approve, block } from './helpers/fakes.js';
import { sampleBrief } from './helpers/factoryFixtures.js';

const GOOD = [
  { id: 'expenses', title: 'Submit and list expenses', covers: ['submit-expense'], acceptance: ['submit-expense#1', 'submit-expense#2'], instructions: 'Add the expense record, API and pages.', dependsOn: [] },
  { id: 'report', title: 'Monthly report', covers: ['monthly-report'], acceptance: ['monthly-report#1'], instructions: 'Add the report page.', dependsOn: ['expenses'] },
];
const reply = (units) => ({ text: 'Here it is.\n```json\n' + JSON.stringify({ units }) + '\n```' });

test('the split uses the brief\'s stable example ids: after a revision, #2 can exist without #1', () => {
  const brief = sampleBrief();
  brief.features[0].acceptance = [brief.features[0].acceptance[1]];          // #1 removed in a revision; #2 keeps its id
  assert.equal(validateSplit([{ ...GOOD[0], acceptance: ['submit-expense#2'] }, GOOD[1]], brief).ok, true);
  assert.match(validateSplit(GOOD, brief).problems.join('\n'), /"submit-expense#1" is not a worked example in the brief/);
});

test('a good split passes and every unit is marked as a feature', () => {
  const v = validateSplit(parseSplit(reply(GOOD).text).units, sampleBrief());
  assert.equal(v.ok, true);
  assert.deepEqual(v.units.map((u) => u.kind), ['feature', 'feature']);
});

test('every rule a computer can check is checked, with reasons the author can act on', () => {
  const brief = sampleBrief();
  const p = (units) => validateSplit(units, brief).problems ?? [];
  assert.match(p([GOOD[0]]).join('\n'), /monthly-report#1 is not in any feature/);
  assert.match(p([GOOD[0]]).join('\n'), /brief feature monthly-report is not covered/);
  assert.match(p([GOOD[0], { ...GOOD[1], acceptance: ['monthly-report#1', 'submit-expense#1'] }]).join('\n'), /submit-expense#1 is in more than one feature/);
  assert.match(p([{ ...GOOD[0], id: 'Bad Id' }, GOOD[1]]).join('\n'), /"Bad Id" is not a valid feature id/);
  assert.match(p([GOOD[1], GOOD[0]]).join('\n'), /report depends on expenses, which comes later/);
  assert.match(p([{ ...GOOD[0], acceptance: [] }, { ...GOOD[1], acceptance: ['monthly-report#1', 'submit-expense#1', 'submit-expense#2'] }]).join('\n'), /expenses has no worked examples/);
  assert.match(p([{ ...GOOD[0], instructions: 'z'.repeat(2001) }, GOOD[1]]).join('\n'), /instructions for expenses are 2001 characters \(the limit is 2000\)/);
  assert.match(p([{ ...GOOD[0], covers: ['nope'] }, GOOD[1]]).join('\n'), /covers "nope", which is not a feature in the brief/);
  assert.match(p([{ ...GOOD[0], id: 'brand' }, GOOD[1]]).join('\n'), /"brand" is reserved/);
});

test('more than 6 examples in one feature is refused', () => {
  const brief = sampleBrief();
  brief.features[0].acceptance = Array.from({ length: 7 }, (_, i) => ({ given: 'g', when: `w${i}`, then: 't' }));
  const ids = Array.from({ length: 7 }, (_, i) => `submit-expense#${i + 1}`);
  assert.match(validateSplit([{ ...GOOD[0], acceptance: ids }, GOOD[1]], brief).problems.join('\n'), /expenses has 7 worked examples \(at most 6\); split it/);
});

test('briefProblems: modules, a feature with no examples, an example without an id', () => {
  assert.deepEqual(briefProblems(sampleBrief()), []);
  const noId = sampleBrief(); delete noId.features[0].acceptance[0].id;
  assert.match(briefProblems(noId).join('\n'), /worked example 1 of "Submit an expense" has no id/);
  assert.match(briefProblems(sampleBrief({ modules: ['ocr'] })).join('\n'), /needs optional modules \(ocr\) that the foundation does not have yet/);
  const b = sampleBrief(); b.features[1].acceptance = [];
  assert.match(briefProblems(b).join('\n'), /"Monthly report" has no worked examples/);
});

function sctx({ author, reviewer = approve, escalate = async () => 'reject' }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'split-'));
  const team = {
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: author }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: reviewer }),
  };
  return { team, hooks: { escalate }, log: new RunLog(dir), cwd: dir, options: DEFAULT_OPTIONS,
    usage: { costUsd: 0, apiCostUsd: 0, apiCalls: 0 }, renderBrief: (b) => `# Brief for ${b.client}` };
}

test('runSplit: a broken list goes back as a failed round with the problems; then reviewed and approved', async () => {
  const s = sctx({ author: (r, task, c, o, n) => (n === 0 ? reply([GOOD[0]]) : reply(GOOD)) });
  const out = await runSplit(s, sampleBrief());
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.units.map((u) => u.id), ['expenses', 'report']);
  assert.match(s.team.author.calls[0].task, /# Brief for Acme Ltd/);
  assert.match(s.team.author.calls[0].task, /submit-expense#1/);
  assert.match(s.team.author.calls[1].task, /monthly-report#1 is not in any feature/);
  assert.equal(s.team.reviewer.calls.length, 1, 'the broken list was never sent for review');
  assert.equal(s.team.author.calls[0].opts.write, false);
});

test('runSplit: still blocked after every round asks the operator; reject stops', async () => {
  const s = sctx({ author: () => reply(GOOD), reviewer: () => block('report should come first') });
  const out = await runSplit(s, sampleBrief());
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, 'You rejected the list of features, so nothing was built.');
});

test('runSplit: no usable list at all fails in plain words', async () => {
  const out = await runSplit(sctx({ author: () => ({ text: 'sorry' }) }), sampleBrief());
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /could not get a usable list of features/);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/factory-split.test.js`
Expected: FAIL (`Cannot find module '../src/factory/split.js'`).

- [ ] **Step 3: Implement `src/factory/split.js`**

- Acceptance ids come from Plan 7's `acceptanceIds(brief)`, which reads each example's stable `id` (Contract 7 §7.4). This file never numbers examples itself. Only `.id`, `.featureId` and `.example` of each entry are used.
- `briefProblems(brief)`: `kind !== 'web-app'` → `This brief is for "<kind>", and the factory only builds web apps.`; non-empty `modules` → `The brief needs optional modules (<list>) that the foundation does not have yet, so building it now would leave them out.`; each feature with no examples → `The feature "<title>" has no worked examples. Add at least one to the brief, so it can be tested.`; an example without a string `id` → `The worked example <n> of "<title>" has no id, so its test could not be traced. Approve the brief again with this version of Conductor (conductor brief <project> --revise).` (Plan 7 assigns ids at approval; this only catches an old brief).
- `parseSplit(text)`: `extractJson`, `JSON.parse`, must be an object with a `units` array; each unit's `covers`, `acceptance`, `dependsOn` default to `[]`; strings trimmed. Errors are short reasons (`no \`\`\`json block found in the reply`, `the JSON has no "units" list`, `not valid JSON (…)`).
- `validateSplit(units, brief)` collects **all** problems (messages as in the tests): count 1–`MAX_UNITS`; id matches `^[a-z][a-z0-9-]{1,39}$`, unique, not `brand`; title 1–80 characters; instructions 1–`MAX_INSTRUCTIONS`; `covers` non-empty and known; `acceptance` 1–`MAX_EXAMPLES_PER_UNIT`, each known (else `"<id>" is not a worked example in the brief`), each belonging to a feature the unit covers (`<unit> has <id>, but does not cover <featureId>`), each in exactly one unit, and every acceptance id placed; every brief feature covered by some unit; `dependsOn` only earlier ids. When no problem so far, it calls `featureRequest({ brief, units, index })` for every unit and turns a `too-long` error into a problem. On success returns `{ ok: true, units: units.map((u) => ({ ...u, kind: 'feature' })) }`.
- Prompts (in this file; plain constants plus the brief):
  - **author:** the rendered brief (`sctx.renderBrief(brief)`, clipped to 30 000 characters after `redact`), the list of acceptance ids with their examples, then the rules: "Split this approved brief into an ordered list of build features. Each feature is built in one run by a modest local coding model and checked by reviewers, so keep each one small: at most one new database table, at most 6 worked examples, instructions under 2000 characters, and no more than about 10 steps of work. Put what others depend on first. Every worked example id must appear in exactly one feature; every brief feature must be covered. The app's name is already set; do not include it. The foundation already provides sign-in, roles, teams, files, email, the activity log, backups and the page shell: never rebuild them." Then the JSON shape `{"units": [{"id": "kebab-case", "title": "...", "covers": ["brief feature id"], "acceptance": ["feature-id#1"], "instructions": "...", "dependsOn": ["earlier id"]}]}`. Feedback is added as in `planAuthor` (blocked → "A reviewer blocked your previous list: …"; failed → "Your previous list could not be used: …").
  - **reviewer:** the rendered brief, the proposed list, and "Review this list of build features. Check: is anything in the brief missing, is any feature too big for one run of a modest model, is the order right, would any feature rebuild something the foundation already provides?" plus the same `BLOCK_RULES` sentence the plan reviewer gets (copy the constant's text; `prompts.js` does not export it).
- `runSplit` uses `reviewLoop` with `maxRounds: options.planRounds`. `produce` calls `callRole(log, team.author, 'author', prompt, '', { cwd, write: false, timeoutMs: options.agentTimeoutMs })`; a `no-participant` failure returns `{ pause }`; parse or validate problems return `{ error: problems.join('; ') }`. Every call's `usage.costUsd` is added to `sctx.usage` (and to `apiCostUsd`/`apiCalls` for an API kind, using `isApiKind` from `src/vendors.js`), the same arithmetic as `callAgent`. Outcomes:
  - approved → `{ status: 'ok', units, note: null }`;
  - paused → `{ status: 'paused', reason }`;
  - exhausted with a valid list → `askUser(sctx, { kind: 'plan', title: 'the list of features', reason, recommendation: 'Approve only if the concern above does not matter for this client.', situation: 'disagree' })`; approve → `{ status: 'ok', units, note: 'Feature list: you approved it over the concern: <reason>' }`; otherwise `{ status: 'stopped', reason: 'You rejected the list of features, so nothing was built.' }`;
  - no valid list → `{ status: 'failed', reason: 'Conductor could not get a usable list of features from the AI author, so nothing was built. The details are in the build log; run the same command again to retry.' }`.
  - Events: `log.event('split-agreed', { units: ids, rounds })` on success.

- [ ] **Step 4: Run the tests**

Run: `node --test test/factory-split.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/split.js test/factory-split.test.js
git commit -m "feat(factory): the author splits an approved brief into small checked features

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
