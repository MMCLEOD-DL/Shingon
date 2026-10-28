import { createRequire } from 'node:module';
import path from 'node:path';
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

async function startWorker(): Promise<Tesseract.Worker> {
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    ...localEngineOptions(),
    // tesseract.js calls these from its message handler: without them, progress or a failed job throws there,
    // outside any promise, and would bring the server down. A failed job still rejects its own promise.
    logger: () => undefined,
    errorHandler: () => undefined,
  });
  // A receipt is read as one block of text (see SEGMENTATION). Tesseract's own notes ("Estimating resolution as 326") go nowhere.
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, debug_file: '/dev/null' });
  return worker;
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
 * Images (JPEG, PNG, WebP) are passed as bytes, never as URLs; PDFs are read through their text layer. A reading
 * that takes longer than `timeoutMs` stops its worker, starts a fresh one, and is reported as unreadable.
 *
 * The workers are a small pool rather than a tesseract.js scheduler, so that one stuck job can be stopped
 * without stopping the others.
 */
export async function createLocalEngine(opts: { workers?: number; timeoutMs?: number } = {}): Promise<OcrEngine> {
  const size = Math.max(1, opts.workers ?? 1);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const idle: Tesseract.Worker[] = [];
  const live = new Set<Tesseract.Worker>();
  const waiting: { resolve: (w: Tesseract.Worker) => void; reject: (e: unknown) => void }[] = [];
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

  // Start workers while someone is waiting and the pool is below its size.
  const fill = (): void => {
    while (!closed && waiting.length > starting && live.size + starting < size) {
      starting += 1;
      startWorker().then(
        (w) => {
          starting -= 1;
          live.add(w);
          release(w);
        },
        (e: unknown) => {
          starting -= 1;
          waiting.shift()?.reject(e);
          fill();
        },
      );
    }
  };
  const release = (w: Tesseract.Worker): void => {
    if (closed) {
      live.delete(w);
      void w.terminate();
      return;
    }
    const next = waiting.shift();
    if (next) next.resolve(w);
    else idle.push(w);
  };
  const acquire = (): Promise<Tesseract.Worker> => {
    if (closed) return Promise.reject(closedError());
    const w = idle.pop();
    if (w) return Promise.resolve(w);
    const p = new Promise<Tesseract.Worker>((resolve, reject) => waiting.push({ resolve, reject }));
    fill();
    return p;
  };

  // Start the first worker now, so a broken install fails at start-up rather than on the first receipt.
  const first = await startWorker();
  live.add(first);
  idle.push(first);

  async function recognise(bytes: Buffer): Promise<OcrLine[]> {
    const worker = await acquire();
    if (closed) {
      release(worker);
      throw closedError();
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
    });
    const job = worker.recognize(bytes, { rotateAuto: true }, { blocks: true, text: false });
    let outcome: Tesseract.RecognizeResult | 'timeout' | 'closed';
    try {
      outcome = await Promise.race([job, timedOut, whenClosed]);
    } catch {
      // Tesseract could not decode the picture; the worker is still usable.
      release(worker);
      throw new UnreadableError(IMAGE_UNREADABLE);
    } finally {
      clearTimeout(timer);
    }
    if (outcome === 'closed') {
      // The worker is stopped once its job ends (release does that after close).
      void job.then(
        () => {
          release(worker);
        },
        () => {
          release(worker);
        },
      );
      throw closedError();
    }
    if (outcome === 'timeout') {
      live.delete(worker);
      await worker.terminate().catch(() => undefined);
      fill();
      throw new UnreadableError(TOO_SLOW);
    }
    release(worker);
    return linesOf(outcome.data);
  }

  return {
    id: ENGINE_ID,
    kind: 'local',
    outboundId: null,
    async read({ bytes, type }): Promise<OcrResult> {
      const started = performance.now();
      let lines: OcrLine[];
      if (type === 'application/pdf') lines = await readPdfText(bytes);
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
      // Idle workers stop now; a worker still reading stops when its job ends, and that reading is refused.
      const stopping = idle.splice(0);
      for (const w of stopping) live.delete(w);
      await Promise.all(stopping.map((w) => w.terminate()));
    },
  };
}
