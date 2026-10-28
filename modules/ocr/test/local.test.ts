import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createLocalEngine, localEngineOptions, UnreadableError, type OcrEngine } from '../src/index.js';
import { pngBomb } from './helpers.js';

let engine: OcrEngine;
const fx = (p: string) => readFileSync(new URL(`./fixtures/receipts/${p}`, import.meta.url));
beforeAll(async () => { engine = await createLocalEngine({ workers: 1, timeoutMs: 60_000 }); }, 120_000);
afterAll(async () => { await engine.close(); });

test('the model is read from disk, never downloaded', () => {
  const o = localEngineOptions();
  expect(path.isAbsolute(o.langPath)).toBe(true);
  expect(existsSync(path.join(o.langPath, 'eng.traineddata.gz'))).toBe(true);
  expect(o.cacheMethod).toBe('none');
  expect(o.langPath).not.toMatch(/^https?:/);
});

test('a clean receipt is read with its total in the lines', async () => {
  const r = await engine.read({ bytes: fx('rendered/taxi-clean.png'), type: 'image/png' });
  expect(r.engine).toBe('local-tesseract');
  expect(r.lines.map((l) => l.text).join('\n')).toMatch(/12\.40/);
  expect(r.lines.every((l) => l.confidence >= 0 && l.confidence <= 1)).toBe(true);
}, 60_000);

test('a photo-like JPEG is read', async () => {
  const r = await engine.read({ bytes: fx('rendered/cafe-photo.jpg'), type: 'image/jpeg' });
  expect(r.lines.length).toBeGreaterThan(3);
}, 60_000);

test('HEIC is refused with a sentence staff can act on', async () => {
  await expect(engine.read({ bytes: Buffer.from('....ftypheic'), type: 'image/heic' })).rejects.toThrow(UnreadableError);
  await expect(engine.read({ bytes: Buffer.from('....ftypheic'), type: 'image/heic' })).rejects.toMatchObject({
    userMessage: "Photos in HEIC format can't be read automatically. Please type the details, or take the photo again from this page.",
  });
});

test('engine identity', () => {
  expect(engine).toMatchObject({ id: 'local-tesseract', kind: 'local', outboundId: null });
});

test('bytes that are not a picture are refused, not a crash, and the engine keeps working', async () => {
  await expect(engine.read({ bytes: Buffer.from('not a picture at all'), type: 'image/png' })).rejects.toMatchObject({
    userMessage: "This picture couldn't be opened. Please type the details.",
  });
  const r = await engine.read({ bytes: fx('rendered/taxi-clean.png'), type: 'image/png' });
  expect(r.lines.length).toBeGreaterThan(3);
}, 60_000);

describe('a reading that takes too long', () => {
  let bomb: Buffer;
  beforeAll(async () => { bomb = await pngBomb(30_000); }, 60_000);    // 30000 x 30000 px, about 2.8 s to fail

  test('is refused, and the next reading gets a fresh worker that reads it', async () => {
    const slow = await createLocalEngine({ workers: 1, timeoutMs: 1500 });
    try {
      const started = performance.now();
      await expect(slow.read({ bytes: bomb, type: 'image/png' })).rejects.toMatchObject({
        userMessage: 'This receipt took too long to read. Please type the details.',
      });
      expect(performance.now() - started).toBeLessThan(5000);                 // unbounded, it fails after about 2.8 s with another sentence
      const r = await slow.read({ bytes: fx('rendered/taxi-clean.png'), type: 'image/png' });
      expect(r.lines.map((l) => l.text).join('\n')).toMatch(/12\.40/);
    } finally {
      await slow.close();
    }
  }, 60_000);

  test('with two workers, does not hold up a reading running beside it', async () => {
    const pair = await createLocalEngine({ workers: 2, timeoutMs: 1500 });
    try {
      const [stuck, taxi] = await Promise.allSettled([
        pair.read({ bytes: bomb, type: 'image/png' }),
        pair.read({ bytes: fx('rendered/taxi-clean.png'), type: 'image/png' }),
      ]);
      expect(stuck).toMatchObject({ status: 'rejected', reason: { userMessage: 'This receipt took too long to read. Please type the details.' } });
      expect(taxi.status).toBe('fulfilled');
      if (taxi.status === 'fulfilled') expect(taxi.value.lines.map((l) => l.text).join('\n')).toMatch(/12\.40/);
    } finally {
      await pair.close();
    }
  }, 60_000);
});

test('closing the engine stops a reading in progress instead of leaving it waiting', async () => {
  const other = await createLocalEngine({ workers: 1, timeoutMs: 60_000 });
  const reading = other.read({ bytes: fx('rendered/supermarket-clean.png'), type: 'image/png' });
  const settled = reading.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 50));                     // the worker is now reading
  await other.close();
  await settled;
  await expect(reading).rejects.toThrow('The OCR engine has been closed.');
  await expect(other.read({ bytes: fx('rendered/taxi-clean.png'), type: 'image/png' })).rejects.toThrow('The OCR engine has been closed.');
}, 60_000);
