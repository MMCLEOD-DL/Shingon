import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChangeRun, loadChangeRun, saveChangeRun, findUnfinishedRun, STAGES, RUN_UNREADABLE } from '../src/factory/change/run.js';
import {
  realDeps, missingSeams, DEP_NAMES, CONTINUE_OUTCOMES, loadBriefVersion, currentBriefVersion, makeReviseBrief,
  NO_BRIEF_VERSION, NO_APPROVED_BRIEF,
} from '../src/factory/change/seams.js';
import { RUN_ID_RE } from '../src/factory/ids.js';
import { briefPaths } from '../src/factory/brief.js';
import { makeFoundation, makeProject, stubDeps, writeBriefVersion } from './helpers/changeFixtures.js';

const FIELDS = { kind: 'change', slug: 'acme', mainAtStart: 'a'.repeat(40), baseRef: 'a'.repeat(40) };
const emptyProject = () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'chg-')), 'acme');
  mkdirSync(path.join(dir, 'builds'), { recursive: true });
  return dir;
};
const NOW = new Date('2026-10-27T14:32:05Z');

test('createChangeRun writes builds/<runId>/change.json and loadChangeRun reads it back', () => {
  const dir = emptyProject();
  const run = createChangeRun(dir, FIELDS, { now: NOW });
  assert.match(run.runId, RUN_ID_RE);
  const onDisk = JSON.parse(readFileSync(path.join(dir, 'builds', run.runId, 'change.json'), 'utf8'));
  assert.equal(onDisk.schema, 1);
  assert.equal(onDisk.kind, 'change');
  assert.equal(onDisk.stage, 'brief');
  assert.equal(onDisk.status, 'running');
  assert.equal(onDisk.createdAt, NOW.toISOString());
  assert.deepEqual(loadChangeRun(dir, run.runId), onDisk);
  const up = createChangeRun(dir, { ...FIELDS, kind: 'foundation-upgrade' }, { now: NOW, newId: () => '20261027-143206-ffff' });
  assert.equal(up.stage, 'prepare');
  assert.ok(STAGES.includes(up.stage));
});

test('createChangeRun requires kind, slug, mainAtStart and baseRef', () => {
  const dir = emptyProject();
  for (const k of ['kind', 'slug', 'mainAtStart', 'baseRef']) {
    assert.throws(() => createChangeRun(dir, { ...FIELDS, [k]: undefined }), new RegExp(k));
  }
  assert.throws(() => createChangeRun(dir, { ...FIELDS, kind: 'build' }), /kind/);
});

test('createChangeRun never overwrites: a taken run id gets a fresh one', () => {
  const dir = emptyProject();
  const ids = ['20261027-143205-aaaa', '20261027-143205-aaaa', '20261027-143205-bbbb'];
  const newId = () => ids.shift();
  const first = createChangeRun(dir, FIELDS, { now: NOW, newId });
  const before = readFileSync(path.join(dir, 'builds', first.runId, 'change.json'), 'utf8');
  const second = createChangeRun(dir, { ...FIELDS, slug: 'other' }, { now: NOW, newId });
  assert.equal(second.runId, '20261027-143205-bbbb');
  assert.equal(readFileSync(path.join(dir, 'builds', first.runId, 'change.json'), 'utf8'), before);
  assert.throws(() => createChangeRun(dir, FIELDS, { now: NOW, newId: () => '20261027-143205-aaaa' }), /could not/i);
});

test('saveChangeRun sets updatedAt and persists', () => {
  const dir = emptyProject();
  const run = createChangeRun(dir, FIELDS, { now: NOW });
  saveChangeRun(dir, { ...run, stage: 'build' });
  const back = loadChangeRun(dir, run.runId);
  assert.equal(back.stage, 'build');
  assert.ok(Date.parse(back.updatedAt) >= Date.parse(run.updatedAt));
});

test('findUnfinishedRun returns the newest running/paused/failed run and ignores done, stopped and Plan 8 build folders', () => {
  const dir = emptyProject();
  assert.equal(findUnfinishedRun(dir), null);
  const mk = (id, status, at) => {
    const r = createChangeRun(dir, FIELDS, { now: new Date(at), newId: () => id });
    saveChangeRun(dir, { ...r, status });
    return r;
  };
  mk('20261027-100000-0001', 'done', '2026-10-27T10:00:00Z');
  mk('20261027-110000-0002', 'paused', '2026-10-27T11:00:00Z');
  mk('20261027-120000-0003', 'failed', '2026-10-27T12:00:00Z');
  mk('20261027-130000-0004', 'stopped', '2026-10-27T13:00:00Z');
  mkdirSync(path.join(dir, 'builds', '20261027-140000-0005'));
  writeFileSync(path.join(dir, 'builds', '20261027-140000-0005', 'build.json'), '{}');
  assert.equal(findUnfinishedRun(dir).runId, '20261027-120000-0003');
});

