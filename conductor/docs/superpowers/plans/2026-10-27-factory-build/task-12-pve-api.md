# Task 12: Proxmox API client and stub

A zero-dependency client for the few Proxmox VE API calls the `proxmox` provider needs, and an in-memory stub of those calls on `127.0.0.1` for the tests (index Ruling 11: TLS is always verified; plain `http://` only for `127.0.0.1`; the token secret never appears in an error, event or log).

**Files:**
- Create: `src/factory/machines/pveApi.js`, `test/helpers/pveStub.js`
- Test: `test/factory-pve-api.test.js`

**Interfaces:**
- Consumes: `node:https`, `node:http`, `node:fs`; `redact` (`src/secrets.js`).
- Produces:
  - `createPveClient({ apiUrl, tokenId, secret, caFile = null, request = nodeRequest, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, timeoutMs = 30000 }) -> client`
  - `client.get(path) -> data`, `client.post(path, form = {}) -> data`, `client.put(path, form = {}) -> data`, `client.del(path) -> data`: `path` is below `/api2/json` (for example `/cluster/resources?type=vm`); `form` is sent as `application/x-www-form-urlencoded`; the result is the response's `data`.
  - `client.waitTask(node, upid, { timeoutMs = 300000, intervalMs = 2000 } = {})`: resolves when the task stopped with `exitstatus === 'OK'`; throws `PveError` otherwise.
  - `PveError` (`extends Error`; `status`; plain message).
  - `test/helpers/pveStub.js`: `startPveStub({ token = 'conductor@pve!factory=s3cret-token-value', node = 'ms01', resources = [], failOn = {} } = {}) -> Promise<{ url, state, requests, close() }>`. `state.resources` is the list behind `/cluster/resources`; `failOn` may hold `clone`, `start` or `interfaces` (`true` makes that call's task fail, or for `interfaces` never return an IPv4 address).

Stub routes (all under `/api2/json`, 401 without the exact `Authorization: PVEAPIToken=<token>` header):

| Method and path | Behaviour |
|---|---|
| `GET /cluster/resources?type=vm` | `state.resources` (`{ vmid, type: 'lxc', node, pool, tags, name, status, maxmem }`) |
| `POST /nodes/:node/lxc/:id/clone` | needs `newid`, `hostname`, `pool`; 500 `CT <newid> already exists` when taken; adds a stopped resource (maxmem from the template); returns a UPID |
| `PUT /nodes/:node/lxc/:id/config` | applies `tags`, `cores`, `memory` (maxmem = memory × 1 048 576), `description`; returns `null` |
| `GET /nodes/:node/lxc/:id/config` | `{ hostname, tags, description, cores, memory }` |
| `POST /nodes/:node/lxc/:id/status/start` / `stop` | sets `running` / `stopped`; returns a UPID |
| `GET /nodes/:node/lxc/:id/interfaces` | running: `[{ name: 'lo', inet: '127.0.0.1/8' }, { name: 'eth0', inet: '192.168.1.<id − 9000>/24' }]`; stopped: 500 |
| `DELETE /nodes/:node/lxc/:id?purge=1&destroy-unreferenced-disks=1` | 500 unless stopped; removes it; returns a UPID |
| `GET /nodes/:node/tasks/:upid/status` | `{ status: 'stopped', exitstatus: 'OK' }`, or the failure text for a `failOn` task |

Every request is recorded in `requests` as `{ method, path, query, form }`.

- [ ] **Step 1: Write the failing tests**

Create `test/factory-pve-api.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/factory-pve-api.test.js`
Expected: FAIL (`Cannot find module '../src/factory/machines/pveApi.js'`).

- [ ] **Step 3: Implement `test/helpers/pveStub.js`**

`http.createServer` on `127.0.0.1` port 0, following the route table above; bodies parsed with `URLSearchParams`; UPIDs look like `UPID:ms01:<hex>:<hex>:<hex>:<kind>:<vmid>:conductor@pve!factory:`; `close()` closes the server. Nothing else is implemented: an unknown route answers 501, so a test that calls something unexpected fails loudly.

- [ ] **Step 4: Implement `src/factory/machines/pveApi.js`**

- Construction checks: `apiUrl` must parse; `https:` always allowed, `http:` only for hostname `127.0.0.1` (otherwise `The Proxmox address must start with https:// (got <apiUrl>)`); an empty `secret` throws `The Proxmox API token secret is missing. Put it in the environment variable named by factory.machines.proxmox.tokenEnv.`
- `nodeRequest({ method, url, headers, body, ca, timeoutMs }) -> { status, body }` uses `https.request` or `http.request` with `ca` (the file's contents when `caFile` is set) and **never** sets `rejectUnauthorized: false`; a timeout or socket error rejects with `PveError(0, 'Conductor could not reach Proxmox at <host>: <reason>.')`. Certificate errors keep their reason (`self-signed certificate…`) and add `Set factory.machines.proxmox.caFile to the Proxmox CA certificate (/etc/pve/pve-root-ca.pem on the Proxmox host).`
- Every call sends `Authorization: PVEAPIToken=<tokenId>=<secret>`; POST and PUT send `new URLSearchParams(stringified form).toString()`.
- Status handling: 2xx → `JSON.parse(body).data`; 401 → `Proxmox refused the API token (check its id and secret).`; 403 → `Proxmox did not allow that: the factory's API token has no rights for <method> <path>. Check the token's rights on the pool.`; anything else → `Proxmox answered with an error (<status>): <first line of the reply's message or errors, clipped to 300>.` Every message goes through `redact` and has the secret replaced by `[redacted]` before it is thrown.
- `waitTask`: polls `GET /nodes/<node>/tasks/<encodeURIComponent(upid)>/status`; `status === 'stopped'` and `exitstatus === 'OK'` → done; stopped otherwise → `The Proxmox task did not finish properly: <exitstatus>.`; past `timeoutMs` (measured with `now`) → `The Proxmox task did not finish within <s> seconds.`

- [ ] **Step 5: Run the tests**

Run: `node --test test/factory-pve-api.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/factory/machines/pveApi.js test/helpers/pveStub.js test/factory-pve-api.test.js
git commit -m "feat(factory): zero-dependency Proxmox API client and an in-memory test stub

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
