// test/factory-first-ship.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeSsh } from './helpers/fakeSsh.js';
import { scriptedAsk } from './helpers/scriptedAsk.js';
import { TEST_BRIEF } from './helpers/shipProject.js';
import { runFirstSetup } from '../src/factory/ship/firstShip.js';
import { newDeployment, withStep } from '../src/factory/deployments/store.js';
import { forgetRememberedSecrets } from '../src/secrets.js';

const T = { host: 'acme-box', user: 'highland', port: null, keyPath: null, label: 'acme-office' };
const PW = 'Zq3-backup-password-from-ops-init_xyz';
const SETTINGS = { settings: [{ key: 'SMTP_URL', value: 'smtp://u:mailpass@h:587', secret: true }, { key: 'MATRIX_ACCESS_TOKEN', value: 'syt_matrix_token_1', secret: true }],
  alerts: { matrix: { homeserver: 'https://m.example.org', roomId: '!a:example.org' }, webhook: false, heartbeat: true } };
// The box claims foundation 0.1.3 (foundation v0.1.0's release script stamps the app version into foundation.json): Conductor must not believe it.
const VERSION = JSON.stringify({ version: { app: '0.1.3', foundation: '0.1.3', commit: 'abc' }, ready: { status: 'ok', checks: [] } });
const BOX_RULES = [
  { match: "\\[ ! -e \\.env \\]" },
  { match: 'docker run --rm -u', stderr: 'Setting up Acme Ltd. Do these before you start the box:\n' },
  { match: "sed -n 's/\\^BACKUP_PASSWORD=//p'", stdout: `${PW}\n` },
  { match: 'entrypoint node ops', stdout: VERSION },
  { match: 'ops check', stdout: '✓ app\n✓ app:backups\n✓ app:restore-test\n' },
  { match: 'psql', stdout: '{}' },
  { match: 'bootstrap-admin', stdout: 'Send this link: https://staff.acme.co.uk/invite/tok_one_time_123\n' },
];
const dep0 = () => newDeployment({ name: 'acme-office', project: 'acme', host: 'acme-box', ssh: { user: 'highland', port: null, keyPath: null },
  bundleDir: '/opt/highland/acme', hosting: 'client-box', imageDelivery: 'tar', registry: null, access: 'cloudflare-tunnel',
  origin: 'https://staff.acme.co.uk', site: ':80', alerts: { matrix: null, webhook: false, heartbeat: false } });

function run(f, dep, answers, extra = {}) {
  const ask = scriptedAsk(answers);
  const said = [];
  ask.say = (t) => said.push(t);
  ask.sayOnce = (t) => said.push(t);
  const saved = [];
  return runFirstSetup({ dep, brief: TEST_BRIEF, target: T, ask, version: '0.1.3', foundation: 'v0.1.0',
    images: { app: 'highland/app', ops: 'highland/ops', appRef: 'highland/app:0.1.3', opsRef: 'highland/ops:0.1.3' },
    imagesFile: 'images-0.1.3.tar', facts: { hasEnv: false, hasCompose: false }, settings: SETTINGS,
    save: (d) => { saved.push(d); return d; }, env: f.env(), now: () => '2026-10-27T10:00:00.000Z',
    opts: { startTimeoutMs: 1000, pollMs: 1, sleep: async () => {} }, ...extra })
    .then((r) => ({ ...r, said: said.join('\n'), saved, ask }));
}

