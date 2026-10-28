// Plan 11, Task 8: shipping a checked release as an update to every deployment, one at a time, through Plan 10 only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeProject, makeFoundation, stubDeps } from './helpers/changeFixtures.js';
import { rememberSecret, forgetRememberedSecrets } from '../src/secrets.js';
import { NO_APPROVAL } from '../src/factory/change/gate.js';
import { projectDeployments, shipUpdate, shipReport, NO_DEPLOYMENTS } from '../src/factory/change/ship.js';

const RUN_ID = '20261027-143205-a1b2';
let projectsRoot, projectDir, foundationDir, REL, GOOD_APPROVAL;

before(async () => {
  const foundation = await makeFoundation();
  foundationDir = foundation.dir;
  ({ projectsRoot, projectDir } = await makeProject({ foundation }));
  REL = execFileSync('git', ['-C', path.join(projectDir, 'app'), 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim();
  GOOD_APPROVAL = { sha: REL, branch: `build/${RUN_ID}`, at: '2026-10-27T14:00:00.000Z', council: { status: 'approved', overridden: false } };
});
after(() => {
  for (const d of [projectsRoot, foundationDir]) if (d) rmSync(d, { recursive: true, force: true });
});

const dep = (name, over = {}) => ({ slug: 'acme', projectDir: '/nowhere', name, problem: null,
  deployment: { name, project: 'acme', currentVersion: '0.2.0', foundation: 'v0.1.0', setup: { step: 'done' }, ...over } });
const entries = [dep('beta-office'), dep('acme-office'), dep('acme-cloud'), { ...dep('other'), slug: 'bobs' }];
const run = (over = {}) => ({ runId: RUN_ID, slug: 'acme', approval: GOOD_APPROVAL, release: { version: '0.3.0', sha: REL, tag: 'v0.3.0' }, deployments: {}, ...over });
const updated = async () => ({ outcome: 'updated', message: 'Updated from 0.2.0 to 0.3.0. A backup (1a2b3c4d) was taken first.' });
const calledNames = (deps) => deps.calls.filter((c) => c.name === 'updateDeployment').map((c) => c.args[0].name);
const ship = (deps, over = {}) => shipUpdate({
  projectDir, projectsRoot, slug: 'acme', run: run(), version: '0.3.0', foundation: 'v0.1.0', deps, ask: async () => false, save: () => {}, ...over,
});

test('updates every deployment of this project one at a time, in name order, through Plan 10, and saves each result as it comes', async () => {
  const saves = [];
  const factory = { projectsRoot };
  const say = () => {};
  const state = {};
  let running = 0;
  let overlapped = false;
  const deps = stubDeps({
    listDeployments: () => entries,
    updateDeployment: async () => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return updated();
    },
  });
  const r = await ship(deps, { factory, say, state, save: (x) => saves.push(structuredClone(x.deployments)) });
  assert.deepEqual(r, { status: 'done', reason: null });
  assert.equal(overlapped, false);
  assert.deepEqual(calledNames(deps), ['acme-cloud', 'acme-office', 'beta-office']);
  const first = deps.calls.find((c) => c.name === 'updateDeployment');
  assert.deepEqual(first.args[0], { projectDir, name: 'acme-cloud', version: '0.3.0', foundation: 'v0.1.0', runId: RUN_ID });
  assert.equal(first.args[1].factory, factory);
  assert.equal(first.args[1].say, say);
  assert.equal(first.args[1].state, state);
  // a 'started' marker before each box, then its result
  assert.equal(saves.length, 6);
  assert.deepEqual(saves[0], { 'acme-cloud': { outcome: 'started', at: '2026-10-27T14:32:05.000Z', from: '0.2.0' } });
  assert.deepEqual(Object.keys(saves[1]), ['acme-cloud']);
  assert.deepEqual(saves[1]['acme-cloud'], {
    outcome: 'updated', message: 'Updated from 0.2.0 to 0.3.0. A backup (1a2b3c4d) was taken first.', at: '2026-10-27T14:32:05.000Z', from: '0.2.0',
  });
  assert.deepEqual(Object.keys(saves[5]), ['acme-cloud', 'acme-office', 'beta-office']);
  // the deployments are read again before each box
  assert.equal(deps.calls.filter((c) => c.name === 'listDeployments').length, 4);
});

test('the deployments are read through listDeployments for this projects root, and other projects are left out', async () => {
  const deps = stubDeps({ listDeployments: () => entries });
  const { list, problem } = projectDeployments(deps, { projectsRoot, slug: 'acme' });
  assert.equal(problem, null);
  assert.deepEqual(list.map((e) => e.name), ['acme-cloud', 'acme-office', 'beta-office']);
  assert.equal(list[0].deployment.currentVersion, '0.2.0');
  assert.equal(deps.calls[0].args[0], projectsRoot);
});

for (const outcome of ['cancelled', 'rolled-back', 'busy', 'settings-error', 'lost-contact', 'urgent', 'refused', 'something-new']) {
  test(`a ${outcome} outcome stops the rest; later deployments are not touched`, async () => {
    const saves = [];
    const deps = stubDeps({ listDeployments: () => entries, updateDeployment: async ({ name }) => ({ outcome: name === 'acme-office' ? outcome : 'updated', message: 'm' }) });
    const r = await ship(deps, { save: (x) => saves.push(structuredClone(x.deployments)) });
    assert.equal(r.status, 'stopped');
    assert.match(r.reason, /^acme-office: /);
    assert.deepEqual(calledNames(deps), ['acme-cloud', 'acme-office']);
    assert.equal(saves.at(-1)['acme-office'].outcome, outcome);
    assert.equal(saves.at(-1)['beta-office'], undefined);
  });
}

test('the outcome sentences are the exact ones, with names and versions filled in', async () => {
  const cases = {
    updated: 'acme-cloud: updated to 0.3.0, with a backup taken first.',
    'already-on': 'acme-cloud: already on 0.3.0.',
    cancelled: 'acme-cloud: the update was cancelled and nothing was changed there: m',
    'rolled-back': 'acme-cloud: the new version failed its health check, so the box undid the update by itself. It is back on 0.2.0 with its data as before.',
    busy: 'acme-cloud: something else was already running on the box, so nothing was changed there: m',
    'settings-error': "acme-cloud: the box's settings are not right, so the update did not start: m",
    urgent: 'acme-cloud: URGENT. The update failed and the automatic undo also failed. Follow "Recovering from a failed update" in the foundation runbook now. m',
    'lost-contact': 'acme-cloud: Conductor lost contact with the box during the update, so it does not know how it ended. Check it with "conductor deployments status" before trying again. m',
    refused: 'acme-cloud: Conductor did not start the update there: m',
    'something-new': 'acme-cloud: the update ended in a way Conductor does not recognise (something-new), so it is treated as failed.',
  };
  const list = [dep('acme-cloud')];
  for (const [outcome, sentence] of Object.entries(cases)) {
    const text = shipReport({ release: { version: '0.3.0' }, deployments: { 'acme-cloud': { outcome, message: 'm', from: '0.2.0' } } }, list);
    assert.equal(text, `Deployments:\n  ${sentence}`, outcome);
  }
  assert.equal(shipReport({ release: { version: '0.3.0' }, deployments: { 'acme-cloud': { outcome: 'not-set-up' } } }, list),
    'Deployments:\n  acme-cloud: not set up yet, so it was not updated. Finish it with "conductor ship acme --to acme-cloud".');
});

test('an unreadable deployment record of this project stops the ship before any box is touched; Plan 10\'s sentence is passed through', async () => {
  const problem = `The deployment record ${projectsRoot}/acme/deployments/acme-broken.json could not be read (Unexpected end of JSON input). Fix or remove it.`;
  const broken = { slug: 'acme', projectDir, name: 'acme-broken', deployment: null, problem };
  const deps = stubDeps({ listDeployments: () => [...entries, broken] });
  const r = await ship(deps);
  assert.equal(r.status, 'stopped');
  assert.ok(r.reason.startsWith(problem), r.reason);
  assert.match(r.reason, /acme-broken/);
  assert.match(r.reason, /No deployment was updated/);
  assert.match(r.reason, /conductor change acme --resume/);
  assert.doesNotMatch(r.reason, /could not be read \(The deployment record/);
  assert.deepEqual(calledNames(deps), []);
  // a broken record of another project does not stop this one
  const other = stubDeps({ listDeployments: () => [...entries, { ...broken, slug: 'bobs' }], updateDeployment: updated });
  assert.equal((await ship(other)).status, 'done');
});

test('a listDeployments that throws stops the ship with a plain reason', async () => {
  const deps = stubDeps({ listDeployments: () => { throw new Error('EACCES: permission denied'); } });
  const r = await ship(deps);
  assert.equal(r.status, 'stopped');
  assert.match(r.reason, /could not read this project's deployments \(EACCES: permission denied\)/);
  assert.deepEqual(calledNames(deps), []);
});

test('a deployment whose setup is not finished is skipped and reported, and the rest carry on', async () => {
  const saves = [];
  const list = [dep('beta-office'), dep('acme-office', { setup: { step: 'configured' } }), dep('acme-cloud')];
  const deps = stubDeps({ listDeployments: () => list, updateDeployment: updated });
  const r = await ship(deps, { save: (x) => saves.push(structuredClone(x.deployments)) });
  assert.deepEqual(r, { status: 'done', reason: null });
  assert.deepEqual(calledNames(deps), ['acme-cloud', 'beta-office']);
  assert.deepEqual(saves.at(-1)['acme-office'], { outcome: 'not-set-up', at: '2026-10-27T14:32:05.000Z' });
});

test('an updateDeployment that throws counts as failed and stops the rest, with the error redacted', async () => {
  const secret = 'sk-ant-xxxxxxxxxxxxxxxxxxxx';
  rememberSecret(secret);
  try {
    const saves = [];
    const deps = stubDeps({ listDeployments: () => entries, updateDeployment: async () => { throw new Error(`ssh: password ${secret}`); } });
    const r = await ship(deps, { save: (x) => saves.push(structuredClone(x.deployments)) });
    assert.equal(r.status, 'stopped');
    assert.equal(r.reason, 'acme-cloud: the update ended in a way Conductor does not recognise (error), so it is treated as failed.');
    assert.deepEqual(calledNames(deps), ['acme-cloud']);
    const saved = saves.at(-1)['acme-cloud'];
    assert.equal(saved.outcome, 'error');
    assert.match(saved.message, /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(saves), /sk-ant-/);
  } finally {
    forgetRememberedSecrets();
  }
});

test('a box message is redacted and clipped before it is saved', async () => {
  const secret = 'hunter2-hunter2-hunter2';
  rememberSecret(secret);
  try {
    let saved;
    const deps = stubDeps({ listDeployments: () => [dep('acme-cloud')], updateDeployment: async () => ({ outcome: 'busy', message: `${secret} ${'x'.repeat(5000)}` }) });
    const r = await ship(deps, { save: (x) => { saved = structuredClone(x.deployments); } });
    assert.equal(r.status, 'stopped');
    assert.ok(saved['acme-cloud'].message.length < 1100);
    assert.match(saved['acme-cloud'].message, /^\[redacted\] /);
    assert.doesNotMatch(r.reason, /hunter2/);
  } finally {
    forgetRememberedSecrets();
  }
});

test('a start marker that cannot be saved stops the ship before the box is touched', async () => {
  const deps = stubDeps({ listDeployments: () => entries, updateDeployment: updated });
  const r = await ship(deps, { save: () => { throw new Error('ENOSPC'); } });
  assert.equal(r.status, 'stopped');
  assert.match(r.reason, /could not record that it was starting on acme-cloud, so nothing was done there/);
  assert.deepEqual(calledNames(deps), []);
});

test('a result that cannot be saved stops the ship before the next deployment', async () => {
  const deps = stubDeps({ listDeployments: () => entries, updateDeployment: updated });
  let n = 0;
  const r = await ship(deps, { save: () => { n += 1; if (n === 2) throw new Error('ENOSPC'); } });
  assert.equal(r.status, 'stopped');
  assert.match(r.reason, /could not record what happened on acme-cloud/);
  assert.deepEqual(calledNames(deps), ['acme-cloud']);
});

test('a deployment with an unchecked earlier update stops the ship before any version check, never shown calmer than Plan 10 left it', async () => {
  const saves = [];
  const list = [dep('acme-cloud', { currentVersion: '0.3.0', pendingCheck: { since: '2026-10-26T10:00:00.000Z', version: '0.4.0', foundation: 'v0.1.0', why: 'urgent', runId: RUN_ID } }), dep('acme-office')];
  const deps = stubDeps({ listDeployments: () => list, updateDeployment: updated });
  const r = await ship(deps, { save: (x) => saves.push(structuredClone(x.deployments)) });
  assert.equal(r.status, 'stopped');
  assert.match(r.reason, /^acme-cloud: URGENT\. /);
  assert.match(r.reason, /conductor deployments status acme-cloud/);
  assert.doesNotMatch(r.reason, /already on/);
  assert.deepEqual(calledNames(deps), []);
  const saved = saves.at(-1);
  assert.equal(saved['acme-cloud'].outcome, 'pending-check');
  assert.equal(saved['acme-office'], undefined);
  const text = shipReport({ release: { version: '0.3.0' }, deployments: saved }, list);
  assert.match(text, /acme-cloud: URGENT\./);
  assert.doesNotMatch(text, /already on/);

  // lost-contact / interrupted: not known, check first
  const lost = stubDeps({ listDeployments: () => [dep('acme-cloud', { pendingCheck: { version: '0.3.0', why: 'interrupted' } }), dep('acme-office')], updateDeployment: updated });
  const r2 = await ship(lost);
  assert.equal(r2.reason, 'acme-cloud: Conductor did not see how an earlier update there (0.3.0) ended, so nothing was done there. Check it with "conductor deployments status acme-cloud" before trying again.');
  assert.deepEqual(calledNames(lost), []);
});

test('a deployment whose record changes during the ship is read again before it is touched', async () => {
  let pending = null;
  const deps = stubDeps({
    listDeployments: () => [dep('acme-cloud'), dep('acme-office', pending ? { pendingCheck: pending } : {})],
    updateDeployment: async () => { pending = { version: '0.3.0', why: 'lost-contact' }; return updated(); },
  });
  const r = await ship(deps);
  assert.equal(r.status, 'stopped');
  assert.match(r.reason, /^acme-office: Conductor did not see how an earlier update there/);
  assert.deepEqual(calledNames(deps), ['acme-cloud']);
});

test('a saved start marker (a crash during an update) is asked about on resume; no leaves every box alone', async () => {
  const questions = [];
  const deps = stubDeps({ listDeployments: () => entries, updateDeployment: updated });
  const r = await ship(deps, {
    run: run({ deployments: { 'acme-cloud': { outcome: 'started', at: '2026-10-27T14:00:00.000Z', from: '0.2.0' } } }),
    ask: async (q) => { questions.push(q); return false; },
  });
  assert.equal(r.status, 'stopped');
  assert.match(r.reason, /You chose not to try acme-cloud again/);
  assert.deepEqual(questions, ['acme-cloud may not have finished updating last time (Conductor started an update there but did not see how it ended). Try it again now?']);
  assert.deepEqual(calledNames(deps), []);
  assert.match(shipReport({ release: { version: '0.3.0' }, deployments: { 'acme-cloud': { outcome: 'started', from: '0.2.0' } } }, [dep('acme-cloud')]),
    /acme-cloud: Conductor did not see how the last attempt ended, so it may have stopped part-way\. Check it with "conductor deployments status acme-cloud"/);
});

test('a saved stopping outcome is asked about before the setup check', async () => {
  const questions = [];
  const deps = stubDeps({ listDeployments: () => [dep('acme-cloud', { setup: { step: 'configured' } })], updateDeployment: updated });
  const r = await ship(deps, { run: run({ deployments: { 'acme-cloud': { outcome: 'busy', message: 'm', from: '0.2.0' } } }), ask: async (q) => { questions.push(q); return false; } });
  assert.equal(r.status, 'stopped');
  assert.equal(questions.length, 1);
});

test('on resume a deployment saved as newer is checked again without asking', async () => {
  const saved = { 'acme-cloud': { outcome: 'newer', message: '', from: '0.4.0' } };
  const still = stubDeps({ listDeployments: () => [dep('acme-cloud', { currentVersion: '0.4.0' })], updateDeployment: updated });
  const r1 = await ship(still, { run: run({ deployments: structuredClone(saved) }), ask: async () => { throw new Error('asked'); } });
  assert.equal(r1.status, 'stopped');
  assert.match(r1.reason, /newer than 0\.3\.0, so it was left alone\. This release is older than what the box runs.*conductor deployments status acme-cloud/);
  assert.deepEqual(calledNames(still), []);
  const now = stubDeps({ listDeployments: () => [dep('acme-cloud')], updateDeployment: updated });
  const r2 = await ship(now, { run: run({ deployments: structuredClone(saved) }), ask: async () => { throw new Error('asked'); } });
  assert.deepEqual(r2, { status: 'done', reason: null });
  assert.deepEqual(calledNames(now), ['acme-cloud']);
});

test('the ship guard is checked before each deployment: a run without approval updates nothing', async () => {
  const deps = stubDeps({ listDeployments: () => entries, updateDeployment: updated });
  const r = await ship(deps, { run: run({ approval: undefined }) });
  assert.deepEqual(r, { status: 'stopped', reason: NO_APPROVAL });
  assert.deepEqual(calledNames(deps), []);
});

test('the ship guard runs again before every deployment, not only the first', async () => {
  const r0 = run();
  const deps = stubDeps({
    listDeployments: () => entries,
    updateDeployment: async () => { r0.approval = undefined; return updated(); },
  });
  const r = await ship(deps, { run: r0 });
  assert.deepEqual(r, { status: 'stopped', reason: NO_APPROVAL });
  assert.deepEqual(calledNames(deps), ['acme-cloud']);
});

test('a deployment already on the new version or newer is not updated again', async () => {
  const saves = [];
  const same = stubDeps({ listDeployments: () => [dep('acme-cloud', { currentVersion: '0.3.0' }), dep('acme-office')], updateDeployment: updated });
  const r1 = await ship(same, { save: (x) => saves.push(structuredClone(x.deployments)) });
  assert.deepEqual(r1, { status: 'done', reason: null });
  assert.deepEqual(calledNames(same), ['acme-office']);
  assert.equal(saves.at(-1)['acme-cloud'].outcome, 'already-on');

  const newer = stubDeps({ listDeployments: () => [dep('acme-cloud', { currentVersion: '0.4.0' }), dep('acme-office')], updateDeployment: updated });
  const r2 = await ship(newer);
  assert.equal(r2.status, 'stopped');
  assert.match(r2.reason, /is on 0\.4\.0, newer than 0\.3\.0/);
  assert.deepEqual(calledNames(newer), []);

  const unreadable = stubDeps({ listDeployments: () => [dep('acme-cloud', { currentVersion: null })], updateDeployment: updated });
  const r3 = await ship(unreadable);
  assert.equal(r3.status, 'stopped');
  assert.deepEqual(calledNames(unreadable), []);
});

test('resume skips deployments already updated and asks before retrying the one that stopped the ship', async () => {
  const before = () => run({ deployments: { 'acme-cloud': { outcome: 'updated', from: '0.2.0' }, 'acme-office': { outcome: 'rolled-back', message: 'm', from: '0.2.0' } } });
  const questions = [];

  const no = stubDeps({ listDeployments: () => entries, updateDeployment: updated });
  const r1 = await ship(no, { run: before(), ask: async (q) => { questions.push(q); return false; } });
  assert.equal(r1.status, 'stopped');
  assert.match(r1.reason, /You chose not to try acme-office again/);
  assert.deepEqual(no.calls.filter((c) => c.name === 'updateDeployment'), []);
  assert.deepEqual(questions, ['acme-office did not update last time (the new version failed its health check, so the box undid the update by itself). Try it again now?']);

  // anything but exactly true is a no; an ask that throws is a no
  for (const answer of [async () => 'yes', async () => 1, async () => { throw new Error('no terminal'); }]) {
    const d = stubDeps({ listDeployments: () => entries, updateDeployment: updated });
    assert.equal((await ship(d, { run: before(), ask: answer })).status, 'stopped');
    assert.deepEqual(calledNames(d), []);
  }

  const yes = stubDeps({ listDeployments: () => entries, updateDeployment: updated });
  const r2 = await ship(yes, { run: before(), ask: async () => true });
  assert.deepEqual(r2, { status: 'done', reason: null });
  assert.deepEqual(calledNames(yes), ['acme-office', 'beta-office']);
});

test('on resume a deployment that was not set up before is looked at again without asking', async () => {
  const deps = stubDeps({ listDeployments: () => [dep('acme-cloud')], updateDeployment: updated });
  const r = await ship(deps, { run: run({ deployments: { 'acme-cloud': { outcome: 'not-set-up' } } }), ask: async () => { throw new Error('asked'); } });
  assert.deepEqual(r, { status: 'done', reason: null });
  assert.deepEqual(calledNames(deps), ['acme-cloud']);
});

test('no deployments: done, with the plain note', async () => {
  const deps = stubDeps({ listDeployments: () => [{ ...dep('other'), slug: 'bobs' }] });
  assert.deepEqual(await ship(deps), { status: 'done', reason: NO_DEPLOYMENTS });
  assert.equal(NO_DEPLOYMENTS, 'This project has no deployments yet, so nothing was updated. When you are ready, ship it with "conductor ship <slug> --to <deployment>".');
});

test('shipReport lists every deployment with what happened and the version it is on now', () => {
  const { list } = projectDeployments(stubDeps({ listDeployments: () => entries }), { projectsRoot, slug: 'acme' });
  const text = shipReport({ release: { version: '0.3.0' }, deployments: { 'acme-cloud': { outcome: 'updated' }, 'acme-office': { outcome: 'rolled-back', message: 'm', from: '0.2.0' } } }, list);
  assert.equal(text, [
    'Deployments:',
    '  acme-cloud: updated to 0.3.0, with a backup taken first.',
    '  acme-office: the new version failed its health check, so the box undid the update by itself. It is back on 0.2.0 with its data as before.',
    '  beta-office: not updated (still on 0.2.0), because an earlier deployment did not update.',
  ].join('\n'));
});

test('a record that becomes unreadable after the first box says only that it and the rest were not updated', async () => {
  let broken = false;
  const deps = stubDeps({
    listDeployments: () => [dep('acme-cloud'), broken ? { ...dep('acme-office'), problem: 'deployments/acme-office.json could not be read. Fix or remove it.' } : dep('acme-office')],
    updateDeployment: async () => { broken = true; return updated(); },
  });
  const r = await ship(deps);
  assert.equal(r.status, 'stopped');
  assert.doesNotMatch(r.reason, /No deployment was updated/);
  assert.match(r.reason, /acme-office and the deployments after it were not updated\./);
  assert.deepEqual(calledNames(deps), ['acme-cloud']);
});
