# Task 6: Build on a machine and deliver

This task turns an approved release into the two things a box needs, and puts them on the box:

1. **Find the approved release** in the project's app repo (Ruling 1).
2. **Build on a factory machine** (Contract 3, purpose `'smoke'`): send the repo as a `git bundle`, clone it at the release tag, check the commit is exactly the approved one, then run the foundation's own `npm ci`, `npm run images` and `npm run bundle`. Then either `docker save` the two images to a file, or tag and push them to the operator's registry (Ruling 3).
3. **Deliver to the box**: stream the bundle (and the images file) from the machine to the box through Conductor, check SHA-256 at both ends, and unpack a reference copy of the bundle into `<bundleDir>/.conductor/bundle-<v>/`.

No secret is involved anywhere in this task: the registry sign-in on the build machine is the operator's one-off `docker login` there (follow-up 8).

**Files:**
- Create: `src/factory/ship/release.js`, `test/helpers/shipProject.js`
- Test: `test/factory-release.test.js`

**Interfaces:**
- Consumes: `remoteRun`, `remotePipe`, `sendFile`, `shq`, `targetOfMachine`, `sshProblem` (Task 2); `isVersion`, `compareVersions` (Task 4); `runCommand`; Contract 3 `provider.acquire({ purpose, projectSlug, runId }) -> Machine` and `machine.release()`.
- Produces: `approvedRelease`, `imageNames`, `buildOnMachine`, `deliverToBox`, `cleanupBuild`, `Built` (index, Task 6); `Built` also carries `arch` (the build machine's `uname -m`). Test helper:

```js
// test/helpers/shipProject.js
makeShipProject(root, { slug = 'acme', version = '0.1.3', approve = true, tag = true } = {})
  -> { projectsRoot: root, projectDir, appDir, sha }
// project.json { schema: 1, slug, client: 'Acme Ltd', createdAt, foundation: { repo: '/f', tag: 'v0.1.0' }, status: 'ready', approved: { sha, at } }
// app/: a real git repo with package.json { name, version } and foundation.json, one commit, tag v<version> when `tag`
fakeProvider({ host = 'hf-build', user = 'hf' } = {}) -> { acquire, released: () => number, acquired: () => object[] }
TEST_BRIEF = { client: 'Acme Ltd', policy: { hosting: 'client-box', outbound: ['Cloudflare tunnel'], residency: 'uk',
  retention: { text: '6 years', days: 2190 }, backupDestination: 'client-owned storage', operatorAccess: true } }
```

**`approvedRelease(projectDir)`** problems, in order:
- no `project.json.approved.sha` (40 hex) → `This project has no approved build yet. Build it and approve it first (conductor build acme).`
- the commit is not in `app/` → `The approved build (abc1234) is not in the project's app repository.`
- no `v<x.y.z>` tag points at it (`git tag --points-at <sha> --list v*`, highest by `compareVersions`) → `The approved build (abc1234) has no release number yet, so it cannot be shipped. A release is made when a build or change is approved.`
- `package.json` version at the commit ≠ tag → `The release tag v0.1.3 does not match the version in package.json (0.1.2) at the approved build.`
- no `foundation.json` at the commit → `The approved build has no foundation.json, so Conductor cannot tell which foundation it is built on.`

**`imageNames`**: tar → `{ app: 'highland/app', ops: 'highland/ops' }`; registry → `{ app: '<host>/<namespace>/app', ops: '<host>/<namespace>/ops' }`; `appRef`/`opsRef` add `:<version>`.

**`buildOnMachine` remote steps** (each a `remoteRun` on the machine target, label `the build machine (<host>)`; any non-zero stops the build, cleans up, and returns `{ ok: false, problem }` where `problem` is `The build on the build machine failed while <step> (<last non-empty output line, redacted>).`):

| step text | command |
|---|---|
| checking the build machine | `uname -m; for t in docker node npm git sha256sum; do command -v "$t" >/dev/null 2>&1 \|\| echo "missing=$t"; done; printf 'home=%s\n' "$HOME"` (a `missing=` line is a problem: `<tool> is missing on the build machine.`) |
| preparing a folder | `mkdir -p <workDir>` where `workDir = <home>/hf-ship/<slug>-<runId>` |
| sending the app | local `git -C <appDir> bundle create <tmp>/app.bundle <tag>`, then `sendFile(<tmp>/app.bundle, 'cat > <workDir>/app.bundle')` |
| unpacking the app | `cd <workDir> && git clone -q --branch <tag> app.bundle src && test "$(git -C src rev-parse HEAD)" = <sha>` |
| building the images | `cd <workDir>/src && npm ci --no-audit --no-fund && npm run images && npm run bundle` (timeout `buildTimeoutMs`) |
| saving the images (tar) | `docker save highland/app:<v> highland/ops:<v> -o <workDir>/images-<v>.tar && sha256sum <workDir>/images-<v>.tar <workDir>/src/dist/highland-bundle-<v>.tar.gz` |
| pushing the images (registry) | `docker tag highland/app:<v> <appRef> && docker tag highland/ops:<v> <opsRef> && docker push <appRef> && docker push <opsRef> && sha256sum <workDir>/src/dist/highland-bundle-<v>.tar.gz` |

`provider.acquire` throwing → `{ ok: false, problem: 'No build machine was available: <message, redacted>.' }` and nothing else happens.

**`deliverToBox`** (box target; `dir = dep.bundleDir`, `c = <dir>/.conductor`):
1. `mkdir -p <dir>/.conductor`; failure → `Conductor could not create <dir> on acme-office. Create it once by hand on the box: sudo mkdir -p <dir> && sudo chown highland <dir>`.
2. For the bundle (always) and the images file (tar delivery only), with `final` = `<c>/highland-bundle-<v>.tar.gz` and `<dir>/images-<v>.tar` (the updater wants the images file inside the bundle folder):
   - `sha256sum <final> 2>/dev/null` already equal to the built sum → skip (a re-run after a failure does not copy 600 MB again);
   - else `remotePipe(machine 'cat <path>' → box 'cat > <final>.part')`, then `sha256sum <final>.part`; equal → `mv <final>.part <final>`; different → `rm -f <final>.part` and `The copy of <file> to acme-office arrived damaged (its checksum did not match), so nothing was loaded. Run the ship again.`
3. `rm -rf <c>/bundle-<v> && mkdir -p <c>/bundle-<v> && tar -xzf <c>/highland-bundle-<v>.tar.gz -C <c>/bundle-<v>` and check it holds `compose.yaml`, `Caddyfile`, `.env.example`, `RUNBOOK.md` (`ls`); otherwise `The bundle for <v> is incomplete.`.
4. Returns `{ ok: true, problem: null, imagesFile: 'images-<v>.tar' | null }` (relative to the bundle folder).

**`cleanupBuild(built)`**: `rm -rf <workDir>` only when `workDir` ends with `/hf-ship/<slug>-<runId>`; `docker rmi` of the built refs (errors ignored); then `machine.release()`. Never throws (each step in its own try).

- [ ] **Step 1: Write the failing tests**

```js
// test/factory-release.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeSsh } from './helpers/fakeSsh.js';
import { makeShipProject, fakeProvider } from './helpers/shipProject.js';
import { approvedRelease, imageNames, buildOnMachine, deliverToBox, cleanupBuild } from '../src/factory/ship/release.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'rel-'));
const BOX = { host: 'acme-box', user: 'highland', port: null, keyPath: null, label: 'acme-office' };
const DEP = { name: 'acme-office', bundleDir: '/opt/highland/acme', imageDelivery: 'tar', registry: null };
const SUM = 'a'.repeat(64);
const BUILD_RULES = (d) => [
  { host: 'hf-build', match: '^uname -m', stdout: 'x86_64\nhome=/home/hf\n' },
  { host: 'hf-build', match: '^cat > .*app\\.bundle$', saveStdinTo: path.join(d, 'got.bundle') },
  { host: 'hf-build', match: '^docker save', stdout: `${SUM}  /home/hf/hf-ship/acme-r1/images-0.1.3.tar\n${'b'.repeat(64)}  /home/hf/hf-ship/acme-r1/src/dist/highland-bundle-0.1.3.tar.gz\n` },
];

test('approvedRelease finds the release tag on the approved commit', async () => {
  const p = makeShipProject(tmp());
  assert.deepEqual(await approvedRelease(p.projectDir), { ok: true, sha: p.sha, version: '0.1.3', tag: 'v0.1.3' });
});

test('approvedRelease refuses plainly without approval or without a release tag', async () => {
  assert.match((await approvedRelease(makeShipProject(tmp(), { approve: false }).projectDir)).problem, /no approved build yet/);
  assert.match((await approvedRelease(makeShipProject(tmp(), { tag: false }).projectDir)).problem, /has no release number yet, so it cannot be shipped/);
});

test('imageNames keeps local-only names for tar and namespaces registry images', () => {
  assert.deepEqual(imageNames({ imageDelivery: 'tar', registry: null, slug: 'acme', version: '0.1.3' }),
    { app: 'highland/app', ops: 'highland/ops', appRef: 'highland/app:0.1.3', opsRef: 'highland/ops:0.1.3' });
  assert.equal(imageNames({ imageDelivery: 'registry', registry: { host: 'reg.example.com', namespace: 'highland-acme', user: 'u' }, slug: 'acme', version: '0.1.3' }).appRef,
    'reg.example.com/highland-acme/app:0.1.3');
});

test('buildOnMachine sends the exact release, builds with the foundation scripts and saves the images', async () => {
  const d = tmp();
  const p = makeShipProject(d);
  const f = fakeSsh(d, BUILD_RULES(d));
  const prov = fakeProvider();
  const rel = await approvedRelease(p.projectDir);
  const b = await buildOnMachine({ provider: prov, slug: 'acme', runId: 'r1', appDir: p.appDir, release: rel, dep: DEP, say: () => {}, env: f.env() });
  assert.equal(b.ok, true, b.problem);
  assert.equal(b.arch, 'x86_64');
  assert.deepEqual(prov.acquired()[0], { purpose: 'smoke', projectSlug: 'acme', runId: 'r1' });
  execFileSync('git', ['bundle', 'verify', path.join(d, 'got.bundle')], { cwd: p.appDir });
  const cmds = f.calls().map((c) => c.command);
  assert.ok(cmds.some((c) => c.includes("git clone -q --branch 'v0.1.3' app.bundle src") && c.includes(p.sha)));
  assert.ok(cmds.some((c) => c.endsWith('npm ci --no-audit --no-fund && npm run images && npm run bundle')));
  assert.deepEqual(b.imagesFile, { path: '/home/hf/hf-ship/acme-r1/images-0.1.3.tar', sha256: SUM });
  assert.equal(prov.released(), 0); // the caller cleans up after delivery
});

test('a failed build cleans up and says which step failed', async () => {
  const d = tmp();
  const p = makeShipProject(d);
  const f = fakeSsh(d, [...BUILD_RULES(d), { host: 'hf-build', match: 'npm ci', code: 1, stdout: 'npm ERR! network request failed\n' }]);
  const prov = fakeProvider();
  const b = await buildOnMachine({ provider: prov, slug: 'acme', runId: 'r1', appDir: p.appDir, release: await approvedRelease(p.projectDir), dep: DEP, say: () => {}, env: f.env() });
  assert.equal(b.ok, false);
  assert.equal(b.problem, 'The build on the build machine failed while building the images (npm ERR! network request failed).');
  assert.ok(f.calls().some((c) => c.command.startsWith("rm -rf '/home/hf/hf-ship/acme-r1'")));
  assert.equal(prov.released(), 1);
});

test('deliverToBox copies, checks the checksum and unpacks the reference bundle', async () => {
  const d = tmp();
  const f = fakeSsh(d, [
    { host: 'acme-box', match: 'sha256sum .*\\.part$', stdout: `${SUM}  x\n` },
    { host: 'acme-box', match: 'ls ', stdout: 'Caddyfile\nRUNBOOK.md\ncompose.yaml\n.env.example\n' },
  ]);
  const built = { machine: {}, target: { host: 'hf-build', user: 'hf', port: null, keyPath: null, label: 'the build machine' }, workDir: '/w',
    imagesFile: { path: '/w/images-0.1.3.tar', sha256: SUM }, bundleFile: { path: '/w/src/dist/highland-bundle-0.1.3.tar.gz', sha256: SUM } };
  const r = await deliverToBox({ built, target: BOX, dep: DEP, version: '0.1.3', say: () => {}, env: f.env() });
  assert.deepEqual(r, { ok: true, problem: null, imagesFile: 'images-0.1.3.tar' });
  const box = f.calls().filter((c) => c.host === 'acme-box').map((c) => c.command);
  assert.ok(box.some((c) => c.includes("mv '/opt/highland/acme/images-0.1.3.tar.part' '/opt/highland/acme/images-0.1.3.tar'")));
  assert.ok(box.some((c) => c.includes("tar -xzf '/opt/highland/acme/.conductor/highland-bundle-0.1.3.tar.gz' -C '/opt/highland/acme/.conductor/bundle-0.1.3'")));
});

test('a damaged copy is removed and nothing is loaded', async () => {
  const d = tmp();
  const f = fakeSsh(d, [{ host: 'acme-box', match: 'sha256sum .*\\.part$', stdout: `${'f'.repeat(64)}  x\n` }]);
  const built = { machine: {}, target: { host: 'hf-build', user: 'hf', port: null, keyPath: null, label: 'b' }, workDir: '/w',
    imagesFile: null, bundleFile: { path: '/w/b.tgz', sha256: SUM } };
  const r = await deliverToBox({ built, target: BOX, dep: { ...DEP, imageDelivery: 'registry' }, version: '0.1.3', say: () => {}, env: f.env() });
  assert.equal(r.ok, false);
  assert.match(r.problem, /arrived damaged \(its checksum did not match\), so nothing was loaded/);
  assert.ok(f.calls().some((c) => /^rm -f '.*\.part'$/.test(c.command)));
});

test('cleanupBuild never throws, even when the machine is gone', async () => {
  const f = fakeSsh(tmp(), [{ match: '.', code: 255 }]);
  await cleanupBuild({ machine: { release: async () => { throw new Error('gone'); } }, target: { host: 'hf-build', user: 'hf', port: null, keyPath: null, label: 'b' },
    workDir: '/home/hf/hf-ship/acme-r1', slug: 'acme', runId: 'r1', images: { appRef: 'highland/app:0.1.3', opsRef: 'highland/ops:0.1.3' } }, { env: f.env() });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/factory-release.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `test/helpers/shipProject.js`** (real `git init` with `-c user.name=t -c user.email=t@t`; `fakeProvider().acquire(args)` records `args` and returns `{ id: 'm1', host, ssh: { user, keyPath: null }, labels: {}, release: async () => { released += 1; } }`).

- [ ] **Step 4: Implement `src/factory/ship/release.js`** to the rules above. `Built` keeps `slug` and `runId` so `cleanupBuild` can check the folder name. The temporary local bundle file lives in `mkdtempSync(os.tmpdir())` and is removed in `finally`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/factory-release.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/factory/ship/release.js test/helpers/shipProject.js test/factory-release.test.js
git commit -m "feat(ship): build the approved release on a factory machine and deliver it with checksums"
```
