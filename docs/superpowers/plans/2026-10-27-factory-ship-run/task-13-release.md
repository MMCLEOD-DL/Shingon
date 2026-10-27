# Task 13: Cutting releases (`releaseApp`) and finding the approved one

Contract 7 §7.6: the build gate (Plan 8) and the change gate (Plan 11) only **record** approval (`project.json.approved`) and move `main`. **Releases are cut by Plan 10's `releaseApp`**, and `conductor ship` finds the release for the approved build, or cuts the first one. This task builds both, in `src/factory/ship/release.js`.

`releaseApp` never edits the app repo's working copy while it works: it clones `main` into a scratch folder, runs the app's own `npm run release -- <bump>` there (the foundation's `scripts/release.ts`: changelog section, version fields, `release: v<x>` commit, annotated tag), and only then moves `main` in the project's app repo **by compare-and-swap** and adds the tag. If `main` moved meanwhile, nothing is added.

**Files:**
- Create: `src/factory/ship/release.js`
- Modify: `test/helpers/shipProject.js` (add `released` option, `fakeNpm`)
- Test: `test/factory-release.test.js`

**Interfaces:**
- Consumes: `loadProject` (Plan 7's `src/factory/projects.js`); `RUN_ID_RE` (Plan 8's `src/factory/ids.js`); `parseVersion`, `compareVersions` (Task 4); `runCommand` (`src/exec.js`); `strictChildEnv`, `redact` (`src/secrets.js`); `findBin` (`src/council/tools.js`).
- Produces (index, Task 13; Contract 7 §7.6):

```js
RELEASE_BUMPS = ['first', 'minor', 'patch']
FIRST_RELEASE_NPM_BUMP = 'major'          // see Ruling 1: the app's first release is 1.0.0
findRelease(appDir, sha, { env }) -> Promise<{ sha, version, tag } | null>
releaseApp({ projectDir, bump, runId }, { env = process.env, run = runCommand } = {})
  -> Promise<{ ok: true, version, sha, tag } | { ok: false, reason }>
approvedRelease(projectDir, { runId, env }) -> Promise<{ ok: true, sha, version, tag, cut: boolean } | { ok: false, problem }>   // sha = the release commit (what is built)
// test/helpers/shipProject.js additions
makeShipProject(root, { …, released = true })   // released: false → a fresh app as Plan 8 leaves it (see Step 3)
approve(p, sha) -> void                          // sets project.json approved.sha
fakeNpm(dir, { mainBump = null } = {}) -> { binDir, env(base), calls() }   // stub `npm`; see Step 3
```

**Why `first` runs `npm run release -- major`** (Contract 7 §7.11, which amends §7.6): the foundation refuses `npm run release -- first` in any clone made at a release tag (BUILDING-ON "Starting a client app" step 4: "a clone made at a release tag already has one"), and its `first` would only re-tag the foundation's own 0.1.0. So `bump: 'first'` keeps its meaning, "this app's first release", and runs `major`, giving 1.0.0. Plan 8's `createApp` deletes the foundation tags the clone brought in, so every `v*` tag in the app repo is an app release (§7.11).

**What "the app has its own releases" means.** A fresh app (Plan 8's `createApp`) is a clone of the foundation, so its `package.json` `name` is `highland-foundation`; it carries no tags, because `createApp` deletes the foundation tags it inherits (Contract 7 §7.11). `releaseApp('first')` renames the package to the project's slug (Contract 7 §7.9 item 1: the v0.2.0 release script stamps `foundation.json` only for `highland-foundation`, so the rename is what lets that fix apply to apps). So: **`package.json` `name` at `main` equal to `highland-foundation` ⇔ the app has never been released by Conductor.**

**`findRelease(appDir, sha)`**: `git -C appDir tag --list 'v*' --format='%(refname:short) %(objectname) %(*objectname)'`; keep tags whose rest is a plain `x.y.z` (`parseVersion`, no pre-release); the tag's commit is the peeled `%(*objectname)` (annotated) or `%(objectname)` (light); keep those where `merge-base --is-ancestor <sha> <commit>` **and** `merge-base --is-ancestor <commit> refs/heads/main` succeed ("on or after the approved build, and on `main`"). Return the highest by `compareVersions`, or `null`. An app repo holds no foundation tags (Plan 8's `createApp` deletes them; Plan 11 fetches foundation releases as `refs/foundation/vX.Y.Z`, Contract 7 §7.11), and a stray one would sit below the approved build, so it is never chosen.

**`releaseApp({ projectDir, bump, runId })`** — every refusal is `{ ok: false, reason }` in plain English with nothing changed; it never throws for operator-facing problems:
1. `bump` not in `RELEASE_BUMPS` → `"<bump>" is not a kind of release Conductor makes (first, minor or patch).`; `runId` not matching `RUN_ID_RE` → `"<runId>" is not a run id.`; `findBin('git')`/`findBin('npm')` missing → `Conductor needs <tool> on this machine to make a release, and it is not installed.`
2. `project = loadProject(projectDir)`; `appDir = <projectDir>/app`; `main = git rev-parse --verify refs/heads/main` (missing → `The project has no app yet, so there is nothing to release.`).
3. **Adopt a release that already happened** (a crash after `main` moved): when `main`'s subject is `release: v<x.y.z>` and `package.json` at `main` says `<x.y.z>`: if `refs/tags/v<x.y.z>` points at `main`, return `{ ok: true, version, sha: main, tag }`; if the tag is missing, create it (`git tag -a v<x> -m v<x> <main>`) and return the same. No `npm` runs.
4. `name = package.json name at main` (`git show main:package.json`). `first` with `name !== 'highland-foundation'` → `This app has already had its first release, so it cannot have another first one.` `minor`/`patch` with `name === 'highland-foundation'` → `This app has not had its first release yet. Ship it once (conductor ship) to make it.`
5. `scratch = mkdtempSync(os.tmpdir() + '/hf-release-')` (removed in `finally`); `git clone -q --no-hardlinks --branch main <appDir> <scratch>/app` (all tags come along, so the release script sees every existing `v*` tag, all of them app releases, and refuses a version that would clash); `git config user.name`/`user.email` in the clone copied from the app repo when set, else `Conductor` / `conductor@localhost` (the release script refuses without an identity).
6. **`first` only, one preparation commit in the clone** (`Start <client>'s own releases`):
   - `package.json` `name` → `project.slug`; in `package-lock.json` (when present) the top-level `name` and `packages[''].name` → `project.slug`; both rewritten with `JSON.stringify(j, null, 2) + '\n'`.
   - `CHANGELOG.md`: the line `- First release of the <client> app, built on highland-foundation <project.foundation.tag>.` inserted as the first line under `## [Unreleased]` (no such heading → `The app's CHANGELOG.md has no "## [Unreleased]" section, so a release cannot be made.`).
   - `minor`/`patch` add nothing: the change's own entries are already under `Unreleased` (Plan 11 writes them before it calls `releaseApp`), and the release script refuses an empty `Unreleased`.
7. In the clone: `npm ci --no-audit --no-fund --loglevel=error` (15 minutes), then `npm run release -- <first ? FIRST_RELEASE_NPM_BUMP : bump>` (10 minutes), both with `strictChildEnv({ env })`. Non-zero → `The app's release script stopped: <last non-empty line of its output, redacted, without its final full stop>.` (for example the foundation's `There is nothing under "Unreleased" in CHANGELOG.md, so there is nothing to release.`, or its `npm audit` refusal).
8. `version` = `package.json` version in the clone, `tag = 'v' + version`, `sha` = clone `HEAD`; the clone's `refs/tags/<tag>` must peel to `sha`, and `main` must be an ancestor of `sha`; otherwise `The app's release script did not leave the release Conductor expected, so nothing was added.`
9. **Move it into the app repo, compare-and-swap first:**
   - `git -C appDir fetch -q --no-tags <scratch>/app +refs/heads/main:refs/conductor/release-<runId>`;
   - when the app repo's current branch is `main`, `status --porcelain` must be empty (else `The app folder has changes Conductor did not make, so the release was not added.`);
   - `git -C appDir update-ref refs/heads/main <sha> <main>`; failure → `The app's main branch moved while the release was being made, so the release was not added. Run it again.`;
   - `git -C appDir fetch -q --no-tags <scratch>/app refs/tags/<tag>:refs/tags/<tag>`; when the current branch is `main`, `reset -q --hard <sha>`;
   - `update-ref -d refs/conductor/release-<runId>` in every path (`finally`).
10. Return `{ ok: true, version, sha, tag }`. Recording it is the caller's job (Plan 11 keeps it in its run; `conductor ship` just ships it).

**Foundation v0.1.0 caveat (kept, not worked around):** the v0.1.0 release script also writes the app's version into `foundation.json` (fixed in v0.2.0, Contract 7 §7.9 item 1). So, for apps on v0.1.0, `foundation.json` and the box's `/api/version` `foundation` field show the app's version. Plan 10 therefore records each deployment's foundation from `project.json.foundation.tag` (Tasks 8–11) and never from the box.

**`approvedRelease(projectDir, { runId })`** — "find or cut the release" (Contract 7 §7.6):
1. `approved.sha` missing or not 40 hex → `This project has no approved build yet. Build it and approve it first (conductor build acme).`
2. `cat-file -e <sha>^{commit}` fails in `app/` → `The approved build (abc1234) is not in the project's app repository.`
3. `findRelease(appDir, approved.sha)` found → the version in `package.json` at the tag's commit must equal the tag (else `The release tag v1.0.3 does not match the version in package.json (1.0.2).`) → `{ ok: true, …, cut: false }`.
4. Not found, and `package.json` name at `main` is `highland-foundation`:
   - `main !== approved.sha` → `The app's main branch has moved since the build was approved (main is <short>, the approved build is <short>), so Conductor will not release it. Approve the build again.`
   - else `releaseApp({ projectDir, bump: 'first', runId })`; `ok: false` → `Conductor could not make the app's first release: <reason>`; otherwise `{ ok: true, …, cut: true }`.
5. Not found, and the app already has releases → `The approved change (abc1234) has no release yet. Finish it with: conductor change acme --resume` (a change's release is Plan 11's step; `ship` never makes `minor` or `patch` releases).

- [ ] **Step 1: Write the failing tests**

```js
// test/factory-release.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeShipProject, fakeNpm, approve, RUN_ID } from './helpers/shipProject.js';
import { releaseApp, approvedRelease, findRelease } from '../src/factory/ship/release.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'rel-'));
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

test('the first release renames the package, notes the foundation, runs the app\'s own release as major, and moves main', async () => {
  const d = tmp();
  const p = makeShipProject(d, { released: false });
  const npm = fakeNpm(d);
  const before = git(p.appDir, 'rev-parse', 'main');
  const r = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() });
  assert.deepEqual(r, { ok: true, version: '1.0.0', sha: git(p.appDir, 'rev-parse', 'main'), tag: 'v1.0.0' });
  assert.equal(git(p.appDir, 'rev-parse', 'v1.0.0^{commit}'), r.sha);
  assert.equal(git(p.appDir, 'merge-base', '--is-ancestor', before, r.sha), '');
  assert.equal(JSON.parse(git(p.appDir, 'show', 'main:package.json')).name, 'acme');
  assert.match(git(p.appDir, 'show', 'main:CHANGELOG.md'), /First release of the Acme Ltd app, built on highland-foundation v0\.1\.0\./);
  assert.deepEqual(npm.calls().map((c) => c.join(' ')), ['ci --no-audit --no-fund --loglevel=error', 'run release -- major']);
  assert.equal(git(p.appDir, 'for-each-ref', 'refs/conductor'), '');
});

test('a release that already happened is adopted, without running npm again', async () => {
  const d = tmp();
  const p = makeShipProject(d, { released: false });
  const npm = fakeNpm(d);
  const first = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() });
  git(p.appDir, 'tag', '-d', 'v1.0.0'); // a crash between moving main and adding the tag
  const again = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() });
  assert.deepEqual(again, first);
  assert.equal(npm.calls().length, 2);
});

test('main moving during the release adds nothing', async () => {
  const d = tmp();
  const p = makeShipProject(d, { released: false });
  const npm = fakeNpm(d, { mainBump: p.appDir }); // the stub commits to the real app's main while "releasing"
  const r = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /main branch moved while the release was being made/);
  assert.equal(git(p.appDir, 'tag', '--list', 'v1.0.0'), '');
});

test('the release script\'s own refusal comes back plainly, and minor/patch need a first release', async () => {
  const d = tmp();
  const p = makeShipProject(d); // released 0.1.3, nothing under Unreleased
  const npm = fakeNpm(d);
  const r = await releaseApp({ projectDir: p.projectDir, bump: 'minor', runId: RUN_ID }, { env: npm.env() });
  assert.deepEqual(r, { ok: false, reason: 'The app\'s release script stopped: There is nothing under "Unreleased" in CHANGELOG.md, so there is nothing to release.' });
  assert.equal(git(p.appDir, 'rev-parse', 'main'), git(p.appDir, 'rev-parse', 'v0.1.3^{commit}'));
  assert.match((await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: npm.env() })).reason, /already had its first release/);
  const fresh = makeShipProject(tmp(), { released: false });
  assert.match((await releaseApp({ projectDir: fresh.projectDir, bump: 'patch', runId: RUN_ID }, { env: npm.env() })).reason, /has not had its first release yet/);
  assert.match((await releaseApp({ projectDir: fresh.projectDir, bump: 'major', runId: RUN_ID }, { env: npm.env() })).reason, /is not a kind of release Conductor makes/);
});

test('findRelease ignores the foundation\'s tags and picks the newest release on or after the build', async () => {
  const d = tmp();
  const p = makeShipProject(d, { released: false });
  git(p.appDir, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0', `${p.sha}~1`); // a stray foundation tag below the approved build (createApp removes these; still never chosen)
  assert.equal(await findRelease(p.appDir, p.sha), null);
  const done = await releaseApp({ projectDir: p.projectDir, bump: 'first', runId: RUN_ID }, { env: fakeNpm(d).env() });
  assert.deepEqual(await findRelease(p.appDir, p.sha), { sha: done.sha, version: '1.0.0', tag: 'v1.0.0' });
});

test('approvedRelease finds an existing release, cuts the first one, and refuses the rest plainly', async () => {
  const a = makeShipProject(tmp());
  assert.deepEqual(await approvedRelease(a.projectDir, { runId: RUN_ID }), { ok: true, sha: git(a.appDir, 'rev-parse', 'v0.1.3^{commit}'), version: '0.1.3', tag: 'v0.1.3', cut: false });
  const d = tmp();
  const b = makeShipProject(d, { released: false });
  const cut = await approvedRelease(b.projectDir, { runId: RUN_ID, env: fakeNpm(d).env() });
  assert.deepEqual([cut.ok, cut.version, cut.cut], [true, '1.0.0', true]);
  assert.match((await approvedRelease(makeShipProject(tmp(), { approve: false }).projectDir, { runId: RUN_ID })).problem, /no approved build yet/);
  const c = makeShipProject(tmp());
  git(c.appDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'A change');
  approve(c, git(c.appDir, 'rev-parse', 'main'));
  assert.match((await approvedRelease(c.projectDir, { runId: RUN_ID })).problem, /has no release yet\. Finish it with: conductor change acme --resume$/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/factory-release.test.js`
Expected: FAIL, `Cannot find module '../src/factory/ship/release.js'`.

- [ ] **Step 3: Extend `test/helpers/shipProject.js`**

- Both shapes start like an app Plan 8's `createApp` made: commit 1 "foundation" with `package.json { name: 'highland-foundation', version: '0.1.0' }`, `foundation.json { name: 'highland-foundation', version: '0.1.0', commit: 'v0.1.0' }`, `CHANGELOG.md` = `# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-26\n- First foundation release.\n`, and **no** `v0.1.0` tag (createApp deletes the foundation tags it inherits, Contract 7 §7.11); then commit 2 "Name the app: Acme Ltd".
  - `released: false` (a fresh app as Plan 8 leaves it): `approved.sha` = commit 2.
  - `released: true` (the default, an app with a release): commit 3 "Feature work" with `package.json` name = slug and version = `version` (this is `approved.sha`), then commit 4 `release: v<version>` (its `## [<version>]` changelog section) with annotated tag `v<version>`: the release sits just after the approved build, as `releaseApp` leaves it.
- `approve(p, sha)` rewrites `project.json` with `approved.sha = sha` (Plan 7's `writeJsonAtomic`).
- `fakeNpm(dir, { mainBump })` writes a stub `npm` (`writeStubCli`) that appends its argv to `npm-calls.jsonl` and: `ci …` → exit 0; `run release -- <bump>` → in `process.cwd()`: read `package.json`, refuse with the foundation's message on stderr and exit 1 when the `## [Unreleased]` section is empty, else raise the version (`major`/`minor`/`patch`), move the Unreleased lines under `## [<v>] - 2026-10-27`, write `package.json` and `foundation.json` (version stamped, as v0.1.0 does), `git commit -qam "release: v<v>"`, `git tag -a v<v> -m v<v>`; with `mainBump` set, first runs `git -C <mainBump> commit -q --allow-empty -m moved` (identity via `-c`).

- [ ] **Step 4: Implement `src/factory/ship/release.js`** to the rules above. Every git and npm call goes through `runCommand` with argument arrays (no shell); every message kept from a tool goes through `redact`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/factory-release.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/factory/ship/release.js test/helpers/shipProject.js test/factory-release.test.js
git commit -m "feat(ship): releaseApp cuts releases with the app's own release script; ship finds or cuts the approved one

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
