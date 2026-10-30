/**
 * Runs inside a worker thread of the PDF reader process (pdfChild.ts, started by pdfText.ts): checks the raw PDF,
 * reads its text layer and posts back its lines, or why it could not. Self-contained on purpose (only pdfjs-dist,
 * type-only imports): in the tests it runs from the TypeScript source with Node's type stripping, in the app from
 * dist/.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { inflateSync } from 'node:zlib';

export type PdfWorkerReply = { ok: true; lines: string[] } | { ok: false; problem: 'unopenable' | 'too-many-pages' | 'partly-scanned' };
/** What the thread is given: the PDF, and whether to check it first (always, except in tests of the watchdogs). */
export interface PdfWorkerInput {
  data: Uint8Array;
  preScan: boolean;
}

/** The most pages read. A longer PDF is refused whole: a total or date on a later page must not go unseen. */
const MAX_PAGES = 3;
/** The most all the compressed streams of one PDF may inflate to, together. A receipt needs far less. */
const INFLATE_BUDGET = 32 * 1024 * 1024;

// PDF whitespace (NUL counts) and delimiters.
const WS = new Set(['\0', '\t', '\n', '\f', '\r', ' ']);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);
const OBJ_HEADER = /(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+obj(?![^\0\t\n\f\r ()<>[\]{}/%])/g;
// The keyword "stream" as a token of its own, as pdfjs's lexer reads it: whitespace, a delimiter or the start of the
// file before it, whitespace, a delimiter or the end after it ("endstream" and "streams" are other tokens).
const NOT_REGULAR = '\\0\\t\\n\\f\\r ()<>\\[\\]{}/%';
const STREAM_KEYWORD = new RegExp(`(?<![^${NOT_REGULAR}])stream(?![^${NOT_REGULAR}])`, 'g');
// The keyword "obj" as a token of its own ("endobj" is another token).
const OBJ_KEYWORD = new RegExp(`(?<![^${NOT_REGULAR}])obj(?![^${NOT_REGULAR}])`, 'g');
// An inline image ("BI … ID") whose data names a filter: pdfjs would decode it outside the budget.
const INLINE_IMAGE_FILTER = /\bBI\b[^]{0,4096}?\/(?:F|Filter)\b[^]{0,4096}?\bID\b/;

type Value =
  | { kind: 'name'; name: string }
  | { kind: 'array'; items: Value[] }
  | { kind: 'ref'; num: number }
  | { kind: 'int'; value: number }
  | { kind: 'other' };

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
        return { kind: 'ref', num: Number(token) };
      }
      this.at = save;
      return { kind: 'int', value: Number(token) };
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

/** Where pdfjs starts a stream's data: after the end of the line holding "stream", whatever else is on it (its skipToNextLine). */
function skipToNextLine(text: string, at: number): number {
  for (; at < text.length; at += 1) {
    if (text[at] === '\r') return text[at + 1] === '\n' ? at + 2 : at + 1;
    if (text[at] === '\n') return at + 1;
  }
  return at;
}

/** True when a stream's dictionary makes it an object stream (pdfjs reads one by its /N and /First alone). */
function isObjectStream(dict: Map<string, Value>): boolean {
  const type = dict.get('/Type');
  return (type?.kind === 'name' && type.name === '/ObjStm') || dict.has('/N') || dict.has('/First');
}

/**
 * The pages a viewer could reach, from every dictionary read: each /Type /Page dictionary, and each object a
 * page-tree node (/Type /Pages, or untyped with /Kids and /Count) lists in /Kids that is not itself a node (pdfjs
 * takes such a kid as a page whatever else it says). Objects are keyed by number, so a redefinition counts once.
 * A /Kids it can't follow (not an array of references) makes the tree unfollowable. Counting too many only ever
 * refuses a PDF.
 */
class PageTree {
  private readonly typed = new Set<number>();
  private readonly kids = new Set<number>();
  private readonly nodes = new Set<number>();
  private readonly seen = new Set<number>();
  unfollowable = false;

