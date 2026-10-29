import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factoryConfig } from '../src/factory/config.js';
import { validateBrief } from '../src/factory/brief.js';
import { newRunId, composeProjectOf, RUN_ID_RE, SLUG_RE, COMPOSE_PROJECT_RE } from '../src/factory/ids.js';
import { sampleBrief } from './helpers/factoryFixtures.js';

const home = '/home/op';
const cfg = (factory) => factoryConfig({ factory }, { env: {}, home });

test('defaults: static provider, foundation v0.2.0, the real verify, browser gate on, 2 check fixes and 3 council fixes', () => {
  const f = cfg({});
  assert.deepEqual(f.foundation, { repo: '/root/highland-foundation', tag: 'v0.2.0' });
  assert.deepEqual(f.build, { testCommand: null, browserGate: true, fixRounds: 2, councilFixRounds: 3 });
  assert.equal(f.machines.provider, 'static');
  assert.equal(f.machines.sweepAfterMs, 6 * 3600_000);
  assert.deepEqual(f.machines.static.hosts, []);
  assert.equal(f.machines.proxmox, null);
});

test('a static host is completed with defaults and ~ is expanded', () => {
  const f = cfg({ machines: { static: { hosts: [{ id: 'ct111', host: '192.168.1.111', keyPath: '~/.ssh/id_ed25519' }] } } });
  assert.deepEqual(f.machines.static.hosts[0], {
    id: 'ct111', name: 'ct111', host: '192.168.1.111', user: 'root', keyPath: '/home/op/.ssh/id_ed25519',
    previewPort: 8080, workRoot: '/srv/hf-factory',
  });
});

test('fail closed: unknown keys, bad tags, bad provider, ssh foundation URLs, bad hosts, bad fix rounds', () => {
  assert.throws(() => cfg({ biuld: {} }), /Unknown setting "factory.biuld"/);
  assert.throws(() => cfg({ build: { fixrounds: 1 } }), /Unknown setting "factory.build.fixrounds"/);
  assert.throws(() => cfg({ build: { councilFixRounds: 11 } }), /factory.build.councilFixRounds must be a whole number from 0 to 10/);
  assert.throws(() => cfg({ foundation: { tag: 'main' } }), /factory.foundation.tag must be a release tag such as v0.1.0/);
  assert.throws(() => cfg({ foundation: { repo: 'git@github.com:x/y.git' } }), /local folder, a file:\/\/ or an https:\/\/ address/);
  assert.throws(() => cfg({ machines: { provider: 'aws' } }), /factory.machines.provider must be "static" or "proxmox"/);
  assert.throws(() => cfg({ machines: { static: { hosts: [{ id: 'x', host: 'a b' }] } } }), /host "a b" is not a valid address/);
  assert.throws(() => cfg({ machines: { static: { hosts: [{ id: 'x', host: 'h', workRoot: 'relative' }] } } }), /workRoot must be an absolute path/);
  assert.throws(() => cfg({ machines: { provider: 'proxmox' } }), /factory.machines.proxmox is missing/);
});

