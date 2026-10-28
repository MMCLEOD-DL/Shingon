/**
 * Renders the fictional receipt templates into the corpus (Plan 12 Task 3). Run by hand, outputs committed:
 *   npx tsx modules/ocr/test/fixtures/make-receipts.ts
 * Nothing in `npm test` renders; the tests only read the committed files. Every receipt is fictional (Ruling 10).
 *
 * For each template: `<name>-clean.png` (80 mm wide at 300 dpi, straight, black on white) and `<name>-photo.jpg`
 * (rotated 2.5°, low contrast, film grain, JPEG quality 70, about 1500 px on the long side, like a phone snapshot).
 * Also `pdf/e-ticket.pdf` (the train receipt as a text PDF) and `pdf/scanned.pdf` (the same, image only), and
 * `expected.json` (what each file should be read as).
 */
import { chromium, type Browser } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const templates = path.join(here, 'templates');
const out = path.join(here, 'receipts');

interface Expected { amountPence: number; vatPence: number | null; date: string; merchant: string }

// The first seven rows of Task 2's table, plus the smudged café receipt.
const RECEIPTS: Record<string, Expected> = {
  cafe: { amountPence: 875, vatPence: 146, date: '2026-03-05', merchant: 'Corner Café' },
  taxi: { amountPence: 1240, vatPence: 207, date: '2026-03-12', merchant: 'Northside Taxis' },
  supermarket: { amountPence: 2349, vatPence: 333, date: '2026-03-19', merchant: 'Harbour Foods' },
  fuel: { amountPence: 4500, vatPence: 750, date: '2026-03-23', merchant: 'Fuel Stop' },
  train: { amountPence: 320, vatPence: null, date: '2026-03-02', merchant: 'Fictional Rail' },
  hotel: { amountPence: 24000, vatPence: 4000, date: '2026-03-11', merchant: 'Glen Lodge' },
  restaurant: { amountPence: 2399, vatPence: 400, date: '2026-03-19', merchant: 'Harbour Deli' },
  smudged: { amountPence: 875, vatPence: 146, date: '2026-03-05', merchant: 'Corner Café' },
};

const MM_PX = 96 / 25.4; // CSS pixels per millimetre
const DPI = 300;
const PHOTO_LONG_SIDE = 1500;

async function renderClean(browser: Browser, name: string): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: Math.ceil(80 * MM_PX), height: 400 }, deviceScaleFactor: DPI / 96 });
  await page.goto(pathToFileURL(path.join(templates, `${name}.html`)).href);
  const png = await page.locator('.receipt').screenshot({ type: 'png' });
  await page.close();
  return png;
}

async function renderPhoto(browser: Browser, clean: Buffer): Promise<Buffer> {
  // Size the receipt so the finished snapshot is about PHOTO_LONG_SIDE px on its long side (PNG width and height
  // are the big-endian words at bytes 16 and 20).
  const w = clean.readUInt32BE(16);
  const h = clean.readUInt32BE(20);
  const margin = 50;
  const scale = (PHOTO_LONG_SIDE - 2 * margin) / Math.max(w, h);
  const iw = Math.round(w * scale);
  const ih = Math.round(h * scale);
  const sw = iw + 2 * margin;
  const sh = ih + 2 * margin;
  const [W, H, M, IW, IH] = [String(sw), String(sh), String(margin), String(iw), String(ih)];
  const page = await browser.newPage({ viewport: { width: sw, height: sh }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><body style="margin:0">
    <div id="shot" style="position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#7d776d">
      <img src="data:image/png;base64,${clean.toString('base64')}" style="position:absolute;left:${M}px;top:${M}px;width:${IW}px;height:${IH}px;
        transform:rotate(2.5deg);filter:contrast(0.55) brightness(1.08) sepia(0.2);box-shadow:4px 6px 14px rgba(0,0,0,0.35)">
      <svg width="${W}" height="${H}" style="position:absolute;left:0;top:0;mix-blend-mode:multiply;opacity:0.35">
        <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>
        <rect width="100%" height="100%" filter="url(#grain)"/>
      </svg>
    </div></body></html>`);
  const jpg = await page.locator('#shot').screenshot({ type: 'jpeg', quality: 70 });
  await page.close();
  return jpg;
}

async function renderPdfs(browser: Browser, trainClean: Buffer): Promise<void> {
  const width = '80mm';
  const text = await browser.newPage();
  await text.goto(pathToFileURL(path.join(templates, 'train.html')).href);
  const textHeight = (await text.locator('.receipt').boundingBox())?.height ?? 600;
  writeFileSync(path.join(out, 'pdf', 'e-ticket.pdf'), await text.pdf({ width, height: `${String(Math.ceil(textHeight) + 2)}px`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } }));
  await text.close();

  // The same receipt as a picture only: no text layer.
  const scan = await browser.newPage();
  await scan.setContent(`<!doctype html><html><head><style>@page{margin:0}html,body{margin:0}img{display:block;width:80mm}</style></head>
    <body><img src="data:image/png;base64,${trainClean.toString('base64')}"></body></html>`);
  const scanHeight = (await scan.locator('img').boundingBox())?.height ?? 600;
  writeFileSync(path.join(out, 'pdf', 'scanned.pdf'), await scan.pdf({ width, height: `${String(Math.ceil(scanHeight) + 2)}px`, margin: { top: 0, right: 0, bottom: 0, left: 0 } }));
  await scan.close();
}

async function main(): Promise<void> {
  mkdirSync(path.join(out, 'rendered'), { recursive: true });
  mkdirSync(path.join(out, 'pdf'), { recursive: true });
  const browser = await chromium.launch();
  const expected: Record<string, Expected> = {};
  let trainClean: Buffer | undefined;
  try {
    for (const [name, values] of Object.entries(RECEIPTS)) {
      const clean = await renderClean(browser, name);
      writeFileSync(path.join(out, 'rendered', `${name}-clean.png`), clean);
      writeFileSync(path.join(out, 'rendered', `${name}-photo.jpg`), await renderPhoto(browser, clean));
      expected[`${name}-clean.png`] = values;
      expected[`${name}-photo.jpg`] = values;
      if (name === 'train') trainClean = clean;
    }
    await renderPdfs(browser, trainClean ?? readFileSync(path.join(out, 'rendered', 'train-clean.png')));
    expected['e-ticket.pdf'] = RECEIPTS['train']!;
  } finally {
    await browser.close();
  }
  writeFileSync(path.join(out, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
  console.log(`Rendered ${String(Object.keys(RECEIPTS).length)} receipts to ${path.relative(process.cwd(), out)}`);
}

await main();
