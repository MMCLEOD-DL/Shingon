import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { OcrLine } from './extract.js';
import type { PdfWorkerReply } from './pdfWorker.js';
import { UnreadableError } from './types.js';

export const SCANNED_PDF = "This PDF is a scanned picture, so it can't be read automatically. Please type the details.";
export const UNOPENABLE_PDF = "This PDF couldn't be opened. Please type the details.";

/** The longest a PDF may take, whatever the engine's own timeout. */
const PDF_MAX_MS = 10_000;

// dist/pdfWorker.js in the app; src/pdfWorker.ts (run with Node's type stripping) in the tests.
const compiled = new URL('./pdfWorker.js', import.meta.url);
const WORKER_FILE = existsSync(fileURLToPath(compiled)) ? compiled : new URL('./pdfWorker.ts', import.meta.url);

/**
 * The text layer of a PDF receipt (e-tickets, online orders), as lines with confidence 1: the text is exact, not
 * recognised. Only the first three pages are read. A PDF with no text (a scan) or one that won't open is refused
 * with a sentence staff can act on. Scripts and embedded fonts are never run or loaded.
 *
 * The PDF is read in its own worker thread with a memory limit and a timeout of min(timeoutMs, 10 s), so a hostile
 * PDF (a compression bomb, a parser loop) is stopped and refused instead of exhausting the server. Inflated
 * streams live outside the thread's heap limit, so the timeout is what bounds their memory.
 */
export async function readPdfText(bytes: Buffer, timeoutMs: number): Promise<OcrLine[]> {
  const worker = new Worker(WORKER_FILE, {
    workerData: new Uint8Array(bytes),
    resourceLimits: { maxOldGenerationSizeMb: 256 },
    stdout: true,
    stderr: true,
  });
  let timer: NodeJS.Timeout | undefined;
  const reply = await new Promise<PdfWorkerReply | null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, Math.min(timeoutMs, PDF_MAX_MS));
    worker.once('message', (m: PdfWorkerReply) => {
      resolve(m);
    });
    // Out of memory, a crash, or an exit without an answer.
    worker.once('error', () => {
      resolve(null);
    });
    worker.once('exit', () => {
      resolve(null);
    });
  });
  clearTimeout(timer);
  worker.removeAllListeners('error');
  worker.on('error', () => undefined);
  await worker.terminate();
  if (reply === null || !reply.ok) throw new UnreadableError(UNOPENABLE_PDF);
  if (reply.lines.length === 0) throw new UnreadableError(SCANNED_PDF);
  return reply.lines.map((text) => ({ text, confidence: 1 }));
}
