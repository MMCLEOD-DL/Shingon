import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  expect(listed).toEqual(['.env.example', 'Caddyfile', 'RUNBOOK.md', 'compose.yaml']);
  expect(listed).not.toContain('.env');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a missing runbook stops the bundle: it is required, never silently left out', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hf-bundle-root-'));
  try {
    const real = new URL('..', import.meta.url).pathname;
    mkdirSync(path.join(root, 'deploy'));
    for (const f of ['package.json', 'deploy/compose.yaml', 'deploy/Caddyfile', 'deploy/.env.example']) cpSync(path.join(real, f), path.join(root, f));
    expect(() => buildBundle(root, path.join(root, 'out'))).toThrow('docs/RUNBOOK.md is missing, so the bundle cannot be made.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