test('a full first ship follows the runbook order and shows the backup password exactly once', async (t) => {
  t.after(forgetRememberedSecrets);
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), BOX_RULES);
  const r = await run(f, dep0(), ['saved', true, 'jo@acme.co.uk', 'Jo Bloggs']);
  assert.equal(r.outcome, 'installed', r.text);
  const cmds = f.calls().map((c) => c.command);
  const order = ['cp .conductor/bundle-0.1.3/compose.yaml', 'docker load -i', "[ ! -e .env ]", 'init', "BACKUP_PASSWORD=//p", 'mktemp .env.conductor', 'up -d', 'entrypoint node ops', 'ops backup', 'ops restore-test', 'ops check', 'bootstrap-admin'];
  let last = -1;
  for (const o of order) { const i = cmds.findIndex((c, k) => k > last && c.includes(o)); assert.ok(i > last, `missing or out of order: ${o}`); last = i; }
  assert.equal(r.said.split(PW).length - 1, 1);
  assert.match(r.said, /Send this link to Jo Bloggs yourself \(it works for 7 days\): https:\/\/staff\.acme\.co\.uk\/invite\/tok_one_time_123/);
  for (const c of f.calls()) for (const s of [PW, 'mailpass', 'syt_matrix_token_1']) assert.ok(!c.command.includes(s) && !c.argv.join(' ').includes(s), `secret in argv: ${c.command}`);
  assert.match(f.calls().find((c) => c.command.includes('mktemp .env.conductor')).stdin, /^APP_TAG=0\.1\.3\nCOMPOSE_PROFILES=tunnel\nTUNNEL_ENABLED=true\nSMTP_URL=smtp:\/\/u:mailpass@h:587\nMATRIX_ACCESS_TOKEN=syt_matrix_token_1\n$/);
  assert.deepEqual(r.saved.map((d) => d.setup.step), ['delivered', 'initialised', 'password-saved', 'configured', 'started', 'verified', 'done']);
  assert.equal(r.dep.currentVersion, '0.1.3');
  assert.equal(r.dep.foundation, 'v0.1.0');
  assert.deepEqual(r.dep.history.map((h) => h.outcome), ['installed']);
  for (const d of r.saved) assert.ok(!JSON.stringify(d).includes(PW));
});

test('resuming after the password was shown but not confirmed never re-runs ops init', async (t) => {
  t.after(forgetRememberedSecrets);
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), BOX_RULES);
  const r = await run(f, withStep(dep0(), 'initialised', 'x'), ['saved', false]);
  assert.equal(r.outcome, 'installed', r.text);
  assert.ok(!f.calls().some((c) => c.command.includes('docker run --rm -u')));
  assert.ok(r.said.includes(PW));
});

test('once the password is confirmed it is never read again', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), BOX_RULES);
  const r = await run(f, withStep(dep0(), 'password-saved', 'x'), [false]);
  assert.equal(r.outcome, 'installed', r.text);
  assert.ok(!f.calls().some((c) => c.command.includes('BACKUP_PASSWORD')));
});

test('a newer release arriving mid-setup reloads the images and moves APP_TAG on', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), BOX_RULES);
  const r = await run(f, { ...withStep(dep0(), 'started', 'x'), bundleVersion: '0.1.2' }, [false]);
  assert.equal(r.outcome, 'installed', r.text);
  const cmds = f.calls().map((c) => c.command);
  assert.ok(cmds.some((c) => c.includes('docker load -i')));
  assert.ok(cmds.some((c) => c.endsWith('docker compose up -d')));
  assert.equal(f.calls().find((c) => c.command.includes('mktemp .env.conductor')).stdin, 'APP_TAG=0.1.3\n');
});

test('a folder that already holds a deployment is left alone', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), BOX_RULES);
  const r = await run(f, dep0(), [], { facts: { hasEnv: true, hasCompose: true } });
  assert.equal(r.outcome, 'stopped');
  assert.match(r.text, /already holds a deployment that Conductor did not set up/);
  assert.equal(f.calls().length, 0);
});

test('an .env that appeared after delivery stops before ops init', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), [{ match: "\\[ ! -e \\.env \\]", code: 1 }, ...BOX_RULES]);
  const r = await run(f, withStep(dep0(), 'delivered', 'x'), []);
  assert.equal(r.outcome, 'stopped');
  assert.ok(!f.calls().some((c) => c.command.includes('docker run --rm -u')));
});

test('no terminal at the password step: part-way, step stays at initialised', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), BOX_RULES);
  const ask = scriptedAsk([]); ask.isTTY = false;
  const r = await run(f, withStep(dep0(), 'initialised', 'x'), [], { ask });
  assert.equal(r.outcome, 'partway');
  assert.match(r.text, /shown to you once, and there is no terminal/);
  assert.match(r.text, /conductor ship acme --to acme-office$/);
});

test('a failed start is part-way and keeps the configured step', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), [{ match: 'docker compose up -d', code: 1, stderr: 'dependency failed to start: container migrate exited (1)\n' }, ...BOX_RULES]);
  const r = await run(f, withStep(dep0(), 'password-saved', 'x'), []);
  assert.equal(r.outcome, 'partway');
  assert.match(r.text, /could not start the app \(dependency failed to start: container migrate exited \(1\)\)/);
  assert.equal(r.saved.at(-1).setup.step, 'configured');
});

