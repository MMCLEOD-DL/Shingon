// test/config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, buildAdapter } from '../src/config.js';

function writeConfig(obj) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const f = path.join(dir, 'config.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('loads the example-shaped config into Participants', () => {
  const f = writeConfig({ participants: [
    { name: 'claude', adapter: 'claude-code', roles: ['author', 'reviewer'] },
    { name: 'local', adapter: 'local-agent', model: 'm', roles: ['grunt'] },
  ]});
  const { participants, byName } = loadConfig(f);
  assert.equal(participants.length, 2);
  assert.equal(byName.get('claude').adapter.kind, 'claude-code');
  assert.equal(byName.get('local').adapter.kind, 'local-agent');
});

test('unknown adapter kind throws naming the participant', () => {
  assert.throws(() => buildAdapter({ name: 'bad', adapter: 'telepathy' }), /bad.*telepathy|telepathy.*bad/);
});

test('local-agent without model throws', () => {
  assert.throws(() => buildAdapter({ name: 'local', adapter: 'local-agent' }), /model/);
});
