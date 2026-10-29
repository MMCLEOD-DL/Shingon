export type AllowedType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'application/pdf';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);

const at = (b: Buffer, offset: number, bytes: readonly number[]): boolean =>
  b.length >= offset + bytes.length && bytes.every((v, i) => b[offset + i] === v);
const ascii = (b: Buffer, offset: number, len: number): string => b.subarray(offset, offset + len).toString('latin1');

/**
 * Decides the type from the first bytes alone. The file name and the browser's claim are never consulted,
 * so HTML or SVG renamed to receipt.jpg is refused. Anything not on the list returns null.
 */
export function sniffType(head: Buffer): AllowedType | null {
  const b = head.subarray(0, 32);
  if (at(b, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(b, 0, PNG)) return 'image/png';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp' && HEIC_BRANDS.has(ascii(b, 8, 4))) return 'image/heic';
  if (ascii(b, 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}