test('loadChangeRun on a damaged change.json throws RUN_UNREADABLE, plain English, no JSON parser text', () => {
  const dir = emptyProject();
  const run = createChangeRun(dir, FIELDS, { now: NOW });
  writeFileSync(path.join(dir, 'builds', run.runId, 'change.json'), '{ not json');
  assert.throws(() => loadChangeRun(dir, run.runId), (e) => {
    assert.equal(e.message, RUN_UNREADABLE(run.runId));
    assert.doesNotMatch(e.message, /Unexpected token|JSON/);
    return true;
  });
  assert.throws(() => loadChangeRun(dir, '../etc'), /could not be read/);
  assert.throws(() => loadChangeRun(dir, '20261027-143205-9999'), /could not be read/);
});

test('loadChangeRun refuses a wrong schema', () => {
  const dir = emptyProject();
  const run = createChangeRun(dir, FIELDS, { now: NOW });
  writeFileSync(path.join(dir, 'builds', run.runId, 'change.json'), JSON.stringify({ ...run, schema: 2 }));
  assert.throws(() => loadChangeRun(dir, run.runId), /could not be read/);
});

test('findUnfinishedRun on a damaged change.json throws RUN_UNREADABLE (a run we cannot read might be unfinished)', () => {
  const dir = emptyProject();
  const run = createChangeRun(dir, FIELDS, { now: NOW });
  writeFileSync(path.join(dir, 'builds', run.runId, 'change.json'), '');
  assert.throws(() => findUnfinishedRun(dir), (e) => e.message === RUN_UNREADABLE(run.runId));
});

test('loadBriefVersion reads brief-v<n>.json; a missing or invalid one throws NO_BRIEF_VERSION(n)', async () => {
  const f = await makeFoundation();
  const p = await makeProject({ foundation: f });
  assert.equal(loadBriefVersion(p.projectDir, 1).version, 1);
  assert.throws(() => loadBriefVersion(p.projectDir, 2), (e) => e.message === NO_BRIEF_VERSION(2));
  writeFileSync(briefPaths(p.projectDir).json(3), '{"schema":1}');
  assert.throws(() => loadBriefVersion(p.projectDir, 3), (e) => e.message === NO_BRIEF_VERSION(3));
  writeFileSync(briefPaths(p.projectDir).json(4), 'nope');
  assert.throws(() => loadBriefVersion(p.projectDir, 4), (e) => e.message === NO_BRIEF_VERSION(4));
});

test('currentBriefVersion returns the approved version; none approved → NO_APPROVED_BRIEF; a broken current.json → its plain text', async () => {
  const f = await makeFoundation();
  const p = await makeProject({ foundation: f });
  assert.equal(currentBriefVersion(p.projectDir), 1);
  writeBriefVersion(p.projectDir, 2, {});
  assert.equal(currentBriefVersion(p.projectDir), 2);
  assert.throws(() => currentBriefVersion(emptyProject()), (e) => e.message === NO_APPROVED_BRIEF);
  writeFileSync(briefPaths(p.projectDir).current, 'garbage');
  assert.throws(() => currentBriefVersion(p.projectDir), /damaged/);
});

function reviseHarness(projectDir, { saved = null } = {}) {
  const calls = [];
  let session = saved;
  const impl = makeReviseBrief({
    importNotes: (dir, file) => { calls.push(['importNotes', dir, file]); return { name: 'notes/n1.txt', bytes: 3 }; },
    newSession: (o) => { calls.push(['newSession', o]); return { ...o, stage: 'draft' }; },
    loadSession: (dir, slug) => { calls.push(['loadSession', slug]); return session; },
    saveSession: (dir, s) => { calls.push(['saveSession']); session = s; },
    runBriefSession: async (a) => { calls.push(['runBriefSession', a]); return { status: 'approved', version: 2 }; },
  });
  return { impl, calls, names: () => calls.map((c) => c[0]) };
}

