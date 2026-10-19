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
