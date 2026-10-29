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
  expect(String(page.headers['content-security-policy'])).toContain("default-src 'self'");
  // HEAD on a page path is answered like GET, without a body
  const head = await t.app.inject({ method: 'HEAD', url: '/notes/123' });
  expect(head.statusCode).toBe(200);
  expect(head.body).toBe('');
  expect(String(head.headers['content-type'])).toContain('text/html');
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

test('caching follows the path inside the built app, not the folder it sits in', async () => {
  // The whole app lives under a folder called "assets"; only its own assets/ folder may be cached for a year.
  const dist = path.join(mkdtempSync(path.join(tmpdir(), 'site-')), 'assets', 'dist');
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>HF</title>');
  writeFileSync(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  const t = await createTestApp({ webDistDir: dist });
  expect((await t.app.inject({ method: 'GET', url: '/index.html' })).headers['cache-control']).toBe('no-cache');
  expect((await t.app.inject({ method: 'GET', url: '/favicon.svg' })).headers['cache-control']).toBe('no-cache');
  expect((await t.app.inject({ method: 'GET', url: '/assets/app-abc123.js' })).headers['cache-control']).toBe('public, max-age=31536000, immutable');
  await t.close();
});
