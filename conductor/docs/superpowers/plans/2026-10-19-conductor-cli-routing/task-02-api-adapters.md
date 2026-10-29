# Task 2: Vendors & API adapters

Spec §4 and §7 call for a paid-API fallback that is used only when no subscription can take the call. This task adds:

- the vendor mapping that the two-vendor rule and routing use;
- two text-only API adapters, Anthropic Messages and OpenAI Responses, built on Node's global `fetch`;
- config support for both.

No routing is done here (that is Task 4). These are plain adapters behind the existing `run(role, task, context, opts)` contract.

**Files:**
- Create: `src/vendors.js`, `src/adapters/api.js`, `test/vendors.test.js`, `test/api.test.js`
- Modify: `src/config.js`, `test/config.test.js` (append)

**Interfaces:**
- Consumes:
  - `getRolePreset(role)` (`src/roles.js`);
  - `normalize(raw) -> { text, diff, verdict }` (`src/normalizer.js`);
  - `makeResult` (it already carries `failure`);
  - `redact(x)` and `addScrubEnv(name)` (`src/secrets.js`);
  - `isContextOverflow(text)` (Task 1);
  - `DEFAULT_OPTIONS` (`src/options.js`).
- Produces:
  - `vendorOf`, `isApiKind`, `isSubscriptionKind` (see index).
  - `AnthropicApiAdapter`, `OpenAiApiAdapter` with `.kind`, `.model`, `.envKey`, `.baseUrl`, `.run()` and `.probe()`.
  - `loadConfig()` also returns `routing` and `options`.
  - Adapter `failure` kinds:
    - `401`/`403`/`429`/`5xx`/network error → `'infrastructure'`;
    - a body that mentions the context limit → `'context-overflow'`;
    - timeout → `'timeout'`;
    - any other `4xx` → `null`.
  - The error text always starts `HTTP <status>:` for HTTP errors, so `classifyFailure` can tell a rate limit (`429`) from `unauthorized` (`401`).

Behaviour rules:
- `run` with `opts.write` returns `ok:false`, error `an API participant cannot edit files`, failure `null`. It never calls the network.
- If the key env var is missing, `run` returns `ok:false`, error `<ENV> is not set`, failure `'infrastructure'`.
- `probe()` checks only that the key is present and never makes a paid call: `{ ok: true, reason: '' }` or `{ ok: false, reason: 'unauthorized' }`.
- The key is sent only as a request header. Every error string passes through `redact()`, so a body that echoes the key cannot leak it.
- A non-frontier `envKey` is added to `SCRUB_ENV` with `addScrubEnv`, so no CLI, test command or local agent inherits it.
- **Config:**
  - API participants may not declare `can_edit_files: true` or the `grunt` role (`loadConfig` throws).
  - Unknown keys in the config's `options` section throw `Unknown option "<k>" in config`.

- [ ] **Step 1: Write the failing tests**

Create `test/vendors.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vendorOf, isApiKind, isSubscriptionKind } from '../src/vendors.js';

test('vendorOf maps adapter kinds to vendors', () => {
  assert.equal(vendorOf('claude-code'), 'anthropic');
  assert.equal(vendorOf('anthropic-api'), 'anthropic');
  assert.equal(vendorOf('codex'), 'openai');
  assert.equal(vendorOf('openai-api'), 'openai');
  assert.equal(vendorOf('local-agent'), 'local');
  assert.equal(vendorOf('something-else'), 'something-else');
});

test('api and subscription kinds', () => {
  assert.equal(isApiKind('anthropic-api'), true);
  assert.equal(isApiKind('openai-api'), true);
  assert.equal(isApiKind('codex'), false);
  assert.equal(isSubscriptionKind('claude-code'), true);
  assert.equal(isSubscriptionKind('codex'), true);
  assert.equal(isSubscriptionKind('anthropic-api'), false);
  assert.equal(isSubscriptionKind('local-agent'), false);
});
```

