import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestApp } from './helpers/testApp.js';

test('the server serves the app for page paths and JSON 404 for unknown API paths', async () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'dist-'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>HF</title>');
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  const t = await createTestApp({ webDistDir: dist });
  const page = await t.app.inject({ method: 'GET', url: '/notes/123' });
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('<title>HF</title>');
  expect(page.headers['cache-control']).toBe('no-cache');
  const api = await t.app.inject({ method: 'GET', url: '/api/nope' });
  expect(api.statusCode).toBe(404);
  expect(api.json()).toEqual({ error: "We couldn't find that." });
  expect(api.headers['cache-control']).toBe('no-store');
  // hashed assets are cacheable for a year; a missing asset is not quietly answered with the app page
  const asset = await t.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
  expect(asset.statusCode).toBe(200);
  expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  // the static file routes are on the crossing gate's allow-list, and nothing else slipped past defineRoute
  const declared = new Set([...t.app.hf.routes, ...t.app.hf.staticRoutes].map((r) => `${r.method} ${r.url}`));
  expect(t.app.hf.allRoutes.filter((r) => r.method !== 'HEAD' && !declared.has(`${r.method} ${r.url}`))).toEqual([]);
  expect(t.app.hf.staticRoutes.map((r) => r.url)).toContain('/index.html');
  await t.close();
});

test('without a built app the server answers page paths with the plain 404', async () => {
  const t = await createTestApp();
  const page = await t.app.inject({ method: 'GET', url: '/notes' });
  expect(page.statusCode).toBe(404);
  expect(t.app.hf.staticRoutes).toEqual([]);
  await t.close();
});
