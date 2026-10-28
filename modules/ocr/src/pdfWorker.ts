/**
 * Runs inside a worker thread (started by pdfText.ts): reads the text layer of one PDF and posts back its lines, or
 * why it could not. Self-contained on purpose (only pdfjs-dist, type-only imports): in the tests it runs from the
 * TypeScript source with Node's type stripping, in the app from dist/.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';

export type PdfWorkerReply = { ok: true; lines: string[] } | { ok: false; problem: 'unopenable' };

const MAX_PAGES = 3;

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
