import { test, expect } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { LocalDiskStorage } from '../src/files/storage.js';

test('put/get/delete round trip with size and hash; keys are sharded; no temp files left', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'st-'));
  const s = new LocalDiskStorage(root);
  const r = await s.put('ab12cd', Readable.from(['hello ', 'world']));
  expect(r).toEqual({ size: 11, sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9' });
  expect(await text(s.get('ab12cd'))).toBe('hello world');
  expect(readdirSync(path.join(root, 'ab'))).toEqual(['ab12cd']);
  await s.delete('ab12cd');
  expect(readdirSync(path.join(root, 'ab'))).toEqual([]);
  await expect(s.check()).resolves.toBeUndefined();
  expect(() => s.get('../etc/passwd')).toThrow(/invalid storage key/);
});

test('a failed write leaves no temp file and no object', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'st-'));
  const s = new LocalDiskStorage(root);
  const broken = new Readable({ read() { this.push('part'); this.destroy(new Error('boom')); } });
  await expect(s.put('cd34ef', broken)).rejects.toThrow('boom');
  expect(readdirSync(path.join(root, 'cd'))).toEqual([]);
  await expect(s.delete('../x')).rejects.toThrow(/invalid storage key/);
});
