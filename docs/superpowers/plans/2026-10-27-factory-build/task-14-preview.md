# Task 14: Demo deploy and previews

`conductor preview <slug>` (spec §4.2) shows the app running with demo data on a factory machine, on the operator's own network (index Ruling 12). `bringUpDemo` does the work on a machine and is shared with Plan 9 (council deploy tests):
1. `git archive` the chosen commit of the app into a tarball and copy it into the machine's `runDir` (`scp`);
2. run `demoUpScript` over SSH: build the app and ops images from the foundation's own Dockerfiles (tagged `runImages(slug, runId)`), copy `compose.yaml` and `Caddyfile`, make `.env` with the foundation's own `ops init --demo`, set the preview settings, add a Mailpit service, `docker compose up -d proxy mailpit` (not `ops`), wait for `/healthz`, run the demo seeder;
3. return the address and the seeder's sign-in list.

`startPreview` chooses the commit (the build in progress, if there is one, else `main`), acquires a machine, brings the demo up and records `preview.json`. A preview of the same commit that is still running is reused; a different commit replaces it. `stopPreview` releases the machine and removes the record.

**Files:**
- Create: `src/factory/deploy.js`, `src/factory/preview.js`
- Modify: `test/helpers/stubDocker.js` (also log each call as a JSON line in `<logFile>.json`; `run … init … --out /out/.env` writes a minimal `.env` into the host side of the `-v` mount; `compose … exec` prints the `seed` option; add `stubCurl(binDir, body = '{"status":"ok"}')`)
- Test: `test/factory-preview.test.js`