  note(num: number, dict: Map<string, Value> | null): void {
    this.seen.add(num);
    if (!dict) return;
    const type = dict.get('/Type');
    if (type?.kind === 'name' && type.name === '/Page') this.typed.add(num);
    const kids = dict.get('/Kids');
    if (kids === undefined) return;
    this.nodes.add(num);
    const pagesNode = type?.kind === 'name' ? type.name === '/Pages' : type === undefined && dict.has('/Count');
    if (!pagesNode) return; // a form field's or other tree's /Kids
    if (kids.kind !== 'array') {
      this.unfollowable = true;
      return;
    }
    for (const kid of kids.items) {
      if (kid.kind === 'ref') this.kids.add(kid.num);
      else this.unfollowable = true;
    }
  }

  /** The number of pages, or null when a kid is an object this reading never found. */
  count(): number | null {
    if (this.unfollowable) return null;
    const pages = new Set(this.typed);
    for (const kid of this.kids) {
      if (!this.seen.has(kid)) return null;
      if (!this.nodes.has(kid)) pages.add(kid);
    }
    return pages.size;
  }
}

/** Notes every object of a decoded object stream in `tree`; false when the stream can't be followed. */
function noteObjectStream(dict: Map<string, Value>, decoded: Buffer, tree: PageTree): boolean {
  const n = dict.get('/N');
  const first = dict.get('/First');
  if (n?.kind !== 'int' || first?.kind !== 'int') return false;
  const text = decoded.toString('latin1');
  const head = new Reader(text, 0);
  try {
    for (let i = 0; i < n.value; i += 1) {
      const num = head.value();
      const offset = head.value();
      if (num.kind !== 'int' || offset.kind !== 'int') return false;
      const at = first.value + offset.value;
      if (at >= text.length) return false;
      const reader = new Reader(text, at);
      reader.skipSpace();
      tree.note(num.value, text.startsWith('<<', reader.at) ? reader.dict() : null);
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * Checks the raw PDF before pdfjs sees it — a cheap first line; the memory watchdogs in pdfChild.ts and pdfText.ts
 * are the backstop. Every object is read from its header ("4 0 obj"); a stream's top-level dictionary must have no
 * filter, /FlateDecode, /DCTDecode (JPEG pictures, which reading text never decodes) or [/FlateDecode /DCTDecode]
 * (under /Filter or its abbreviation /F, which pdfjs also reads), and all the FlateDecode streams together must
 * inflate to at most INFLATE_BUDGET. Each stream's data starts after the end of the "stream" line, as pdfjs starts
 * it, runs to the next "endstream" and must inflate completely. An object stream may not hold a stream (pdfjs would
 * decode one found there without this check seeing it). A "stream" keyword outside every object read this way is
 * refused, as is any dictionary this reader can't follow.
 *
 * It also counts the pages (PageTree), from plain objects and object streams: read() requires pdfjs to visit exactly
 * that many distinct pages, so a page tree whose /Count understates its pages can't hide one. An "obj" keyword that is not part of a header read here is refused (pdfjs allows a comment between
 * the object number and "obj", and such an object would escape the count).
 *
 * Returns the number of pages, or null to refuse the file.
 */
function scan(data: Uint8Array): { pages: number } | null {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const text = bytes.toString('latin1');
  let budget = INFLATE_BUDGET;
  // Where the checked streams' data and the objects' dictionaries are: a "stream" inside them is not a keyword.
  const covered: { start: number; end: number }[] = [];
  const tree = new PageTree();
  const headers = new Set<number>(); // where each header's "obj" keyword is
  OBJ_HEADER.lastIndex = 0;
  for (let m = OBJ_HEADER.exec(text); m !== null; m = OBJ_HEADER.exec(text)) {
    headers.add(m.index + m[0].length - 3);
    const reader = new Reader(text, m.index + m[0].length);
    reader.skipSpace();
    if (!text.startsWith('<<', reader.at)) {
      tree.note(Number(m[1]), null);
      continue; // not a dictionary, so not a stream
    }
    const dictStart = reader.at;
    let dict: Map<string, Value>;
    try {
      dict = reader.dict();
    } catch {
      return null;
    }
    covered.push({ start: dictStart, end: reader.at });
    tree.note(Number(m[1]), dict);
    reader.skipSpace();
    STREAM_KEYWORD.lastIndex = reader.at;
    const kw = STREAM_KEYWORD.exec(text);
    if (!kw || kw.index !== reader.at) continue; // a dictionary object without a stream
    const dataStart = skipToNextLine(text, kw.index + 'stream'.length);
    const dataEnd = text.indexOf('endstream', dataStart);
    if (dataEnd < 0) return null;
    covered.push({ start: kw.index, end: dataEnd });
    OBJ_HEADER.lastIndex = dataEnd; // an "obj" inside the data is not a header
    const filters = filterNames(dict.get('/Filter'));
    const abbreviated = filterNames(dict.get('/F'));
    if (filters === null || abbreviated === null) return null;
    for (const list of [filters, abbreviated]) {
      if (list.some((f) => f !== '/FlateDecode' && f !== '/DCTDecode')) return null;
      if (list.length > 1 && !(list.length === 2 && list[0] === '/FlateDecode' && list[1] === '/DCTDecode')) return null;
    }
    const used = abbreviated.length > 0 ? abbreviated : filters; // pdfjs takes /F when it is there
    const objectStream = isObjectStream(dict);
    if (objectStream && used.includes('/DCTDecode')) return null;
    let decoded: Buffer | null = null;
    if (used[0] === '/FlateDecode') {
      if (budget <= 0) return null;
      try {
        decoded = inflateSync(bytes.subarray(dataStart, dataEnd), { maxOutputLength: budget });
      } catch {
        return null; // over the budget, or not a complete zlib stream
      }
      budget -= decoded.length;
    } else if (used.length === 0) {
      decoded = bytes.subarray(dataStart, dataEnd);
    }
    if (objectStream) {
      if (!decoded) return null;
      STREAM_KEYWORD.lastIndex = 0;
      if (STREAM_KEYWORD.test(decoded.toString('latin1'))) return null;
      // pdfjs serves objects only from a stream with /First (an ICC profile's /N is a component count, not this).
      if (dict.has('/First') && !noteObjectStream(dict, decoded, tree)) return null;
    }
    if (decoded && used.length < 2 && INLINE_IMAGE_FILTER.test(decoded.toString('latin1'))) return null;
  }
  // Any "stream" keyword this reading did not account for: pdfjs might find a stream we did not check.
  STREAM_KEYWORD.lastIndex = 0;
  for (const kw of text.matchAll(STREAM_KEYWORD)) {
    if (!covered.some((c) => kw.index >= c.start && kw.index < c.end)) return null;
  }
  OBJ_KEYWORD.lastIndex = 0;
  for (const kw of text.matchAll(OBJ_KEYWORD)) {
    if (!headers.has(kw.index) && !covered.some((c) => kw.index >= c.start && kw.index < c.end)) return null;
  }
  const pages = tree.count();
  return pages === null ? null : { pages };
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

async function read({ data, preScan }: PdfWorkerInput): Promise<PdfWorkerReply> {
  const scanned = preScan ? scan(data) : null;
  if (preScan && scanned === null) return { ok: false, problem: 'unopenable' };
  if (scanned && scanned.pages > MAX_PAGES) return { ok: false, problem: 'too-many-pages' };
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
    if (doc.numPages > MAX_PAGES) return { ok: false, problem: 'too-many-pages' };
    const lines: string[] = [];
    const visited = new Set<string>();
    let textless = 0;
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      // Each page read must be a different page object: a page tree with false counts can send pdfjs to one twice.
      const ref = page.ref;
      if (!ref || visited.has(`${String(ref.num)} ${String(ref.gen)}`)) return { ok: false, problem: 'unopenable' };
      visited.add(`${String(ref.num)} ${String(ref.gen)}`);
      const content = await page.getTextContent();
      const items = content.items.flatMap((i) =>
        'str' in i && i.str.trim() !== '' ? [{ str: i.str, x: i.transform[4] as number, y: i.transform[5] as number, height: i.height }] : [],
      );
      const pageLines = groupIntoLines(items);
      if (pageLines.length === 0) textless += 1;
      lines.push(...pageLines);
    }
    // Every page-like object in the file was read, or the file is refused: the declared count is not evidence.
    if (scanned && visited.size !== scanned.pages) return { ok: false, problem: 'unopenable' };
    // A page with no text (a scan, a picture, or blank) is decided per page: text elsewhere must not hide it.
    if (textless > 0 && textless < doc.numPages) return { ok: false, problem: 'partly-scanned' };
    return { ok: true, lines };
  } catch {
    return { ok: false, problem: 'unopenable' };
  } finally {
    await task.destroy();
  }
}

if (parentPort) {
  const port = parentPort;
  void read(workerData as PdfWorkerInput).then((reply) => {
    port.postMessage(reply);
  });
}
