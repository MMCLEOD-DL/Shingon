import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OcrLine } from './extract.js';
import type { PdfWorkerReply } from './pdfWorker.js';
import { UnreadableError } from './types.js';

export const SCANNED_PDF = "This PDF is a scanned picture, so it can't be read automatically. Please type the details.";
export const UNOPENABLE_PDF = "This PDF couldn't be opened. Please type the details.";
export const TOO_MANY_PAGES_PDF = "This PDF has more than 3 pages, so it can't be read automatically. Please type the details.";
export const PARTLY_SCANNED_PDF = "Part of this PDF is a scanned picture or a blank page, so it can't be read automatically. Please type the details.";

/** The longest a PDF may take, whatever the engine's own timeout. */
const PDF_MAX_MS = 3_000;
/** The most resident memory the PDF reader process may use, and how often that is checked (here and in the process). */
export const PDF_MEMORY_CEILING = 320 * 1024 * 1024;
const WATCHDOG_MS = 20;
/** The largest PDF read at all. The engine has no size limit of its own (the reading queue's maxBytes comes later). */
const PDF_MAX_BYTES = 20 * 1024 * 1024;
/** The largest reply taken from the reader process (three pages of text need far less). */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;
/** A little past the app's own timeout: the reader process's own deadline, should the app be stuck or gone. */
const CHILD_DEADLINE_MARGIN_MS = 1_000;

// dist/pdfChild.js in the app; src/pdfChild.ts (run with Node's type stripping) in the tests.
const compiled = new URL('./pdfChild.js', import.meta.url);
const fromSource = !existsSync(fileURLToPath(compiled));
const CHILD_FILE = fileURLToPath(fromSource ? new URL('./pdfChild.ts', import.meta.url) : compiled);
// Explicit flags only, never the app's own (process.execArgv) or NODE_OPTIONS (the environment is empty). Node
// 22.13–22.17 strip TypeScript types only with the flag; later versions accept it and do so anyway.
const NODE_FLAGS = ['--max-old-space-size=256', ...(fromSource ? ['--experimental-strip-types', '--no-warnings'] : [])];

/** For the tests of the defences only: skip the pre-scan, or change the ceilings, or see the reader process. */
export interface PdfReadOptions {
  preScan?: boolean;
  ceilingBytes?: number;
  childCeilingBytes?: number;
  onChild?: (child: ChildProcess) => void;
}

// One PDF process at a time: the others wait their turn (each one's time limit starts when it runs).
let queue: Promise<unknown> = Promise.resolve();

/**
 * The text layer of a PDF receipt (e-tickets, online orders), as lines with confidence 1: the text is exact, not
 * recognised. A PDF of more than three pages is refused whole rather than read in part, so a total or date on a later
 * page can't go unseen; the pages are counted from the file itself, not from its declared page count. A PDF with no
 * text (a scan), one where any page has no text (part scanned, or a blank page), or one that won't open is refused
 * too, each with a sentence staff can act on. Scripts and embedded fonts are never run or loaded.
 *
 * Each PDF is read in a process of its own (pdfChild.ts), one at a time, so whatever it costs goes back to the
 * system when the process ends. Inside, a pre-scan (pdfWorker.ts) refuses compression bombs before pdfjs runs; it is
 * a first line only. Two watchdogs hold the process to PDF_MEMORY_CEILING of resident memory, each on its own: the
 * process checks itself from a thread pdfjs never blocks, and this side checks it from /proc and kills it. A read
 * longer than min(timeoutMs, 3 s) is killed too. Files over 20 MB are refused outright.
 */
export function readPdfText(bytes: Buffer, timeoutMs: number, opts: PdfReadOptions = {}): Promise<OcrLine[]> {
  if (bytes.length > PDF_MAX_BYTES) return Promise.reject(new UnreadableError(UNOPENABLE_PDF));
  const turn = queue.then(() => readInProcess(bytes, Math.min(timeoutMs, PDF_MAX_MS), opts));
  queue = turn.catch(() => undefined);
  return turn;
}

