import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProxmoxProvider, tagsFor, labelsFromTags } from '../src/factory/machines/proxmox.js';
import { createPveClient } from '../src/factory/machines/pveApi.js';
import { getMachineProvider } from '../src/factory/machines/index.js';
import { factoryConfig } from '../src/factory/config.js';
import { SCRUB_ENV } from '../src/secrets.js';
import { startPveStub } from './helpers/pveStub.js';

const SECRET = 's3cret-token-value';
const RAW = { apiUrl: 'http://127.0.0.1:1', node: 'ms01', tokenId: 'conductor@pve!factory', pool: 'hf-factory', template: 9099, vmidRange: [9100, 9149], keyPath: '/k' };
const TEMPLATE = { vmid: 9099, type: 'lxc', node: 'ms01', pool: 'hf-factory', tags: '', name: 'hf-template', status: 'stopped', maxmem: 4096 * 1048576 };
const ours = (vmid, labels) => ({ vmid, type: 'lxc', node: 'ms01', pool: 'hf-factory', tags: tagsFor(labels), name: `hf-${vmid}`, status: 'running', maxmem: 4096 * 1048576 });
const L = (run, over = {}) => ({ factory: 'hf', project: 'acme-ltd', run, purpose: 'council', createdAt: '2026-10-27T14:30:05.000Z', ...over });

async function setup({ resources = [], failOn = {}, now = () => new Date('2026-10-27T14:30:05Z'), cfg = {} } = {}) {
  const stub = await startPveStub({ resources: [TEMPLATE, ...resources], failOn });
  const factory = factoryConfig({ factory: { machines: { provider: 'proxmox', proxmox: { ...RAW, apiUrl: stub.url, ...cfg } } } }, { env: {} });
  const sshCalls = [];
  const ssh = { exec: async (m, script) => { sshCalls.push({ m, script }); return { code: 0, stdout: '', stderr: '' }; } };
  const knownHostsDir = mkdtempSync(path.join(tmpdir(), 'kh-'));
  const p = new ProxmoxProvider({ cfg: factory.machines.proxmox, pve: createPveClient({ apiUrl: stub.url, tokenId: RAW.tokenId, secret: SECRET }), ssh, now, sleep: async () => {}, knownHostsDir });
  return { stub, p, sshCalls, knownHostsDir };
}
const deletes = (stub) => stub.requests.filter((r) => r.method === 'DELETE').map((r) => r.path);

test('tags carry the project, run, purpose and time, and read back', () => {
  const t = tagsFor(L('20261027-143005-a1b2', { purpose: 'preview' }));
  assert.equal(t, 'hf-factory;hf-p-acme-ltd;hf-r-20261027-143005-a1b2;hf-u-preview;hf-t-1793111405');
  assert.deepEqual(labelsFromTags(t), L('20261027-143005-a1b2', { purpose: 'preview' }));
  assert.equal(labelsFromTags('web;prod'), null);
});

test('acquire: lowest free id in range, cloned into the pool, tagged, started, reachable', async () => {
  const foreign = { vmid: 9100, type: 'lxc', node: 'ms01', pool: 'other', tags: '', name: 'someone', status: 'running', maxmem: 1 };
  const { stub, p, sshCalls, knownHostsDir } = await setup({ resources: [foreign] });
  try {
    const m = await p.acquire({ purpose: 'preview', projectSlug: 'acme-ltd', runId: '20261027-143005-a1b2' });
    assert.equal(m.vmid, 9101);
    assert.equal(m.host, '192.168.1.101');
    const clone = stub.requests.find((r) => r.path.endsWith('/clone'));
    assert.equal(clone.path, '/api2/json/nodes/ms01/lxc/9099/clone');
    assert.deepEqual([clone.form.newid, clone.form.pool, clone.form.full], ['9101', 'hf-factory', '0']);
    const cfgReq = stub.requests.find((r) => r.method === 'PUT');
    assert.deepEqual([cfgReq.form.tags, cfgReq.form.cores, cfgReq.form.memory], ['hf-factory;hf-p-acme-ltd;hf-r-20261027-143005-a1b2;hf-u-preview;hf-t-1793111405', '2', '4096']);
    assert.deepEqual(m.ssh, { user: 'root', keyPath: '/k', knownHostsFile: path.join(knownHostsDir, 'known_hosts-9101'), hostKeyPolicy: 'accept-new' });
    assert.ok(sshCalls.length >= 1, 'waited for ssh');
    assert.equal(m.previewPort, 80);
  } finally { await stub.close(); }
});

test('the cap: no clone when the factory already has its maximum', async () => {
  const { stub, p } = await setup({ resources: [9110, 9111, 9112].map((v, i) => ours(v, L(`20261027-14300${i}-aaaa`))) });
  try {
    await assert.rejects(p.acquire({ purpose: 'council', projectSlug: 'acme-ltd', runId: '20261027-150000-bbbb' }),
      (e) => e.code === 'cap' && /The factory already has 3 machines \(its limit\)/.test(e.message));
    assert.equal(stub.requests.some((r) => r.path.endsWith('/clone')), false);
  } finally { await stub.close(); }
});

