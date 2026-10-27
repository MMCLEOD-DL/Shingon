import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileAtomic, writeJsonAtomic, createFileExclusive } from '../src/factory/fsAtomic.js';
import { factoryConfig, DEFAULT_PROJECTS_ROOT } from '../src/factory/config.js';
import { loadConfig } from '../src/config.js';
import { slugify, validateSlug, projectDir, createProject, readProject, loadProject, saveProject, listProjects, PROJECT_STATUSES } from '../src/factory/projects.js';
import { lockProject } from '../src/factory/projectLock.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'proj-'));
const NOW = new Date('2026-10-27T10:00:00Z');

test('atomic writes leave no temp files; exclusive create refuses to overwrite', () => {
  const d = tmp();
  const f = path.join(d, 'a.json');
  writeJsonAtomic(f, { a: 1 });
  writeJsonAtomic(f, { a: 2 });
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { a: 2 });
  assert.equal(readFileSync(f, 'utf8').endsWith('\n'), true);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  writeFileAtomic(path.join(d, 'b.txt'), 'hi', { mode: 0o644 });
  assert.equal(statSync(path.join(d, 'b.txt')).mode & 0o777, 0o644);
  createFileExclusive(path.join(d, 'v1.json'), 'one');
  assert.throws(() => createFileExclusive(path.join(d, 'v1.json'), 'two'), (e) => e.code === 'EEXIST');
  assert.equal(readFileSync(path.join(d, 'v1.json'), 'utf8'), 'one');
  assert.deepEqual(readdirSync(d).sort(), ['a.json', 'b.txt', 'v1.json'], 'no .tmp files left behind');
});

