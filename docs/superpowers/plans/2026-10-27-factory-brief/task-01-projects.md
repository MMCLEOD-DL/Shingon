# Task 1: Project folder — atomic writes, factory config, projects, project lock

This task builds roadmap Contract 1 (extended by Contract 7 §7.5): the client project folder under `projectsRoot`, created, read and saved safely. It also builds three of the shared modules Contract 7 §7.1 gives Plan 7 to own: `fsAtomic.js`, `config.js` (`factoryConfig`) and `projectLock.js` (`lockProject`). Plans 8–12 import these and never redefine them. The `conductor project …` commands come later (Task 9); this task is the library.

**Files:**
- Create: `src/factory/fsAtomic.js`, `src/factory/config.js`, `src/factory/projects.js`, `src/factory/projectLock.js`
- Modify: `src/config.js` (`loadConfig` also returns `factory`)
- Test: `test/factory-projects.test.js`

**Interfaces:**
- Consumes: `loadConfig` (`src/config.js`, today returning `{ participants, byName, routing, options }`).
- Produces: everything listed for Task 1 in the index's Shared Interfaces.

- [ ] **Step 1: Write the failing tests** in `test/factory-projects.test.js`

```js
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
  assert.throws(() => lockProject(p, 'deploy'), /lockProject: kind must be brief, build or change/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-projects.test.js`
Expected: FAIL with `Cannot find module '…/src/factory/fsAtomic.js'`.

- [ ] **Step 3: Implement `src/factory/fsAtomic.js`**

- `writeFileAtomic(file, data, { mode = 0o600 } = {})`:
  - the temp file is `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp` in the same folder;
  - `openSync(tmp, 'wx', mode)`, then `writeSync`, `fsyncSync`, `closeSync`, then `renameSync(tmp, file)`;
  - then fsync the folder (`openSync(dir, 'r')`, `fsyncSync`, inside try/catch, since some filesystems refuse);
  - on any error, `rmSync(tmp, { force: true })` and rethrow;
  - pass the mode explicitly and `chmodSync(tmp, mode)` before the rename, so the umask cannot widen it.
- `writeJsonAtomic` is `writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', opts)`.
- `createFileExclusive` writes and fsyncs the temp file the same way, then calls `linkSync(tmp, file)`, which throws `EEXIST` atomically. It always unlinks the temp file, then fsyncs the folder.

- [ ] **Step 4: Implement `src/factory/config.js` and the `loadConfig` change**