test('a container that will not start is destroyed before the error', async () => {
  const { stub, p } = await setup({ failOn: { start: true } });
  try {
    await assert.rejects(p.acquire({ purpose: 'council', projectSlug: 'acme-ltd', runId: '20261027-143005-a1b2' }),
      /could not prepare a machine on Proxmox: The Proxmox task did not finish properly: startup failed\. It removed the half-made container \(9100\)/);
    assert.deepEqual(deletes(stub), ['/api2/json/nodes/ms01/lxc/9100']);
    assert.equal(stub.state.resources.some((r) => r.vmid === 9100), false);
  } finally { await stub.close(); }
});

test('the guard: never stops or deletes outside the pool, the range, the label, or the template', async () => {
  const untagged = { ...ours(9120, L('20261027-143005-a1b2')), tags: '' };
  const outside = { ...ours(205, L('20261027-143005-a1b2')) };
  const elsewhere = { ...ours(9121, L('20261027-143005-a1b2')), pool: 'prod' };
  const { stub, p } = await setup({ resources: [untagged, outside, elsewhere] });
  try {
    for (const vmid of [9120, 205, 9121, 9099]) {
      await assert.rejects(p.destroy(vmid), /refused to delete container \d+: it is not one of the factory's own machines/);
    }
    assert.deepEqual(deletes(stub), []);
    assert.equal(stub.requests.some((r) => r.path.includes('/status/stop')), false);
  } finally { await stub.close(); }
});

test('release stops and deletes its own container and its known_hosts file; twice is harmless', async () => {
  const { stub, p } = await setup();
  try {
    const m = await p.acquire({ purpose: 'council', projectSlug: 'acme-ltd', runId: '20261027-143005-a1b2' });
    writeFileSync(m.ssh.knownHostsFile, 'x');
    await m.release();
    assert.deepEqual(deletes(stub), ['/api2/json/nodes/ms01/lxc/9100']);
    assert.equal(existsSync(m.ssh.knownHostsFile), false);
    await m.release();
    assert.equal(deletes(stub).length, 1);
  } finally { await stub.close(); }
});

test('list and sweep go by tag: old ones go, kept and young ones stay, unlabelled ones are left alone', async () => {
  const resources = [
    ours(9110, L('20261026-020000-aaaa', { createdAt: '2026-10-26T02:00:00.000Z' })),
    ours(9111, L('20261026-020001-bbbb', { createdAt: '2026-10-26T02:00:01.000Z', purpose: 'preview' })),
    ours(9112, L('20261027-140000-cccc', { createdAt: '2026-10-27T14:00:00.000Z' })),
    { ...ours(9113, L('x')), tags: 'mine' },
  ];
  const { stub, p } = await setup({ resources });
  try {
    assert.deepEqual((await p.list()).map((m) => m.vmid), [9110, 9111, 9112]);
    assert.equal(await p.sweep({ olderThanMs: 6 * 3600_000, keep: ['20261026-020001-bbbb'] }), 1);
    assert.deepEqual(deletes(stub), ['/api2/json/nodes/ms01/lxc/9110']);
    assert.match(p.notes.join('\n'), /Container 9113 is in the factory's pool but has no factory label, so it was left alone/);
  } finally { await stub.close(); }
});

test('getMachineProvider: the token comes from the environment, and is scrubbed from child processes', () => {
  const factory = factoryConfig({ factory: { machines: { provider: 'proxmox', proxmox: { ...RAW, tokenEnv: 'HF_TEST_PVE_TOKEN' } } } }, { env: {} });
  assert.throws(() => getMachineProvider(factory, { env: {} }), (e) => e.code === 'config' && /environment variable HF_TEST_PVE_TOKEN/.test(e.message));
  const p = getMachineProvider(factory, { env: { HF_TEST_PVE_TOKEN: SECRET } });
  assert.equal(p.kind, 'proxmox');
  assert.ok(SCRUB_ENV.includes('HF_TEST_PVE_TOKEN'));
});

test('a clone that collides with a container made meanwhile moves on to the next free number', async () => {
  const { stub, p } = await setup();
  try {
    const realPost = p.pve.post;
    let first = true;
    p.pve = { ...p.pve, post: async (pth, form) => {
      if (first && pth.endsWith('/clone')) { first = false; throw new Error('Proxmox answered with an error (500): CT 9100 already exists.'); }
      return realPost(pth, form);
    } };
    const m = await p.acquire({ purpose: 'council', projectSlug: 'acme-ltd', runId: '20261027-143005-a1b2' });
    assert.equal(m.vmid, 9101);
    assert.deepEqual(deletes(stub), []);
  } finally { await stub.close(); }
});