Create `test/api.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AnthropicApiAdapter, OpenAiApiAdapter } from '../src/adapters/api.js';
import { SCRUB_ENV } from '../src/secrets.js';

const KEY_NAME = 'CONDUCTOR_TEST_API_KEY';
const KEY = 'sk-test-0123456789abcdefSECRET';

// Runs fn(baseUrl, seen) against a one-route 127.0.0.1 server; seen collects requests.
async function withServer(handler, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null }); handler(req, res, body); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    server.closeAllConnections(); // a handler that never answers must not hold close() open
    await new Promise((r) => server.close(r));
  }
}
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

function withKey(fn) {
  return async () => {
    const prev = process.env[KEY_NAME];
    process.env[KEY_NAME] = KEY;
    try { await fn(); } finally { if (prev === undefined) delete process.env[KEY_NAME]; else process.env[KEY_NAME] = prev; }
  };
}

test('anthropic: sends the messages request and parses text, verdict and cost', withKey(async () => {
  await withServer((req, res) => json(res, 200, {
    content: [{ type: 'text', text: 'Looks fine.\nVERDICT: APPROVE' }],
    usage: { input_tokens: 1000, output_tokens: 500 },
  }), async (baseUrl, seen) => {
    const a = new AnthropicApiAdapter({ model: 'claude-x', envKey: KEY_NAME, baseUrl, prices: { inputPerMTok: 3, outputPerMTok: 15 } });
    assert.equal(a.kind, 'anthropic-api');
    const r = await a.run('reviewer', 'review this', 'ctx');
    assert.equal(r.ok, true);
    assert.equal(r.verdict.decision, 'APPROVE');
    assert.ok(Math.abs(r.usage.costUsd - 0.0105) < 1e-9);
    assert.equal(seen[0].url, '/v1/messages');
    assert.equal(seen[0].headers['x-api-key'], KEY);
    assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(seen[0].body.model, 'claude-x');
    assert.match(seen[0].body.system, /REVIEWER/);
    assert.match(seen[0].body.messages[0].content, /review this[\s\S]*Context:\nctx/);
  });
}));

test('openai: sends the responses request and parses output_text', withKey(async () => {
  await withServer((req, res) => json(res, 200, {
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'VERDICT: BLOCK - missing test' }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }), async (baseUrl, seen) => {
    const a = new OpenAiApiAdapter({ model: 'gpt-x', envKey: KEY_NAME, baseUrl });
    assert.equal(a.kind, 'openai-api');
    const r = await a.run('reviewer', 'review');
    assert.equal(r.verdict.decision, 'BLOCK');
    assert.equal(r.usage.costUsd, null);
    assert.equal(seen[0].url, '/responses');
    assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(seen[0].body.model, 'gpt-x');
    assert.match(seen[0].body.instructions, /REVIEWER/);
  });
}));

test('HTTP failures map to failure kinds and keep the status in the error', withKey(async () => {
  for (const [status, body, failure] of [
    [429, { error: { message: 'rate limit' } }, 'infrastructure'],
    [401, { error: { message: 'bad key' } }, 'infrastructure'],
    [503, { error: { message: 'overloaded' } }, 'infrastructure'],
    [400, { error: { message: 'prompt is too long: 300000 tokens' } }, 'context-overflow'],
    [400, { error: { message: 'bad request' } }, null],
  ]) {
    await withServer((req, res) => json(res, status, body), async (baseUrl) => {
      const r = await new AnthropicApiAdapter({ model: 'm', envKey: KEY_NAME, baseUrl }).run('reviewer', 't');
      assert.equal(r.ok, false);
      assert.match(r.error, new RegExp(`^HTTP ${status}:`));
      assert.equal(r.failure, failure, `${status} ${JSON.stringify(body)}`);
    });
  }
}));

test('an error body that echoes the key never leaks it (Review Focus 5)', withKey(async () => {
  await withServer((req, res) => json(res, 500, { echoed: req.headers['x-api-key'] }), async (baseUrl) => {
    const r = await new AnthropicApiAdapter({ model: 'm', envKey: KEY_NAME, baseUrl }).run('reviewer', 't');
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes(KEY), 'key leaked into the result');
    assert.match(r.error, /\[redacted\]/);
  });
}));

test('write calls, a missing key and an unreachable host fail without a paid call', async () => {
  const a = new AnthropicApiAdapter({ model: 'm', envKey: 'CONDUCTOR_TEST_UNSET_KEY', baseUrl: 'http://127.0.0.1:9' });
  const w = await a.run('author', 't', '', { write: true });
  assert.equal(w.ok, false);
  assert.match(w.error, /cannot edit files/);
  assert.equal(w.failure, null);
  const k = await a.run('reviewer', 't');
  assert.match(k.error, /CONDUCTOR_TEST_UNSET_KEY is not set/);
  assert.equal(k.failure, 'infrastructure');
  assert.deepEqual(a.probe(), { ok: false, reason: 'unauthorized' });
});

test('an unreachable host is infrastructure; a slow one is a timeout', withKey(async () => {
  const down = await new OpenAiApiAdapter({ model: 'm', envKey: KEY_NAME, baseUrl: 'http://127.0.0.1:9' }).run('reviewer', 't');
  assert.equal(down.failure, 'infrastructure');
  assert.match(down.error, /could not reach 127\.0\.0\.1:9/);
  await withServer(() => {}, async (baseUrl) => {
    const slow = await new OpenAiApiAdapter({ model: 'm', envKey: KEY_NAME, baseUrl }).run('reviewer', 't', '', { timeoutMs: 200 });
    assert.equal(slow.failure, 'timeout');
  });
  assert.deepEqual(new OpenAiApiAdapter({ model: 'm', envKey: KEY_NAME }).probe(), { ok: true, reason: '' });
}));

test('a custom key name is scrubbed from every child process; frontier names are not', () => {
  new AnthropicApiAdapter({ model: 'm', envKey: 'MY_ANTHROPIC_BILLING_KEY' });
  assert.ok(SCRUB_ENV.includes('MY_ANTHROPIC_BILLING_KEY'));
  new AnthropicApiAdapter({ model: 'm' });
  assert.ok(!SCRUB_ENV.includes('ANTHROPIC_API_KEY'));
});

test('a model is required', () => {
  assert.throws(() => new AnthropicApiAdapter({}), /requires a model/);
  assert.throws(() => new OpenAiApiAdapter({}), /requires a model/);
});
```

