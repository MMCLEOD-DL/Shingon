// test/localAgent.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { LocalAgentAdapter } from '../src/adapters/localAgent.js';

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
