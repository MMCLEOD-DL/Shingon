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
import { stubDockerPath, stubCurl, stubHostname } from './helpers/stubDocker.js';
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
    'SMTP_URL=smtp://mailpit:1025', 'INSTANCE_MODE=demo', 'BACKUP_REPOSITORY=/preview-has-no-backups', 'HTTP_PORT=192.168.1.111:8080', 'HTTPS_PORT=127.0.0.1:8081']) assert.ok(env.split('\n').includes(line), line);
  assert.match(readFileSync(path.join(root, 'runs', P, 'bundle', 'compose.override.yaml'), 'utf8'), /mailpit: \{ image: axllent\/mailpit:v1\.21\.8, networks: \[backend\] \}/);
  const calls = readFileSync(`${logFile}.json`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const init = calls.find((a) => a.includes('init'));
  assert.equal(init[init.indexOf('--client') + 1], HOSTILE, 'the client name arrives as one argument');
  assert.ok(init.includes('--demo'));
  assert.ok(calls.some((a) => a.join(' ') === `compose -p ${P} up -d proxy mailpit`));
  assert.ok(calls.some((a) => a.join(' ').startsWith('build -q -f deploy/Dockerfile -t hf-preview/acme-ltd-app:20261027-143005-a1b2')));
  assert.equal(calls.some((a) => a.includes('ops') && a.includes('up')), false, 'ops is never started for a preview');
  assert.equal(env.split('\n').filter((l) => l.startsWith('INSTANCE_MODE')).length, 1);
});

// Runs demoUpScript locally under bash -s (the script arrives on stdin, as over ssh) with stub docker, curl and hostname.
async function runDemoUp(over = {}, { addresses } = {}) {
  const root = tmp('root-');
  const src = await makeFoundationRepo({ extra: { 'deploy/compose.yaml': 'name: x\n', 'deploy/Caddyfile': ':80\n', 'deploy/Dockerfile': 'FROM x\n', 'deploy/ops.Dockerfile': 'FROM x\n' } });
  mkdirSync(path.join(root, 'runs', P), { recursive: true });
  await git(src, ['archive', '--format=tar.gz', '-o', path.join(root, 'runs', P, 'source.tar.gz'), 'HEAD']);
  const { binDir, logFile } = stubDockerPath(tmp('bin-'), { seed: SEED });
  stubCurl(binDir);
  if (addresses !== undefined) stubHostname(binDir, addresses);
  const script = demoUpScript({ root, project: P, slug: 'acme-ltd', runId: '20261027-143005-a1b2', client: 'Acme Ltd', origin: 'http://hf-build.lan:8080', bindHost: '192.168.1.111', port: 8080, version: '0.1.0', commit: 'abc1234', ...over });
  const r = await runCommand({ cmd: 'bash', args: ['-s'], input: script, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } });
  const envFile = path.join(root, 'runs', P, 'bundle', '.env');
  return { r, env: existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n') : [], logFile };
}

test('demoUpScript: commands that read stdin cannot swallow the rest of the script', async () => {
  const { r } = await runDemoUp();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /HF-STEP seeding\nHF-DEMO-UP\nDemo data added/);
});

test('demoUpScript: with no IPv4 host, binds to the box\'s own private address, never 0.0.0.0', async () => {
  const { r, env } = await runDemoUp({ bindHost: null }, { addresses: 'fd00::5 192.168.1.50 172.17.0.1' });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(env.includes('HTTP_PORT=192.168.1.50:8080'), env.join('|'));
  assert.throws(() => demoUpScript({ root: '/srv/hf-factory', project: P, slug: 'acme-ltd', runId: '20261027-143005-a1b2', client: 'A', origin: 'http://h:1', bindHost: '0.0.0.0', port: 1, version: '0.1.0', commit: 'abc' }), /unsafe bindHost/);
});

test('demoUpScript: refuses plainly when the box has no private address', async () => {
  const { r, logFile } = await runDemoUp({ bindHost: null }, { addresses: '8.8.8.8 fe80::1' });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no private network address/);
  assert.equal(existsSync(logFile), false, 'nothing was built');
});

