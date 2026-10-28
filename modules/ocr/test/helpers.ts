import { existsSync, readdirSync } from 'node:fs';
import { constants, createDeflate, deflateRawSync } from 'node:zlib';
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

/** A one-page PDF whose page content is `data` with the stream dictionary entries `dict` (e.g. "/Filter /FlateDecode"). */
export function pdfWithContent(dict: string, data: Buffer): Buffer {
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
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 226 600] /Contents 4 0 R >>',
    [Buffer.from(`<< /Length ${String(data.length)} ${dict} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')],
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
