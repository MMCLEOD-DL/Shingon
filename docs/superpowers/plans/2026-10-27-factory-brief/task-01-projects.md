# Task 1: Project folder — atomic writes, settings, projects

This task builds roadmap Contract 1: the client project folder under `projectsRoot`, created and read safely. The `conductor project …` commands come later (Task 9); this task is the library.

**Files:**
- Create: `src/factory/fsAtomic.js`, `src/factory/settings.js`, `src/factory/projects.js`
- Test: `test/factory-projects.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: everything listed for Task 1 in the index's Shared Interfaces.

- [ ] **Step 1: Write the failing tests** in `test/factory-projects.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileAtomic, writeJsonAtomic, createFileExclusive } from '../src/factory/fsAtomic.js';
import { factorySettings, DEFAULT_PROJECTS_ROOT } from '../src/factory/settings.js';
import { slugify, validateSlug, projectDir, createProject, readProject, listProjects } from '../src/factory/projects.js';

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

test('factorySettings: default root, ~ expansion, env override, operator name, plain errors', () => {
  const home = '/home/m';
  assert.equal(DEFAULT_PROJECTS_ROOT, '~/highland-projects');
  assert.deepEqual(factorySettings({ env: {}, home, user: 'malcolm' }), { projectsRoot: '/home/m/highland-projects', operatorName: 'malcolm' });
  const cfg = path.join(tmp(), 'c.json');
  writeFileSync(cfg, JSON.stringify({ participants: [], factory: { projectsRoot: '~/clients', operatorName: 'Malcolm McLeod' } }));
  assert.deepEqual(factorySettings({ configPath: cfg, env: {}, home, user: 'x' }), { projectsRoot: '/home/m/clients', operatorName: 'Malcolm McLeod' });
  assert.equal(factorySettings({ configPath: cfg, env: { CONDUCTOR_PROJECTS_ROOT: '/srv/p' }, home }).projectsRoot, '/srv/p');
  writeFileSync(cfg, JSON.stringify({ factory: { projectsRoot: 'relative/dir' } }));
  assert.throws(() => factorySettings({ configPath: cfg, env: {}, home }), /factory\.projectsRoot must be a full path \(starting with \/ or ~\), but the config has "relative\/dir"/);
  writeFileSync(cfg, JSON.stringify({ factory: { operatorName: 42 } }));
  assert.throws(() => factorySettings({ configPath: cfg, env: {}, home }), /factory\.operatorName must be text/);
  assert.equal(factorySettings({ env: {}, home, user: '' }).operatorName, 'operator');
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
});

test('createProject makes the Contract 1 layout and project.json; refuses a duplicate', () => {
  const root = path.join(tmp(), 'projects'); // does not exist yet
  const { dir, project } = createProject(root, { client: 'Acme Ltd', now: NOW });
  assert.equal(dir, path.join(root, 'acme-ltd'));
  assert.deepEqual(project, { schema: 1, slug: 'acme-ltd', client: 'Acme Ltd', createdAt: '2026-10-27T10:00:00.000Z', foundation: { repo: null, tag: null }, status: 'briefing' });
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

- [ ] **Step 4: Implement `src/factory/settings.js`**

- `factorySettings({ configPath, env, home, user })`:
  - reads `JSON.parse(readFileSync(configPath))` when `configPath` is given. A missing or invalid `factory` key means `{}`;
  - `factory` must be a plain object when present: `the config's "factory" section must be an object`;
  - `projectsRoot`: `env.CONDUCTOR_PROJECTS_ROOT`, else `factory.projectsRoot`, else `DEFAULT_PROJECTS_ROOT`. Expand a leading `~` or `~/` with `home`. After expansion it must be absolute; otherwise throw the exact message in the test;
  - `operatorName`: when present it must be a non-empty string of at most 80 characters, otherwise `factory.operatorName must be text (your name, as it should appear on approved briefs)`. When absent, use `user`, and an empty `user` gives `'operator'`;
  - `user` defaults to `os.userInfo().username` inside a try/catch (`safeUserName()`, not exported).
- The function never reads `participants`, so it works with a config that has none.

- [ ] **Step 5: Implement `src/factory/projects.js`**

- `SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`, at most 40 characters.
- `validateSlug` returns `"${slug}" is not a usable folder name: use 1–40 lower-case letters, digits and single hyphens, e.g. acme-ltd` or `null`.
- `slugify`:
  1. `NFKD`, then strip `̀-ͯ`;
  2. lower-case, `&` → ` and `;
  3. runs of anything outside `[a-z0-9]` → `-`;
  4. trim hyphens, cut to 40, trim hyphens again.
- `projectDir(root, slug)` throws `new Error(validateSlug(slug))` when the slug is invalid, else returns `path.join(root, slug)`.
- `createProject`:
  - trims `client` and refuses an empty one (`The client name is empty: say who the app is for, e.g. conductor project new "Acme Ltd"`);
  - refuses more than 120 characters or a control character;
  - refuses an empty slug with the exact message in the test;
  - `mkdirSync(root, { recursive: true, mode: 0o700 })`;
  - `mkdirSync(dir, { mode: 0o700 })` (not recursive). On `EEXIST` it reads the existing `project.json` client for the message (falling back to `unknown client`) and throws;
  - makes `brief`, `notes`, `builds` and `deployments` with mode 0o700;
  - writes `project.json` with `writeJsonAtomic`.
- `readProject`:
  - no folder → the "no project called" message;
  - no `project.json` → `The folder ${slug} has no project.json. It may be a half-made project: remove the folder and run conductor project new again.`;
  - JSON that won't parse, a `schema` other than 1 or a mismatched `slug` → `The project.json in ${slug} could not be read (${why}).`.
- `listProjects`:
  - skips non-folders silently;
  - counts folders whose slug is invalid or that `readProject` rejects as `skipped`;
  - sorts by slug;
  - a missing root gives `{ projects: [], skipped: 0 }`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/factory-projects.test.js && npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/factory/fsAtomic.js src/factory/settings.js src/factory/projects.js test/factory-projects.test.js
git commit -m "feat(factory): client project folders with atomic writes (Contract 1)"
```
