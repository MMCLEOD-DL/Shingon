/**
 * Makes receipt-exif-rotated.jpg for the sideways-photo journey (Plan 12 Task 6). Run by hand, output committed:
 *   npx tsx apps/web/e2e/files/make-exif.ts
 *
 * A phone held upright stores its photo sideways and adds an EXIF "orientation 6" tag saying "turn me 90° clockwise
 * to show me". This file is exactly that: a portrait receipt photo (3000 × 4000 as seen) stored as 4000 × 3000
 * pixels turned a quarter-turn anticlockwise, with orientation 6. The receipt is Task 3's fictional taxi photo
 * (Ruling 10). No image library is used: Chromium draws the pixels, and the EXIF block is written by hand.
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const SOURCE = path.resolve(here, '../../../../modules/ocr/test/fixtures/receipts/rendered/taxi-photo.jpg');
const OUT = path.join(here, 'receipt-exif-rotated.jpg');
const STORED = { width: 4000, height: 3000 };

/** An APP1 segment holding a big-endian TIFF block with one tag: Orientation (0x0112), SHORT, value 6. */
function exifOrientation6(): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // the first IFD starts straight after the header
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // one value
  tiff.writeUInt16BE(6, 18); // "rotate 90° clockwise to display"
  tiff.writeUInt32BE(0, 22); // no next IFD
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/** Puts the EXIF segment straight after the start-of-image marker, in place of the JFIF one if there is one. */
function withExif(jpeg: Buffer): Buffer {
  if (jpeg.readUInt16BE(0) !== 0xffd8) throw new Error('Not a JPEG.');
  let rest = jpeg.subarray(2);
  if (rest.readUInt16BE(0) === 0xffe0) rest = rest.subarray(2 + rest.readUInt16BE(2));
  return Buffer.concat([jpeg.subarray(0, 2), exifOrientation6(), rest]);
}

async function main(): Promise<void> {
  const photo = readFileSync(SOURCE).toString('base64');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: STORED, deviceScaleFactor: 1 });
    // A portrait "scene" 3000 wide and 4000 tall (a grey table with the receipt on it), turned a quarter-turn
    // anticlockwise about its centre so that it fills the 4000 × 3000 landscape frame.
    await page.setContent(`<!doctype html><html><body style="margin:0;overflow:hidden">
      <div id="frame" style="position:relative;width:4000px;height:3000px;overflow:hidden;background:#7d776d">
        <div style="position:absolute;left:500px;top:-500px;width:3000px;height:4000px;transform:rotate(-90deg);
          display:flex;align-items:center;justify-content:center;background:#7d776d">
          <img src="data:image/jpeg;base64,${photo}" style="width:2800px;height:auto">
        </div>
      </div></body></html>`);
    const jpeg = await page.locator('#frame').screenshot({ type: 'jpeg', quality: 80 });
    writeFileSync(OUT, withExif(jpeg));
  } finally {
    await browser.close();
  }
  console.log(`Wrote ${OUT}`);
}

await main();
