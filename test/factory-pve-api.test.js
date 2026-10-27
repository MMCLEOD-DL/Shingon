import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPveClient, PveError } from '../src/factory/machines/pveApi.js';
import { startPveStub } from './helpers/pveStub.js';

const TOKEN_ID = 'conductor@pve!factory';
const SECRET = 's3cret-token-value';

test('authenticated GET and form-encoded POST against the stub', async () => {
  const stub = await startPveStub({ resources: [{ vmid: 9099, type: 'lxc', node: 'ms01', pool: 'hf-factory', tags: '', name: 'tpl', status: 'stopped', maxmem: 4294967296 }] });
  try {
    const c = createPveClient({ apiUrl: stub.url, tokenId: TOKEN_ID, secret: SECRET });
    assert.equal((await c.get('/cluster/resources?type=vm'))[0].vmid, 9099);
    const upid = await c.post('/nodes/ms01/lxc/9099/clone', { newid: 9100, hostname: 'hf-acme', pool: 'hf-factory', full: 0 });
    assert.match(upid, /^UPID:ms01:/);
    await c.waitTask('ms01', upid, { intervalMs: 1 });
    assert.deepEqual(stub.requests.at(-2).form, { newid: '9100', hostname: 'hf-acme', pool: 'hf-factory', full: '0' });
  } finally { await stub.close(); }
});

test('errors are plain and never carry the secret', async () => {
  const stub = await startPveStub();
  try {
    const bad = createPveClient({ apiUrl: stub.url, tokenId: TOKEN_ID, secret: 'wrong-secret-value' });
    await assert.rejects(bad.get('/cluster/resources?type=vm'), (e) => e instanceof PveError && e.status === 401
      && /Proxmox refused the API token \(check its id and secret\)/.test(e.message) && !e.message.includes('wrong-secret-value'));
    const c = createPveClient({ apiUrl: stub.url, tokenId: TOKEN_ID, secret: SECRET });
    await assert.rejects(c.del('/nodes/ms01/lxc/4242?purge=1'), (e) => e.status === 500 && /Proxmox answered with an error/.test(e.message));
  } finally { await stub.close(); }
});

test('a failed task is reported; a task that never ends times out', async () => {
  const stub = await startPveStub({ failOn: { start: true }, resources: [{ vmid: 9100, type: 'lxc', node: 'ms01', pool: 'hf-factory', tags: '', name: 'x', status: 'stopped', maxmem: 1 }] });
  try {
    const c = createPveClient({ apiUrl: stub.url, tokenId: TOKEN_ID, secret: SECRET });
    const upid = await c.post('/nodes/ms01/lxc/9100/status/start');
    await assert.rejects(c.waitTask('ms01', upid, { intervalMs: 1 }), /The Proxmox task did not finish properly: startup failed/);
    let t = 0;
    const slow = createPveClient({ apiUrl: stub.url, tokenId: TOKEN_ID, secret: SECRET, now: () => (t += 1000), sleep: async () => {},
      request: async () => ({ status: 200, body: JSON.stringify({ data: { status: 'running' } }) }) });
    await assert.rejects(slow.waitTask('ms01', 'UPID:x', { timeoutMs: 5000, intervalMs: 1 }), /did not finish within 5 seconds/);
  } finally { await stub.close(); }
});

test('only https, except plain http to 127.0.0.1', () => {
  assert.throws(() => createPveClient({ apiUrl: 'http://192.168.1.100:8006', tokenId: TOKEN_ID, secret: SECRET }), /must start with https:\/\//);
  assert.doesNotThrow(() => createPveClient({ apiUrl: 'https://192.168.1.100:8006', tokenId: TOKEN_ID, secret: SECRET }));
  assert.throws(() => createPveClient({ apiUrl: 'https://192.168.1.100:8006', tokenId: TOKEN_ID, secret: '' }), /The Proxmox API token secret is missing/);
});
