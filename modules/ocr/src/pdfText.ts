import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { OcrLine } from './extract.js';
import { UnreadableError } from './types.js';

export const SCANNED_PDF = "This PDF is a scanned picture, so it can't be read automatically. Please type the details.";
export const UNOPENABLE_PDF = "This PDF couldn't be opened. Please type the details.";

const MAX_PAGES = 3;

interface Item {
  str: string;
  x: number;
  y: number;
  height: number;
}

/**
 * The text layer of a PDF receipt (e-tickets, online orders), as lines with confidence 1: the text is exact, not
 * recognised. Only the first three pages are read. A PDF with no text (a scan) or one that won't open is refused
 * with a sentence staff can act on. Scripts and embedded fonts are never run or loaded.
 */
export async function readPdfText(bytes: Buffer): Promise<OcrLine[]> {
  const task = getDocument({
    // pdfjs-dist 6 no longer has `isEvalSupported`: it never compiles code from a PDF.
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch {
      throw new UnreadableError(UNOPENABLE_PDF);
    }
    const lines: OcrLine[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n += 1) {
      let items: Item[];
      try {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        items = content.items.flatMap((i) =>
          'str' in i && i.str.trim() !== '' ? [{ str: i.str, x: i.transform[4] as number, y: i.transform[5] as number, height: i.height }] : [],
        );
      } catch {
        throw new UnreadableError(UNOPENABLE_PDF);
      }
      lines.push(...groupIntoLines(items).map((text) => ({ text, confidence: 1 })));
    }
    if (lines.length === 0) throw new UnreadableError(SCANNED_PDF);
    return lines;
  } finally {
    await task.destroy();
  }
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
