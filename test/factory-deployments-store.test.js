// test/factory-deployments-store.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SETUP_STEPS, OUTCOMES, newDeployment, validateDeployment, saveDeployment, loadDeployment,
  listDeployments, addHistory, withStep, lockDeployment, deploymentPath, DeploymentError,
} from '../src/factory/deployments/store.js';
import { rememberSecret, forgetRememberedSecrets } from '../src/secrets.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'deps-'));
export const BASE = {
  name: 'acme-office', project: 'acme', host: 'acme-box', ssh: { user: 'highland', port: null, keyPath: null },
  bundleDir: '/opt/highland/acme', hosting: 'client-box', imageDelivery: 'tar', registry: null,
  access: 'cloudflare-tunnel', origin: 'https://staff.acme.co.uk', site: ':80',
  alerts: { matrix: { homeserver: 'https://matrix.example.org', roomId: '!a:example.org' }, webhook: false, heartbeat: true },
};

test('a new deployment is valid, starts at step "new", and has no version or history', () => {
  const d = newDeployment(BASE);
  assert.deepEqual(validateDeployment(d), { ok: true, problems: [] });
  assert.equal(d.schema, 1);
  assert.equal(d.setup.step, 'new');
  assert.equal(d.currentVersion, null);
  assert.deepEqual(d.history, []);
  assert.equal(SETUP_STEPS.at(-1), 'done');
  assert.ok(OUTCOMES.includes('rolled-back') && OUTCOMES.includes('lost-contact'));
});

test('validation explains each bad field in plain words', () => {
  const r = validateDeployment({ ...newDeployment(BASE), host: '-oProxyCommand=x', bundleDir: '/opt/../etc', site: 'staff.acme.co.uk', imageDelivery: 'registry' });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /host/.test(p)));
  assert.ok(r.problems.some((p) => /bundle folder/.test(p)));
  assert.ok(r.problems.some((p) => /:80/.test(p)));
  assert.ok(r.problems.some((p) => /registry/.test(p)));
  assert.ok(validateDeployment({ ...newDeployment(BASE), foundation: '0.1.0' }).problems.some((p) => /foundation/.test(p)));
  assert.equal(validateDeployment({ ...newDeployment(BASE), foundation: 'v0.1.0' }).ok, true);
});

test('save is atomic, round-trips, and leaves no temp files', () => {
  const dir = tmp();
  const d = newDeployment(BASE);
  saveDeployment(dir, d);
  assert.deepEqual(loadDeployment(dir, 'acme-office'), d);
  assert.deepEqual(readdirSync(path.join(dir, 'deployments')), ['acme-office.json']);
  assert.equal(loadDeployment(dir, 'nope'), null);
});

test('save refuses a secret-looking key or a remembered secret value, and writes nothing', () => {
  const dir = tmp();
  assert.throws(() => saveDeployment(dir, { ...newDeployment(BASE), alerts: { ...BASE.alerts, matrix: { ...BASE.alerts.matrix, accessToken: 'x' } } }),
    (e) => e instanceof DeploymentError && /would have held a secret \(in alerts\.matrix\)/.test(e.message));
  rememberSecret('syt_supersecretvalue');
  try {
    assert.throws(() => saveDeployment(dir, addHistory(newDeployment(BASE), { version: '0.1.0', outcome: 'cancelled', detail: 'token syt_supersecretvalue', at: 't' })),
      (e) => !e.message.includes('syt_supersecretvalue'));
  } finally { forgetRememberedSecrets(); }
  assert.equal(existsSync(deploymentPath(dir, 'acme-office')), false);
});

test('a corrupt record is a plain-English error, not a crash', () => {
  const dir = tmp();
  mkdirSync(path.join(dir, 'deployments'));
  writeFileSync(deploymentPath(dir, 'acme-office'), '{ not json');
  assert.throws(() => loadDeployment(dir, 'acme-office'), (e) => e instanceof DeploymentError && /could not be read/.test(e.message));
});

