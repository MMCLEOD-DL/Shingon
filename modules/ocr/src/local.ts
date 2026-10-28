import { createRequire } from 'node:module';
import path from 'node:path';
import type { Worker as Thread } from 'node:worker_threads';
import Tesseract from 'tesseract.js';
import type { OcrLine } from './extract.js';
import { readPdfText } from './pdfText.js';
import { UnreadableError, type OcrEngine, type OcrInputType, type OcrResult } from './types.js';

const { createWorker, OEM, PSM } = Tesseract;

export const HEIC_REFUSED = "Photos in HEIC format can't be read automatically. Please type the details, or take the photo again from this page.";
export const TOO_SLOW = 'This receipt took too long to read. Please type the details.';
export const IMAGE_UNREADABLE = "This picture couldn't be opened. Please type the details.";

const IMAGE_TYPES: ReadonlySet<OcrInputType> = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ENGINE_ID = 'local-tesseract';

/**
 * Where Tesseract finds its model: the `4.0.0_best_int` English model inside the `@tesseract.js-data/eng` package,
 * read from disk with no cache. Without an explicit local `langPath`, tesseract.js downloads the model from a CDN at
 * run time; that must never happen on a client box.
 */
export function localEngineOptions(): { langPath: string; gzip: true; cacheMethod: 'none' } {
  const pkg = createRequire(import.meta.url).resolve('@tesseract.js-data/eng/package.json');
  return { langPath: path.join(path.dirname(pkg), '4.0.0_best_int'), gzip: true, cacheMethod: 'none' };
}

/** One Tesseract worker, and a promise that settles if its thread crashes or exits. */
interface Slot {
  worker: Tesseract.Worker;
  died: Promise<'died'>;
}

async function startSlot(): Promise<Slot> {
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    ...localEngineOptions(),
    // tesseract.js calls these from its message handler: without them, progress or a failed job throws there,
    // outside any promise, and would bring the server down. A failed job still rejects its own promise.
    logger: () => undefined,
    errorHandler: () => undefined,
  });
  // PSM 6, one uniform block of text, not PSM 4 (one column). Measured on the rendered corpus (Plan 12 Task 3):
  // with PSM 4 (and 3) Tesseract split the right-aligned prices into their own column and dropped the TOTAL and VAT
  // lines on every photo, and the date line on a clean taxi receipt (8 of 16 totals right, 7 not found); with PSM 6,
  // 16 of 16. Tesseract's own notes ("Estimating resolution as 326") go nowhere.
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, debug_file: '/dev/null' });
  // The worker thread itself (not in tesseract.js's types). Without an 'error' listener a crashed thread would raise
  // an unhandled 'error' event; with it, the crash only retires this worker.
  const thread = (worker as unknown as { worker?: Thread | null }).worker;
  const died = new Promise<'died'>((resolve) => {
    thread?.on('error', () => {
      resolve('died');
    });
    thread?.on('exit', () => {
      resolve('died');
    });
  });
  return { worker, died };
}

/** True when the bytes start like a JPEG, PNG or WebP file, whatever type they were sent as. */
function looksLikeImage(b: Buffer): boolean {
  const jpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
  return jpeg || png || webp;
}

function linesOf(page: Tesseract.Page): OcrLine[] {
  return (page.blocks ?? [])
    .flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
    .map((l) => ({ text: l.text.replace(/\s+/g, ' ').trim(), confidence: Math.min(1, Math.max(0, l.confidence / 100)) }))
    .filter((l) => l.text !== '');
}

/**
 * The local OCR engine: Tesseract (LSTM only) compiled to WebAssembly, in worker threads, entirely on the box.
 * Images (JPEG, PNG, WebP) are passed as bytes, never as URLs; PDFs are read through their text layer in a thread
 * of their own (pdfText.ts). A reading that takes longer than `timeoutMs`, fails, or whose thread crashes retires
 * its worker (a fresh one is started for the next reading) and is reported as unreadable.
 *
 * The workers are a small pool rather than a tesseract.js scheduler, so that one stuck job can be stopped
 * without stopping the others.
 */
