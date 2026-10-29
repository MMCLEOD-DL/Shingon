import { existsSync, readdirSync } from 'node:fs';
import { constants, createDeflate, deflateRawSync, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** An absolute path inside `modules/ocr/test/fixtures`. */
export function fixturesDir(rel: string): string {
  return fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url));
}

/** True when the folder holds at least one receipt image or PDF. */
export function hasImages(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((f) => /\.(jpe?g|png|webp|pdf)$/i.test(f));
}

/** zlib-compresses `chunk` repeated `times` times, without ever holding the whole uncompressed data. */
async function deflateRepeated(chunk: Buffer, times: number): Promise<Buffer> {
  const d = createDeflate({ level: 9 });
  const out: Buffer[] = [];
  d.on('data', (c: Buffer) => out.push(c));
  const done = new Promise<void>((resolve, reject) => {
    d.on('end', resolve);
    d.on('error', reject);
  });
  for (let i = 0; i < times; i += 1) if (!d.write(chunk)) await new Promise((r) => d.once('drain', r));
  d.end();
  await done;
  return Buffer.concat(out);
}

/**
 * A zlib stream that inflates to `gib` GiB of zeros, built in milliseconds: one 16 MiB block of zeros is compressed
 * once with a full flush (so it stands alone) and repeated, then closed with an empty final block and the checksum.
 * About 16 KB per 16 MiB, so 1 GiB is about 1 MB and 4 GiB about 4 MB.
 */
function zerosBomb(gib: number): Buffer {
  const block = deflateRawSync(Buffer.alloc(16 << 20), { level: 9, finishFlush: constants.Z_FULL_FLUSH });
  const repeats = gib * 64;
  const total = repeats * (16 << 20);
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE((((total % 65521) << 16) >>> 0) + 1); // zeros: a = 1, b = length mod 65521
  return Buffer.concat([Buffer.from([0x78, 0xda]), ...Array<Buffer>(repeats).fill(block), deflateRawSync(Buffer.alloc(0)), adler]);
}

/**
 * A one-page PDF whose page content stream (object 4) is written exactly as `head` (its dictionary), `afterDict`
 * (the "stream" keyword and its end of line), then `data` and "endstream". For building awkward constructions.
 */
export function pdfWithRawStream(head: string, afterDict: string, data: Buffer, contents = '4 0 R'): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let at = 0;
  const add = (b: Buffer | string): void => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    parts.push(buf);
    at += buf.length;
  };
  add('%PDF-1.7\n');
  const objects: (string | Buffer[])[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 226 600] /Contents ${contents} >>`,
    [Buffer.from(head + afterDict, 'latin1'), data, Buffer.from('\nendstream', 'latin1')],
  ];
  objects.forEach((o, i) => {
    offsets.push(at);
    add(`${String(i + 1)} 0 obj\n`);
    if (typeof o === 'string') add(o);
    else o.forEach(add);
    add('\nendobj\n');
  });
  const xref = at;
  add(`xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`);
  for (const o of offsets) add(`${String(o).padStart(10, '0')} 00000 n \n`);
  add(`trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/**
 * Predictor amplification (Task 3 re-review 4, "P9"): a 2-byte deflate whose PNG predictor rows are 250 MB wide,
 * named 20 times as the page content. Small enough to pass the pre-scan; pdfjs builds each row in memory.
 */
export function predictorBomb(): Buffer {
  const data = deflateSync(Buffer.from([0x00, 0x20]));
  const dict = `<< /Length ${String(data.length)} /Filter /FlateDecode /DecodeParms << /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns 250000000 >> >>`;
  return pdfWithRawStream(dict, '\nstream\n', data, `[${Array(20).fill('4 0 R').join(' ')}]`);
}

/** A one-page PDF whose page content is `data` with the stream dictionary entries `dict` (e.g. "/Filter /FlateDecode"). */
export function pdfWithContent(dict: string, data: Buffer): Buffer {
  return pdfWithRawStream(`<< /Length ${String(data.length)} ${dict} >>`, '\nstream\n', data);
}

/** Five ways of writing a FlateDecode bomb's dictionary that a naive scan misreads but pdfjs accepts (Task 3 review). */
export function trickyBombs(): [string, Buffer][] {
  const bomb = zerosBomb(1);
  const n = String(bomb.length);
  const raw = (head: string, after = '\nstream\n'): Buffer => pdfWithRawStream(head, after, bomb);
  return [
    ['C1 "(obj)" string after the filter', raw(`<< /Filter /FlateDecode /X (obj) /Length ${n} >>`)],
    ['C1 a /Xobj key after the filter', raw(`<< /Filter /FlateDecode /Xobj 1 /Length ${n} >>`)],
    ['C2 a nested /Filter /DCTDecode first', raw(`<< /X << /Filter /DCTDecode >> /Filter /FlateDecode /Length ${n} >>`)],
    ['C2 a /Filter inside a string first', raw(`<< /X (/Filter /DCTDecode) /Filter /FlateDecode /Length ${n} >>`)],
    ['C3 a #-escaped name', raw(`<< /Fil#74er /FlateDecode /Length ${n} >>`)],
    ['C4 a comment as whitespace', raw(`<< /Filter%c\n/FlateDecode /Length ${n} >>`)],
    ['C4 a NUL as whitespace', raw(`<< /Filter\u0000/FlateDecode /Length ${n} >>`)],
    ['C5 spaces before the end of line after "stream"', raw(`<< /Filter /FlateDecode /Length ${n} >>`, '\nstream  \n')],
  ];
}