- In `src/config.js`, `loadConfig` returns `{ participants, byName, routing, options, factory: parsed.factory ?? {} }`. Nothing else in it changes; it does not validate `factory` (that is `factoryConfig`'s job, so each plan's section is checked in one place).
- `factoryConfig(config, { env = process.env, home = homedir(), user = safeUserName() } = {})` (`user` is an extra, optional test seam beyond Contract 7's `{ env, home }`):
  - `section = config?.factory`. Absent or `undefined` means `{}`. Present but not a plain object → `the config's "factory" section must be an object`;
  - `projectsRoot`: `env.CONDUCTOR_PROJECTS_ROOT`, else `section.projectsRoot`, else `DEFAULT_PROJECTS_ROOT`. Expand a leading `~` or `~/` with `home`. After expansion it must be absolute; otherwise throw the exact message in the test;
  - `operatorName`: when present it must be a non-empty string of at most 80 characters, otherwise `factory.operatorName must be text (your name, as it should appear on approved briefs)`. When absent, use `user`, and an empty `user` gives `'operator'`;
  - `user` defaults to `os.userInfo().username` inside a try/catch (`safeUserName()`, not exported);
  - returns `{ projectsRoot, operatorName }`. Plans 8 and 10 add their own sections (Contract 7 §7.2) by extending this function; unknown keys in `section` are left alone so their keys are not refused before those plans land.
- `factoryConfig` takes the config **object**, not a path. It never reads `participants`, so Task 9 can pass `{ factory }` read straight from a config file that has no participants.

- [ ] **Step 5: Implement `src/factory/projects.js`**

- `SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`, at most 40 characters (not exported; Plan 8's `ids.js` owns the exported `SLUG_RE`, and every slug this module accepts also passes that one).
- `PROJECT_STATUSES = Object.freeze(['briefing', 'building', 'ready', 'shipped'])`.
- `validateSlug` returns `"${slug}" is not a usable folder name: use 1–40 lower-case letters, digits and single hyphens, e.g. acme-ltd` or `null`.
- `slugify`:
  1. `NFKD`, then strip `̀-ͯ`;
  2. lower-case, `&` → ` and `;
  3. runs of anything outside `[a-z0-9]` → `-`;
  4. trim hyphens, cut to 40, trim hyphens again.
- `projectDir(root, slug)` throws `new Error(validateSlug(slug))` when the slug is invalid, else returns `path.join(root, slug)`.
- `projectProblem(project, folderSlug) -> string | null` (private; used by both `loadProject` and `saveProject`, so the rules live once). In order:
  - not a plain object → `it is not a JSON object`;
  - `schema !== 1` → `schema must be 1`;
  - `slug !== folderSlug` → `its slug "${slug}" does not match its folder "${folderSlug}"`;
  - `client` not a non-empty string → `it has no client name`;
  - `status` not in `PROJECT_STATUSES` → `status must be briefing, building, ready or shipped, not "${status}"`;
  - `foundation` not an object with `repo` and `tag` (both strings, or both null) → `foundation must be { repo, tag } (or both null)`;
  - `approved` not `null` and not an object with string `sha`, `at`, `runId` and integer `briefVersion ≥ 1` → `approved must be null or { sha, at, runId, briefVersion }`;
  - `builtFromBrief` not `null` and not an integer ≥ 1 → `builtFromBrief must be null or a brief version number`.
- `createProject`:
  - trims `client` and refuses an empty one (`The client name is empty: say who the app is for, e.g. conductor project new "Acme Ltd"`);
  - refuses more than 120 characters or a control character;
  - refuses an empty slug with the exact message in the test;
  - `mkdirSync(root, { recursive: true, mode: 0o700 })`;
  - `mkdirSync(dir, { mode: 0o700 })` (not recursive). On `EEXIST` it reads the existing `project.json` client for the message (falling back to `unknown client`) and throws;
  - makes `brief`, `notes`, `builds` and `deployments` with mode 0o700;
  - builds `{ schema: 1, slug, client, createdAt, status: 'briefing', foundation: { repo: null, tag: null }, approved: null, builtFromBrief: null }` and writes it with `saveProject(dir, project)`.
- `loadProject(dir)`:
  - no folder → `There is no project folder at ${dir}.`;
  - no `project.json` → `The folder ${basename} has no project.json. It may be a half-made project: remove the folder and run conductor project new again.`;
  - JSON that won't parse, or `projectProblem(project, basename(dir))` → `The project.json in ${basename} could not be read (${why}).`;
  - returns the parsed object.
- `saveProject(dir, project)`: `why = projectProblem(project, basename(dir))`; when set, throw `Conductor will not save project.json for ${basename}: ${why}.` and write nothing. Otherwise `writeJsonAtomic(path.join(dir, 'project.json'), project)`.
- `readProject(root, slug)`: `dir = projectDir(root, slug)`; no folder → the "no project called" message; otherwise `{ dir, project: loadProject(dir) }`.
- `listProjects(root)`:
  - skips non-folders silently;
  - counts folders whose slug is invalid or that `readProject` rejects as `skipped`;
  - returns `{ projects: [{ slug, client, status, createdAt, dir }], skipped }`, sorted by slug;
  - a missing root gives `{ projects: [], skipped: 0 }`.

- [ ] **Step 6: Implement `src/factory/projectLock.js`**

One lock per project, shared by every kind of job, so a brief, a build and a change can never run on the same project at once (Contract 7 §7.1).

- `LOCK_KINDS = ['brief', 'build', 'change']` (not exported). An unknown kind throws `lockProject: kind must be brief, build or change` (a programming error, not an operator message).
- `lockProject(projectDir, kind, { pid = process.pid, isAlive = pidAlive, now = () => new Date() } = {}) -> release()`. The third argument is a test seam beyond Contract 7's `(projectDir, kind)`; callers in Plans 8 and 11 pass two arguments.
  - The lock file is `<projectDir>/.conductor.lock`. Write it with `openSync(lock, 'wx', 0o600)`, holding `{ pid, kind, at: now().toISOString() }`.
  - On `EEXIST`, read the holder. An unreadable file counts as dead. If `isAlive(holder.pid)`, throw `This project is busy: a ${holder.kind} is running (pid ${holder.pid}, since ${when}). Wait for it to finish or stop it, then try again.` where `when` is `27 October 2026 10:00 UTC` (en-GB date, 24-hour `HH:MM`, UTC), or `an unknown time` when `at` does not parse. Otherwise `rmSync` it and retry once.
  - The returned `release()` deletes the lock only if the file still holds **this** pid, and never throws.
  - `pidAlive(pid)` is `try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/factory-projects.test.js test/config.test.js && npm test`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/config.js src/factory/fsAtomic.js src/factory/config.js src/factory/projects.js src/factory/projectLock.js test/factory-projects.test.js
git commit -m "feat(factory): client project folders, factory config and project lock (Contracts 1, 7)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