test('reviseBrief starts a revise session from the current version, or continues a saved one when notesFile is null', async () => {
  const f = await makeFoundation();
  const p = await makeProject({ foundation: f });
  const h = reviseHarness(p.projectDir);
  const log = {}; const io = {}; const author = {};
  const out = await h.impl({ projectDir: p.projectDir, slug: 'acme', notesFile: '/tmp/n.txt', author, io, log, operatorName: 'Malcolm', cwd: '/tmp/w' });
  assert.deepEqual(out, { status: 'approved', version: 2 });
  assert.deepEqual(h.calls.find((c) => c[0] === 'importNotes').slice(1), [p.projectDir, '/tmp/n.txt']);
  const ns = h.calls.find((c) => c[0] === 'newSession')[1];
  assert.equal(ns.mode, 'revise'); assert.equal(ns.baseVersion, 1); assert.equal(ns.slug, 'acme'); assert.deepEqual(ns.notes, ['notes/n1.txt']);
  assert.ok(h.names().includes('saveSession'));
  const rb = h.calls.find((c) => c[0] === 'runBriefSession')[1];
  assert.equal(rb.projectDir, p.projectDir); assert.equal(rb.author, author); assert.equal(rb.io, io);
  assert.equal(rb.log, log); assert.equal(rb.cwd, '/tmp/w'); assert.equal(rb.operatorName, 'Malcolm');
  assert.equal(rb.session.mode, 'revise');

  // second call: continue the saved revise session
  const h2 = reviseHarness(p.projectDir, { saved: { slug: 'acme', mode: 'revise', baseVersion: 1, notes: [] } });
  await h2.impl({ projectDir: p.projectDir, slug: 'acme', notesFile: null, author, io, log, operatorName: 'M', cwd: '/w' });
  assert.deepEqual(h2.names(), ['loadSession', 'runBriefSession']);
});

test('reviseBrief stops plainly: no saved session to continue, a saved non-revision draft, a revision already open, unreadable notes', async () => {
  const f = await makeFoundation();
  const p = await makeProject({ foundation: f });
  const base = { projectDir: p.projectDir, slug: 'acme', author: {}, io: {}, log: {}, operatorName: 'M', cwd: '/w' };
  const a = reviseHarness(p.projectDir);
  const r1 = await a.impl({ ...base, notesFile: null });
  assert.equal(r1.status, 'stopped'); assert.match(r1.reason, /no unfinished brief revision/);
  assert.ok(!a.names().includes('runBriefSession'));

  const b = reviseHarness(p.projectDir, { saved: { slug: 'acme', mode: 'new' } });
  for (const notesFile of [null, '/n.txt']) {
    const r = await b.impl({ ...base, notesFile });
    assert.equal(r.status, 'stopped'); assert.match(r.reason, /not a revision/);
  }
  assert.ok(!b.names().includes('runBriefSession') && !b.names().includes('importNotes'));

  const c = reviseHarness(p.projectDir, { saved: { slug: 'acme', mode: 'revise' } });
  const r3 = await c.impl({ ...base, notesFile: '/n.txt' });
  assert.equal(r3.status, 'stopped'); assert.match(r3.reason, /already/);
  assert.ok(!c.names().includes('importNotes'));

  const impl = makeReviseBrief({
    importNotes: () => { throw new Error('The notes file is empty.'); },
    newSession: () => assert.fail('no session'), loadSession: () => null, saveSession: () => assert.fail('no save'),
    runBriefSession: () => assert.fail('no run'),
  });
  assert.deepEqual(await impl({ ...base, notesFile: '/n.txt' }), { status: 'stopped', reason: 'The notes file is empty.' });
});

test('missingSeams names every dep that is not a function', () => {
  assert.deepEqual(missingSeams({ ...stubDeps(), releaseApp: undefined, runBuild: 1 }), ['releaseApp', 'runBuild']);
  assert.deepEqual(missingSeams(stubDeps()), []);
  assert.deepEqual(missingSeams(null), [...DEP_NAMES].sort());
});

test('realDeps provides every dep (Plans 7–10 are merged)', () => {
  const d = realDeps();
  assert.deepEqual(missingSeams(d), []);
  assert.equal(typeof d.now, 'function');
  assert.deepEqual(CONTINUE_OUTCOMES, ['updated', 'already-on']);
});

test('stubDeps records calls and lists real deployment files', async () => {
  const f = await makeFoundation();
  const p = await makeProject({ foundation: f, deployments: [{ name: 'acme-office', currentVersion: '0.1.0' }] });
  const d = stubDeps();
  const rows = d.listDeployments(p.projectsRoot, { slug: 'acme' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deployment.setup.step, 'done');
  assert.equal(rows[0].deployment.foundation, 'v0.1.0');
  assert.equal(d.calls[0].name, 'listDeployments');
});
