// test/roles.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRolePreset, ROLES } from '../src/roles.js';

test('exposes the closed role set', () => {
  assert.deepEqual(ROLES, ['author', 'reviewer', 'grunt']);
});

test('reviewer preset asks for a VERDICT line', () => {
  const p = getRolePreset('reviewer');
  assert.match(p.outputShape, /VERDICT:/);
  assert.ok(p.systemPrompt.length > 0);
});

test('author and grunt presets exist and differ', () => {
  assert.notEqual(getRolePreset('author').systemPrompt, getRolePreset('grunt').systemPrompt);
});

test('unknown role throws naming the role', () => {
  assert.throws(() => getRolePreset('boss'), /boss/);
});

test('prototype-key role names throw, not return inherited members', () => {
  assert.throws(() => getRolePreset('constructor'), /constructor/);
  assert.throws(() => getRolePreset('__proto__'), /__proto__/);
  assert.throws(() => getRolePreset('toString'), /toString/);
});