test('a 120-character client name is accepted and stays one argument', async () => {
  const long = `Acme '${'x'.repeat(114)}`;
  assert.equal(long.length, 120);
  const { r, logFile } = await runDemoUp({ client: long });
  assert.equal(r.code, 0, r.stderr);
  const init = readFileSync(`${logFile}.json`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((a) => a.includes('init'));
  assert.equal(init[init.indexOf('--client') + 1], long);
  assert.throws(() => demoUpScript({ root: '/srv/hf-factory', project: P, slug: 'acme-ltd', runId: '20261027-143005-a1b2', client: 'x'.repeat(121), origin: 'http://h:1', bindHost: '1.2.3.4', port: 1, version: '0.1.0', commit: 'abc' }), /unsafe client/);
});

test('bringUpDemo: a host name (not IPv4) makes the script find the private address on the box', async () => {
  const appDir = await makeFoundationRepo();
  const sha = (await git(appDir, ['rev-parse', 'HEAD'])).stdout.trim();
  let script = '';
  const ssh = { exec: async (m, s) => { if (/HF-STEP/.test(s)) script = s; return { code: 0, stdout: /HF-STEP/.test(s) ? `HF-DEMO-UP\n${SEED}\n` : '', stderr: '' }; }, upload: async () => ({ code: 0, stdout: '', stderr: '' }) };
  const out = await bringUpDemo({ machine: { host: 'hf-build.lan', previewPort: 8080, runDir: `/srv/x/runs/${P}`, ssh: {} }, appDir, sha, slug: 'acme-ltd', runId: '20261027-143005-a1b2', client: 'A', ssh });
  assert.equal(out.url, 'http://hf-build.lan:8080/');
  assert.match(script, /hostname -I/);
  assert.doesNotMatch(script, /0\.0\.0\.0/);
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

test('a failure writing preview.json after bring-up releases the machine', async () => {
  const s = await previewSetup();
  const blocking = { ...s.deps, bringUpDemo: async () => { mkdirSync(path.join(s.projectDir, 'preview.json')); return { url: 'http://192.168.1.111:8080/', seedText: SEED }; } };
  await assert.rejects(startPreview({ factory: s.factory, slug: s.slug, deps: blocking }));
  assert.equal(s.provider.held.size, 0);
  assert.equal(s.provider.released.length, 1);
});

test('no app yet is refused in plain words', async () => {
  const { projectsRoot, slug } = makeProject();
  await assert.rejects(startPreview({ factory: factoryConfig({ factory: { projectsRoot } }, { env: {} }), slug, deps: { provider: fakeProvider(), ssh: {}, bringUpDemo: async () => ({}) } }),
    /There is no app for acme-ltd yet\. Run "conductor build acme-ltd" first\./);
});

test('the build in progress is previewed when its branch exists; previewRuns lists recorded runs', async () => {
  const { previewRuns } = await import('../src/factory/preview.js');
  const s = await previewSetup();
  const appDir = path.join(s.projectDir, 'app');
  await git(appDir, ['checkout', '-q', '-b', 'build/20261027-100000-aaaa']);
  writeFileSync(path.join(appDir, 'y.txt'), 'y'); await git(appDir, ['add', '-A']); await git(appDir, ['commit', '-q', '-m', 'feature']);
  const tip = (await git(appDir, ['rev-parse', 'HEAD'])).stdout.trim();
  mkdirSync(path.join(s.projectDir, 'builds', '20261027-100000-aaaa'), { recursive: true });
  writeFileSync(path.join(s.projectDir, 'builds', '20261027-100000-aaaa', 'build.json'), JSON.stringify({ schema: 1, kind: 'build', status: 'paused', branch: 'build/20261027-100000-aaaa' }));
  const r = await startPreview({ factory: s.factory, slug: s.slug, deps: s.deps });
  assert.deepEqual([r.from, r.sha], ['build', tip]);
  const rec = JSON.parse(readFileSync(path.join(s.projectDir, 'preview.json'), 'utf8'));
  assert.deepEqual(previewRuns(s.factory.projectsRoot), [rec.runId]);
  assert.equal(s.ups[0].client, 'Acme Ltd');
});
