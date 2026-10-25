// test/localAgent.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { LocalAgentAdapter, localCodexConfig } from '../src/adapters/localAgent.js';
import { CodexAdapter } from '../src/adapters/codex.js';

test('drives codex with the localai provider, model, and workspace-write sandbox when writing', async () => {
  const bin = writeStubCli(mkdtempSync(path.join(tmpdir(), 'la-')), 'codex', `
    const oi = args.indexOf('-o');
    require('node:fs').writeFileSync(args[oi+1], args.join(' '));
  `);
  const r = await new LocalAgentAdapter({ bin, model: 'shingon-qwen3.8-27b-q4' }).run('grunt', 'do the chunk', '', { write: true });
  assert.match(r.text, /-c model_provider=localai/);
  assert.match(r.text, /-c model=shingon-qwen3\.8-27b-q4/);
  assert.match(r.text, /--sandbox workspace-write/);
});

test('requires a model', () => {
  assert.throws(() => new LocalAgentAdapter({ bin: 'codex' }), /model/);
});

test('kind is local-agent', () => {
  assert.equal(new LocalAgentAdapter({ model: 'm' }).kind, 'local-agent');
});

test('forwards opts and appends extraConfig after provider/model', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'la-'));
  const bin = writeStubCli(d, 'codex', `
    const oi = args.indexOf('-o');
    require('node:fs').writeFileSync(args[oi+1], 'cwd=' + process.cwd() + ' ' + args.join(' '));
  `);
  const a = new LocalAgentAdapter({ bin, model: 'm1', extraConfig: ['model_providers.localai.base_url=http://127.0.0.1:8091/v1'] });
  const r = await a.run('grunt', 't', '', { cwd: d, write: true });
  assert.ok(r.text.includes('cwd=' + d));
  assert.match(r.text, /-c model_provider=localai -c model=m1 -c model_providers\.localai\.base_url=http:\/\/127\.0\.0\.1:8091\/v1/);
  assert.match(r.text, /--sandbox workspace-write/);
});

test('write:false runs the local agent read-only (T1)', async () => {
  const bin = writeStubCli(mkdtempSync(path.join(tmpdir(), 'la-')), 'codex', `
    const oi = args.indexOf('-o');
    require('node:fs').writeFileSync(args[oi+1], args.join(' '));
  `);
  const r = await new LocalAgentAdapter({ bin, model: 'm' }).run('grunt', 't', '', { write: false });
  assert.match(r.text, /--sandbox read-only/);
  assert.doesNotMatch(r.text, /workspace-write/);
});

// Echoes CODEX_HOME and its config.toml so tests can see what the local Codex was given.
const HOME_ECHO = `
  const fs = require('node:fs');
  const oi = args.indexOf('-o');
  const home = process.env.CODEX_HOME;
  const cfg = home ? fs.readFileSync(require('node:path').join(home, 'config.toml'), 'utf8') : '';
  fs.writeFileSync(args[oi+1], JSON.stringify({ home: home ?? null, cfg, mode: home ? (fs.statSync(home).mode & 0o777) : null }));
`;

test('runs codex with a private CODEX_HOME holding only the provider block, removed afterwards', async () => {
  const bin = writeStubCli(mkdtempSync(path.join(tmpdir(), 'la-')), 'codex', HOME_ECHO);
  const a = new LocalAgentAdapter({ bin, model: 'm', baseUrl: 'http://127.0.0.1:8091/v1', contextWindow: 32768 });
  const seen = JSON.parse((await a.run('grunt', 't', '', { write: true })).text);
  assert.ok(seen.home && !seen.home.startsWith(path.join(process.env.HOME ?? '/nonexistent', '.codex')));
  assert.equal(seen.mode, 0o700);
  assert.ok(!seen.home.startsWith(tmpdir() + path.sep), `home ${seen.home} is under the temp dir`);
  assert.equal(seen.cfg, [
    'model_context_window = 32768',
    '',
    '[model_providers.localai]',
    'name = "localai"',
    'base_url = "http://127.0.0.1:8091/v1"',
    'wire_api = "responses"',
    'env_key = "LOCALAI_API_KEY"',
    '',
  ].join('\n'));
  assert.doesNotMatch(seen.cfg, /mcp|plugin|projects/);
  assert.equal(existsSync(seen.home), false);
});

test('provider block always carries a base_url, defaulting to local LocalAI', async () => {
  const bin = writeStubCli(mkdtempSync(path.join(tmpdir(), 'la-')), 'codex', HOME_ECHO);
  const seen = JSON.parse((await new LocalAgentAdapter({ bin, model: 'm' }).run('grunt', 't')).text);
  assert.match(seen.cfg, /^base_url = "http:\/\/localhost:8080\/v1"$/m);
  assert.doesNotMatch(seen.cfg, /model_context_window/);
});

test('escapes base_url and rejects provider names that are not bare TOML keys', () => {
  assert.match(localCodexConfig({ provider: 'p', baseUrl: 'http://x/"\n[evil]', envKey: 'K' }), /^base_url = "http:\/\/x\/\\"\\n\[evil\]"$/m);
  assert.throws(() => new LocalAgentAdapter({ model: 'm', provider: 'a]\n[b' }), /provider/);
  assert.throws(() => new LocalAgentAdapter({ model: 'm', contextWindow: '32k' }), /contextWindow/);
});

test('frontier codex keeps the user codex home', async () => {
  const bin = writeStubCli(mkdtempSync(path.join(tmpdir(), 'la-')), 'codex', HOME_ECHO);
  const prev = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  try {
    const seen = JSON.parse((await new CodexAdapter({ bin }).run('reviewer', 't')).text);
    assert.equal(seen.home, null);
  } finally {
    if (prev !== undefined) process.env.CODEX_HOME = prev;
  }
});

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

test('probe does not follow a redirect (the key stays with the configured server)', async () => {
  const prev = process.env.LOCALAI_API_KEY;
  process.env.LOCALAI_API_KEY = 'local-probe-key-123456';
  let hits = 0;
  const target = http.createServer((req, res) => { hits++; res.writeHead(200); res.end('{}'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const redirector = http.createServer((req, res) => {
    req.resume();
    res.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/v1/chat/completions` });
    res.end();
  });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  try {
    const r = await new LocalAgentAdapter({ bin: okBin(), model: 'm', baseUrl: `http://127.0.0.1:${redirector.address().port}/v1` }).probe({ timeoutMs: 5000 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unavailable');
    assert.ok(!JSON.stringify(r).includes('local-probe-key-123456'));
    assert.equal(hits, 0);
  } finally {
    if (prev === undefined) delete process.env.LOCALAI_API_KEY; else process.env.LOCALAI_API_KEY = prev;
    for (const s of [redirector, target]) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  }
});

async function withBodyServer(status, body, fn) {
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}/v1`); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

test('probe: LocalAI with no GPU worker is "worker-offline", other 5xx stay "unavailable"', async () => {
  await withBodyServer(500, '{"error":{"message":"no healthy nodes available"}}', async (baseUrl) => {
    const r = await new LocalAgentAdapter({ bin: okBin(), model: 'm', baseUrl }).probe();
    assert.deepEqual(r, { ok: false, reason: 'worker-offline', detail: 'the local model server is running, but no GPU worker is connected to it' });
  });
  await withBodyServer(500, '{"error":"boom"}', async (baseUrl) => {
    const r = await new LocalAgentAdapter({ bin: okBin(), model: 'm', baseUrl }).probe();
    assert.equal(r.reason, 'unavailable');
  });
});
