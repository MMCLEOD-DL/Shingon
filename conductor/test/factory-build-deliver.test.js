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
  { host: 'hf-build', match: "^cat > .*app\\.bundle'$", saveStdinTo: path.join(d, 'got.bundle') },
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
    { host: 'acme-box', match: "sha256sum .*\\.part'$", stdout: `${SUM}  x\n` },
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
  const f = fakeSsh(d, [{ host: 'acme-box', match: "sha256sum .*\\.part'$", stdout: `${'f'.repeat(64)}  x\n` }]);
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

test('the sent bundle clones at the release tag to exactly the release commit (the remote unpack step, run locally)', async () => {
  const d = tmp();
  const p = makeShipProject(d);
  const f = fakeSsh(d, BUILD_RULES(d));
  const b = await buildOnMachine({ provider: fakeProvider(), slug: 'acme', runId: RUN_ID, appDir: p.appDir, release: rel(p), dep: DEP, say: () => {}, env: f.env(), buildTimeoutMs: 60000 });
  assert.equal(b.ok, true, b.problem);
  execFileSync('git', ['clone', '-q', '--branch', 'v0.1.3', path.join(d, 'got.bundle'), path.join(d, 'src')]);
  assert.equal(execFileSync('git', ['-C', path.join(d, 'src'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), rel(p).sha);
});

test('registry delivery tags and pushes the namespaced images, keeps no images file, and cleans up the tags too', async () => {
  const d = tmp();
  const p = makeShipProject(d);
  const reg = { ...DEP, imageDelivery: 'registry', registry: { host: 'reg.example.com', namespace: 'highland-acme', user: 'u' } };
  const f = fakeSsh(d, [...BUILD_RULES(d).slice(0, 2),
    { host: 'hf-build', match: '^docker tag', stdout: `${SUM}  ${W}/src/dist/highland-bundle-0.1.3.tar.gz\n` }]);
  const prov = fakeProvider();
  const b = await buildOnMachine({ provider: prov, slug: 'acme', runId: RUN_ID, appDir: p.appDir, release: rel(p), dep: reg, say: () => {}, env: f.env(), buildTimeoutMs: 60000 });
  assert.equal(b.ok, true, b.problem);
  assert.equal(b.imagesFile, null);
  assert.deepEqual(b.bundleFile, { path: `${W}/src/dist/highland-bundle-0.1.3.tar.gz`, sha256: SUM });
  const push = f.calls().map((c) => c.command).find((c) => c.startsWith('docker tag'));
  assert.equal(push, "docker tag 'highland/app:0.1.3' 'reg.example.com/highland-acme/app:0.1.3' && docker tag 'highland/ops:0.1.3' 'reg.example.com/highland-acme/ops:0.1.3'"
    + " && docker push 'reg.example.com/highland-acme/app:0.1.3' && docker push 'reg.example.com/highland-acme/ops:0.1.3'"
    + ` && sha256sum '${W}/src/dist/highland-bundle-0.1.3.tar.gz'`);
  assert.ok(!f.calls().some((c) => c.command.includes('docker save')));
  await cleanupBuild(b, { env: f.env() });
  assert.ok(f.calls().some((c) => c.command.endsWith("'reg.example.com/highland-acme/app:0.1.3' 'reg.example.com/highland-acme/ops:0.1.3'")));
  assert.equal(prov.released(), 1);
});

test('a missing tool on the build machine stops before anything is sent, and the machine is released', async () => {
  const d = tmp();
  const p = makeShipProject(d);
  const f = fakeSsh(d, [{ host: 'hf-build', match: '^uname -m', stdout: 'aarch64\nmissing=docker\n' }]);
  const prov = fakeProvider();
  const b = await buildOnMachine({ provider: prov, slug: 'acme', runId: RUN_ID, appDir: p.appDir, release: rel(p), dep: DEP, say: () => {}, env: f.env(), buildTimeoutMs: 60000 });
  assert.deepEqual(b, { ok: false, problem: 'docker is missing on the build machine.' });
  assert.ok(!f.calls().some((c) => c.command.startsWith('cat >')));
  assert.equal(prov.released(), 1);
});

test('an invalid run id is a programming error: it throws before any machine is asked for', async () => {
  const prov = fakeProvider();
  await assert.rejects(buildOnMachine({ provider: prov, slug: 'acme', runId: 'nope', appDir: '/x', release: { sha: 'a'.repeat(40), version: '0.1.3', tag: 'v0.1.3' }, dep: DEP }),
    /not a valid run id/);
  assert.equal(prov.acquired().length, 0);
});

test('a file already on the box with the right checksum is not copied again', async () => {
  const d = tmp();
  const f = fakeSsh(d, [
    { host: 'acme-box', match: "sha256sum '[^']*' 2>/dev/null$", stdout: `${SUM}  x\n` },
    { host: 'acme-box', match: 'ls ', stdout: 'Caddyfile\nRUNBOOK.md\ncompose.yaml\n.env.example\n' },
  ]);
  const built = { machine: {}, target: { host: 'hf-build', user: 'hf', port: null, keyPath: null, label: 'b' }, workDir: '/w',
    imagesFile: { path: '/w/images-0.1.3.tar', sha256: SUM }, bundleFile: { path: '/w/b.tgz', sha256: SUM } };
  const r = await deliverToBox({ built, target: BOX, dep: DEP, version: '0.1.3', say: () => {}, env: f.env() });
  assert.equal(r.ok, true, r.problem);
  assert.ok(!f.calls().some((c) => c.host === 'hf-build'));
  assert.ok(!f.calls().some((c) => c.command.includes('.part')));
});

test('a bundle without its runbook is incomplete', async () => {
  const d = tmp();
  const f = fakeSsh(d, [
    { host: 'acme-box', match: "sha256sum .*\\.part'$", stdout: `${SUM}  x\n` },
    { host: 'acme-box', match: "^ls -A '/opt/highland/acme/\\.conductor/bundle-0\\.1\\.3'$", stdout: 'Caddyfile\ncompose.yaml\n.env.example\n' },
  ]);
  const built = { machine: {}, target: { host: 'hf-build', user: 'hf', port: null, keyPath: null, label: 'b' }, workDir: '/w',
    imagesFile: null, bundleFile: { path: '/w/b.tgz', sha256: SUM } };
  const r = await deliverToBox({ built, target: BOX, dep: { ...DEP, imageDelivery: 'registry' }, version: '0.1.3', say: () => {}, env: f.env() });
  assert.deepEqual(r, { ok: false, problem: 'The bundle for 0.1.3 is incomplete.', imagesFile: null });
});

test('a registry host with a port (reg.lan:5000) is accepted, pushed to and cleaned up', async () => {
  assert.equal(imageNames({ imageDelivery: 'registry', registry: { host: 'reg.lan:5000', namespace: 'highland-acme', user: 'u' }, slug: 'acme', version: '0.1.3' }).opsRef,
    'reg.lan:5000/highland-acme/ops:0.1.3');
  assert.throws(() => imageNames({ imageDelivery: 'registry', registry: { host: "reg.lan:5000'x", namespace: 'n', user: 'u' }, slug: 'acme', version: '0.1.3' }));
  assert.throws(() => imageNames({ imageDelivery: 'registry', registry: { host: '-reg', namespace: 'n', user: 'u' }, slug: 'acme', version: '0.1.3' }));
  const d = tmp();
  const p = makeShipProject(d);
  const reg = { ...DEP, imageDelivery: 'registry', registry: { host: 'reg.lan:5000', namespace: 'highland-acme', user: 'u' } };
  const f = fakeSsh(d, [...BUILD_RULES(d).slice(0, 2),
    { host: 'hf-build', match: '^docker tag', stdout: `${SUM}  ${W}/src/dist/highland-bundle-0.1.3.tar.gz\n` }]);
  const prov = fakeProvider();
  const b = await buildOnMachine({ provider: prov, slug: 'acme', runId: RUN_ID, appDir: p.appDir, release: rel(p), dep: reg, say: () => {}, env: f.env(), buildTimeoutMs: 60000 });
  assert.equal(b.ok, true, b.problem);
  assert.ok(f.calls().some((c) => c.command.includes("docker push 'reg.lan:5000/highland-acme/app:0.1.3'")));
  await cleanupBuild(b, { env: f.env() });
  assert.ok(f.calls().some((c) => c.command === "docker rmi 'highland/app:0.1.3' 'highland/ops:0.1.3' 'reg.lan:5000/highland-acme/app:0.1.3' 'reg.lan:5000/highland-acme/ops:0.1.3'"));
});

test('an unexpected throw after the machine is acquired still cleans up and releases it', async () => {
  const d = tmp();
  const p = makeShipProject(d);
  const f = fakeSsh(d, BUILD_RULES(d));
  const prov = fakeProvider();
  const b = await buildOnMachine({ provider: prov, slug: 'acme', runId: RUN_ID, appDir: p.appDir, release: rel(p), dep: DEP,
    say: () => { throw new Error('boom'); }, env: f.env(), buildTimeoutMs: 60000 });
  assert.equal(b.ok, false);
  assert.match(b.problem, /boom/);
  assert.equal(prov.released(), 1);
  assert.ok(f.calls().some((c) => c.command.startsWith("docker rmi 'highland/app:0.1.3'")));
});

test('the mkdir-failure message names the box\'s real ssh user', async () => {
  const f = fakeSsh(tmp(), [{ host: 'acme-box', match: '^mkdir', code: 1, stderr: 'Permission denied\n' }]);
  const built = { machine: {}, target: { host: 'hf-build', user: 'hf', port: null, keyPath: null, label: 'b' }, workDir: '/w', imagesFile: null, bundleFile: { path: '/w/b.tgz', sha256: SUM } };
  const r = await deliverToBox({ built, target: { ...BOX, user: 'ops' }, dep: DEP, version: '0.1.3', say: () => {}, env: f.env() });
  assert.equal(r.problem, 'Conductor could not create /opt/highland/acme on acme-office. Create it once by hand on the box: sudo mkdir -p /opt/highland/acme && sudo chown ops /opt/highland/acme');
});

test('a failing checksum command on the box is reported as a command failure, not a damaged copy, and nothing is loaded', async () => {
  const f = fakeSsh(tmp(), [{ host: 'acme-box', match: "sha256sum .*\\.part'$", code: 1, stderr: 'sha256sum: No such file\n' }]);
  const built = { machine: {}, target: { host: 'hf-build', user: 'hf', port: null, keyPath: null, label: 'b' }, workDir: '/w', imagesFile: null, bundleFile: { path: '/w/b.tgz', sha256: SUM } };
  const r = await deliverToBox({ built, target: BOX, dep: { ...DEP, imageDelivery: 'registry' }, version: '0.1.3', say: () => {}, env: f.env() });
  assert.equal(r.ok, false);
  assert.equal(r.problem, 'A command on acme-office failed (code 1): sha256sum: No such file.');
  assert.ok(!f.calls().some((c) => c.command.startsWith('mv ')));
});
