import { test, expect, vi, afterEach } from 'vitest';
import { prepareReceiptImage } from '../../../src/modules/ocr/index.js';

afterEach(() => { vi.unstubAllGlobals(); });

const photo = (name = 'IMG_0042.HEIC', type = 'image/heic') => new File([new Uint8Array(64)], name, { type });

/** A browser that can decode the picture: a bitmap of the given size and an OffscreenCanvas that records what it was asked. */
function fakeBrowser(width: number, height: number, opts: { failEncode?: boolean } = {}) {
  const seen = { bitmapOptions: undefined as unknown, canvas: [0, 0], drawn: [] as number[], encode: undefined as unknown, closed: false };
  vi.stubGlobal('createImageBitmap', vi.fn(async (_f: Blob, o: unknown) => {
    seen.bitmapOptions = o;
    return { width, height, close: () => { seen.closed = true; } };
  }));
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(w: number, h: number) { seen.canvas = [w, h]; }
    getContext() { return { drawImage: (_b: unknown, x: number, y: number, w: number, h: number) => { seen.drawn = [x, y, w, h]; } }; }
    async convertToBlob(o: unknown) {
      seen.encode = o;
      if (opts.failEncode) throw new Error('encoder broke');
      return new Blob([new Uint8Array(10)], { type: 'image/jpeg' });
    }
  });
  return seen;
}

test('a big photo is turned upright, shrunk to the longest side and sent as JPEG named .jpg', async () => {
  const seen = fakeBrowser(4000, 3000);
  const out = await prepareReceiptImage(photo(), { maxSide: 2000, quality: 0.85 });
  expect(seen.bitmapOptions).toEqual({ imageOrientation: 'from-image' });
  expect(seen.canvas).toEqual([2000, 1500]);
  expect(seen.drawn).toEqual([0, 0, 2000, 1500]);
  expect(seen.encode).toEqual({ type: 'image/jpeg', quality: 0.85 });
  expect(seen.closed).toBe(true);
  expect(out.name).toBe('IMG_0042.jpg');
  expect(out.type).toBe('image/jpeg');
  expect(out.size).toBe(10);
});

test('a portrait photo keeps its shape; a small one is not enlarged', async () => {
  const tall = fakeBrowser(3000, 4000);
  await prepareReceiptImage(photo('a.jpg', 'image/jpeg'));
  expect(tall.canvas).toEqual([1500, 2000]);
  const small = fakeBrowser(800, 600);
  await prepareReceiptImage(photo('b.png', 'image/png'));
  expect(small.canvas).toEqual([800, 600]);
});

test('a file with no reported type (some phones\' HEIC) is tried too', async () => {
  const seen = fakeBrowser(4000, 3000);
  const out = await prepareReceiptImage(photo('IMG_1.heic', ''));
  expect(seen.canvas).toEqual([2000, 1500]);
  expect(out.name).toBe('IMG_1.jpg');
});

test('a PDF goes up unchanged and is never decoded', async () => {
  const seen = fakeBrowser(4000, 3000);
  const pdf = new File(['%PDF-1.4'], 'e-ticket.pdf', { type: 'application/pdf' });
  expect(await prepareReceiptImage(pdf)).toBe(pdf);
  expect(seen.bitmapOptions).toBeUndefined();
});

test('when the browser cannot decode the photo (HEIC on Chrome) the original goes up', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new DOMException('The source image could not be decoded.', 'InvalidStateError'))));
  const original = photo();
  expect(await prepareReceiptImage(original)).toBe(original);
});

test('an old browser without createImageBitmap, or a failing encoder, sends the original', async () => {
  vi.stubGlobal('createImageBitmap', undefined);
  const original = photo('c.jpg', 'image/jpeg');
  expect(await prepareReceiptImage(original)).toBe(original);
  fakeBrowser(4000, 3000, { failEncode: true });
  expect(await prepareReceiptImage(original)).toBe(original);
});

test('a browser that refuses the orientation option decodes through an <img>, which is drawn upright', async () => {
  const seen = fakeBrowser(0, 0);
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new TypeError("The provided value 'from-image' is not a valid enum value."))));
  const revoked: string[] = [];
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL() { return 'blob:x'; }
    static override revokeObjectURL(u: string) { revoked.push(u); }
  });
  vi.stubGlobal('Image', class { src = ''; naturalWidth = 3000; naturalHeight = 4000; async decode() { /* decoded */ } });
  const out = await prepareReceiptImage(photo('IMG_2.jpg', 'image/jpeg'));
  expect(seen.canvas).toEqual([1500, 2000]);
  expect(out.name).toBe('IMG_2.jpg');
  expect(revoked).toEqual(['blob:x']);
});
