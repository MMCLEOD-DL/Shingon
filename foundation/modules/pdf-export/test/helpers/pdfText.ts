import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * The text items of each page, in the order they were drawn (pdfjs reads the content stream in order), without the
 * blank items pdfjs adds between runs. pdfjs-dist 6 has no `isEvalSupported`: it never compiles code from a PDF.
 */
export async function pdfPages(buf: Buffer): Promise<string[][]> {
  const task = getDocument({ data: new Uint8Array(buf), disableFontFace: true, useSystemFonts: false, verbosity: VerbosityLevel.ERRORS });
  try {
    const doc = await task.promise;
    const pages: string[][] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const content = await (await doc.getPage(n)).getTextContent();
      pages.push(content.items.flatMap((i) => ('str' in i && i.str.trim() !== '' ? [i.str] : [])));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** True when `wanted` appears as consecutive items of `items`. */
export function seq(items: readonly string[], wanted: readonly string[]): boolean {
  for (let i = 0; i + wanted.length <= items.length; i += 1) {
    if (wanted.every((w, j) => items[i + j] === w)) return true;
  }
  return false;
}
