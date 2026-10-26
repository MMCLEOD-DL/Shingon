import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildBundle } from './bundle.js';

test('the bundle holds the compose file, Caddyfile and example settings, and never a real .env', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'hf-bundle-test-'));
  try {
  const { file, included } = buildBundle(undefined, out);
  expect(path.basename(file)).toMatch(/^highland-bundle-\d+\.\d+\.\d+.*\.tar\.gz$/);
  const listed = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  expect(listed).toEqual([...included].sort());
  expect(listed).toEqual(expect.arrayContaining(['compose.yaml', 'Caddyfile', '.env.example']));
  expect(listed).not.toContain('.env');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
