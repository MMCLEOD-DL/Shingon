/**
 * Gets a receipt photo ready in the browser before it is uploaded (Plan 12 Review Focus 2).
 *
 * A phone held upright stores its photo sideways with an EXIF orientation tag, and an iPhone may send HEIC. Here the
 * browser decodes the picture turned the way it is meant to be seen, shrinks it so its longest side is at most
 * RECEIPT_MAX_SIDE, and sends it as a JPEG. Safari decodes HEIC itself, so iPhone photos arrive as JPEG too.
 *
 * Why 2000 px: it is the plan's value. The server refuses pictures over 25 megapixels (Task 3); 2000 × 1500 is 3 MP, so
 * an ordinary phone photo never comes near that, and the file is a few hundred KB on mobile data. The cost: a long till
 * roll photographed whole fills the 2000 px along its length, leaving only about 500–800 px across the text. Task 3's
 * corpus photos (1500 px long side) read correctly, but a very long receipt may come back with more "Please check".
 *
 * When the browser can't (an old browser, HEIC on Chrome, a PDF), the original file goes up unchanged and the server
 * says plainly if it couldn't be read. It never throws.
 */

export const RECEIPT_MAX_SIDE = 2000;
export const RECEIPT_JPEG_QUALITY = 0.85;

export interface PrepareOptions {
  /** Longest side of the result in pixels. */
  maxSide?: number;
  /** JPEG quality, 0 to 1. */
  quality?: number;
}

// Pictures a browser may be able to decode. Some phones report no type for HEIC, so an empty type is tried too.
const DECODABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', '']);

const jpegName = (name: string): string => `${name.replace(/\.[^./\\]*$/, '') || 'receipt'}.jpg`;

type Picture = ImageBitmap | HTMLImageElement;

/**
 * The picture decoded the way it is meant to be seen. createImageBitmap's orientation option first; a browser that
 * refuses that option (older Safari knows only "none" and "flipY") decodes through an <img>, which browsers draw
 * upright from EXIF too.
 */
async function decodeUpright(file: File): Promise<{ picture: Picture; width: number; height: number; release: () => void }> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { picture: bitmap, width: bitmap.width, height: bitmap.height, release: () => { bitmap.close(); } };
  } catch (first) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { picture: img, width: img.naturalWidth, height: img.naturalHeight, release: () => { URL.revokeObjectURL(url); } };
    } catch {
      URL.revokeObjectURL(url);
      throw first;
    }
  }
}

/** White first: JPEG has no transparency, and a transparent PNG would otherwise turn black. */
function paint(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, picture: Picture, width: number, height: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(picture, 0, 0, width, height);
}

async function encode(bitmap: Picture, width: number, height: number, quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    paint(ctx, bitmap, width, height);
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  paint(ctx, bitmap, width, height);
  return new Promise((resolve) => { canvas.toBlob(resolve, 'image/jpeg', quality); });
}

/** The photo upright, at most `maxSide` px on its longest side, as `<name>.jpg`; or the original file if that can't be done. */
export async function prepareReceiptImage(file: File, opts: PrepareOptions = {}): Promise<File> {
  const maxSide = opts.maxSide ?? RECEIPT_MAX_SIDE;
  const quality = opts.quality ?? RECEIPT_JPEG_QUALITY;
  if (!DECODABLE.has(file.type) || typeof createImageBitmap !== 'function') return file;
  let decoded: Awaited<ReturnType<typeof decodeUpright>> | undefined;
  try {
    decoded = await decodeUpright(file);
    if (decoded.width === 0 || decoded.height === 0) return file;
    const scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const blob = await encode(decoded.picture, width, height, quality);
    if (!blob || blob.size === 0) return file;
    return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    decoded?.release();
  }
}
