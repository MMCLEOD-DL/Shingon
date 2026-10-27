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

test('TLS: a self-signed Proxmox is refused without caFile and accepted with it', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const https = await import('node:https');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-tls-'));
  const key = path.join(dir, 'k.pem'); const crt = path.join(dir, 'c.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) { t.skip('openssl is not available'); fs.rmSync(dir, { recursive: true, force: true }); return; }
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: 'ok' }));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const apiUrl = `https://127.0.0.1:${server.address().port}`;
  try {
    const bare = createPveClient({ apiUrl, tokenId: TOKEN_ID, secret: SECRET });
    await assert.rejects(bare.get('/version'), (e) => e instanceof PveError && /self-signed/.test(e.message) && /caFile/.test(e.message));
    const withCa = createPveClient({ apiUrl, tokenId: TOKEN_ID, secret: SECRET, caFile: crt });
    assert.equal(await withCa.get('/version'), 'ok');
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a secret echoed by the server is redacted from every error', async () => {
  const mk = (status, body) => createPveClient({ apiUrl: 'https://192.168.1.100:8006', tokenId: TOKEN_ID, secret: SECRET, sleep: async () => {},
    request: async () => ({ status, body: JSON.stringify(body) }) });
  const check = (e) => e instanceof PveError && e.message.includes('[redacted]') && !JSON.stringify({ m: e.message, s: e.status, n: e.name, st: e.stack?.split('\n')[0] }).includes(SECRET);
  await assert.rejects(mk(500, { message: `bad token ${SECRET} here` }).get('/x'), check);
  await assert.rejects(mk(403, { message: SECRET }).get(`/x/${SECRET}`), check);
  await assert.rejects(mk(200, { data: { status: 'stopped', exitstatus: `failed ${SECRET}` } }).waitTask('ms01', 'UPID:x'), check);
  await assert.rejects(mk(200, { data: { status: 'stopped' } }).waitTask('ms01', 'UPID:x'), /properly: unknown\./);
});

test('construction errors hide userinfo and unreadable caFile is plain', () => {
  assert.throws(() => createPveClient({ apiUrl: 'http://admin:hunter2pw@192.168.1.100:8006', tokenId: TOKEN_ID, secret: SECRET }),
    (e) => /must start with https:\/\//.test(e.message) && !e.message.includes('hunter2pw'));
  assert.throws(() => createPveClient({ apiUrl: 'https://192.168.1.100:8006', tokenId: TOKEN_ID, secret: SECRET, caFile: '/nonexistent/ca.pem' }),
    (e) => e instanceof PveError && /factory\.machines\.proxmox\.caFile/.test(e.message) && !/ENOENT/.test(e.message));
});
