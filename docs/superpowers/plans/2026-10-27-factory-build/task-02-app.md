# Task 2: The app from the foundation tag

`createApp` makes `<project>/app`, the client's own git repo, by cloning the foundation **at its release tag** (index Ruling 9, BUILDING-ON "Starting a client app"). `nameApp` makes the build branch's first commit. That commit holds two things:
- the client's name, in the one line of `apps/web/src/brand.ts` that a client build may change (Ruling 6);
- `app-profile.json` at the app's root, written from the approved brief (Contract 7 §7.5).

Contract 7 §7.5 says "`createApp` writes `app-profile.json`". Here the write sits in `nameApp`, the step of the first build that makes the BRAND commit: `createApp` only clones onto `main`, and `main` must stay at the foundation tag until the operator approves. It is the same module, the same build step and the same commit the contract asks for.

**Files:**
- Create: `src/factory/app.js`
- Test: `test/factory-app.test.js`

**Interfaces:**
- Consumes: `git` (`src/workspace.js`; its fixed flags allow only the `file` protocol, so an https clone adds `-c protocol.https.allow=always` for that one command); `makeFoundationRepo`, `makeProject`, `sampleBrief` (Task 1).
- Produces: `createApp({ projectDir, foundation: { repo, tag }, expectCommit = null, git }) -> Promise<{ appDir, commit, created }>`, `nameApp({ appDir, brief, git }) -> Promise<string|null>`, `appProfileOf(brief) -> AppProfile`, `initialsOf(client) -> string`, `FOUNDATION_REMOTE = 'foundation'`, `APP_PROFILE_FILE = 'app-profile.json'`.
  - `AppProfile = { schema: 1, modules: string[], policy: { outbound: string[], residency } }` (Contract 7 §7.5, the shape Plan 12's `AppProfileSchema` checks).

- [ ] **Step 1: Write the failing tests**

Create `test/factory-app.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createApp, nameApp, initialsOf, appProfileOf } from '../src/factory/app.js';
import { git } from '../src/workspace.js';
import { makeFoundationRepo, makeProject, sampleBrief } from './helpers/factoryFixtures.js';

const out = async (dir, args) => (await git(dir, args)).stdout.trim();

test('clones the tag onto a new main, keeps the foundation as a remote, records the commit', async () => {
  const repo = await makeFoundationRepo();
  const { projectDir } = makeProject();
  const r = await createApp({ projectDir, foundation: { repo, tag: 'v0.1.0' } });
  assert.equal(r.created, true);
  assert.equal(r.appDir, path.join(projectDir, 'app'));
  assert.equal(await out(r.appDir, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(await out(r.appDir, ['rev-parse', 'HEAD']), r.commit);
  assert.equal(r.commit, await out(repo, ['rev-parse', 'v0.1.0^{commit}']));
  assert.equal(await out(r.appDir, ['remote']), 'foundation');
  assert.deepEqual(readdirSync(projectDir).filter((n) => n.startsWith('app.partial')), [], 'no half-made clone left');
});

test('a second call reuses the app; a moved tag is refused', async () => {
  const repo = await makeFoundationRepo();
  const { projectDir } = makeProject();
  const first = await createApp({ projectDir, foundation: { repo, tag: 'v0.1.0' } });
  const again = await createApp({ projectDir, foundation: { repo, tag: 'v0.1.0' }, expectCommit: first.commit });
  assert.deepEqual([again.created, again.commit], [false, first.commit]);
  await assert.rejects(createApp({ projectDir, foundation: { repo, tag: 'v0.1.0' }, expectCommit: 'f'.repeat(40) }),
    /The foundation's tag v0\.1\.0 now points at a different commit than when this app was made/);
});

test('refuses a missing tag and a foundation.json that does not match the tag, leaving nothing behind', async () => {
  const repo = await makeFoundationRepo();
  const { projectDir } = makeProject();
  await assert.rejects(createApp({ projectDir, foundation: { repo, tag: 'v9.9.9' } }), /The foundation has no release v9\.9\.9/);
  const bad = await makeFoundationRepo({ extra: { 'foundation.json': '{"name":"highland-foundation","version":"0.0.9","commit":"v0.0.9"}' } });
  await assert.rejects(createApp({ projectDir, foundation: { repo: bad, tag: 'v0.1.0' } }), /foundation\.json says v0\.0\.9, not v0\.1\.0/);
  assert.equal(existsSync(path.join(projectDir, 'app')), false);
});

test('an https foundation is cloned with https allowed for that command only; ssh is never enabled', async () => {
  const calls = [];
  const fake = async (cwd, args) => { calls.push(args); return { code: 128, stdout: '', stderr: 'fatal: unable to access' }; };
  const { projectDir } = makeProject();
  await assert.rejects(createApp({ projectDir, foundation: { repo: 'https://git.example/hf.git', tag: 'v0.1.0' }, git: fake }),
    /Conductor could not copy the foundation from https:\/\/git\.example\/hf\.git/);
  const clone = calls.find((a) => a.includes('clone'));
  assert.deepEqual(clone.slice(0, 3), ['-c', 'protocol.https.allow=always', 'clone']);
  assert.equal(calls.flat().some((a) => /protocol\.ssh/.test(a)), false);
});

test('nameApp rewrites the BRAND line and writes app-profile.json in one commit, once', async () => {
  const repo = await makeFoundationRepo();
  const { projectDir } = makeProject();
  const { appDir } = await createApp({ projectDir, foundation: { repo, tag: 'v0.1.0' } });
  const brief = sampleBrief({ client: 'Acme "Office" Ltd', policy: { ...sampleBrief().policy, outbound: ['cloudflare-tunnel'] } });
  const sha = await nameApp({ appDir, brief });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(readFileSync(path.join(appDir, 'apps/web/src/brand.ts'), 'utf8').split('\n')[1],
    'export const BRAND = { appName: "Acme \\"Office\\" Ltd", shortName: "AO" } as const;');
  assert.deepEqual(JSON.parse(readFileSync(path.join(appDir, 'app-profile.json'), 'utf8')),
    { schema: 1, modules: [], policy: { outbound: ['cloudflare-tunnel'], residency: 'uk' } });
  assert.equal(await out(appDir, ['log', '-1', '--format=%s']), 'Name the app: Acme "Office" Ltd');
  assert.deepEqual((await out(appDir, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort(), ['app-profile.json', 'apps/web/src/brand.ts']);
  assert.equal(await nameApp({ appDir, brief }), null);
});

test('appProfileOf copies only modules, outbound ids and residency from the brief', () => {
  assert.deepEqual(appProfileOf(sampleBrief()), { schema: 1, modules: [], policy: { outbound: [], residency: 'uk' } });
});

test('nameApp refuses a brand.ts without the expected line', async () => {
  const repo = await makeFoundationRepo({ extra: { 'apps/web/src/brand.ts': 'export default {};\n' } });
  const { projectDir } = makeProject();
  const { appDir } = await createApp({ projectDir, foundation: { repo, tag: 'v0.1.0' } });
  await assert.rejects(nameApp({ appDir, brief: sampleBrief() }), /does not have the expected BRAND line/);
  assert.equal(await out(appDir, ['status', '--porcelain']), '');
});

test('initials skip company suffixes', () => {
  assert.equal(initialsOf('Highland Automations Ltd'), 'HA');
  assert.equal(initialsOf('acme limited'), 'A');
  assert.equal(initialsOf('Smith, Jones & Brown LLP'), 'SJB');
  assert.equal(initialsOf('Ltd'), 'App');
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/factory-app.test.js`
Expected: FAIL (`Cannot find module '../src/factory/app.js'`).

- [ ] **Step 3: Implement `createApp` in `src/factory/app.js`**

- `appDir = <projectDir>/app`. If it exists: it must be a git repo (`rev-parse --git-dir`); resolve `git rev-parse --verify --quiet refs/tags/<tag>^{commit}` inside it. With `expectCommit` set and different, throw `The foundation's tag <tag> now points at a different commit than when this app was made. Conductor will not build on it; ask the foundation's maintainer why the tag moved.` Return `{ appDir, commit, created: false }`.
- Otherwise clone into `<projectDir>/app.partial-<6 hex>`: args `['clone', '--quiet', '--no-hardlinks', '--branch', tag, repo, partialDir]`, prefixed with `['-c', 'protocol.https.allow=always']` only when `repo` starts with `https://`, timeout 15 minutes. A failing clone throws `Conductor could not copy the foundation from <repo>: <first line of stderr, redacted>`; a clone that fails with `Remote branch <tag> not found` throws `The foundation has no release <tag>.`
- In the partial dir: `checkout -q -b main`, `remote rename origin foundation`, read `foundation.json`. Its `commit` must equal `tag` and its `version` must equal the tag without `v`; otherwise throw `The foundation at <tag> is not a proper release: its foundation.json says <v + version>, not <tag>.`
- With `expectCommit` set, compare as above. Then `renameSync(partialDir, appDir)`.
- Any throw removes the partial dir (`rmSync(…, { recursive: true, force: true })`).

- [ ] **Step 4: Implement `nameApp`, `appProfileOf` and `initialsOf`**

- `initialsOf`: split on non-letters, drop `ltd`, `limited`, `plc`, `llp`, `llc`, `inc`, `co` (case-insensitive), take the first letter of up to 3 words, upper-case; empty → `'App'`.
- `appProfileOf(brief)`: `{ schema: 1, modules: [...brief.modules], policy: { outbound: [...brief.policy.outbound], residency: brief.policy.residency } }`.
  - `modules` is always `[]` while `briefProblems` (Task 4) refuses briefs with modules. Plan 12 lifts that refusal, and the modules then flow through unchanged.
  - Plan 11 rewrites this file when a change brief alters `modules` or `policy`.
- `nameApp({ appDir, brief })`:
  1. The tree must be clean (`status --porcelain` empty), else throw `The app folder has changes Conductor did not make, so it stopped. Nothing was changed.`
  2. Find `/^export const BRAND = \{.*\} as const;$/m` in `apps/web/src/brand.ts`. Missing → throw `The foundation's apps/web/src/brand.ts does not have the expected BRAND line, so Conductor cannot name the app. Nothing was changed.`
  3. Replace that line with `export const BRAND = { appName: ${JSON.stringify(brief.client)}, shortName: ${JSON.stringify(initialsOf(brief.client))} } as const;`.
  4. Write `app-profile.json` as `JSON.stringify(appProfileOf(brief), null, 2) + '\n'`.
  5. Neither file changed → return `null`.
  6. Otherwise `add` exactly those two files, `commit -q -m "Name the app: <client>"`, and return `rev-parse HEAD`.

- [ ] **Step 5: Run the tests**

Run: `node --test test/factory-app.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/factory/app.js test/factory-app.test.js
git commit -m "feat(factory): create the client app from the foundation tag, name it and write its app profile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