async function readInProcess(bytes: Buffer, ms: number, opts: PdfReadOptions): Promise<OcrLine[]> {
  const reply = await runReader(bytes, ms, opts);
  if (reply?.ok === false && reply.problem === 'too-many-pages') throw new UnreadableError(TOO_MANY_PAGES_PDF);
  if (reply?.ok === false && reply.problem === 'partly-scanned') throw new UnreadableError(PARTLY_SCANNED_PDF);
  if (reply === null || !reply.ok) throw new UnreadableError(UNOPENABLE_PDF);
  if (reply.lines.length === 0) throw new UnreadableError(SCANNED_PDF);
  return reply.lines.map((text) => ({ text, confidence: 1 }));
}

/** The process's resident memory in bytes, from /proc/<pid>/status (VmRSS), or null when it can't be read. */
function residentBytes(pid: number): number | null {
  const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${String(pid)}/status`, 'latin1'));
  return m ? Number(m[1]) * 1024 : null;
}

function isReply(v: unknown): v is PdfWorkerReply {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { ok?: unknown; lines?: unknown };
  return r.ok === false || (r.ok === true && Array.isArray(r.lines) && r.lines.every((l) => typeof l === 'string'));
}

/**
 * Runs one reader process to its end: its reply, or null for any other ending. Settles only once the process has
 * exited and been reaped ('close'), so the next one starts after its memory is back with the system; the timeout and
 * the watchdog are cleared then. The error listeners stay: a late error has somewhere harmless to go.
 */
function runReader(bytes: Buffer, ms: number, opts: PdfReadOptions): Promise<PdfWorkerReply | null> {
  const ceiling = opts.ceilingBytes ?? PDF_MEMORY_CEILING;
  const args = [...NODE_FLAGS, CHILD_FILE, String(opts.childCeilingBytes ?? PDF_MEMORY_CEILING), opts.preScan === false ? 'no-pre-scan' : 'pre-scan', String(ms + CHILD_DEADLINE_MARGIN_MS)];
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'ignore'], env: {} });
    } catch (e) {
      process.stderr.write(`The PDF reader process could not start: ${e instanceof Error ? e.message : String(e)}\n`);
      resolve(null);
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let stopped = false; // killed here: by the watchdog, the timeout or an oversized reply
    let settled = false;
    const stop = (): void => {
      stopped = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, ms);
    const watchdog = setInterval(() => {
      try {
        const rss = child.pid === undefined ? null : residentBytes(child.pid);
        if (rss !== null && rss > ceiling) stop();
      } catch {
        // Already gone (or /proc unreadable): its exit is handled below, and the process watches itself too.
      }
    }, WATCHDOG_MS);
    const settle = (value: PdfWorkerReply | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      resolve(value);
    };
    child.on('error', (e: Error) => {
      // It could not be started (no pid, so no exit follows), or could not be signalled.
      process.stderr.write(`The PDF reader process failed: ${e.message.split('\n')[0] ?? ''}\n`);
      if (child.pid === undefined) settle(null);
      else if (!stopped) stop();
    });
    // The process stopped reading (it exited): its exit says the rest.
    child.stdin?.on('error', () => undefined);
    child.stdout?.on('error', () => undefined);
    child.stdout?.on('data', (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > MAX_REPLY_BYTES) stop();
      else out.push(c);
    });
    // 'close' comes once the process has exited (and been reaped) and its output is complete.
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (stopped || code !== 0) {
        // Its own watchdog ends it with SIGKILL (a refused PDF is not a fault, so not logged); anything else is.
        if (!stopped && signal !== 'SIGKILL') process.stderr.write(`The PDF reader process stopped: ${signal ?? `exit code ${String(code)}`}\n`);
        settle(null);
        return;
      }
      let reply: unknown = null;
      try {
        reply = JSON.parse(Buffer.concat(out).toString('utf8'));
      } catch {
        // not a reply
      }
      settle(isReply(reply) ? reply : null);
    });
    opts.onChild?.(child);
    child.stdin?.end(bytes);
  });
}
