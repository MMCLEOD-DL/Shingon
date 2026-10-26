import { test, expect } from 'vitest';
import { hashPassword, verifyPassword, checkPasswordRules } from '../src/auth/password.js';

test('hash format and verification', async () => {
  const h = await hashPassword('correct horse battery');
  expect(h).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  expect(await verifyPassword('correct horse battery', h)).toBe(true);
  expect(await verifyPassword('correct horse batterz', h)).toBe(false);
  expect(await verifyPassword('x', 'garbage')).toBe(false);
  expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
});

test('password rules are plain English', () => {
  expect(checkPasswordRules('short', 'a@b.c')).toBe('Use at least 10 characters.');
  expect(checkPasswordRules('x'.repeat(201), 'a@b.c')).toBe('Use at most 200 characters.');
  expect(checkPasswordRules('alice@hf.test', 'Alice@HF.test')).toBe('Your password cannot be your email address.');
  expect(checkPasswordRules('correct horse battery', 'a@b.c')).toBeNull();
});
