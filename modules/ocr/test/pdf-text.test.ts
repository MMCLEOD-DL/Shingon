import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { createLocalEngine, UnreadableError, type OcrEngine } from '../src/index.js';
import { readPdfText, PDF_MEMORY_CEILING, type PdfReadOptions } from '../src/pdfText.js';
import { bypassBombs, formFeedPdf, modernPdf, n4Bomb, pdfBomb, pdfWithContent, predictorBomb, trickyBombs } from './helpers.js';

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

  test.each(trickyBombs())('%s', async (_label, bomb) => {
    const growth = await peakGrowthMb(() => expect(engine.read({ bytes: bomb, type: 'application/pdf' })).rejects.toMatchObject({ userMessage: UNOPENABLE }));
    expect(growth.rss).toBeLessThan(300);
    expect(growth.arrayBuffers).toBeLessThan(300);
  }, 30_000);

  test.each(bypassBombs())('%s is refused by the pre-scan itself', async (_label, bomb) => {
    const r = await readWatched(bomb);
    expect(r.error).toMatchObject({ userMessage: UNOPENABLE });
    expect(r.exit).toEqual({ code: 0, signal: null }); // the reader answered "unopenable": no watchdog was needed
    expect(r.peakMb).toBeLessThan(200);
  }, 30_000);

  test('a "stream" line with a form feed before its end still reads', async () => {
    const r = await engine.read({ bytes: formFeedPdf(), type: 'application/pdf' });
    expect(r.lines.map((l) => l.text)).toContain('Total 3.20');
  });

  test('a PDF with an object stream and a predicted cross-reference stream still reads', async () => {
    const r = await engine.read({ bytes: modernPdf(), type: 'application/pdf' });
    expect(r.lines.map((l) => l.text)).toContain('Total 3.20');
  });

  test('after all that, the e-ticket still reads', async () => {
    const r = await engine.read({ bytes: fx('pdf/e-ticket.pdf'), type: 'application/pdf' });
    expect(r.lines.some((l) => /Total £3\.20/.test(l.text))).toBe(true);
  });
});

/** Polls a process's peak resident memory (VmHWM) every 5 ms from a thread of its own, so a busy main thread can't stop it. */
const MONITOR = `
const { workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const s = new Int32Array(workerData);
setInterval(() => {
  const pid = Atomics.load(s, 0);
  if (pid === 0) return;
  try {
    const m = /VmHWM:\\s+(\\d+) kB/.exec(readFileSync('/proc/' + pid + '/status', 'latin1'));
    if (m) Atomics.store(s, 1, Math.max(Atomics.load(s, 1), Number(m[1])));
  } catch {}
}, 5);
`;

interface Watched {
  error: unknown;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  peakMb: number;
  pid: number;
}

/** Reads a PDF through readPdfText and reports how its reader process ended and its peak resident memory. */
async function readWatched(bytes: Buffer, opts: PdfReadOptions = {}): Promise<Watched> {
  const shared = new SharedArrayBuffer(8);
  const state = new Int32Array(shared);
  const monitor = new Worker(MONITOR, { eval: true, workerData: shared });
  await new Promise((r) => setTimeout(r, 50)); // the monitor is running
  let exit: Watched['exit'] = null;
  let error: unknown = null;
  try {
    await readPdfText(bytes, 60_000, {
      ...opts,
      onChild: (child: ChildProcess) => {
        Atomics.store(state, 0, child.pid ?? 0);
        child.once('exit', (code, signal) => {
          exit = { code, signal };
        });
        opts.onChild?.(child);
      },
    });
  } catch (e) {
    error = e;
  } finally {
    await monitor.terminate();
  }
  return { error, exit, peakMb: (Atomics.load(state, 1) * 1024) / 1e6, pid: Atomics.load(state, 0) };
}

const CEILING_MB = PDF_MEMORY_CEILING / 1e6;
/** How far past the ceiling memory may get between two checks (20 ms of inflating). */
const OVERSHOOT_MB = 80;
/** The reader process ends itself with SIGKILL when its own watchdog fires, so the app's kill and its own look alike. */
const KILLED = { code: null, signal: 'SIGKILL' };

