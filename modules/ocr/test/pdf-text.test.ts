import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createLocalEngine, UnreadableError, type OcrEngine } from '../src/index.js';
import { pdfBomb, pdfWithContent } from './helpers.js';

let engine: OcrEngine;
const fx = (p: string) => readFileSync(new URL(`./fixtures/receipts/${p}`, import.meta.url));
beforeAll(async () => { engine = await createLocalEngine(); }, 120_000);    // default settings
afterAll(async () => { await engine.close(); });

test('a text PDF gives its lines with confidence 1', async () => {
  const r = await engine.read({ bytes: fx('pdf/e-ticket.pdf'), type: 'application/pdf' });
  expect(r.engine).toBe('local-tesseract');
  expect(r.lines.some((l) => /Total £3\.20/.test(l.text))).toBe(true);
  expect(r.lines.every((l) => l.confidence === 1)).toBe(true);
});

test('a scanned PDF is refused', async () => {
  const read = engine.read({ bytes: fx('pdf/scanned.pdf'), type: 'application/pdf' });
  await expect(read).rejects.toThrow(UnreadableError);
  await expect(read).rejects.toMatchObject({
    userMessage: "This PDF is a scanned picture, so it can't be read automatically. Please type the details.",
  });
});

test('a PDF that is not a PDF inside is refused, not a crash', async () => {
  const read = engine.read({ bytes: Buffer.from('%PDF-1.7 junk'), type: 'application/pdf' });
  await expect(read).rejects.toThrow(UnreadableError);
  await expect(read).rejects.toMatchObject({ userMessage: "This PDF couldn't be opened. Please type the details." });
});

const UNOPENABLE = "This PDF couldn't be opened. Please type the details.";

/** Runs `work` and returns how far the process's memory grew at its peak, in MB (sampled every 10 ms). */
async function peakGrowthMb(work: () => Promise<unknown>): Promise<{ rss: number; arrayBuffers: number }> {
  const before = process.memoryUsage();
  let rss = before.rss;
  let arrayBuffers = before.arrayBuffers;
  const sample = (): void => {
    const m = process.memoryUsage();
    rss = Math.max(rss, m.rss);
    arrayBuffers = Math.max(arrayBuffers, m.arrayBuffers);
  };
  const timer = setInterval(sample, 10);
  try {
    await work();
  } finally {
    clearInterval(timer);
    sample();
  }
  return { rss: (rss - before.rss) / 1e6, arrayBuffers: (arrayBuffers - before.arrayBuffers) / 1e6 };
}

describe('compression bombs are refused before they are inflated (default engine settings)', () => {
  test.each([
    ['1 GB', 1],
    ['4 GB', 4],
  ])('a PDF that inflates to %s', async (_label, gib) => {
    const bomb = pdfBomb(gib);
    expect(bomb.length).toBeLessThan(gib * 1.1e6);
    const started = performance.now();
    const growth = await peakGrowthMb(() => expect(engine.read({ bytes: bomb, type: 'application/pdf' })).rejects.toMatchObject({ userMessage: UNOPENABLE }));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(growth.rss).toBeLessThan(200);
    expect(growth.arrayBuffers).toBeLessThan(200);
  }, 30_000);

  test('two at once are both refused', async () => {
    const bomb = pdfBomb(1);
    const growth = await peakGrowthMb(async () => {
      const both = await Promise.allSettled([engine.read({ bytes: bomb, type: 'application/pdf' }), engine.read({ bytes: bomb, type: 'application/pdf' })]);
      for (const r of both) expect(r).toMatchObject({ status: 'rejected', reason: { userMessage: UNOPENABLE } });
    });
    expect(growth.rss).toBeLessThan(200);
  }, 30_000);

  test('a stream with any other filter is refused', async () => {
    for (const dict of ['/Filter /LZWDecode', '/Filter /ASCII85Decode', '/Filter [/ASCII85Decode /FlateDecode]', '/Filter 9 0 R']) {
      await expect(engine.read({ bytes: pdfWithContent(dict, Buffer.from('BT /F1 12 Tf (Total 3.20) Tj ET')), type: 'application/pdf' })).rejects.toMatchObject({ userMessage: UNOPENABLE });
    }
  });

  test('after all that, the e-ticket still reads', async () => {
    const r = await engine.read({ bytes: fx('pdf/e-ticket.pdf'), type: 'application/pdf' });
    expect(r.lines.some((l) => /Total £3\.20/.test(l.text))).toBe(true);
  });
});
