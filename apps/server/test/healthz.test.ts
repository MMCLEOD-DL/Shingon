import { test, expect } from 'vitest';
import { createTestApp } from './helpers/testApp.js';

test('/healthz answers ok to anyone and tells them nothing else', async () => {
  const t = await createTestApp();
  try {
    const r = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok' });
    expect(t.app.hf.routes.find((x) => x.url === '/healthz')?.access).toEqual({ public: 'liveness for Docker' });
  } finally {
    await t.close();
  }
});