describe('the reader process is held to its memory ceiling, whatever the pre-scan says', () => {
  test('by its own watchdog', async () => {
    const r = await readWatched(n4Bomb(), { preScan: false, ceilingBytes: 64 * PDF_MEMORY_CEILING });
    expect(r.error).toMatchObject({ userMessage: UNOPENABLE });
    expect(r.exit).toEqual(KILLED);
    // It reached the ceiling (sampled every few ms from outside, so the last few MB before the kill may be missed).
    expect(r.peakMb).toBeGreaterThan(CEILING_MB * 0.9);
    expect(r.peakMb).toBeLessThan(CEILING_MB + OVERSHOOT_MB);
  }, 30_000);

  test('by the app\'s watchdog, which kills it', async () => {
    const r = await readWatched(n4Bomb(), { preScan: false, childCeilingBytes: 64 * PDF_MEMORY_CEILING });
    expect(r.error).toMatchObject({ userMessage: UNOPENABLE });
    expect(r.exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(r.peakMb).toBeLessThan(CEILING_MB + OVERSHOOT_MB);
  }, 30_000);

  test('each watchdog stops even a harmless PDF that goes over its ceiling', async () => {
    const own = await readWatched(fx('pdf/e-ticket.pdf'), { childCeilingBytes: 1 });
    expect(own.exit).toEqual(KILLED);
    expect(own.error).toMatchObject({ userMessage: UNOPENABLE });
    const app = await readWatched(fx('pdf/e-ticket.pdf'), { ceilingBytes: 1 });
    expect(app.exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(app.error).toMatchObject({ userMessage: UNOPENABLE });
  }, 30_000);

  test('while the app\'s main thread is blocked for 1 s, the process still stops itself at the ceiling', async () => {
    const r = await readWatched(n4Bomb(), {
      preScan: false,
      onChild: (child) => {
        // Once the PDF has been handed over, the app is stuck for a second: its own watchdog can't run.
        child.stdin?.once('finish', () => {
          const end = performance.now() + 1000;
          while (performance.now() < end);
        });
      },
    });
    expect(r.error).toMatchObject({ userMessage: UNOPENABLE });
    expect(r.exit).toEqual(KILLED);
    expect(r.peakMb).toBeLessThan(CEILING_MB + OVERSHOOT_MB);
  }, 30_000);

  test('a stalled app still sees the process stop near the ceiling on wide predictor rows (its stop is immediate)', async () => {
    const r = await readWatched(predictorBomb(), {
      onChild: (child) => {
        child.stdin?.once('finish', () => {
          const end = performance.now() + 2000;
          while (performance.now() < end);
        });
      },
    });
    expect(r.error).toMatchObject({ userMessage: UNOPENABLE });
    expect(r.exit).toEqual(KILLED);
    expect(r.peakMb).toBeLessThan(CEILING_MB + OVERSHOOT_MB);
  }, 30_000);

  test('20 bombs in a row that each reach a watchdog leave the app\'s memory flat', async () => {
    const bomb = n4Bomb();
    const before = process.memoryUsage.rss();
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage.rss());
    }, 10);
    const pids: number[] = [];
    try {
      for (let i = 0; i < 20; i += 1) {
        const r = await readWatched(bomb, { preScan: false });
        expect(r.error).toMatchObject({ userMessage: UNOPENABLE });
        expect(r.exit).toEqual(KILLED);
        expect(r.peakMb).toBeLessThan(CEILING_MB + OVERSHOOT_MB);
        pids.push(r.pid);
      }
    } finally {
      clearInterval(sampler);
    }
    peak = Math.max(peak, process.memoryUsage.rss());
    expect((peak - before) / 1e6).toBeLessThan(100);
    // Every reader process is gone, none left as a zombie.
    for (const pid of pids) expect(existsSync(`/proc/${String(pid)}`)).toBe(false);
    // And a normal PDF still reads afterwards.
    const r = await engine.read({ bytes: fx('pdf/e-ticket.pdf'), type: 'application/pdf' });
    expect(r.lines.some((l) => /Total £3\.20/.test(l.text))).toBe(true);
  }, 120_000);
});
