import { test, expect } from 'vitest';
import { DEFAULT_PROFILE, MODULES, type AppProfile } from '@hf/shared';
import { OcrPolicyError, type EngineMakers } from '@hf/ocr';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { createFakeOcr } from './helpers/fakeOcr.js';
import { makeUser } from './helpers/factories.js';
import { upload } from './helpers/readings.js';
import { CROSSING_APP } from './crossing/world.js';
import { createReadingEngine } from '../src/modules/ocr/index.js';
import type { Config } from '../src/config.js';

const readingRoute = (url: string): boolean => url.startsWith('/api/readings') || url.endsWith('/reading');

test('with ocr off, no reading route exists and no engine is started', async () => {
  const engine = createFakeOcr();
  const t = await createTestApp({ profile: structuredClone(DEFAULT_PROFILE), ocrEngine: engine });
  try {
    expect(t.app.hf.allRoutes.filter((r) => readingRoute(r.url))).toEqual([]);
    expect(t.app.hf.routes.filter((r) => readingRoute(r.url))).toEqual([]);
    expect(t.app.hf.readings).toBeNull();
    const u = await makeUser(t.db, { role: 'member' });
    const f = await upload(t, u, 'taxi-photo.jpg');
    const r = await call(t, await signInAs(t, u), 'POST', `/api/files/${f.id}/reading`, {});
    expect(r.status).toBe(404);
    expect(engine.reads).toBe(0);
  } finally {
    await t.close();
  }

  // What main.ts does at start-up: with ocr off, no engine is made at all.
  let made = 0;
  const makers: EngineMakers = {
    local: async () => { made++; return createFakeOcr(); },
    azure: () => { made++; return createFakeOcr(); },
  };
  expect(await createReadingEngine({ profile: structuredClone(DEFAULT_PROFILE), ocr: { engine: 'local', concurrency: 1, timeoutMs: 1000 } }, { makers })).toBeNull();
  expect(made).toBe(0);
  const on: AppProfile = { ...structuredClone(DEFAULT_PROFILE), modules: ['ocr'] };
  const engine2 = await createReadingEngine({ profile: on, ocr: { engine: 'local', concurrency: 1, timeoutMs: 1000 } }, { makers });
  expect(engine2?.id).toBe('fake');
  expect(made).toBe(1);
});

test('start-up never lets a plain-http loopback address through as the Azure endpoint', async () => {
  // config.ts lets http://127.0.0.1 through in test mode for the stub; the app itself must still refuse it (allowHttpLoopback is false).
  const profile: AppProfile = { schema: 1, modules: ['ocr'], policy: { outbound: ['azure-document-intelligence'], residency: 'uk' } };
  const ocr: Config['ocr'] = { engine: 'azure', concurrency: 1, timeoutMs: 1000, azure: { endpoint: 'http://127.0.0.1:9', key: 'k'.repeat(32), region: 'uksouth' } };
  let made = 0;
  const makers: EngineMakers = { local: async () => { made++; return createFakeOcr(); }, azure: () => { made++; return createFakeOcr(); } };
  const err = await createReadingEngine({ profile, ocr }, { makers }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(OcrPolicyError);
  expect((err as OcrPolicyError).problems.join(' ')).toContain('OCR_AZURE_ENDPOINT');
  expect(JSON.stringify((err as OcrPolicyError).problems)).not.toContain('k'.repeat(32));
  expect(made).toBe(0);
});

test('the crossing world runs with every module on', async () => {
  const t = await createTestApp(CROSSING_APP);
  try {
    expect([...t.config.profile.modules].sort()).toEqual([...MODULES].sort());
    expect(t.app.hf.readings).not.toBeNull();
  } finally {
    await t.close();
  }
});
