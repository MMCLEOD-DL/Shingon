import { deflateSync } from 'node:zlib';

const W = 360;
const H = 560;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * A 360x560 off-white "receipt" PNG with a dark bar per line standing in for text (the bar width follows the line length).
 * Built from raw RGBA rows, zlib and a CRC table, so no image library is needed. The same lines always give the same bytes.
 */
export function receiptPng(lines: string[]): Buffer {
  const stride = W * 4 + 1;
  const raw = Buffer.alloc(stride * H);
  for (let y = 0; y < H; y++) {
    const row = y * stride; // filter byte 0 (none) is already zero
    for (let x = 0; x < W; x++) {
      const o = row + 1 + x * 4;
      raw[o] = 250; raw[o + 1] = 248; raw[o + 2] = 240; raw[o + 3] = 255;
    }
  }
  const paint = (x0: number, x1: number, y0: number, y1: number, v: number) => {
    for (let y = y0; y < y1 && y < H; y++) {
      for (let x = x0; x < x1 && x < W; x++) {
        const o = y * stride + 1 + x * 4;
        raw[o] = v; raw[o + 1] = v; raw[o + 2] = v;
      }
    }
  };
  const margin = 28;
  lines.slice(0, 30).forEach((line, i) => {
    const y = 36 + i * 17;
    const width = Math.max(30, Math.min(W - 2 * margin, line.length * 7));
    paint(margin, margin + width, y, y + 8, i === 0 ? 30 : 70);
  });
  paint(margin, W - margin, H - 40, H - 36, 120);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
