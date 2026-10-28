import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { OcrLine } from './extract.js';
import type { PdfWorkerReply } from './pdfWorker.js';
import { UnreadableError } from './types.js';

export const SCANNED_PDF = "This PDF is a scanned picture, so it can't be read automatically. Please type the details.";
export const UNOPENABLE_PDF = "This PDF couldn't be opened. Please type the details.";

/** The longest a PDF may take, whatever the engine's own timeout. */
const PDF_MAX_MS = 3_000;
/** How much the process may grow while a PDF is read before its thread is stopped, and how often that is checked. */
const PDF_MAX_GROWTH = 192 * 1024 * 1024;
const WATCHDOG_MS = 20;
/** The largest PDF read at all. The engine has no size limit of its own (the reading queue's maxBytes comes later). */
const PDF_MAX_BYTES = 20 * 1024 * 1024;

// dist/pdfWorker.js in the app; src/pdfWorker.ts (run with Node's type stripping) in the tests.
const compiled = new URL('./pdfWorker.js', import.meta.url);
const fromSource = !existsSync(fileURLToPath(compiled));
const WORKER_FILE = fromSource ? new URL('./pdfWorker.ts', import.meta.url) : compiled;
// Node 22.13–22.17 strip TypeScript types only with this flag; later versions accept it and do so anyway.
const EXEC_ARGV = fromSource ? [...process.execArgv, '--experimental-strip-types'] : process.execArgv;

// One PDF thread at a time: the others wait their turn (each one's time limit starts when it runs).
let queue: Promise<unknown> = Promise.resolve();

/**
 * The text layer of a PDF receipt (e-tickets, online orders), as lines with confidence 1: the text is exact, not
 * recognised. Only the first three pages are read. A PDF with no text (a scan) or one that won't open is refused
 * with a sentence staff can act on. Scripts and embedded fonts are never run or loaded.
 *
 * The PDF is read in its own worker thread, one at a time, with a heap limit and a timeout of min(timeoutMs, 3 s).
 * Before pdfjs runs, the thread checks the raw file (pdfWorker.ts): only unfiltered, FlateDecode and DCTDecode
 * streams, inflating to at most 32 MB in all, so a compression bomb is refused without being inflated. That check
 * is a first line only: while the thread runs, a watchdog stops it as soon as the process's memory (RSS or
 * ArrayBuffers, where inflated streams live, outside the heap limit) has grown more than 192 MB. Files over 20 MB
 * are refused outright.
 */
export function readPdfText(bytes: Buffer, timeoutMs: number, limits: { maxGrowthBytes?: number } = {}): Promise<OcrLine[]> {
  if (bytes.length > PDF_MAX_BYTES) return Promise.reject(new UnreadableError(UNOPENABLE_PDF));
  const turn = queue.then(() => readInThread(bytes, timeoutMs, limits.maxGrowthBytes ?? PDF_MAX_GROWTH));
  queue = turn.catch(() => undefined);
  return turn;
}

async function readInThread(bytes: Buffer, timeoutMs: number, maxGrowth: number): Promise<OcrLine[]> {
  const worker = new Worker(WORKER_FILE, {
    execArgv: EXEC_ARGV,
    workerData: new Uint8Array(bytes),
    resourceLimits: { maxOldGenerationSizeMb: 256 },
    stdout: true,
    stderr: true,
  });
  let timer: NodeJS.Timeout | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  const baseline = process.memoryUsage();
  const reply = await new Promise<PdfWorkerReply | null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, Math.min(timeoutMs, PDF_MAX_MS));
    // The memory watchdog: pdfjs's inflated streams are outside the thread's heap limit, and the pre-scan in the
    // thread is only a first line, so the thread is stopped as soon as the process has grown too much.
    watchdog = setInterval(() => {
      const now = process.memoryUsage();
      if (now.rss - baseline.rss > maxGrowth || now.arrayBuffers - baseline.arrayBuffers > maxGrowth) resolve(null);
    }, WATCHDOG_MS);
    worker.once('message', (m: PdfWorkerReply) => {
      resolve(m);
    });
    // Out of memory, a crash, a thread that could not start, or an exit without an answer. The error's own
    // message is logged (it never holds the PDF's content); staff see the plain sentence.
    worker.once('error', (e: Error) => {
      process.stderr.write(`The PDF reader thread failed: ${e.message.split('\n')[0] ?? ''}\n`);
      resolve(null);
    });
    worker.once('exit', () => {
      resolve(null);
    });
  });
  clearTimeout(timer);
  clearInterval(watchdog);
  worker.removeAllListeners('error');
  worker.on('error', () => undefined);
  await worker.terminate();
  if (reply === null || !reply.ok) throw new UnreadableError(UNOPENABLE_PDF);
  if (reply.lines.length === 0) throw new UnreadableError(SCANNED_PDF);
  return reply.lines.map((text) => ({ text, confidence: 1 }));
}
