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
  brief.features[0].acceptance = Array.from({ length: 7 }, (_, i) => ({ id: `submit-expense#${i + 1}`, given: 'g', when: `w${i}`, then: 't' }));
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
