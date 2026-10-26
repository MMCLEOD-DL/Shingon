import { test, expect, vi, afterEach } from 'vitest';
import { api, ApiError } from '../src/api.js';

afterEach(() => vi.unstubAllGlobals());
test('server errors arrive as plain-English ApiError', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: "You don't have permission to do that." }), { status: 403, headers: { 'content-type': 'application/json' } })));
  await expect(api('GET', '/api/users')).rejects.toMatchObject({ status: 403, message: "You don't have permission to do that." });
});
test('a network failure says so plainly', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  const e = await api('GET', '/api/me').catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect((e as ApiError).message).toBe("Couldn't reach the server. Check your connection and try again.");
});
test('204 resolves to undefined and JSON bodies are sent as JSON', async () => {
  const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', f);
  expect(await api('POST', '/api/auth/sign-out', { a: 1 })).toBeUndefined();
  expect(f.mock.calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"a":1}' });
});
test('a 200 that is not JSON becomes the plain message, not a SyntaxError', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway page</html>', { status: 200, headers: { 'content-type': 'text/html' } })));
  const e = await api('GET', '/api/me').catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect((e as ApiError).message).toBe('Something went wrong. Please try again.');
});
