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

// PDF whitespace (NUL counts) and delimiters.
const WS = new Set(['\0', '\t', '\n', '\f', '\r', ' ']);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);
const OBJ_HEADER = /(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+obj(?![^\0\t\n\f\r ()<>[\]{}/%])/g;
// "stream" opening a stream's data: optional spaces or tabs, then the end of line. Not "endstream".
const STREAM_KEYWORD = /(?<!end)stream[ \t\0]*(?:\r\n|\n|\r)/g;
// An inline image ("BI … ID") whose data names a filter: pdfjs would decode it outside the budget.
const INLINE_IMAGE_FILTER = /\bBI\b[^]{0,4096}?\/(?:F|Filter)\b[^]{0,4096}?\bID\b/;

type Value = { kind: 'name'; name: string } | { kind: 'array'; items: Value[] } | { kind: 'ref' } | { kind: 'other' };

/** A minimal reader for one PDF object's dictionary: names (with #xx escapes), strings, nested dictionaries, arrays. */
class Reader {
  // Plain fields, not constructor parameter properties: this file also runs with Node's type stripping.
  private readonly text: string;
  at: number;

  constructor(text: string, at: number) {
    this.text = text;
    this.at = at;
  }

  skipSpace(): void {
    for (;;) {
      const c = this.text[this.at];
      if (c === undefined) return;
      if (WS.has(c)) this.at += 1;
      else if (c === '%') {
        while (this.at < this.text.length && this.text[this.at] !== '\n' && this.text[this.at] !== '\r') this.at += 1;
      } else return;
    }
  }

  private regular(): string {
    const start = this.at;
    while (this.at < this.text.length && !WS.has(this.text[this.at] ?? '') && !DELIM.has(this.text[this.at] ?? '')) this.at += 1;
    return this.text.slice(start, this.at);
  }

  private literalString(): void {
    let depth = 0;
    for (; this.at < this.text.length; this.at += 1) {
      const c = this.text[this.at];
      if (c === '\\') this.at += 1;
      else if (c === '(') depth += 1;
      else if (c === ')' && --depth === 0) {
        this.at += 1;
        return;
      }
    }
  }

  /** One value; a number followed by "G R" is a reference. Throws on anything malformed. */
  value(): Value {
    this.skipSpace();
    const c = this.text[this.at];
    if (c === undefined) throw new Error('end');
    if (c === '/') {
      this.at += 1;
      return { kind: 'name', name: '/' + this.regular().replace(/#([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))) };
    }
    if (c === '<' && this.text[this.at + 1] === '<') {
      this.dict();
      return { kind: 'other' };
    }
    if (c === '<') {
      const end = this.text.indexOf('>', this.at);
      if (end < 0) throw new Error('hex');
      this.at = end + 1;
      return { kind: 'other' };
    }
    if (c === '(') {
      this.literalString();
      return { kind: 'other' };
    }
    if (c === '[') {
      this.at += 1;
      const items: Value[] = [];
      for (;;) {
        this.skipSpace();
        if (this.text[this.at] === ']') {
          this.at += 1;
          return { kind: 'array', items };
        }
        items.push(this.value());
      }
    }
    if (c === ')' || c === '>' || c === ']' || c === '{' || c === '}') throw new Error('delimiter');
    const token = this.regular();
    if (token === '') throw new Error('token');
    if (/^\d+$/.test(token)) {
      const save = this.at;
      this.skipSpace();
      const gen = this.regular();
      this.skipSpace();
      if (/^\d+$/.test(gen) && this.text[this.at] === 'R' && (WS.has(this.text[this.at + 1] ?? ' ') || DELIM.has(this.text[this.at + 1] ?? ''))) {
        this.at += 1;
        return { kind: 'ref' };
      }
      this.at = save;
    }
    return { kind: 'other' };
  }

  /** A dictionary starting at "<<"; returns its top-level entries. */
  dict(): Map<string, Value> {
    const entries = new Map<string, Value>();
    this.skipSpace();
    if (!this.text.startsWith('<<', this.at)) throw new Error('dict');
    this.at += 2;
    for (;;) {
      this.skipSpace();
      if (this.text.startsWith('>>', this.at)) {
        this.at += 2;
        return entries;
      }
      const key = this.value();
      if (key.kind !== 'name') throw new Error('key');
      entries.set(key.name, this.value());
    }
  }
}

/** The filter names of a /Filter entry, or null when it is anything else (a reference, a string …). */
function filterNames(v: Value | undefined): string[] | null {
  if (v === undefined) return [];
  if (v.kind === 'name') return [v.name];
  if (v.kind === 'array' && v.items.every((i) => i.kind === 'name')) return v.items.map((i) => (i as { name: string }).name);
  return null;
}

/**
 * Checks the raw PDF before pdfjs sees it — a cheap first line; the memory watchdog in pdfText.ts is the backstop.
 * Every object is read from its header ("4 0 obj"); a stream's top-level dictionary must have no /Filter,
 * /FlateDecode, /DCTDecode (JPEG pictures, which reading text never decodes) or [/FlateDecode /DCTDecode], and all
 * the FlateDecode streams together must inflate to at most INFLATE_BUDGET. Each stream's data runs to the next
 * "endstream" and must inflate completely. A "stream" keyword outside every object read this way is refused, as is
 * any dictionary this reader can't follow.
 */
function withinBudget(data: Uint8Array): boolean {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const text = bytes.toString('latin1');
  let budget = INFLATE_BUDGET;
  const streams: { start: number; end: number }[] = [];
  OBJ_HEADER.lastIndex = 0;
  for (let m = OBJ_HEADER.exec(text); m !== null; m = OBJ_HEADER.exec(text)) {
    const reader = new Reader(text, m.index + m[0].length);
    reader.skipSpace();
    if (!text.startsWith('<<', reader.at)) continue; // not a dictionary, so not a stream
    let dict: Map<string, Value>;
    try {
      dict = reader.dict();
    } catch {
      return false;
    }
    reader.skipSpace();
    STREAM_KEYWORD.lastIndex = reader.at;
    const kw = STREAM_KEYWORD.exec(text);
    if (!kw || kw.index !== reader.at) continue; // a dictionary object without a stream
    const dataStart = kw.index + kw[0].length;
    const dataEnd = text.indexOf('endstream', dataStart);
    if (dataEnd < 0) return false;
    streams.push({ start: kw.index, end: dataEnd });
    OBJ_HEADER.lastIndex = dataEnd; // an "obj" inside the data is not a header
    const filters = filterNames(dict.get('/Filter'));
    if (filters === null) return false;
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
  // Any "stream" keyword this reading did not account for: pdfjs might find a stream we did not check.
  STREAM_KEYWORD.lastIndex = 0;
  for (const kw of text.matchAll(STREAM_KEYWORD)) {
    if (!streams.some((st) => kw.index >= st.start && kw.index < st.end)) return false;
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
