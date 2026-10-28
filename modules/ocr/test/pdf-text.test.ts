import { test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createLocalEngine, UnreadableError, type OcrEngine } from '../src/index.js';
import { pdfBomb } from './helpers.js';

let engine: OcrEngine;
const fx = (p: string) => readFileSync(new URL(`./fixtures/receipts/${p}`, import.meta.url));
beforeAll(async () => { engine = await createLocalEngine({ workers: 1, timeoutMs: 60_000 }); }, 120_000);
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

test('a compression-bomb PDF is stopped within the timeout, and the engine still reads the next PDF', async () => {
  const bomb = await pdfBomb();                                     // about 1 MB that inflates to 1 GB
  const quick = await createLocalEngine({ workers: 1, timeoutMs: 1500 });
  try {
    const started = performance.now();
    await expect(quick.read({ bytes: bomb, type: 'application/pdf' })).rejects.toMatchObject({
      userMessage: "This PDF couldn't be opened. Please type the details.",
    });
    expect(performance.now() - started).toBeLessThan(5000);                 // unbounded, it runs about 4.6 s and ends "scanned picture"
    const r = await quick.read({ bytes: fx('pdf/e-ticket.pdf'), type: 'application/pdf' });
    expect(r.lines.some((l) => /Total £3\.20/.test(l.text))).toBe(true);
  } finally {
    await quick.close();
  }
}, 60_000);
