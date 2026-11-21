import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireLease, leaseListenError } from '../../src/service/lease.js';

test('duplicate lease reports its actual listen code and releases for reacquisition', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lease-diagnostic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const release = await acquireLease(dir);
  try {
    await assert.rejects(async () => {
      const releaseUnexpected = await acquireLease(dir);
      await releaseUnexpected(); // Do not leak a listener if singleton refusal regresses.
    }, error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'data-in-use');
      assert.equal(error.listenCode, 'EADDRINUSE');
      assert.match(error.message, /already in use/);
      assert.match(error.message, /listen: EADDRINUSE/);
      assert.equal(error.message.includes(dir), false);
      return true;
    });
  } finally {
    await release();
  }
  const releaseAgain = await acquireLease(dir);
  await releaseAgain();
});

test('lease diagnostics distinguish allowlisted listen codes without copying OS data', () => {
  for (const code of ['EADDRINUSE', 'EACCES', 'EPERM', 'EADDRNOTAVAIL', 'EMFILE', 'ENFILE', 'EINVAL', 'ENOBUFS', 'ENOMEM']) {
    const error = leaseListenError({ code, message: 'synthetic-private-path', address: 'synthetic-private-address', port: 12345 });
    assert.equal(error.listenCode, code);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'data-in-use');
    assert.ok(error.message.endsWith(`[listen: ${code}]`));
    assert.deepEqual(Object.keys(error).sort(), ['code', 'listenCode', 'status']);
    assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /synthetic-private|12345/);
    assert.equal(error.cause, undefined);
  }
});

test('unknown and malformed listen codes produce a constant safe diagnostic', () => {
  for (const input of [null, undefined, {}, { code: 'synthetic-sensitive-code' }, { code: 42 }, { code: {} }, { code: ['EACCES'] }]) {
    const error = leaseListenError(input);
    assert.equal(error.listenCode, 'UNKNOWN');
    assert.ok(error.message.endsWith('[listen: UNKNOWN]'));
    assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /synthetic-sensitive/);
    assert.equal(error.cause, undefined);
  }
});
