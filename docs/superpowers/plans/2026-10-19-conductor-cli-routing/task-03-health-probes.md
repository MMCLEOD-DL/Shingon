# Task 3: Health probes

The routing ladder (Tasks 4–5) needs to know before a run which participants are alive.

- The current `checkHealth` only runs `<bin> --version`. That proves the CLI is installed, but not that the local model can answer.
- Loop smoke run 1 failed because the desktop worker was off. LocalAI's `/models` still answers in that state (finding F-A5).

This task lets every adapter supply its own `probe()`, and gives the local agent a real one: a 1-token chat completion against the configured model. It costs nothing because it runs locally.

**Files:**
- Modify: `src/health.js`, `src/adapters/localAgent.js`
- Test: `test/health.test.js`, `test/localAgent.test.js` (append)

**Interfaces:**
- Consumes:
  - `runCommand` (`src/exec.js`);
  - `LocalAgentAdapter` fields `bin`, `model`, `baseUrl`, `envKey` (master);
  - API adapters' `probe()` (Task 2).
- Produces:
  - `checkHealth(adapter, { timeoutMs = 15000 } = {})`. If `typeof adapter.probe === 'function'` it returns `await adapter.probe({ timeoutMs })`. Otherwise it keeps today's `--version` behaviour.
  - `LocalAgentAdapter.prototype.probe({ timeoutMs = 60000 } = {}) -> { ok, reason, detail? }`:
    - `bin --version` fails → `{ ok:false, reason:'unavailable', detail:'<bin> is not installed or does not run' }`.
    - Otherwise it sends `POST <baseUrl>/chat/completions` with `{ model, messages:[{role:'user',content:'Reply with OK.'}], max_tokens: 1 }`. The `authorization: Bearer <key>` header is sent only when the key env var is set.
    - 2xx → `{ ok:true, reason:'' }`.
    - 401/403 → `'unauthorized'`; 404 → `'model-missing'`; any other status, a connection error or a timeout → `'unavailable'`.
    - `detail` is a plain-English sentence that never contains the key.
  - Callers pass the local probe a longer timeout (60 s default), because the first call may load the model (about 9 s cold on .109).

- [ ] **Step 1: Write the failing tests**

Append to `test/health.test.js`:

```js
test('checkHealth delegates to adapter.probe when there is one', async () => {
  let seen = null;
  const r = await checkHealth({ kind: 'x', probe: async (opts) => { seen = opts; return { ok: false, reason: 'unauthorized' }; } }, { timeoutMs: 1234 });
  assert.deepEqual(r, { ok: false, reason: 'unauthorized' });
  assert.deepEqual(seen, { timeoutMs: 1234 });
});
```

Append to `test/localAgent.test.js`:

```js
import http from 'node:http';

async function withLocalServer(status, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization ?? null, body: JSON.parse(body) });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content: 'OK' } }] } : { error: 'nope' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
const okBin = () => writeStubCli(mkdtempSync(path.join(tmpdir(), 'la-')), 'codex', `console.log('codex-cli 0.163.0');`);

test('probe sends a 1-token completion to the local model with the key', async () => {
  const prev = process.env.LOCALAI_API_KEY;
  process.env.LOCALAI_API_KEY = 'local-probe-key-123456';
  try {
    await withLocalServer(200, async (baseUrl, seen) => {
      const r = await new LocalAgentAdapter({ bin: okBin(), model: 'qwen', baseUrl }).probe();
      assert.deepEqual(r, { ok: true, reason: '' });
      assert.equal(seen[0].url, '/v1/chat/completions');
      assert.equal(seen[0].auth, 'Bearer local-probe-key-123456');
      assert.equal(seen[0].body.model, 'qwen');
      assert.equal(seen[0].body.max_tokens, 1);
    });
  } finally {
    if (prev === undefined) delete process.env.LOCALAI_API_KEY; else process.env.LOCALAI_API_KEY = prev;
  }
});

test('probe maps server answers to reasons', async () => {
  for (const [status, reason] of [[401, 'unauthorized'], [403, 'unauthorized'], [404, 'model-missing'], [500, 'unavailable']]) {
    await withLocalServer(status, async (baseUrl) => {
      const r = await new LocalAgentAdapter({ bin: okBin(), model: 'm', baseUrl }).probe();
      assert.equal(r.ok, false);
      assert.equal(r.reason, reason, String(status));
      assert.equal(typeof r.detail, 'string');
    });
  }
});

test('probe reports a missing CLI and an unreachable server as unavailable', async () => {
  const noBin = await new LocalAgentAdapter({ bin: '/nonexistent/codex', model: 'm', baseUrl: 'http://127.0.0.1:9/v1' }).probe();
  assert.equal(noBin.reason, 'unavailable');
  assert.match(noBin.detail, /not installed/);
  const down = await new LocalAgentAdapter({ bin: okBin(), model: 'm', baseUrl: 'http://127.0.0.1:9/v1' }).probe({ timeoutMs: 2000 });
  assert.equal(down.reason, 'unavailable');
  assert.match(down.detail, /could not reach/);
});
```

(`writeStubCli`, `mkdtempSync`, `tmpdir` and `path` are already imported in `test/localAgent.test.js`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL. `checkHealth` ignores `probe`, and `LocalAgentAdapter` has no `probe`.

- [ ] **Step 3: Implement**

`src/health.js`: replace `checkHealth` with:

```js
// An adapter that knows how to check itself (the local model, API keys) says so with probe();
// the subscription CLIs fall back to a cheap `--version`.
export async function checkHealth(adapter, { timeoutMs = 15000 } = {}) {
  if (typeof adapter.probe === 'function') return adapter.probe({ timeoutMs });
  const bin = adapter.bin ?? adapter.kind;
  const { stderr, code, timedOut } = await runCommand({ cmd: bin, args: ['--version'], timeoutMs });
  if (code === 0 && !timedOut) return { ok: true, reason: '' };
  if (timedOut) return { ok: false, reason: 'unavailable' };
  return { ok: false, reason: classifyFailure(stderr) };
}
```

`src/adapters/localAgent.js`: add `import { runCommand } from '../exec.js';` and this method to `LocalAgentAdapter` (after `run`):

```js
  // A real liveness check: LocalAI's /models answers even when its worker is down (F-A5),
  // so ask the model for one token. Free: it runs locally.
  async probe({ timeoutMs = 60000 } = {}) {
    const v = await runCommand({ cmd: this.bin, args: ['--version'], timeoutMs: 15000 });
    if (v.code !== 0 || v.timedOut) return { ok: false, reason: 'unavailable', detail: `${this.bin} is not installed or does not run` };
    const key = process.env[this.envKey];
    let res;
    try {
      res = await fetch(`${String(this.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.text();
    } catch (e) {
      const detail = e?.name === 'TimeoutError'
        ? 'the local model did not answer in time'
        : `could not reach the local model server (${e?.cause?.code ?? e?.message ?? e})`;
      return { ok: false, reason: 'unavailable', detail };
    }
    if (res.ok) return { ok: true, reason: '' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized', detail: `the local model server refused the key (HTTP ${res.status})` };
    if (res.status === 404) return { ok: false, reason: 'model-missing', detail: `the local model server has no model named ${this.model}` };
    return { ok: false, reason: 'unavailable', detail: `the local model server answered HTTP ${res.status}` };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/health.js src/adapters/localAgent.js test
git commit -m "feat: health probes — local model 1-token check, adapters may supply probe()"
```
