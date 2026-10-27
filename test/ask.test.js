// test/ask.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createAsk } from '../src/ui/ask.js';
import { secretValues, forgetRememberedSecrets } from '../src/secrets.js';

function io(isTTY = true) {
  const input = new PassThrough(); const output = new PassThrough(); let out = '';
  output.on('data', (d) => { out += d; });
  return { input, ask: createAsk({ input, output, isTTY }), out: () => out };
}

test('without a terminal every question fails closed and prints nothing', async () => {
  const { ask, out } = io(false);
  assert.equal(ask.isTTY, false);
  assert.equal(io().ask.isTTY, true);
  assert.equal(await ask.text('Host?'), null);
  assert.equal(await ask.secret('Token'), null);
  assert.equal(await ask.confirm('Sure?'), false);
  assert.equal(out(), '');
});

test('a secret is not echoed, is remembered for redaction, and supports backspace', async () => {
  const { input, ask, out } = io();
  const p = ask.secret('Matrix token');
  input.write('syt_abcx\x7fdef\r');
  assert.equal(await p, 'syt_abcdef');
  assert.equal(out(), 'Matrix token (hidden) > \n');
  assert.ok(secretValues({}).includes('syt_abcdef'));
  forgetRememberedSecrets();
});

test('text uses the default, and repeats until the check passes', async () => {
  const { input, ask, out } = io();
  const p = ask.text('Port?', { def: '22', check: (a) => (/^\d+$/.test(a) ? null : 'Type a number.') });
  input.write('abc\n\n');
  assert.equal(await p, '22');
  assert.match(out(), /Port\? \[22\] > Type a number\.\nPort\? \[22\] > /);
});

test('Ctrl-C in a secret prompt gives null', async () => {
  const { input, ask } = io();
  const p = ask.secret('Token');
  input.write('ab\x03');
  assert.equal(await p, null);
});

test('a CR that ends a secret does not swallow the next prompt\'s Enter', async () => {
  const { input, ask } = io();
  const s = ask.secret('Key');
  input.write('abcdefgh\r');
  assert.equal(await s, 'abcdefgh');
  const t = ask.text('Region?', { def: 'eu-west-2' });
  input.write('\n');
  assert.equal(await t, 'eu-west-2');
  forgetRememberedSecrets();
});

test('arrow keys leave nothing in a secret', async () => {
  const { input, ask } = io();
  const p = ask.secret('Key');
  input.write('abc\x1b[Ade\x1bOBfgh\r');
  assert.equal(await p, 'abcdefgh');
  forgetRememberedSecrets();
});

test('raw mode is switched on and restored, also on Ctrl-C', async () => {
  const { input, ask } = io();
  const calls = [];
  input.setRawMode = (v) => { calls.push(v); };
  const a = ask.secret('One'); input.write('abcdefgh\r'); await a;
  const b = ask.secret('Two'); input.write('ab\x03'); assert.equal(await b, null);
  assert.deepEqual(calls, [true, false, true, false]);
  forgetRememberedSecrets();
});