Append to `test/config.test.js`:

```js
import { writeFileSync as writeCfg, mkdtempSync as mkCfgDir } from 'node:fs';
import { tmpdir as cfgTmp } from 'node:os';
import cfgPath from 'node:path';

const cfgFile = (obj) => {
  const f = cfgPath.join(mkCfgDir(cfgPath.join(cfgTmp(), 'cfg-')), 'c.json');
  writeCfg(f, JSON.stringify(obj));
  return f;
};
const API_P = { name: 'claude-api', adapter: 'anthropic-api', model: 'm', roles: ['author', 'reviewer'] };

test('buildAdapter builds the API adapters', () => {
  const a = buildAdapter({ ...API_P, envKey: 'K1', baseUrl: 'http://x', maxTokens: 10, prices: { inputPerMTok: 1, outputPerMTok: 2 } });
  assert.equal(a.kind, 'anthropic-api');
  assert.equal(a.envKey, 'K1');
  assert.equal(a.baseUrl, 'http://x');
  assert.equal(buildAdapter({ name: 'o', adapter: 'openai-api', model: 'm' }).kind, 'openai-api');
});

test('loadConfig returns routing and options, and rejects unknown options', () => {
  const ok = loadConfig(cfgFile({ participants: [API_P], routing: { allowApi: true }, options: { testCommand: 'npm test' } }));
  assert.deepEqual(ok.routing, { allowApi: true });
  assert.deepEqual(ok.options, { testCommand: 'npm test' });
  const bare = loadConfig(cfgFile({ participants: [API_P] }));
  assert.deepEqual(bare.routing, {});
  assert.deepEqual(bare.options, {});
  assert.throws(() => loadConfig(cfgFile({ participants: [API_P], options: { testComand: 'x' } })), /Unknown option "testComand"/);
});

test('API participants cannot edit files or be the local executor', () => {
  assert.throws(() => loadConfig(cfgFile({ participants: [{ ...API_P, capabilities: { can_edit_files: true } }] })), /cannot edit files/);
  assert.throws(() => loadConfig(cfgFile({ participants: [{ ...API_P, roles: ['grunt'] }] })), /cannot be the local executor/);
});
```

