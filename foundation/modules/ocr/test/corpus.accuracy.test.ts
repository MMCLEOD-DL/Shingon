import { test, expect, beforeAll, afterAll } from 'vitest';
import { CONFIDENT } from '@hf/shared';
import { benchCorpus, createLocalEngine, writeAccuracyReport, type OcrEngine } from '../src/index.js';
import { fixturesDir, hasImages } from './helpers.js';

let engine: OcrEngine;
beforeAll(async () => { engine = await createLocalEngine({ workers: 2, timeoutMs: 120_000 }); }, 120_000);
afterAll(async () => { await engine.close(); });

test('the rendered corpus meets the bar', async () => {
  const r = await benchCorpus(engine, fixturesDir('receipts/rendered'), '2026-03-31');
  await writeAccuracyReport(r, 'reports/ocr-accuracy.md');           // plain-English table per field and per file
  for (const f of ['amount', 'vat', 'date', 'merchant'] as const) expect(r.perField[f].confidentlyWrong).toBe(0);   // Ruling 2
  const clean = r.cases.filter((c) => c.file.endsWith('-clean.png'));
  expect(clean.length).toBe(8);
  expect(clean.filter((c) => c.right.amount).length).toBe(clean.length);                    // every clean total right
  expect(r.cases.filter((c) => c.right.amount).length / r.cases.length).toBeGreaterThanOrEqual(0.75);
  // The badly smudged receipt is meant to be misread: its total is right, or it is marked "Please check".
  const heavy = r.cases.filter((c) => c.file.startsWith('smudged-heavy'));
  expect(heavy.map((c) => c.file)).toEqual(['smudged-heavy-photo.jpg', 'smudged-heavy.png']);
  for (const c of heavy) expect(c.right.amount || (c.proposal?.amountPence?.confidence ?? 0) < CONFIDENT).toBe(true);
}, 900_000);

test('operator photos, when present, are never confidently wrong', async () => {
  const dir = fixturesDir('receipts/photos');
  if (!hasImages(dir)) return;                                      // the folder starts empty (operator follow-up)
  const r = await benchCorpus(engine, dir, '2026-03-31');
  await writeAccuracyReport(r, 'reports/ocr-accuracy-photos.md');
  for (const f of ['amount', 'vat', 'date', 'merchant'] as const) expect(r.perField[f].confidentlyWrong).toBe(0);
}, 900_000);
