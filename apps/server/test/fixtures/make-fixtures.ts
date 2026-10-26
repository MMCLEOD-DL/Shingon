// Writes the tiny sample files used by the upload tests. Run: npx tsx apps/server/test/fixtures/make-fixtures.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const dir = new URL('./files/', import.meta.url);
mkdirSync(dir, { recursive: true });
const out = (name: string, data: Buffer | string): void => { writeFileSync(new URL(name, dir), data); };

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const chunk = (type: string, data: Buffer) => { const t = Buffer.concat([Buffer.from(type, 'latin1'), data]); return Buffer.concat([u32(data.length), t, u32(crc32(t))]); };

// JPEG: SOI, a JFIF APP0, EOI.
out('tiny.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]));

// PNG: 1x1 grey pixel.
out('tiny.png', Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', Buffer.concat([u32(1), u32(1), Buffer.from([8, 0, 0, 0, 0])])),
  chunk('IDAT', deflateSync(Buffer.from([0x00, 0x80]))),
  chunk('IEND', Buffer.alloc(0)),
]));

// WebP: RIFF container with a minimal lossy (VP8) chunk.
const vp8 = Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]);
const webpBody = Buffer.concat([Buffer.from('WEBPVP8 ', 'latin1'), Buffer.from([vp8.length, 0, 0, 0]), vp8]);
out('tiny.webp', Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([webpBody.length, 0, 0, 0]), webpBody]));

// HEIC: an ftyp box with major brand heic, then a padding mdat box.
const ftyp = Buffer.concat([u32(24), Buffer.from('ftypheic', 'latin1'), u32(0), Buffer.from('mif1heic', 'latin1')]);
out('tiny.heic', Buffer.concat([ftyp, u32(16), Buffer.from('mdat', 'latin1'), Buffer.alloc(8)]));

out('tiny.pdf', '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
out('evil.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
out('evil.html', '<!doctype html><script>alert(1)</script>');