export async function createLocalEngine(opts: { workers?: number; timeoutMs?: number } = {}): Promise<OcrEngine> {
  const size = Math.max(1, opts.workers ?? 1);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const idle: Slot[] = [];
  const live = new Set<Slot>();
  const waiting: { resolve: (s: Slot) => void; reject: (e: unknown) => void }[] = [];
  let starting = 0;
  let closed = false;
  const closedError = (): Error => new Error('The OCR engine has been closed.');
  // Resolves when the engine is closed, so a reading in progress stops waiting for its (terminated) worker.
  let markClosed: () => void = () => undefined;
  const whenClosed = new Promise<'closed'>((resolve) => {
    markClosed = () => {
      resolve('closed');
    };
  });

  // Take a worker out of the pool for good and stop it; a fresh one starts when someone needs it.
  const retire = (slot: Slot): void => {
    live.delete(slot);
    const at = idle.indexOf(slot);
    if (at >= 0) idle.splice(at, 1);
    void slot.worker.terminate().catch(() => undefined);
    fill();
  };
  const track = (slot: Slot): void => {
    live.add(slot);
    void slot.died.then(() => {
      if (live.has(slot)) retire(slot);
    });
  };
  // Start workers while someone is waiting and the pool is below its size.
  const fill = (): void => {
    while (!closed && waiting.length > starting && live.size + starting < size) {
      starting += 1;
      startSlot().then(
        (slot) => {
          starting -= 1;
          track(slot);
          release(slot);
        },
        (e: unknown) => {
          starting -= 1;
          waiting.shift()?.reject(e);
          fill();
        },
      );
    }
  };
  const release = (slot: Slot): void => {
    if (closed || !live.has(slot)) {
      live.delete(slot);
      void slot.worker.terminate().catch(() => undefined);
      return;
    }
    const next = waiting.shift();
    if (next) next.resolve(slot);
    else idle.push(slot);
  };
  const acquire = (): Promise<Slot> => {
    if (closed) return Promise.reject(closedError());
    const slot = idle.pop();
    if (slot) return Promise.resolve(slot);
    const p = new Promise<Slot>((resolve, reject) => waiting.push({ resolve, reject }));
    fill();
    return p;
  };

  // Start the first worker now, so a broken install fails at start-up rather than on the first receipt.
  const first = await startSlot();
  track(first);
  idle.push(first);

  async function recognise(bytes: Buffer): Promise<OcrLine[]> {
    const slot = await acquire();
    if (closed) {
      release(slot);
      throw closedError();
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
    });
    let outcome: Tesseract.RecognizeResult | 'timeout' | 'closed' | 'died';
    try {
      outcome = await Promise.race([slot.worker.recognize(bytes, { rotateAuto: true }, { blocks: true, text: false }), timedOut, whenClosed, slot.died]);
    } catch {
      // Tesseract could not read the picture. The worker may be left in a bad state, so it is replaced.
      retire(slot);
      throw new UnreadableError(IMAGE_UNREADABLE);
    } finally {
      clearTimeout(timer);
    }
    if (outcome === 'closed') throw closedError();
    if (outcome === 'timeout') {
      retire(slot);
      throw new UnreadableError(TOO_SLOW);
    }
    if (outcome === 'died') {
      retire(slot);
      throw new UnreadableError(IMAGE_UNREADABLE);
    }
    release(slot);
    return linesOf(outcome.data);
  }

  return {
    id: ENGINE_ID,
    kind: 'local',
    outboundId: null,
    async read({ bytes, type }): Promise<OcrResult> {
      const started = performance.now();
      let lines: OcrLine[];
      if (type === 'application/pdf') lines = await readPdfText(bytes, timeoutMs);
      else if (IMAGE_TYPES.has(type) && looksLikeImage(bytes)) lines = await recognise(bytes);
      else if (type === 'image/heic') throw new UnreadableError(HEIC_REFUSED);
      else throw new UnreadableError(IMAGE_UNREADABLE);
      return { engine: ENGINE_ID, lines, warnings: [], ms: Math.round(performance.now() - started) };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      markClosed();
      for (const w of waiting.splice(0)) w.reject(closedError());
      // Every worker stops now, busy ones included; their readings are refused with the closed error.
      const all = [...live];
      live.clear();
      idle.length = 0;
      await Promise.all(all.map((s) => s.worker.terminate().catch(() => undefined)));
    },
  };
}