/**
 * A one-page PDF whose objects (catalog, page tree, page, `content` as object 4, font) all sit in one compressed
 * object stream, with a cross-reference stream. `content` is written as is: a stream there is the N4 construction.
 */
function objectStreamPdf(content: Buffer): Buffer {
  const objs: [number, Buffer][] = [
    [1, Buffer.from('<</Type/Catalog/Pages 2 0 R>>\n', 'latin1')],
    [2, Buffer.from('<</Type/Pages/Kids[3 0 R]/Count 1>>\n', 'latin1')],
    [3, Buffer.from('<</Type/Page/Parent 2 0 R/MediaBox[0 0 226 600]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>\n', 'latin1')],
    [4, content],
    [5, Buffer.from('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\n', 'latin1')],
  ];
  const index: string[] = [];
  let length = 0;
  for (const [num, b] of objs) {
    index.push(`${String(num)} ${String(length)}`);
    length += b.length;
  }
  const header = Buffer.from(`${index.join(' ')}\n`, 'latin1');
  const objStm = deflateSync(Buffer.concat([header, ...objs.map(([, b]) => b)]));
  const first = Buffer.from('%PDF-1.7\n', 'latin1');
  const off6 = first.length;
  const six = Buffer.concat([
    Buffer.from(`6 0 obj\n<</Type/ObjStm/N ${String(objs.length)}/First ${String(header.length)}/Length ${String(objStm.length)}/Filter/FlateDecode>>stream\n`, 'latin1'),
    objStm,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
  const xrefAt = off6 + six.length;
  const row = (type: number, f2: number, f3: number): Buffer => {
    const b = Buffer.alloc(7);
    b[0] = type;
    b.writeUInt32BE(f2, 1);
    b.writeUInt16BE(f3, 5);
    return b;
  };
  const rows = [row(0, 0, 65535), row(2, 6, 0), row(2, 6, 1), row(2, 6, 2), row(2, 6, 3), row(2, 6, 4), row(1, off6, 0), row(1, xrefAt, 0)];
  const xref = deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    first,
    six,
    Buffer.from(`7 0 obj\n<</Type/XRef/Size 8/W[1 4 2]/Root 1 0 R/Filter/FlateDecode/Length ${String(xref.length)}>>stream\n`, 'latin1'),
    xref,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${String(xrefAt)}\n%%EOF\n`, 'latin1'),
  ]);
}

/**
 * Ways past the round-3 pre-scan (Task 3 re-review 3), each a 1 GiB bomb that pdfjs reads: N1–N3, other characters
 * between "stream" and the end of its line (pdfjs skips the whole line); N4, the bomb stream inside an object stream;
 * and the filter under /F, the abbreviation pdfjs also reads.
 */
export function bypassBombs(): [string, Buffer][] {
  const bomb = zerosBomb(1);
  const head = `<< /Length ${String(bomb.length)} /Filter /FlateDecode >>`;
  return [
    ['N1 a form feed after "stream"', pdfWithRawStream(head, '\nstream\f\n', bomb)],
    ['N2 a comment after "stream"', pdfWithRawStream(head, '\nstream%x\n', bomb)],
    ['N3 other words after "stream"', pdfWithRawStream(head, '\nstream junk\n', bomb)],
    ['N4 the bomb stream inside an object stream', n4Bomb()],
    ['the filter named by /F', pdfWithRawStream(`<< /Length ${String(bomb.length)} /F /FlateDecode >>`, '\nstream\n', bomb)],
  ];
}

/** N4: an object stream holding a stream object (object 4, the page content) that inflates to 1 GiB. */
export function n4Bomb(): Buffer {
  const bomb = zerosBomb(1);
  return objectStreamPdf(
    Buffer.concat([Buffer.from(`<</Length ${String(bomb.length)}/Filter/FlateDecode>>stream\n`, 'latin1'), bomb, Buffer.from('\nendstream\n', 'latin1')]),
  );
}

/** An ordinary page whose "stream" line carries a form feed before its end: pdfjs reads it, and so must we. */
export function formFeedPdf(): Buffer {
  const content = deflateSync(Buffer.from('BT /F1 12 Tf 10 500 Td (Total 3.20) Tj ET', 'latin1'));
  return pdfWithRawStream(`<< /Length ${String(content.length)} /Filter /FlateDecode >>`, '\nstream\f\n', content);
}

/**
 * An ordinary PDF in the compact modern layout: its catalog, page tree, page and font sit in a compressed object
 * stream, and its cross-reference table is a compressed stream with PNG "Up" prediction (/Predictor 12). The
 * dictionaries are written without spaces ("/Filter/FlateDecode"). The page says "Total 3.20".
 */
export function modernPdf(): Buffer {
  const objs: [number, string][] = [
    [1, '<</Type/Catalog/Pages 2 0 R>>'],
    [2, '<</Type/Pages/Kids[3 0 R]/Count 1>>'],
    [3, '<</Type/Page/Parent 2 0 R/MediaBox[0 0 226 600]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>'],
    [5, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'],
  ];
  let body = '';
  const index: string[] = [];
  for (const [num, text] of objs) {
    index.push(`${String(num)} ${String(body.length)}`);
    body += `${text}\n`;
  }
  const header = `${index.join(' ')}\n`;
  const objStm = deflateSync(Buffer.from(header + body, 'latin1'));
  const content = deflateSync(Buffer.from('BT /F1 12 Tf 10 500 Td (Total 3.20) Tj ET', 'latin1'));

  const parts: Buffer[] = [];
  let at = 0;
  const add = (b: Buffer | string): void => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    parts.push(buf);
    at += buf.length;
  };
  const offsets = new Map<number, number>();
  add('%PDF-1.7\n');
  offsets.set(4, at);
  add(`4 0 obj\n<</Length ${String(content.length)}/Filter/FlateDecode>>stream\n`);
  add(content);
  add('\nendstream\nendobj\n');
  offsets.set(6, at);
  add(`6 0 obj\n<</Type/ObjStm/N ${String(objs.length)}/First ${String(header.length)}/Length ${String(objStm.length)}/Filter/FlateDecode>>stream\n`);
  add(objStm);
  add('\nendstream\nendobj\n');
  const xrefAt = at;
  offsets.set(7, xrefAt);
  // Rows of [type (1 byte), field 2 (4 bytes), field 3 (2 bytes)] for objects 0..7.
  const row = (type: number, f2: number, f3: number): Buffer => {
    const b = Buffer.alloc(7);
    b[0] = type;
    b.writeUInt32BE(f2, 1);
    b.writeUInt16BE(f3, 5);
    return b;
  };
  const rows = [
    row(0, 0, 65535),
    row(2, 6, 0),
    row(2, 6, 1),
    row(2, 6, 2),
    row(1, offsets.get(4) ?? 0, 0),
    row(2, 6, 3),
    row(1, offsets.get(6) ?? 0, 0),
    row(1, xrefAt, 0),
  ];
  // PNG "Up" prediction: each row is the filter byte 2, then each byte minus the byte above it.
  let prev: Buffer = Buffer.alloc(7);
  const predicted = rows.map((r) => {
    const out = Buffer.alloc(8);
    out[0] = 2;
    for (let i = 0; i < 7; i += 1) out[i + 1] = ((r[i] ?? 0) - (prev[i] ?? 0) + 256) % 256;
    prev = r;
    return out;
  });
  const xref = deflateSync(Buffer.concat(predicted));
  add(`7 0 obj\n<</Type/XRef/Size 8/W[1 4 2]/Root 1 0 R/Filter/FlateDecode/DecodeParms<</Predictor 12/Columns 7>>/Length ${String(xref.length)}>>stream\n`);
  add(xref);
  add(`\nendstream\nendobj\nstartxref\n${String(xrefAt)}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/** A PDF whose one page's content stream inflates to `gib` GiB of zeros (a compression bomb of about `gib` MB). */
export function pdfBomb(gib = 1): Buffer {
  return pdfWithContent('/Filter /FlateDecode', zerosBomb(gib));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const byte of b) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A greyscale PNG of width × height pixels covered in 2 × 2 black dots, 4 px apart: under 25 MP, but slow to read. */
export async function pngDots(width: number, height: number): Promise<Buffer> {
  const dots = Buffer.alloc(1 + width, 0xff);
  dots[0] = 0; // filter: none
  for (let x = 1; x < width; x += 4) dots[x] = dots[x + 1] = 0;
  const white = Buffer.alloc(1 + width, 0xff);
  white[0] = 0;
  const idat = await deflateRepeated(Buffer.concat([dots, dots, white, white]), Math.ceil(height / 4));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(4 * Math.ceil(height / 4), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** A white greyscale PNG of side × side pixels, about 1 MB on disk (a decompression bomb that is slow to read). */
export async function pngBomb(side: number): Promise<Buffer> {
  const row = Buffer.alloc(1 + side, 0xff);
  row[0] = 0; // filter: none
  const rowsPerChunk = 100;
  const idat = await deflateRepeated(Buffer.concat(Array<Buffer>(rowsPerChunk).fill(row)), Math.ceil(side / rowsPerChunk));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