// Plans 8 and 10 add sections to FactoryConfig, so these tests check Plan 7's keys one by one, never the whole object.
test('factoryConfig: default root, ~ expansion, env override, operator name, plain errors', () => {
  const home = '/home/m';
  assert.equal(DEFAULT_PROJECTS_ROOT, '~/highland-projects');
  const bare = factoryConfig({}, { env: {}, home, user: 'malcolm' });
  assert.equal(bare.projectsRoot, '/home/m/highland-projects');
  assert.equal(bare.operatorName, 'malcolm');
  assert.equal(factoryConfig(null, { env: {}, home, user: 'm' }).projectsRoot, '/home/m/highland-projects');
  const cfg = { factory: { projectsRoot: '~/clients', operatorName: 'Malcolm McLeod' } };
  assert.equal(factoryConfig(cfg, { env: {}, home, user: 'x' }).projectsRoot, '/home/m/clients');
  assert.equal(factoryConfig(cfg, { env: {}, home, user: 'x' }).operatorName, 'Malcolm McLeod');
  assert.equal(factoryConfig(cfg, { env: { CONDUCTOR_PROJECTS_ROOT: '/srv/p' }, home }).projectsRoot, '/srv/p');
  assert.throws(() => factoryConfig({ factory: { projectsRoot: 'relative/dir' } }, { env: {}, home }), /factory\.projectsRoot must be a full path \(starting with \/ or ~\), but the config has "relative\/dir"/);
  assert.throws(() => factoryConfig({ factory: { operatorName: 42 } }, { env: {}, home }), /factory\.operatorName must be text/);
  assert.throws(() => factoryConfig({ factory: 'yes' }, { env: {}, home }), /the config's "factory" section must be an object/);
  assert.equal(factoryConfig({}, { env: {}, home, user: '' }).operatorName, 'operator');
});

test('loadConfig keeps the factory section (Contract 7 §7.1)', () => {
  const f = path.join(tmp(), 'c.json');
  writeFileSync(f, JSON.stringify({ participants: [], factory: { operatorName: 'Malcolm' } }));
  assert.deepEqual(loadConfig(f).factory, { operatorName: 'Malcolm' });
  assert.equal(factoryConfig(loadConfig(f), { env: {}, home: '/home/m' }).operatorName, 'Malcolm');
  writeFileSync(f, JSON.stringify({ participants: [] }));
  assert.deepEqual(loadConfig(f).factory, {});
});

test('slugify and validateSlug', () => {
  assert.equal(slugify('Acme Ltd.'), 'acme-ltd');
  assert.equal(slugify('  Café & Bar  '), 'cafe-and-bar');
  assert.equal(slugify('株式会社'), '');
  const long = slugify('The Extremely Long Named Highland Joinery And Cabinet Makers Company');
  assert.ok(long.length <= 40 && !long.endsWith('-'), long);
  assert.equal(validateSlug('acme-ltd'), null);
  for (const bad of ['', '../etc', 'Acme', 'acme/..', '-acme', 'acme-', 'a'.repeat(41), 'acme--ltd', '.']) {
    assert.match(validateSlug(bad) ?? '', /folder name/, bad);
  }
  assert.throws(() => projectDir('/root/p', '../etc'), /folder name/);
  assert.equal(projectDir('/root/p', 'acme'), '/root/p/acme');
  assert.deepEqual(PROJECT_STATUSES, ['briefing', 'building', 'ready', 'shipped']);
});

test('createProject makes the Contract 1 layout and the Contract 7 §7.5 project.json; refuses a duplicate', () => {
  const root = path.join(tmp(), 'projects'); // does not exist yet
  const { dir, project } = createProject(root, { client: 'Acme Ltd', now: NOW });
  assert.equal(dir, path.join(root, 'acme-ltd'));
  assert.deepEqual(project, { schema: 1, slug: 'acme-ltd', client: 'Acme Ltd', createdAt: '2026-10-27T10:00:00.000Z', status: 'briefing',
    foundation: { repo: null, tag: null }, approved: null, builtFromBrief: null });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf8')), project);
  for (const sub of ['brief', 'notes', 'builds', 'deployments']) assert.ok(statSync(path.join(dir, sub)).isDirectory(), sub);
  assert.equal(existsSync(path.join(dir, 'app')), false, 'Plan 8 creates app/ from the foundation tag');
  assert.equal(statSync(path.join(dir, 'notes')).mode & 0o777, 0o700);
  assert.throws(() => createProject(root, { client: 'ACME LTD', now: NOW }), /A project called acme-ltd already exists \(Acme Ltd\)\. Choose another folder name with --slug <name>\./);
  assert.equal(createProject(root, { client: 'ACME LTD', slug: 'acme-2', now: NOW }).project.slug, 'acme-2');
  assert.throws(() => createProject(root, { client: '株式会社', now: NOW }), /Conductor could not make a folder name from "株式会社"\. Choose one with --slug <name>/);
  assert.throws(() => createProject(root, { client: '   ', now: NOW }), /The client name is empty/);
  assert.throws(() => createProject(root, { client: 'x', slug: '../evil', now: NOW }), /folder name/);
  assert.equal(existsSync(path.join(root, '..', 'evil')), false);
});

test('loadProject and saveProject work on a folder; a refused save writes nothing', () => {
  const root = tmp();
  const { dir, project } = createProject(root, { client: 'Acme', now: NOW });
  assert.deepEqual(loadProject(dir), project);
  const next = { ...project, status: 'building',
    foundation: { repo: '/root/highland-foundation', tag: 'v0.1.0', commit: 'a'.repeat(40) },
    approved: { sha: 'b'.repeat(40), at: NOW.toISOString(), runId: '20261027-100000-a1b2', briefVersion: 1 }, builtFromBrief: 1 };
  saveProject(dir, next);
  assert.deepEqual(loadProject(dir), next);
  assert.deepEqual(readProject(root, 'acme'), { dir, project: next });
  assert.throws(() => saveProject(dir, { ...next, status: 'done' }), /Conductor will not save project\.json for acme: status must be briefing, building, ready or shipped, not "done"\./);
  assert.throws(() => saveProject(dir, { ...next, slug: 'other' }), /its slug "other" does not match its folder "acme"/);
  assert.throws(() => saveProject(dir, { ...next, builtFromBrief: 0 }), /builtFromBrief must be null or a brief version number/);
  assert.throws(() => saveProject(dir, { ...next, approved: { sha: 'x' } }), /approved must be null or \{ sha, at, runId, briefVersion \}/);
  assert.deepEqual(loadProject(dir), next, 'a refused save leaves the file as it was');
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  assert.throws(() => loadProject(path.join(root, 'nope')), /There is no project folder at .*nope/);
});

test('readProject and listProjects: plain errors, half-made folders skipped', () => {
  const root = tmp();
  createProject(root, { client: 'Beta Co', now: NOW });
  createProject(root, { client: 'Acme', now: NOW });
  mkdirSync(path.join(root, 'half-made'));
  mkdirSync(path.join(root, 'broken'));
  writeFileSync(path.join(root, 'broken', 'project.json'), '{nope');
  writeFileSync(path.join(root, 'stray.txt'), 'x');
  const { projects, skipped } = listProjects(root);
  assert.deepEqual(projects.map((p) => p.slug), ['acme', 'beta-co']);
  assert.equal(skipped, 2);
  assert.equal(readProject(root, 'acme').project.client, 'Acme');
  assert.throws(() => readProject(root, 'nope'), /There is no project called "nope"\. See your projects with: conductor project list/);
  assert.throws(() => readProject(root, 'half-made'), /The folder half-made has no project\.json/);
  assert.throws(() => readProject(root, 'broken'), /project\.json in broken could not be read/);
  assert.deepEqual(listProjects(path.join(root, 'missing')), { projects: [], skipped: 0 });
});

test('lockProject: one job per project, plain busy message, a dead holder is replaced, release is idempotent', () => {
  const p = tmp();
  const lockFile = path.join(p, '.conductor.lock');
  const release = lockProject(p, 'brief', { pid: 111, isAlive: () => true, now: () => NOW });
  assert.deepEqual(JSON.parse(readFileSync(lockFile, 'utf8')), { pid: 111, kind: 'brief', at: NOW.toISOString() });
  assert.throws(() => lockProject(p, 'build', { pid: 222, isAlive: (pid) => pid === 111 }),
    /This project is busy: a brief is running \(pid 111, since 27 October 2026 10:00 UTC\)\. Wait for it to finish or stop it, then try again\./);
  const r2 = lockProject(p, 'change', { pid: 222, isAlive: () => false }); // 111 died without releasing
  release(); // the old holder's release must not remove 222's lock
  assert.ok(existsSync(lockFile));
  r2();
  r2();
  assert.equal(existsSync(lockFile), false);
  writeFileSync(lockFile, '{garbage'); // an unreadable lock counts as dead
  lockProject(p, 'brief', { pid: 333, isAlive: () => true })();
  assert.throws(() => lockProject(p, 'deploy'), /lockProject: kind must be brief, build, change or preview/);
});

test('lockProject: a preview has its own lock file, so it runs beside a build but not beside another preview (Contract 7 §7.11)', () => {
  const p = tmp();
  const build = lockProject(p, 'build', { pid: 111, isAlive: () => true, now: () => NOW });
  const preview = lockProject(p, 'preview', { pid: 222, isAlive: () => true, now: () => NOW });
  assert.ok(existsSync(path.join(p, '.conductor.lock')));
  assert.deepEqual(JSON.parse(readFileSync(path.join(p, '.preview.lock'), 'utf8')), { pid: 222, kind: 'preview', at: NOW.toISOString() });
  assert.throws(() => lockProject(p, 'preview', { pid: 333, isAlive: () => true }),
    /This project is busy: a preview is running \(pid 222, since 27 October 2026 10:00 UTC\)/);
  preview();
  assert.equal(existsSync(path.join(p, '.preview.lock')), false);
  assert.ok(existsSync(path.join(p, '.conductor.lock')), 'releasing the preview leaves the build lock alone');
  build();
});

test('lockProject: two starters taking over the same dead lock cannot both hold it', () => {
  const p = tmp();
  const lockFile = path.join(p, '.conductor.lock');
  writeFileSync(lockFile, JSON.stringify({ pid: 99, kind: 'build', at: NOW.toISOString() }));
  let other = null;
  // Starter 111 has read the dead lock; while it checks pid 99, starter 222 takes the lock over completely.
  const isAlive = (pid) => {
    if (!other) other = lockProject(p, 'build', { pid: 222, isAlive: () => false, now: () => NOW });
    return pid === 222;
  };
  assert.throws(() => lockProject(p, 'brief', { pid: 111, isAlive, now: () => NOW }),
    /This project is busy: a build is running \(pid 222, since 27 October 2026 10:00 UTC\)/);
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, 222, 'the second starter still holds the lock');
  assert.deepEqual(readdirSync(p), ['.conductor.lock'], 'no set-aside files are left behind');
  other();
  assert.equal(existsSync(lockFile), false);
});
