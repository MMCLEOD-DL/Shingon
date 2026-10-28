import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createLocalEngine, localEngineOptions, UnreadableError, type OcrEngine } from '../src/index.js';
import { imageSize } from '../src/local.js';
import { pngBomb, pngDots } from './helpers.js';

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

const TOO_LARGE = 'This picture is too large to read. Please type the details, or take the photo again from this page.';

/** Only the start of a JPEG (a JFIF segment, then a baseline frame header) or a WebP (an extended header) of this size. */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(64)]);
}
function webpHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(64);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(56, 4);
  b.write('WEBPVP8X', 8, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

describe('a picture over 25 megapixels', () => {
  test('is refused by its header, before it is decoded (PNG, JPEG, WebP)', async () => {
    const png = await pngBomb(5500);                                   // 30.25 MP
    for (const [bytes, type] of [[png, 'image/png'], [jpegHeader(6000, 5000), 'image/jpeg'], [webpHeader(6000, 5000), 'image/webp']] as const) {
      const started = performance.now();
      await expect(engine.read({ bytes, type })).rejects.toMatchObject({ userMessage: TOO_LARGE });
      expect(performance.now() - started).toBeLessThan(200);
    }
  }, 60_000);

  test('the header sizes are read right', () => {
    expect(imageSize(fx('rendered/taxi-clean.png'))).toEqual({ width: 947, height: 794 });
    expect(imageSize(fx('rendered/cafe-photo.jpg'))).toEqual({ width: 1500, height: 1348 });
    expect(imageSize(jpegHeader(6000, 5000))).toEqual({ width: 6000, height: 5000 });
    expect(imageSize(webpHeader(6000, 5000))).toEqual({ width: 6000, height: 5000 });
    expect(imageSize(Buffer.from('\xff\xd8\xff not really a JPEG at all, no frame header here', 'latin1'))).toBeNull();
  });
});

describe('a reading that takes too long', () => {
  let bomb: Buffer;
  beforeAll(async () => { bomb = await pngDots(4800, 5000); }, 60_000);    // 24 MP of dots, about 6 s to read

  test('is refused, and the next reading gets a fresh worker that reads it', async () => {
    const slow = await createLocalEngine({ workers: 1, timeoutMs: 1500 });
    try {
      const started = performance.now();
      await expect(slow.read({ bytes: bomb, type: 'image/png' })).rejects.toMatchObject({
        userMessage: 'This receipt took too long to read. Please type the details.',
      });
      expect(performance.now() - started).toBeLessThan(5000);                 // unbounded, it takes about 6 s
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
