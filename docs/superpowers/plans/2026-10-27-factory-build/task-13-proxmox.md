# Task 13: The Proxmox machine provider

The `proxmox` provider (spec §4.7, operator-approved; Contract 3) creates and destroys LXC containers from a Docker-ready template, **only** inside the factory's own pool, within its VMID range and under its resource cap, using a token whose rights cover only that pool. Every container is tagged with the project and the run; crashes are swept by tag. It is built and tested here against the stub from Task 12. Using it live needs the operator follow-ups in Task 16.

Tags (Proxmox allows `[a-z0-9_+.-]`, separated by `;`): `hf-factory;hf-p-<slug>;hf-r-<runId>;hf-u-<purpose>;hf-t-<unix seconds>`.

**The guard (index Ruling 11).** Immediately before every stop or delete, the provider re-reads `/cluster/resources` and refuses unless the container is in `pool`, inside `vmidRange`, is not the `template`, and carries `hf-factory`. A failed `acquire` destroys what it created (through the same guard) before throwing.

**Files:**
- Create: `src/factory/machines/proxmox.js`
- Modify: `src/factory/machines/index.js` (build the provider: token from the environment, `addScrubEnv`)
- Test: `test/factory-proxmox.test.js`

**Interfaces:**
- Consumes: `createPveClient` (Task 12), `startPveStub` (Task 12), `MachineError` (Task 11), `assertSafe` (Task 10), `composeProjectOf` (Task 1), `addScrubEnv` (`src/secrets.js`), `factoryConfig` (Task 1).
- Produces:
  - `ProxmoxProvider` (`new ProxmoxProvider({ cfg, pve, ssh, now = () => new Date(), sleep, knownHostsDir })`), implementing the Provider shape, plus `destroy(vmid) -> Promise<void>` (the guarded delete, used by `release` and `sweep`).
  - `tagsFor(labels) -> string`, `labelsFromTags(tags) -> labels | null`.
  - Machine extras: `vmid` (number); `id` is `String(vmid)`; `ssh.hostKeyPolicy: 'accept-new'`, `ssh.knownHostsFile: <knownHostsDir>/known_hosts-<vmid>` (default `knownHostsDir` `~/.conductor/machines`).

- [ ] **Step 1: Write the failing tests**

Create `test/factory-proxmox.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/factory-proxmox.test.js`
Expected: FAIL (`Cannot find module '../src/factory/machines/proxmox.js'`).

- [ ] **Step 3: Implement `src/factory/machines/proxmox.js`**

- `tagsFor`/`labelsFromTags` as in the test (`labelsFromTags` splits on `;`, `,` or spaces; `null` without `hf-factory`; `createdAt` from `hf-t-` as an ISO string).
- `ours(resources)`: `type === 'lxc'`, `pool === cfg.pool`, tagged `hf-factory`, VMID in range. Containers in the pool without the tag go into `this.notes` (`Container <id> is in the factory's pool but has no factory label, so it was left alone.`).
- `acquire`:
  1. `assertSafe` on purpose, slug and run id; `labels` with `createdAt = now().toISOString()`.
  2. Read `/cluster/resources?type=vm`. At or over `maxContainers` → `MachineError('cap', 'The factory already has <n> machines (its limit): <project purpose list>. Stop a preview, or run "conductor machines sweep" to clear ones left over from crashes.')`. Their memory plus `memoryMb` over `maxMemoryMb` → `MachineError('cap', 'Another machine would take the factory over its memory limit (<maxMemoryMb> MB).')`.
  3. Free ids: every id in the range not used by **any** resource (any pool), lowest first; none → `MachineError('cap', 'There are no free machine numbers left in <lo>–<hi>.')`.
  4. Clone with `{ newid, hostname: \`hf-<slug>\`.slice(0, 50) + \`-<vmid>\`, pool, full: fullClone ? 1 : 0, description: 'Made by Conductor for the <purpose> of <slug> (run <runId>). Safe to delete.' }`; an `already exists` error moves to the next free id (at most 3 tries); `waitTask`.
  5. From here every failure runs `destroy(vmid)` (its own failure is added to the message) and throws `MachineError('failed', 'Conductor could not prepare a machine on Proxmox: <reason> It removed the half-made container (<vmid>).')`.
  6. `PUT …/config` `{ tags, cores, memory, onboot: 0 }`; `POST …/status/start`; `waitTask`.
  7. Address: poll `…/interfaces` every 2 s for up to 120 s for the first non-loopback IPv4 `inet` (strip `/nn`).
  8. Remove any old `known_hosts-<vmid>`; poll `ssh.exec(machine, 'true')` every 3 s for up to 120 s until it returns code 0.
  9. Return the machine (`runDir: <workRoot>/runs/<composeProject>`, `previewPort: cfg.previewPort`, `release: () => this.destroy(vmid)`).
- `destroy(vmid)`: re-read resources; missing → remove the known_hosts file and return. Guard failure → `MachineError('failed', 'Conductor refused to delete container <vmid>: it is not one of the factory\'s own machines (outside its pool, its number range or its label). Nothing was changed.')`. Running → `status/stop` + `waitTask`. Then `DELETE /nodes/<node>/lxc/<vmid>?purge=1&destroy-unreferenced-disks=1` + `waitTask`; remove the known_hosts file.
- `list()`: `ours`, each with `host` from `…/interfaces` when running (errors → `null`) and `release` bound.
- `sweep({ olderThanMs, keep = [] })`: `ours` whose run is not in `keep` and whose `createdAt` is at least `olderThanMs` before `now()` → `destroy`; returns how many.

- [ ] **Step 4: Wire it into `getMachineProvider`**

For `proxmox`: `secret = env[cfg.tokenEnv]`; missing → `MachineError('config', 'The Proxmox API token is not set. Put its secret in the environment variable <tokenEnv> (never in the config file).')`. `addScrubEnv(cfg.tokenEnv)`; `pve ??= createPveClient({ apiUrl, tokenId, secret, caFile })`; return `new ProxmoxProvider({ cfg, pve, ssh, now })`.

- [ ] **Step 5: Run the tests**

Run: `node --test test/factory-proxmox.test.js test/factory-static.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/factory/machines/proxmox.js src/factory/machines/index.js test/factory-proxmox.test.js
git commit -m "feat(factory): Proxmox machine provider confined to its pool, range, cap and label"
```
