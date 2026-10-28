/**
 * The PDF reader process, started by pdfText.ts for one PDF and gone when it is read: its memory goes back to the
 * system when it exits. It takes the PDF on stdin and writes one JSON reply (a PdfWorkerReply) on stdout.
 *
 * The reading itself runs in a worker thread (pdfWorker.ts), so this main thread stays free to watch the memory: it
 * checks the whole process's resident memory every 20 ms and exits with OVER_CEILING as soon as it is over the
 * ceiling, however busy the reading thread is. pdfText.ts watches it from outside too.
 *
 * Arguments: the ceiling in bytes, then "pre-scan" or "no-pre-scan" (the latter only in tests of the watchdogs).
 * Self-contained on purpose (Node built-ins, type-only imports): in the tests it runs from the TypeScript source
 * with Node's type stripping, in the app from dist/.
 */
import { Worker } from 'node:worker_threads';
import type { PdfWorkerInput, PdfWorkerReply } from './pdfWorker.js';

/** Exit codes (pdfText.ts knows them too): over the memory ceiling; the reading thread failed or never answered. */
const OVER_CEILING = 3;
const READER_FAILED = 4;
const WATCH_MS = 20;

const ceiling = Number(process.argv[2]);
const preScan = process.argv[3] !== 'no-pre-scan';
if (!(ceiling > 0)) process.exit(READER_FAILED);

setInterval(() => {
  if (process.memoryUsage.rss() > ceiling) process.exit(OVER_CEILING);
}, WATCH_MS);

const chunks: Buffer[] = [];
process.stdin.on('data', (c: Buffer) => chunks.push(c));
process.stdin.on('end', () => {
  const pdf = Buffer.concat(chunks);
  chunks.length = 0;
  const data = new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  const input: PdfWorkerInput = { data, preScan };
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const worker = new Worker(new URL(`./pdfWorker.${ext}`, import.meta.url), {
    workerData: input,
    resourceLimits: { maxOldGenerationSizeMb: 256 },
    // pdfjs's own messages must not reach stdout, which carries the reply: they are dropped.
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  const failed = (): never => process.exit(READER_FAILED);
  worker.once('error', failed);
  worker.once('exit', failed);
  worker.once('message', (reply: PdfWorkerReply) => {
    worker.off('exit', failed); // the thread ends once it has answered
    process.stdout.write(JSON.stringify(reply), () => process.exit(0));
  });
});
