import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 32768;
const R = 8;
const P = 1;
const MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  const opts: ScryptOptions = { N: n, r, p, maxmem: MAXMEM };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLen, opts, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P, KEY_BYTES);
  return `scrypt$${String(N)}$${String(R)}$${String(P)}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [n, r, p] = [parts[1], parts[2], parts[3]].map((v) => (v !== undefined && /^\d{1,7}$/.test(v) ? Number(v) : NaN)) as [number, number, number];
    if (![n, r, p].every((v) => Number.isInteger(v) && v > 0) || n < 2 || (n & (n - 1)) !== 0) return false;
    const salt = Buffer.from(parts[4] ?? '', 'base64url');
    const expected = Buffer.from(parts[5] ?? '', 'base64url');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await derive(password, salt, n, r, p, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Returns a plain-English problem with the password, or null when it is acceptable. */
export function checkPasswordRules(password: string, email: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 200) return 'Use at most 200 characters.';
  if (password.trim().toLowerCase() === email.trim().toLowerCase()) return 'Your password cannot be your email address.';
  return null;
}