test('proxmox settings: required fields, range, http only for 127.0.0.1', () => {
  const ok = { apiUrl: 'https://192.168.1.100:8006', node: 'ms01', tokenId: 'conductor@pve!factory', pool: 'hf-factory',
    template: 9099, vmidRange: [9100, 9149], keyPath: '~/.ssh/hf_factory' };
  const f = cfg({ machines: { provider: 'proxmox', proxmox: ok } });
  assert.equal(f.machines.proxmox.tokenEnv, 'CONDUCTOR_PROXMOX_TOKEN');
  assert.deepEqual([f.machines.proxmox.maxContainers, f.machines.proxmox.cores, f.machines.proxmox.memoryMb, f.machines.proxmox.maxMemoryMb], [3, 2, 4096, 12288]);
  assert.equal(f.machines.proxmox.previewPort, 80);
  assert.throws(() => cfg({ machines: { provider: 'proxmox', proxmox: { ...ok, vmidRange: [9149, 9100] } } }), /vmidRange must be two whole numbers, lowest first/);
  assert.throws(() => cfg({ machines: { provider: 'proxmox', proxmox: { ...ok, apiUrl: 'http://192.168.1.100:8006' } } }), /must start with https:\/\//);
  assert.doesNotThrow(() => cfg({ machines: { provider: 'proxmox', proxmox: { ...ok, apiUrl: 'http://127.0.0.1:4555' } } }));
  assert.throws(() => cfg({ machines: { provider: 'proxmox', proxmox: { ...ok, template: 9120 } } }), /template must not be inside vmidRange/);
});

test('machines.proxmox: null is accepted (Q13) and means no proxmox settings', () => {
  assert.equal(cfg({ machines: { proxmox: null } }).machines.proxmox, null);
  assert.throws(() => cfg({ machines: { provider: 'proxmox', proxmox: null } }), /factory.machines.proxmox is missing/);
});

test('Plan 7 keys still pass and the sections are frozen', () => {
  const f = cfg({ projectsRoot: '/srv/p', operatorName: 'Mal' });
  assert.equal(f.projectsRoot, '/srv/p');
  assert.ok(Object.isFrozen(f.foundation) && Object.isFrozen(f.build) && Object.isFrozen(f.machines));
});

test('run ids and compose project names; SLUG_RE follows Plan 7\'s slug rule', () => {
  const id = newRunId(new Date(Date.UTC(2026, 9, 27, 14, 30, 5)), () => 'a1b2');
  assert.equal(id, '20261027-143005-a1b2');
  assert.match(newRunId(), RUN_ID_RE);
  assert.equal(composeProjectOf('acme-ltd', id), 'hf-acme-ltd-20261027-143005-a1b2');
  assert.match(composeProjectOf('acme-ltd', id), COMPOSE_PROJECT_RE);
  assert.throws(() => composeProjectOf('Acme Ltd', id), /not a valid project name/);
  assert.throws(() => composeProjectOf('acme', '$(id)'), /not a valid run id/);
  for (const [s, ok] of [['a', true], ['acme-ltd', true], ['-a', false], ['a--b', false], ['a-', false], ['x'.repeat(41), false]]) assert.equal(SLUG_RE.test(s), ok, s);
});

test('the sample brief is a valid approved brief with example ids', () => {
  const b = sampleBrief();
  assert.deepEqual(validateBrief(b, { stage: 'approved' }).problems, []);
  assert.deepEqual(b.features.flatMap((f) => f.acceptance.map((a) => a.id)), ['submit-expense#1', 'submit-expense#2', 'monthly-report#1']);
});

test('config.example.json has a valid factory block', async () => {
  const { readFileSync } = await import('node:fs');
  const f = factoryConfig(JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')), { env: {}, home: '/h' });
  assert.equal(f.machines.provider, 'static');
  assert.equal(f.machines.static.hosts[0].id, 'ct111');
  assert.equal(f.machines.proxmox, null);
  assert.equal(f.operatorName, 'Malcolm');
});

test('alerts and ship sections: defaults, overrides and plain refusals', () => {
  const f = factoryConfig({}, { env: {}, home: '/home/op' });
  assert.deepEqual(f.alerts, { matrix: null });
  assert.deepEqual(f.ship, { updateTimeoutMs: 2700000, pollMs: 5000, startTimeoutMs: 300000, buildTimeoutMs: 3600000 });
  assert.equal(factoryConfig({ factory: { alerts: { matrix: { homeserver: 'https://m.example.org', roomId: '!a:example.org' } } } }, { env: {}, home: '/h' }).alerts.matrix.roomId, '!a:example.org');
  assert.throws(() => factoryConfig({ factory: { alerts: { matrix: { homeserver: 'm.example.org', roomId: '!a:b' } } } }, { env: {}, home: '/h' }), /homeserver must be a web address/);
  assert.throws(() => factoryConfig({ factory: { ship: { pollMs: 0 } } }, { env: {}, home: '/h' }), /factory\.ship\.pollMs must be a whole number of milliseconds above 0/);
  assert.throws(() => factoryConfig({ factory: { ship: { pollMS: 5 } } }, { env: {}, home: '/h' }), /Unknown setting "factory\.ship\.pollMS"/);
  assert.doesNotThrow(() => factoryConfig({ factory: { alerts: {}, ship: {} } }, { env: {}, home: '/h' }), 'alerts and ship are known top-level keys');
});

test('an explicit null in the ship section is refused, not turned into the default', () => {
  assert.throws(() => factoryConfig({ factory: { ship: { pollMs: null } } }, { env: {}, home: '/h' }), /factory\.ship\.pollMs must be a whole number of milliseconds above 0/);
});