(If `test/config.test.js` already imports `loadConfig`, do not import it again. It does: the existing tests call `loadConfig`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL. `src/vendors.js` and `src/adapters/api.js` do not exist yet, and `loadConfig` has no `routing`/`options`.

- [ ] **Step 3: Implement**

Create `src/vendors.js`:

```js
// src/vendors.js
// Who actually serves a call. The two-vendor rule compares vendors, not adapter kinds:
// Claude Code on a subscription and the Anthropic API are the same vendor.
const VENDOR = {
  'claude-code': 'anthropic',
  'anthropic-api': 'anthropic',
  codex: 'openai',
  'openai-api': 'openai',
  'local-agent': 'local',
};

export const vendorOf = (kind) => VENDOR[kind] ?? kind;
export const isApiKind = (kind) => kind === 'anthropic-api' || kind === 'openai-api';
export const isSubscriptionKind = (kind) => kind === 'claude-code' || kind === 'codex';
```

Create `src/adapters/api.js`:

```js
// src/adapters/api.js
// Paid-API fallback participants (spec §7: never the default). Text-only: they can draft
// a plan or review, never edit files. The key goes only into the request header.
import { getRolePreset } from '../roles.js';
import { normalize } from '../normalizer.js';
import { makeResult } from '../result.js';
import { redact, addScrubEnv } from '../secrets.js';
import { isContextOverflow } from '../health.js';

const BODY_MAX = 300;

function priced(prices, inTok, outTok) {
  if (!prices || !Number.isFinite(inTok) || !Number.isFinite(outTok)) return null;
  return (inTok * prices.inputPerMTok + outTok * prices.outputPerMTok) / 1e6;
}

// 401/403/429/5xx: this participant is unusable right now, try the next one.
function failureFor(status, body) {
  if (isContextOverflow(body)) return 'context-overflow';
  if (status === 401 || status === 403 || status === 429 || status >= 500) return 'infrastructure';
  return null;
}

class ApiAdapter {
  constructor({ kind, model, envKey, baseUrl, timeoutMs = 300000, maxTokens = 8192, prices = null }) {
    if (!model) throw new Error(`${kind} requires a model`);
    this.kind = kind;
    this.model = model;
    this.envKey = envKey;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens;
    this.prices = prices;
    addScrubEnv(envKey); // a custom key name never reaches a CLI, test command or local agent
  }

  // Presence only: a real check would be a paid call.
  probe() {
    return process.env[this.envKey] ? { ok: true, reason: '' } : { ok: false, reason: 'unauthorized' };
  }

  async run(role, task, context = '', opts = {}) {
    if (opts.write) return makeResult({ ok: false, error: 'an API participant cannot edit files' });
    const key = process.env[this.envKey];
    if (!key) return makeResult({ ok: false, error: `${this.envKey} is not set`, failure: 'infrastructure' });
    const preset = getRolePreset(role);
    const system = `${preset.systemPrompt}\n\n${preset.outputShape}`;
    const prompt = context ? `${task}\n\n---\nContext:\n${context}` : task;
    const { url, headers, body } = this.request({ key, system, prompt });

    let res;
    let text;
    try {
      res = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      if (e?.name === 'TimeoutError') return makeResult({ ok: false, error: 'timed out', failure: 'timeout' });
      const why = e?.cause?.code ?? e?.message ?? String(e);
      return makeResult({ ok: false, error: redact(`could not reach ${new URL(url).host}: ${why}`), failure: 'infrastructure' });
    }
    if (!res.ok) {
      return makeResult({ ok: false, error: redact(`HTTP ${res.status}: ${text.slice(0, BODY_MAX)}`), failure: failureFor(res.status, text) });
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return makeResult({ ok: false, error: 'the API reply was not JSON' });
    }
    const { out, inTok, outTok } = this.parse(data);
    const norm = normalize(out);
    return makeResult({
      text: norm.text, diff: norm.diff, verdict: norm.verdict, ok: true,
      usage: { costUsd: priced(this.prices, inTok, outTok), raw: data.usage ?? null },
    });
  }
}

export class AnthropicApiAdapter extends ApiAdapter {
  constructor({ envKey = 'ANTHROPIC_API_KEY', baseUrl = 'https://api.anthropic.com', ...rest } = {}) {
    super({ kind: 'anthropic-api', envKey, baseUrl, ...rest });
  }

  request({ key, system, prompt }) {
    return {
      url: `${this.baseUrl}/v1/messages`,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: { model: this.model, max_tokens: this.maxTokens, system, messages: [{ role: 'user', content: prompt }] },
    };
  }

  parse(data) {
    const out = (data.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
    return { out, inTok: data.usage?.input_tokens, outTok: data.usage?.output_tokens };
  }
}

export class OpenAiApiAdapter extends ApiAdapter {
  constructor({ envKey = 'OPENAI_API_KEY', baseUrl = 'https://api.openai.com/v1', ...rest } = {}) {
    super({ kind: 'openai-api', envKey, baseUrl, ...rest });
  }

  request({ key, system, prompt }) {
    return {
      url: `${this.baseUrl}/responses`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: { model: this.model, instructions: system, input: prompt, max_output_tokens: this.maxTokens },
    };
  }

  parse(data) {
    const out = typeof data.output_text === 'string'
      ? data.output_text
      : (data.output ?? []).flatMap((o) => o?.content ?? []).filter((c) => c?.type === 'output_text').map((c) => c.text).join('');
    return { out, inTok: data.usage?.input_tokens, outTok: data.usage?.output_tokens };
  }
}
```

`src/config.js`:
- Add these imports:

```js
import { AnthropicApiAdapter, OpenAiApiAdapter } from './adapters/api.js';
import { DEFAULT_OPTIONS } from './options.js';
import { isApiKind } from './vendors.js';
```

- Add two cases to the `switch` in `buildAdapter`, before `default:`:

```js
    case 'anthropic-api':
    case 'openai-api': {
      const Api = spec.adapter === 'anthropic-api' ? AnthropicApiAdapter : OpenAiApiAdapter;
      return new Api({ model: spec.model, timeoutMs: spec.timeoutMs, envKey: spec.envKey, baseUrl: spec.baseUrl, maxTokens: spec.maxTokens, prices: spec.prices });
    }
```

- Update the `default:` message to list every kind: `(expected claude-code | codex | local-agent | anthropic-api | openai-api)`.

Replace `loadConfig` with:

```js
export function loadConfig(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed.participants)) throw new Error('config must have a "participants" array');
  const options = parsed.options ?? {};
  for (const k of Object.keys(options)) {
    if (!Object.hasOwn(DEFAULT_OPTIONS, k)) throw new Error(`Unknown option "${k}" in config (known: ${Object.keys(DEFAULT_OPTIONS).join(', ')})`);
  }
  const participants = parsed.participants.map((spec) => {
    if (isApiKind(spec.adapter)) {
      if (spec.capabilities?.can_edit_files) throw new Error(`Participant ${spec.name}: API participants cannot edit files`);
      if (spec.roles?.includes('grunt')) throw new Error(`Participant ${spec.name}: API participants cannot be the local executor (grunt)`);
    }
    return new Participant({
      name: spec.name,
      adapter: buildAdapter(spec),
      roles: spec.roles,
      capabilities: spec.capabilities ?? {},
    });
  });
  const byName = new Map();
  for (const p of participants) {
    if (byName.has(p.name)) throw new Error(`Duplicate participant name: ${p.name}`);
    byName.set(p.name, p);
  }
  return { participants, byName, routing: parsed.routing ?? {}, options };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vendors.js src/adapters/api.js src/config.js test
git commit -m "feat: text-only Anthropic/OpenAI API adapters and vendor mapping"
```