**Interfaces:**
- Consumes: Machine/Provider (Tasks 11, 13), `getMachineProvider`, `MachineError`, `runImages` (Task 11), `createSsh`, `unreachable` (Task 10), `assertSafe`, `shQuote`, `parseMarker` (Task 10), `newRunId` (Task 1), `latestBuild`, `lockProject` (Task 7), `projectDir`, `readProject` (Plan 7 seam), `writeJsonAtomic` (`src/factory/fsAtomic.js`), `git`, `makeFoundationRepo`, `makeProject`, `stubDockerPath` (Tasks 1, 10).
- Produces:
  - `demoUpScript({ root, project, slug, runId, client, origin, bindHost, port, version, commit }) -> string` → ends `HF-DEMO-UP` then the seeder's text; prints `HF-STEP <building|starting|seeding>` as it goes.
  - `bringUpDemo({ machine, appDir, sha, slug, runId, client, ssh, git = gitFn, tmpDir = os.tmpdir() }) -> Promise<{ url, seedText }>`
  - `startPreview({ factory, slug, deps = {} }) -> Promise<{ status: 'started'|'already', url, seedText, sha, from }>`
  - `stopPreview({ factory, slug, deps = {} }) -> Promise<{ status: 'stopped'|'none'|'gone' }>`
  - `deps` defaults: `{ provider: getMachineProvider(factory), ssh: createSsh(factory.machines), bringUpDemo, now: () => new Date() }`
  - `previewRuns(projectsRoot) -> string[]`: the run ids in every project's `preview.json` (what a sweep must spare).
  - `MAILPIT_IMAGE = 'axllent/mailpit:v1.21.8'` (MIT; the version the foundation's own smoke uses).

- [ ] **Step 1: Write the failing tests**

Create `test/factory-preview.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { demoUpScript, bringUpDemo } from '../src/factory/deploy.js';
import { startPreview, stopPreview } from '../src/factory/preview.js';
import { factoryConfig } from '../src/factory/config.js';
import { runCommand } from '../src/exec.js';
import { git } from '../src/workspace.js';
import { stubDockerPath, stubCurl } from './helpers/stubDocker.js';
import { makeFoundationRepo, makeProject } from './helpers/factoryFixtures.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const P = 'hf-acme-ltd-20261027-143005-a1b2';
const HOSTILE = "Acme'; rm -rf / #";
const SEED = 'Demo data added: 2 teams, 8 people.\nSign in with any of these (password: demo-password-1):\n  admin@demo.test (admin)';

test('demoUpScript: builds, makes .env with ops init --demo, starts proxy and mailpit only, seeds; hostile names stay quoted', async () => {
  const root = tmp('root-');
  const src = await makeFoundationRepo({ extra: { 'deploy/compose.yaml': 'name: x\n', 'deploy/Caddyfile': ':80\n', 'deploy/Dockerfile': 'FROM x\n', 'deploy/ops.Dockerfile': 'FROM x\n' } });
  mkdirSync(path.join(root, 'runs', P), { recursive: true });
  await git(src, ['archive', '--format=tar.gz', '-o', path.join(root, 'runs', P, 'source.tar.gz'), 'HEAD']);
  const { binDir, logFile } = stubDockerPath(tmp('bin-'), { seed: SEED });
  stubCurl(binDir);
  const script = demoUpScript({ root, project: P, slug: 'acme-ltd', runId: '20261027-143005-a1b2', client: HOSTILE, origin: 'http://192.168.1.111:8080', bindHost: '192.168.1.111', port: 8080, version: '0.1.0', commit: 'abc1234' });
  const r = await runCommand({ cmd: 'bash', args: ['-s'], input: script, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /HF-DEMO-UP\nDemo data added/);
  const env = readFileSync(path.join(root, 'runs', P, 'bundle', '.env'), 'utf8');
  for (const line of [`COMPOSE_PROJECT_NAME=${P}`, 'APP_TAG=20261027-143005-a1b2', 'APP_IMAGE=hf-preview/acme-ltd-app', 'OPS_IMAGE=hf-preview/acme-ltd-ops',
    'SMTP_URL=smtp://mailpit:1025', 'BACKUP_REPOSITORY=/preview-has-no-backups', 'HTTP_PORT=192.168.1.111:8080', 'HTTPS_PORT=127.0.0.1:8081']) assert.ok(env.split('\n').includes(line), line);
  assert.match(readFileSync(path.join(root, 'runs', P, 'bundle', 'compose.override.yaml'), 'utf8'), /mailpit: \{ image: axllent\/mailpit:v1\.21\.8, networks: \[backend\] \}/);
  const calls = readFileSync(`${logFile}.json`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const init = calls.find((a) => a.includes('init'));
  assert.equal(init[init.indexOf('--client') + 1], HOSTILE, 'the client name arrives as one argument');
  assert.ok(init.includes('--demo'));
  assert.ok(calls.some((a) => a.join(' ') === `compose -p ${P} up -d proxy mailpit`));
  assert.ok(calls.some((a) => a.join(' ').startsWith('build -q -f deploy/Dockerfile -t hf-preview/acme-ltd-app:20261027-143005-a1b2')));
  assert.equal(calls.some((a) => a.includes('ops') && a.includes('up')), false, 'ops is never started for a preview');
});

test('demoUpScript refuses unsafe values before writing anything', () => {
  assert.throws(() => demoUpScript({ root: '/srv/hf-factory', project: P, slug: 'acme ltd', runId: '20261027-143005-a1b2', client: 'A', origin: 'http://h:1', bindHost: '1.2.3.4', port: 1, version: '0.1.0', commit: 'abc' }), /unsafe slug/);
  assert.throws(() => demoUpScript({ root: '/srv/hf-factory', project: P, slug: 'acme-ltd', runId: '20261027-143005-a1b2', client: 'A', origin: 'http://h:1', bindHost: '1.2.3.4', port: 1, version: '0.1.0; reboot', commit: 'abc' }), /unsafe version/);
});

test('bringUpDemo: archives the exact commit, uploads it into the run folder, returns the address and sign-ins', async () => {
  const appDir = await makeFoundationRepo();
  const sha = (await git(appDir, ['rev-parse', 'HEAD'])).stdout.trim();
  const calls = [];
  const ssh = {
    exec: async (m, script) => { calls.push(['exec', script]); return { code: 0, stdout: /HF-STEP/.test(script) ? `HF-STEP seeding\nHF-DEMO-UP\n${SEED}\n` : '', stderr: '' }; },
    upload: async (m, local, remote) => { calls.push(['upload', local, remote, existsSync(local)]); return { code: 0, stdout: '', stderr: '' }; },
  };
  const machine = { host: '192.168.1.111', previewPort: 8080, runDir: `/srv/hf-factory/runs/${P}`, composeProject: P, ssh: {} };
  const out = await bringUpDemo({ machine, appDir, sha, slug: 'acme-ltd', runId: '20261027-143005-a1b2', client: 'Acme Ltd', ssh });
  assert.equal(out.url, 'http://192.168.1.111:8080/');
  assert.match(out.seedText, /admin@demo\.test/);
  const up = calls.find((c) => c[0] === 'upload');
  assert.equal(up[2], `/srv/hf-factory/runs/${P}/source.tar.gz`);
  assert.equal(up[3], true);
  assert.equal(existsSync(up[1]), false, 'the local tarball is removed afterwards');
});

test('bringUpDemo: a failed start is a plain error naming the step', async () => {
  const appDir = await makeFoundationRepo();
  const sha = (await git(appDir, ['rev-parse', 'HEAD'])).stdout.trim();
  const ssh = { exec: async (m, s) => ({ code: /HF-STEP/.test(s) ? 1 : 0, stdout: 'HF-STEP building\n', stderr: 'npm ERR! network' }), upload: async () => ({ code: 0, stdout: '', stderr: '' }) };
  await assert.rejects(bringUpDemo({ machine: { host: 'h', previewPort: 80, runDir: `/srv/x/runs/${P}`, ssh: {} }, appDir, sha, slug: 'acme-ltd', runId: '20261027-143005-a1b2', client: 'A', ssh }),
    (e) => e.code === 'failed' && /The preview did not start \(while building\): npm ERR! network/.test(e.message));
});

function fakeProvider() {
  const held = new Map();
  const released = [];
  return { held, released, kind: 'static', notes: [],
    acquire: async ({ purpose, projectSlug, runId }) => { const m = { id: 'h1', host: '192.168.1.111', previewPort: 8080, runDir: `/r/${runId}`, labels: { project: projectSlug, run: runId, purpose }, release: async () => { held.delete(runId); released.push(runId); } }; held.set(runId, m); return m; },
    list: async () => [...held.values()], sweep: async () => 0 };
}
async function previewSetup() {
  const repo = await makeFoundationRepo();
  const { projectsRoot, projectDir, slug } = makeProject();
  await git(projectDir, ['clone', '-q', repo, 'app']);
  const factory = factoryConfig({ factory: { projectsRoot } }, { env: {} });
  const provider = fakeProvider();
  const ups = [];
  const deps = { provider, ssh: {}, bringUpDemo: async (a) => { ups.push(a); return { url: 'http://192.168.1.111:8080/', seedText: SEED }; } };
  return { factory, slug, projectDir, provider, ups, deps };
}

test('start, reuse, replace on a new commit, stop', async () => {
  const s = await previewSetup();
  const a = await startPreview({ factory: s.factory, slug: s.slug, deps: s.deps });
  assert.deepEqual([a.status, a.from, a.url], ['started', 'main', 'http://192.168.1.111:8080/']);
  const rec = JSON.parse(readFileSync(path.join(s.projectDir, 'preview.json'), 'utf8'));
  assert.equal(rec.sha, a.sha);
  assert.equal((await startPreview({ factory: s.factory, slug: s.slug, deps: s.deps })).status, 'already');
  assert.equal(s.ups.length, 1);
  const appDir = path.join(s.projectDir, 'app');
  writeFileSync(path.join(appDir, 'x.txt'), 'x'); await git(appDir, ['add', '-A']); await git(appDir, ['commit', '-q', '-m', 'more']);
  const b = await startPreview({ factory: s.factory, slug: s.slug, deps: s.deps });
  assert.equal(b.status, 'started');
  assert.deepEqual(s.provider.released, [rec.runId], 'the old preview was stopped first');
  assert.equal((await stopPreview({ factory: s.factory, slug: s.slug, deps: s.deps })).status, 'stopped');
  assert.equal(existsSync(path.join(s.projectDir, 'preview.json')), false);
  assert.equal((await stopPreview({ factory: s.factory, slug: s.slug, deps: s.deps })).status, 'none');
});

test('a preview whose machine vanished is recorded as gone; a failed start releases the machine and records nothing', async () => {
  const s = await previewSetup();
  await startPreview({ factory: s.factory, slug: s.slug, deps: s.deps });
  s.provider.held.clear();
  assert.equal((await stopPreview({ factory: s.factory, slug: s.slug, deps: s.deps })).status, 'gone');
  const failing = { ...s.deps, bringUpDemo: async () => { throw Object.assign(new Error('The preview did not start (while building): x'), { code: 'failed' }); } };
  await assert.rejects(startPreview({ factory: s.factory, slug: s.slug, deps: failing }), /The preview did not start/);
  assert.equal(s.provider.held.size, 0);
  assert.equal(existsSync(path.join(s.projectDir, 'preview.json')), false);
});

test('no app yet is refused in plain words', async () => {
  const { projectsRoot, slug } = makeProject();
  await assert.rejects(startPreview({ factory: factoryConfig({ factory: { projectsRoot } }, { env: {} }), slug, deps: { provider: fakeProvider(), ssh: {}, bringUpDemo: async () => ({}) } }),
    /There is no app for acme-ltd yet\. Run "conductor build acme-ltd" first\./);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/factory-preview.test.js`
Expected: FAIL (`Cannot find module '../src/factory/deploy.js'`).

- [ ] **Step 3: Extend `test/helpers/stubDocker.js`**

As listed under Files. The `.env` the stub writes holds `CLIENT_LABEL=<client>`, `# APP_TAG=` and `INSTANCE_MODE=demo`, so `setenv` has commented and uncommented lines to work on. `stubCurl` writes a `curl` stub that prints `body` and exits 0.

- [ ] **Step 4: Implement `demoUpScript` in `src/factory/deploy.js`**

- Validation first: `root` (`path`), `project`, `slug`, `runId`, `client`, `bindHost` (`host`; must be an IPv4 address or `0.0.0.0`), `port`; `origin` must match `^http://[A-Za-z0-9.-]+(:\d+)?$`; `version` `^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$` and `commit` `^[0-9a-f]{4,40}$` (each failing as `unsafe <name> for a remote command: …`).
- The script, in order, with every value single-quoted: `set -euo pipefail`; `DIR="$ROOT/runs/$P"`; `mkdir -p "$DIR/src" "$DIR/bundle"`; `tar -xzf "$DIR/source.tar.gz" -C "$DIR/src"`; `echo HF-STEP building`; the two `docker build -q -f deploy/Dockerfile|deploy/ops.Dockerfile -t <image>:<runId> --build-arg APP_VERSION=<version> --build-arg GIT_COMMIT=<commit> .` from `$DIR/src`; `cp deploy/compose.yaml deploy/Caddyfile "$DIR/bundle/"`; `docker run --rm -u "$(id -u):$(id -g)" -v "$DIR/bundle:/out" <ops image> init --client <client> --origin <origin> --site :80 --dir "$DIR/bundle" --demo --out /out/.env`; the foundation smoke's `setenv` function (replace the line or its `# ` form, else append) for `COMPOSE_PROJECT_NAME`, `APP_IMAGE`, `OPS_IMAGE`, `APP_TAG`, `SMTP_URL=smtp://mailpit:1025`, `EMAIL_FROM=preview@example.invalid`, `BACKUP_REPOSITORY=/preview-has-no-backups`, `HTTP_PORT=<bindHost>:<port>`, `HTTPS_PORT=127.0.0.1:<port + 1>`; write `compose.override.yaml` (`services:` / `  mailpit: { image: axllent/mailpit:v1.21.8, networks: [backend] }`); `echo HF-STEP starting`; `docker compose -p "$P" up -d proxy mailpit` from `$DIR/bundle`; wait up to 300 s for `curl -fsS http://<bindHost or 127.0.0.1 when 0.0.0.0>:<port>/healthz` to contain `"ok"` (fail with `echo "the app did not answer /healthz within 5 minutes" >&2; exit 1`); `echo HF-STEP seeding`; `docker compose -p "$P" exec -T app node apps/server/dist/seed/cli.js > "$DIR/seed.txt"`; `echo HF-DEMO-UP`; `cat "$DIR/seed.txt"`.

- [ ] **Step 5: Implement `bringUpDemo`**

1. `version` from `git show <sha>:package.json`; `commit` = the first 7 characters of `sha`.
2. `git archive --format=tar.gz -o <tmpDir>/hf-src-<runId>.tar.gz <sha>` in `appDir`.
3. `ssh.exec(machine, 'set -eu; mkdir -p <quoted runDir>')`, then `ssh.upload(machine, tarball, <runDir>/source.tar.gz)`.
4. `bindHost` = `machine.host` when it is an IPv4 address, else `0.0.0.0`; `origin = http://<host>` plus `:<port>` unless the port is 80; `root` = `machine.runDir` without its `/runs/<project>` tail.
5. `ssh.exec(machine, demoUpScript(…), { timeoutMs: 45 * 60_000 })`. `unreachable` → `MachineError('unreachable', 'Conductor lost its SSH connection to <host> while starting the preview.')`; marker `HF-DEMO-UP` → `{ url: origin + '/', seedText: rest }`; otherwise `MachineError('failed', 'The preview did not start (while <last HF-STEP word>): <last non-empty stderr line, redacted, clipped to 300>.')`.
6. `finally`: remove the local tarball.

- [ ] **Step 6: Implement `src/factory/preview.js`**

- `startPreview`:
  1. `readProject(factory.projectsRoot, slug)`; `<dir>/app` must exist (else the message in the test); `lockProject(projectDir, 'preview')` for the rest.
  2. Commit: the latest build whose status is `running`, `paused`, `failed` or `stopped` and whose branch exists → its tip, `from: 'build'`; otherwise `main`'s tip, `from: 'main'`.
  3. An existing `preview.json`: same sha and its machine still in `provider.list()` (matched by `labels.run`) → `{ status: 'already', … }` from the record; same sha but no machine → drop the record; different sha → `stopPreview` first.
  4. `runId = newRunId(now())`; `provider.sweep({ olderThanMs: factory.machines.sweepAfterMs, keep: previewRuns(factory.projectsRoot) })`, ignoring its failure (one line in `provider.notes`).
  5. `machine = await provider.acquire({ purpose: 'preview', projectSlug: slug, runId })`; `bringUpDemo(…)`; on any failure `await machine.release()` (its own failure is added to the error) and rethrow.
  6. `writeJsonAtomic(<projectDir>/preview.json, { schema: 1, runId, machineId: machine.id, provider: provider.kind, host: machine.host, url, sha, from, startedAt })`; return `{ status: 'started', url, seedText, sha, from }`.
- `stopPreview`: no record → `{ status: 'none' }`; find the machine in `provider.list()` by `labels.run`; found → `release()` (a throw keeps the record and is rethrown), then remove the record → `stopped`; not found → remove the record → `gone`.
- `previewRuns`: read `<projectsRoot>/*/preview.json`, return each `runId` that matches `RUN_ID_RE`.

- [ ] **Step 7: Run the tests**

Run: `node --test test/factory-preview.test.js test/factory-remote.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/factory/deploy.js src/factory/preview.js test/helpers/stubDocker.js test/factory-preview.test.js
git commit -m "feat(factory): demo deploy on a factory machine and conductor preview"
```