test('registry delivery: the registry password goes on stdin only, and box-side commands use the bundle sign-in', async (t) => {
  t.after(forgetRememberedSecrets);
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), BOX_RULES);
  const dep = newDeployment({ ...dep0(), setup: undefined, imageDelivery: 'registry', registry: { host: 'reg.example.com:5000', namespace: 'highland-acme', user: 'robot' } });
  const images = { app: 'reg.example.com:5000/highland-acme/app', ops: 'reg.example.com:5000/highland-acme/ops',
    appRef: 'reg.example.com:5000/highland-acme/app:0.1.3', opsRef: 'reg.example.com:5000/highland-acme/ops:0.1.3' };
  const r = await run(f, dep, ['registry-pass-777', 'saved', false], { images, imagesFile: null });
  assert.equal(r.outcome, 'installed', r.text);
  const login = f.calls().find((c) => c.command.includes('login'));
  assert.match(login.command, /docker --config "\$PWD\/\.docker" login 'reg\.example\.com:5000' -u 'robot' --password-stdin$/);
  assert.equal(login.stdin, 'registry-pass-777');
  for (const c of f.calls()) assert.ok(!c.command.includes('registry-pass-777'));
  assert.ok(f.calls().some((c) => c.command.endsWith(`DOCKER_CONFIG="$PWD/.docker" docker pull 'reg.example.com:5000/highland-acme/ops:0.1.3'`)));
  assert.ok(f.calls().some((c) => c.command.includes(`DOCKER_CONFIG="$PWD/.docker" docker run --rm -u`)));
  assert.ok(f.calls().some((c) => c.command.endsWith('DOCKER_CONFIG="$PWD/.docker" docker compose up -d')));
  assert.ok(!f.calls().some((c) => c.command.includes('docker load')));
  assert.match(f.calls().find((c) => c.command.includes('mktemp .env.conductor')).stdin,
    /^APP_TAG=0\.1\.3\nAPP_IMAGE=reg\.example\.com:5000\/highland-acme\/app\nOPS_IMAGE=reg\.example\.com:5000\/highland-acme\/ops\nIMAGE_PULL_POLICY=missing\n/);
});

test('ops init gets each value shQuoted, and a client name that looks like an option is refused before the box', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), BOX_RULES);
  const r = await run(f, withStep(dep0(), 'delivered', 'x'), [], { brief: { ...TEST_BRIEF, client: '--demo' } });
  assert.equal(r.outcome, 'partway');
  assert.match(r.text, /client's name in the brief cannot be given to ops init/);
  assert.equal(f.calls().length, 0);
  const g = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), [{ match: 'docker run --rm -u', code: 1 }, ...BOX_RULES]);
  const s = await run(g, withStep(dep0(), 'delivered', 'x'), [], { brief: { ...TEST_BRIEF, client: "O'Neill & Sons $(x)" } });
  assert.equal(s.outcome, 'partway');
  assert.match(g.calls().find((c) => c.command.includes('docker run')).command,
    /'highland\/ops:0\.1\.3' 'init' '--client' 'O'\\''Neill & Sons \$\(x\)' '--origin' 'https:\/\/staff\.acme\.co\.uk' '--dir' '\/opt\/highland\/acme' '--tunnel' '--out' '\/out\/\.env'$/);
  assert.equal(s.saved.length, 0);
});

test('a failed first backup is part-way at started; an app that never reports the version is part-way too', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), [{ match: 'ops backup', code: 1, stderr: 'The backup destination could not be reached (timeout).\n' }, ...BOX_RULES]);
  const r = await run(f, withStep(dep0(), 'configured', 'x'), []);
  assert.equal(r.outcome, 'partway');
  assert.match(r.text, /^The first backup did not work: The backup destination could not be reached \(timeout\)\. RUNBOOK\.md/);
  assert.equal(r.saved.at(-1).setup.step, 'started');
  assert.equal(r.dep.currentVersion, null);
  const old = JSON.stringify({ version: { app: '0.1.2', foundation: '0.1.2', commit: 'abc' }, ready: null });
  const g = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), [{ match: 'entrypoint node ops', stdout: old }, ...BOX_RULES]);
  const s = await run(g, withStep(dep0(), 'started', 'x'), [], { opts: { startTimeoutMs: 0, pollMs: 1, sleep: async () => {} } });
  assert.equal(s.outcome, 'partway');
  assert.match(s.text, /did not report version 0\.1\.3 within 1 minute\./);
});
