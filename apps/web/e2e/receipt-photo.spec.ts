import path from 'node:path';
import { test, expect } from '@playwright/test';
import { authFile } from './fixtures.js';

// Runs on every browser project, WebKit too (Review Focus 2): a phone photo stored sideways with EXIF orientation 6.
// It uses the first Operations member's stored sign-in and only adds a new reading; the seeded ones are left alone.
const SIDEWAYS = path.join(import.meta.dirname, 'files/receipt-exif-rotated.jpg');

/** Width and height from a JPEG's start-of-frame header (any SOFn), without an image library. */
function jpegSize(buf: Buffer): { width: number; height: number } {
  if (buf.readUInt16BE(0) !== 0xffd8) throw new Error('The stored file is not a JPEG.');
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) throw new Error('The JPEG has a broken marker.');
    const marker = buf[i + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('The JPEG has no start-of-frame header.');
}

test('receipt: a sideways phone photo is uploaded upright and smaller', async ({ browser }, info) => {
  const ctx = await browser.newContext({ ...info.project.use, storageState: authFile('member') });
  try {
    const page = await ctx.newPage();
    await page.goto('/receipts/new');
    await expect(page.getByRole('heading', { name: 'Read a receipt', exact: true })).toBeVisible();
    await page.getByTestId('file-input').setInputFiles(SIDEWAYS);
    await expect(page).toHaveURL(/\/receipts\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'Check the details', exact: true })).toBeVisible();

    const id = /\/receipts\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
    const { reading } = (await (await page.request.get(`/api/readings/${id}`)).json()) as { reading: { fileId: string } };
    const { file } = (await (await page.request.get(`/api/files/${reading.fileId}`)).json()) as { file: { name: string; contentType: string } };
    expect(file).toMatchObject({ name: 'receipt-exif-rotated.jpg', contentType: 'image/jpeg' });
    const stored = await page.request.get(`/api/files/${reading.fileId}/content`);
    const { width, height } = jpegSize(await stored.body());
    expect(height, `stored ${String(width)} × ${String(height)}: not upright`).toBeGreaterThan(width);
    expect(Math.max(width, height)).toBeLessThanOrEqual(2000);
    // Shrunk, not cropped: the 3 : 4 shape of the photo as seen survives.
    expect(Math.abs(width / height - 3 / 4)).toBeLessThan(0.01);
    await expect(page.getByLabel('Total')).toHaveValue('12.40');
  } finally {
    await ctx.close();
  }
});
