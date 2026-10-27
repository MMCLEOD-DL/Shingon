# Task 6: Build on a machine and deliver

This task turns a release (found or cut by Task 13) into the two things a box needs, and puts them on the box:

1. **Build on a factory machine** (Contract 3 / Contract 7 §7.8, purpose **`'ship'`**): send the app repo as a `git bundle`, clone it at the release tag, check the commit is exactly the release commit, then run the foundation's own `npm ci`, `npm run images` and `npm run bundle`. Then either `docker save` the two images to a file, or tag and push them to the operator's registry (Ruling 3).
2. **Deliver to the box**: stream the bundle (and the images file) from the machine to the box through Conductor, check SHA-256 at both ends, and unpack a reference copy of the bundle into `<bundleDir>/.conductor/bundle-<v>/`.
3. **Clean up the build machine**: remove the `highland/app` and `highland/ops` images this build made (and the registry tags), then `machine.release()`. Contract 7 §7.8: the foundation smoke refuses to run on a machine that still holds them.

No secret is involved anywhere in this task: the registry sign-in on the build machine is the operator's one-off `docker login` there (follow-up 8).

**Files:**
- Create: `src/factory/ship/build.js`, `test/helpers/shipProject.js`
- Test: `test/factory-build-deliver.test.js`

**Interfaces:**
- Consumes: `remoteRun`, `remotePipe`, `sendFile`, `targetOfMachine`, `sshProblem` (Task 2); `shQuote`, `assertSafe` (Plan 8's `src/factory/remote.js`); `runCommand`; `writeJsonAtomic` (Plan 7); `RUN_ID_RE` (Plan 8's `src/factory/ids.js`); Contract 7 §7.8 `provider.acquire({ purpose: 'ship', projectSlug, runId }) -> Machine` (with `runDir`) and `machine.release()`.
- Produces: `imageNames`, `buildOnMachine`, `deliverToBox`, `cleanupBuild`, `Built` (index, Task 6); `Built` also carries `arch` (the build machine's `uname -m`). Test helper:

```js
// test/helpers/shipProject.js
RUN_ID = '20261027-100000-a1b2'                     // a Plan 8 run id (RUN_ID_RE)
makeShipProject(root, { slug = 'acme', version = '0.1.3', approve = true } = {})
  -> { projectsRoot: root, projectDir, appDir, sha }
// project.json (Contract 7 §7.5, written with Plan 7's writeJsonAtomic):
//   { schema: 1, slug, client: 'Acme Ltd', createdAt, status: 'ready', builtFromBrief: 1,
//     foundation: { repo: '/f', tag: 'v0.1.0', commit: '<40 hex>' },
//     approved: { sha, at, runId: RUN_ID, briefVersion: 1 } }        // approved null when !approve
// app/: a real git repo on branch main shaped like a released app: the foundation commit (tag v0.1.0),
//   "Name the app", "Feature work" (= approved.sha; package.json name = slug), then "release: v<version>"
//   with annotated tag v<version>. Task 13 adds the `released: false` shape and `approve(p, sha)`.
fakeProvider({ host = 'hf-build', user = 'hf' } = {}) -> { acquire, released: () => number, acquired: () => object[] }
//   acquire(args) records args and returns a Contract 7 §7.8 Machine:
//   { id: 'm1', host, ssh: { user, keyPath: null, knownHostsFile: null, hostKeyPolicy: 'yes' },
//     labels: { factory: 'hf', project: slug, run: runId, purpose, createdAt }, provider: 'static',
//     runDir: `/srv/hf/runs/hf-${slug}-${runId}`, composeProject: `hf-${slug}-${runId}`, previewPort: null,
//     release: async () => { released += 1; } }
TEST_BRIEF = { client: 'Acme Ltd', policy: { hosting: 'client-box', outbound: ['cloudflare-tunnel'], residency: 'uk',
  retention: { text: '6 years', days: 2190 }, backupDestination: { kind: 'client-owned', detail: "A NAS in the client's office" },
  operatorAccess: true } }                          // Plan 7's brief shapes (Contract 7 §7.4)
```

`Release` (from Task 13) is `{ sha, version, tag }`.

**`imageNames`**: tar → `{ app: 'highland/app', ops: 'highland/ops' }`; registry → `{ app: '<host>/<namespace>/app', ops: '<host>/<namespace>/ops' }`; `appRef`/`opsRef` add `:<version>`.

**`buildOnMachine({ provider, slug, runId, appDir, release, dep, say, env, buildTimeoutMs })`**:
- `runId` must match `RUN_ID_RE`, else throw (a programming error, never operator input).
- `provider.acquire({ purpose: 'ship', projectSlug: slug, runId })` throwing → `{ ok: false, problem: 'No build machine was available: <message, redacted, without its final full stop>.' }` and nothing else happens.
- `workDir = machine.runDir`, which must pass `assertSafe('path', …)`. Plan 8's `release()` removes it, so Plan 10 has no build folder of its own.
- Remote steps (each a `remoteRun` on `targetOfMachine(machine)`; any non-zero stops the build, runs `cleanupBuild`, and returns `{ ok: false, problem }` where `problem` is `The build on the build machine failed while <step> (<last non-empty output line, redacted>).`):

| step text | command |
|---|---|
| checking the build machine | `uname -m; for t in docker node npm git sha256sum; do command -v "$t" >/dev/null 2>&1 \|\| echo "missing=$t"; done` (a `missing=` line is a problem: `<tool> is missing on the build machine.`) |
| preparing a folder | `mkdir -p <workDir>` |
| sending the app | local `git -C <appDir> bundle create <tmp>/app.bundle <tag>`, then `sendFile(<tmp>/app.bundle, 'cat > <workDir>/app.bundle')` |
| unpacking the app | `cd <workDir> && git clone -q --branch <tag> app.bundle src && test "$(git -C src rev-parse HEAD)" = <sha>` |
| building the images | `cd <workDir>/src && npm ci --no-audit --no-fund && npm run images && npm run bundle` (timeout `buildTimeoutMs`) |
| saving the images (tar) | `docker save highland/app:<v> highland/ops:<v> -o <workDir>/images-<v>.tar && sha256sum <workDir>/images-<v>.tar <workDir>/src/dist/highland-bundle-<v>.tar.gz` |
| pushing the images (registry) | `docker tag highland/app:<v> <appRef> && docker tag highland/ops:<v> <opsRef> && docker push <appRef> && docker push <opsRef> && sha256sum <workDir>/src/dist/highland-bundle-<v>.tar.gz` |

Every interpolated value goes through `shQuote`.

**`deliverToBox`** (box target; `dir = dep.bundleDir`, `c = <dir>/.conductor`):
1. `mkdir -p <dir>/.conductor`; failure → `Conductor could not create <dir> on acme-office. Create it once by hand on the box: sudo mkdir -p <dir> && sudo chown highland <dir>`.
2. For the bundle (always) and the images file (tar delivery only), with `final` = `<c>/highland-bundle-<v>.tar.gz` and `<dir>/images-<v>.tar` (the updater wants the images file inside the bundle folder):
   - `sha256sum <final> 2>/dev/null` already equal to the built sum → skip (a re-run after a failure does not copy 600 MB again);
   - else `remotePipe(machine 'cat <path>' → box 'cat > <final>.part')`, then `sha256sum <final>.part`; equal → `mv <final>.part <final>`; different → `rm -f <final>.part` and `The copy of <file> to acme-office arrived damaged (its checksum did not match), so nothing was loaded. Run the ship again.`
3. `rm -rf <c>/bundle-<v> && mkdir -p <c>/bundle-<v> && tar -xzf <c>/highland-bundle-<v>.tar.gz -C <c>/bundle-<v>` and check it holds `compose.yaml`, `Caddyfile`, `.env.example`, `RUNBOOK.md` (`ls`); otherwise `The bundle for <v> is incomplete.`.
4. Returns `{ ok: true, problem: null, imagesFile: 'images-<v>.tar' | null }` (relative to the bundle folder).

**`cleanupBuild(built)`** never throws (each step in its own `try`):
1. `docker rmi highland/app:<v> highland/ops:<v>` on the build machine, plus `<appRef> <opsRef>` for registry delivery (errors ignored: an image that was never built is not a problem). These are the names the foundation's `npm run images` gives, so the foundation smoke can run on this machine afterwards (Contract 7 §7.8).
2. `machine.release()` (Plan 8 removes `runDir` and frees the machine).

- [ ] **Step 1: Write the failing tests**

```js
// test/factory-build-deliver.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeSsh } from './helpers/fakeSsh.js';
import { makeShipProject, fakeProvider, RUN_ID } from './helpers/shipProject.js';
import { imageNames, buildOnMachine, deliverToBox, cleanupBuild } from '../src/factory/ship/build.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'bld-'));
const BOX = { host: 'acme-box', user: 'highland', port: null, keyPath: null, label: 'acme-office' };
const DEP = { name: 'acme-office', bundleDir: '/opt/highland/acme', imageDelivery: 'tar', registry: null };
const SUM = 'a'.repeat(64);
const W = `/srv/hf/runs/hf-acme-${RUN_ID}`;
const BUILD_RULES = (d) => [
  { host: 'hf-build', match: '^uname -m', stdout: 'x86_64\n' },
  { host: 'hf-build', match: '^cat > .*app\\.bundle$', saveStdinTo: path.join(d, 'got.bundle') },
  { host: 'hf-build', match: '^docker save', stdout: `${SUM}  ${W}/images-0.1.3.tar\n${'b'.repeat(64)}  ${W}/src/dist/highland-bundle-0.1.3.tar.gz\n` },
];
const rel = (p) => ({ sha: execFileSync('git', ['-C', p.appDir, 'rev-parse', 'v0.1.3^{commit}'], { encoding: 'utf8' }).trim(), version: '0.1.3', tag: 'v0.1.3' });

test('imageNames keeps local-only names for tar and namespaces registry images', () => {
  assert.deepEqual(imageNames({ imageDelivery: 'tar', registry: null, slug: 'acme', version: '0.1.3' }),
    { app: 'highland/app', ops: 'highland/ops', appRef: 'highland/app:0.1.3', opsRef: 'highland/ops:0.1.3' });
  assert.equal(imageNames({ imageDelivery: 'registry', registry: { host: 'reg.example.com', namespace: 'highland-acme', user: 'u' }, slug: 'acme', version: '0.1.3' }).appRef,
    'reg.example.com/highland-acme/app:0.1.3');
});

test('buildOnMachine asks for a ship machine, sends the exact release, builds in the machine\'s run folder and saves the images', async () => {
  const d = tmp();
  const p = makeShipProject(d);
  const f = fakeSsh(d, BUILD_RULES(d));
  const prov = fakeProvider();
  const b = await buildOnMachine({ provider: prov, slug: 'acme', runId: RUN_ID, appDir: p.appDir, release: rel(p), dep: DEP, say: () => {}, env: f.env(), buildTimeoutMs: 60000 });
  assert.equal(b.ok, true, b.problem);
  assert.equal(b.arch, 'x86_64');
  assert.equal(b.workDir, W);
  assert.deepEqual(prov.acquired()[0], { purpose: 'ship', projectSlug: 'acme', runId: RUN_ID });
  execFileSync('git', ['bundle', 'verify', path.join(d, 'got.bundle')], { cwd: p.appDir });
  const cmds = f.calls().map((c) => c.command);
  assert.ok(cmds.some((c) => c.includes("git clone -q --branch 'v0.1.3' app.bundle src") && c.includes(rel(p).sha)));
  assert.ok(cmds.some((c) => c.endsWith('npm ci --no-audit --no-fund && npm run images && npm run bundle')));
  assert.deepEqual(b.imagesFile, { path: `${W}/images-0.1.3.tar`, sha256: SUM });
  assert.equal(prov.released(), 0); // the caller cleans up after delivery
});

test('a failed build removes the images, releases the machine and says which step failed', async () => {
  const d = tmp();
  const p = makeShipProject(d);
  const f = fakeSsh(d, [...BUILD_RULES(d), { host: 'hf-build', match: 'npm ci', code: 1, stdout: 'npm ERR! network request failed\n' }]);
  const prov = fakeProvider();
  const b = await buildOnMachine({ provider: prov, slug: 'acme', runId: RUN_ID, appDir: p.appDir, release: rel(p), dep: DEP, say: () => {}, env: f.env(), buildTimeoutMs: 60000 });
  assert.equal(b.ok, false);
  assert.equal(b.problem, 'The build on the build machine failed while building the images (npm ERR! network request failed).');
  assert.ok(f.calls().some((c) => c.command.startsWith("docker rmi 'highland/app:0.1.3' 'highland/ops:0.1.3'")));
  assert.equal(prov.released(), 1);
});

test('no machine: plain message, nothing else happens', async () => {
  const d = tmp();
  const p = makeShipProject(d);
  const f = fakeSsh(d, []);
  const prov = { acquire: async () => { throw new Error('Every factory machine is in use: hf-build is running a preview for bobs.'); } };
  const b = await buildOnMachine({ provider: prov, slug: 'acme', runId: RUN_ID, appDir: p.appDir, release: rel(p), dep: DEP, say: () => {}, env: f.env(), buildTimeoutMs: 60000 });
  assert.equal(b.problem, 'No build machine was available: Every factory machine is in use: hf-build is running a preview for bobs.');
  assert.equal(f.calls().length, 0);
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

test('cleanupBuild removes the release images, including registry tags, and never throws, even when the machine is gone', async () => {
  const f = fakeSsh(tmp(), [{ match: '.', code: 255 }]);
  await cleanupBuild({ machine: { release: async () => { throw new Error('gone'); } }, target: { host: 'hf-build', user: 'hf', port: null, keyPath: null, label: 'b' },
    workDir: W, version: '0.1.3', images: { appRef: 'reg.example.com/highland-acme/app:0.1.3', opsRef: 'reg.example.com/highland-acme/ops:0.1.3' } }, { env: f.env() });
  assert.equal(f.calls()[0].command,
    "docker rmi 'highland/app:0.1.3' 'highland/ops:0.1.3' 'reg.example.com/highland-acme/app:0.1.3' 'reg.example.com/highland-acme/ops:0.1.3'");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/factory-build-deliver.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `test/helpers/shipProject.js`** (real `git init -b main` with `-c user.name=t -c user.email=t@t`; `project.json` through Plan 7's `writeJsonAtomic`; `fakeProvider` as in the interface block).

- [ ] **Step 4: Implement `src/factory/ship/build.js`** to the rules above. `Built` keeps `version` so `cleanupBuild` can name the local images; when `images.appRef` already equals `highland/app:<v>` (tar delivery) the names are not repeated. The temporary local bundle file lives in `mkdtempSync(os.tmpdir())` and is removed in `finally`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/factory-build-deliver.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/factory/ship/build.js test/helpers/shipProject.js test/factory-build-deliver.test.js
git commit -m "feat(ship): build a release on a factory ship machine, deliver it with checksums, clean the images up

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