test('listDeployments walks every project and reports unreadable records instead of skipping them', () => {
  const root = tmp();
  const a = path.join(root, 'acme'); mkdirSync(a);
  saveDeployment(a, newDeployment(BASE));
  const b = path.join(root, 'bobs'); mkdirSync(path.join(b, 'deployments'), { recursive: true });
  writeFileSync(path.join(b, 'deployments', 'shop.json'), '[]');
  const list = listDeployments(root);
  assert.deepEqual(list.map((e) => [e.slug, e.name, e.problem === null]), [['acme', 'acme-office', true], ['bobs', 'shop', false]]);
  assert.deepEqual(listDeployments(root, { slug: 'bobs' }).map((e) => e.name), ['shop']);
  assert.deepEqual(listDeployments(path.join(root, 'missing')), []);
});

test('history and step helpers return new objects', () => {
  const d = newDeployment(BASE);
  const h = addHistory(d, { version: '0.1.0', outcome: 'installed', at: '2026-10-27T10:00:00.000Z' });
  assert.deepEqual(h.history, [{ at: '2026-10-27T10:00:00.000Z', version: '0.1.0', from: null, outcome: 'installed', detail: '' }]);
  assert.deepEqual(d.history, []);
  assert.throws(() => addHistory(d, { version: '0.1.0', outcome: 'exploded', at: 't' }));
  assert.equal(withStep(d, 'delivered', 't').setup.step, 'delivered');
  assert.throws(() => withStep(d, 'flying', 't'));
});

test('one ship per deployment at a time; a dead holder\'s lock is taken over', () => {
  const dir = tmp();
  const first = lockDeployment(dir, 'acme-office', { pid: 111, isAlive: () => true });
  assert.ok(first);
  assert.equal(lockDeployment(dir, 'acme-office', { pid: 222, isAlive: () => true }), null);
  assert.ok(lockDeployment(dir, 'acme-office', { pid: 333, isAlive: (pid) => pid !== 111 }));
  first.release(); // releasing a lock that was taken over must not remove the new holder's file
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'deployments', 'acme-office.lock'), 'utf8')).pid, 333);
});

test('origin must be a bare http(s) origin', () => {
  for (const origin of ['https://staff.acme.co.uk/app', 'https://u:p@staff.acme.co.uk', 'ftp://x.example', 'https://x.example/?a=1', 'https://x.example/'])
    assert.equal(validateDeployment({ ...newDeployment(BASE), origin }).ok, false, origin);
  assert.equal(validateDeployment({ ...newDeployment(BASE), origin: 'http://10.0.0.5:8080' }).ok, true);
});

test('two takers racing for a dead lock: exactly one wins and the winner keeps it', () => {
  const dir = tmp();
  lockDeployment(dir, 'acme-office', { pid: 111, isAlive: () => true });
  const alive = (pid) => pid !== 111;
  let b = 'unset';
  const a = lockDeployment(dir, 'acme-office', {
    pid: 222, isAlive: alive,
    beforeTakeover: () => { b = lockDeployment(dir, 'acme-office', { pid: 333, isAlive: alive }); },
  });
  assert.ok(b && typeof b.release === 'function'); // the inner taker won
  assert.equal(a, null); // the outer one saw it had lost and reports busy
  const file = path.join(dir, 'deployments', 'acme-office.lock');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 333);
  assert.deepEqual(readdirSync(path.join(dir, 'deployments')), ['acme-office.lock']);
});

test('a corrupt lock file is taken over', () => {
  const dir = tmp();
  mkdirSync(path.join(dir, 'deployments'));
  writeFileSync(path.join(dir, 'deployments', 'acme-office.lock'), 'garbage');
  assert.ok(lockDeployment(dir, 'acme-office', { pid: 5, isAlive: () => true }));
});

test('a bad deployment name never builds a path', () => {
  const dir = tmp();
  assert.throws(() => deploymentPath(dir, '../x'), (e) => e instanceof DeploymentError);
  assert.throws(() => loadDeployment(dir, '../x'), DeploymentError);
  assert.throws(() => lockDeployment(dir, '../x'), DeploymentError);
});

test('a record whose name differs from its file name is refused', () => {
  const dir = tmp();
  saveDeployment(dir, newDeployment(BASE));
  writeFileSync(deploymentPath(dir, 'other'), readFileSync(deploymentPath(dir, 'acme-office')));
  assert.throws(() => loadDeployment(dir, 'other'), (e) => /could not be read \(.*other/.test(e.message));
});
