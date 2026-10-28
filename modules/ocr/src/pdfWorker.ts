/**
 * Runs inside a worker thread (started by pdfText.ts): reads the text layer of one PDF and posts back its lines, or
 * why it could not. Self-contained on purpose (only pdfjs-dist, type-only imports): in the tests it runs from the
 * TypeScript source with Node's type stripping, in the app from dist/.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { inflateSync } from 'node:zlib';

export type PdfWorkerReply = { ok: true; lines: string[] } | { ok: false; problem: 'unopenable' };

const MAX_PAGES = 3;
/** The most all the compressed streams of one PDF may inflate to, together. A receipt needs far less. */
const INFLATE_BUDGET = 32 * 1024 * 1024;
// A stream's dictionary and the start of its data: "<< … >>" then "stream" and its end-of-line.
const STREAM_START = /stream(?:\r\n|\n|\r)/g;
const FILTER = /\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\]|\d+\s+\d+\s+R)/;
// An inline image ("BI … ID") whose data names a filter: pdfjs would decode it outside the budget.
const INLINE_IMAGE_FILTER = /\bBI\b[^]{0,4096}?\/(?:F|Filter)\b[^]{0,4096}?\bID\b/;

/**
 * Checks the raw PDF before pdfjs sees it, so a compression bomb is refused without being inflated: every stream
 * must be unfiltered, FlateDecode or DCTDecode (JPEG pictures, which reading text never decodes), and all the
 * FlateDecode streams together must inflate to at most INFLATE_BUDGET. Each stream's data runs to the next
 * "endstream" and must inflate completely, so a stream cut short by a stray "endstream" is refused too.
 */
function withinBudget(data: Uint8Array): boolean {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const text = bytes.toString('latin1');
  let budget = INFLATE_BUDGET;
  let past = 0; // the end of the last stream's data: a "stream" inside binary data is not a keyword
  for (const m of text.matchAll(STREAM_START)) {
    const at = m.index;
    if (at < past) continue;
    // "endstream" contains "stream"; only the keyword that opens a stream counts.
    if (text.slice(Math.max(0, at - 3), at) === 'end') continue;
    const dictStart = text.lastIndexOf('obj', at);
    const dict = dictStart < 0 ? '' : text.slice(dictStart, at);
    const dataStart = at + m[0].length;
    const dataEnd = text.indexOf('endstream', dataStart);
    if (dataEnd < 0) return false;
    past = dataEnd;
    const found = FILTER.exec(dict)?.[1];
    const filters = found === undefined ? [] : (found.match(/\/[A-Za-z0-9]+/g) ?? ['?']);
    if (/R$/.test(found ?? '')) return false; // a filter given by reference
    if (filters.some((f) => f !== '/FlateDecode' && f !== '/DCTDecode')) return false;
    if (filters.length > 1 && !(filters.length === 2 && filters[0] === '/FlateDecode' && filters[1] === '/DCTDecode')) return false;
    let decoded: Buffer | null = null;
    if (filters[0] === '/FlateDecode') {
      if (budget <= 0) return false;
      try {
        decoded = inflateSync(bytes.subarray(dataStart, dataEnd), { maxOutputLength: budget });
      } catch {
        return false; // over the budget, or not a complete zlib stream
      }
      budget -= decoded.length;
    } else if (filters.length === 0) {
      decoded = bytes.subarray(dataStart, dataEnd);
    }
    if (decoded && filters.length < 2 && INLINE_IMAGE_FILTER.test(decoded.toString('latin1'))) return false;
  }
  return true;
}

interface Item {
  str: string;
  x: number;
  y: number;
  height: number;
}

/** Items whose baselines are within half a line of each other form one line, read left to right, top to bottom. */
function groupIntoLines(items: Item[]): string[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Item[][] = [];
  for (const item of sorted) {
    const row = rows.at(-1);
    const first = row?.[0];
    if (row && first && Math.abs(first.y - item.y) <= Math.max(first.height, item.height, 1) / 2) row.push(item);
    else rows.push([item]);
  }
  return rows
    .map((row) => row.sort((a, b) => a.x - b.x).map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim())
    .filter((text) => text !== '');
}

async function read(data: Uint8Array): Promise<PdfWorkerReply> {
  if (!withinBudget(data)) return { ok: false, problem: 'unopenable' };
  // Loaded only once the file has passed the check.
  const { getDocument, VerbosityLevel } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    // pdfjs-dist 6 no longer has `isEvalSupported`: it never compiles code from a PDF.
    data,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    const doc = await task.promise;
    const lines: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n += 1) {
      const content = await (await doc.getPage(n)).getTextContent();
      const items = content.items.flatMap((i) =>
        'str' in i && i.str.trim() !== '' ? [{ str: i.str, x: i.transform[4] as number, y: i.transform[5] as number, height: i.height }] : [],
      );
      lines.push(...groupIntoLines(items));
    }
    return { ok: true, lines };
  } catch {
    return { ok: false, problem: 'unopenable' };
  } finally {
    await task.destroy();
  }
}

if (parentPort) {
  const port = parentPort;
  void read(workerData as Uint8Array).then((reply) => {
    port.postMessage(reply);
  });
}
