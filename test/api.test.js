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
