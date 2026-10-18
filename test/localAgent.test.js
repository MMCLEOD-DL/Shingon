// test/localAgent.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { LocalAgentAdapter } from '../src/adapters/localAgent.js';

test('drives codex with the localai provider, model, and workspace-write sandbox', async () => {
  const bin = writeStubCli(mkdtempSync(path.join(tmpdir(), 'la-')), 'codex', `
    const oi = args.indexOf('-o');
    require('node:fs').writeFileSync(args[oi+1], args.join(' '));
  `);
  const r = await new LocalAgentAdapter({ bin, model: 'shingon-qwen3.8-27b-q4' }).run('grunt', 'do the chunk');
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
