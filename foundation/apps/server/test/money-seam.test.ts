/**
 * The seam between receipts and money reports: what staff confirmed on two readings goes into buildMoneyReport and out
 * through renderXlsx unchanged. "No VAT shown" (a null VAT) is mapped to 0 before building, as report.ts asks.
 */
import { test, expect, beforeAll, afterAll } from 'vitest';
import readXlsxFile from 'read-excel-file/node';
import { eq } from 'drizzle-orm';
import { buildMoneyReport, type ReportRow } from '@hf/shared';
import { renderXlsx } from '@hf/xlsx-export';
import { createTestApp, call, signInAs, type TestApp } from './helpers/testApp.js';
import { makeTeam, makeUser } from './helpers/factories.js';
import { readingFor } from './helpers/readings.js';
import { receiptReadings } from '../src/db/schema/index.js';

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

test('confirmed readings become report rows; a null VAT counts as 0 and the totals are the confirmed figures', async () => {
  const team = await makeTeam(t.db, 'North');
  const alice = await makeUser(t.db, { role: 'member', teamId: team.id });
  const auth = await signInAs(t, alice);
  const taxi = await readingFor(t, alice, 'taxi.txt');
  const train = await readingFor(t, alice, 'taxi.txt');
  expect((await call(t, auth, 'POST', `/api/readings/${taxi}/confirm`, { amountPence: 1240, vatPence: 207, date: '2026-03-12', merchant: 'Northside Taxis' })).status).toBe(200);
  expect((await call(t, auth, 'POST', `/api/readings/${train}/confirm`, { amountPence: 320, vatPence: null, date: '2026-03-02', merchant: 'Fictional Rail Ltd' })).status).toBe(200);

  // A client feature reads the confirmed values, never the proposal.
  const rows: ReportRow[] = [];
  for (const id of [taxi, train]) {
    const [r] = await t.db.select().from(receiptReadings).where(eq(receiptReadings.id, id));
    const c = r!.confirmed!;
    rows.push({ date: c.date, merchant: c.merchant, gross: c.amountPence, vat: c.vatPence ?? 0 });
  }
  const report = buildMoneyReport({
    title: 'March receipts', periodLabel: 'March 2026', generatedAt: new Date('2026-04-01T08:30:00Z'), rows,
    columns: [
      { key: 'date', label: 'Date', kind: 'date' },
      { key: 'merchant', label: 'Merchant', kind: 'text' },
      { key: 'gross', label: 'Total', kind: 'money' },
      { key: 'vat', label: 'VAT', kind: 'money' },
    ],
  });
  expect(report.totals).toEqual({ gross: 1560, vat: 207 });

  const sheets = await readXlsxFile(await renderXlsx(report), { trim: false });
  const cells = sheets[0]!.data.flat();
  // Money is stored as pounds; the null VAT is a real 0, and the totals are the app's figures written as values.
  const train0 = sheets[0]!.data.find((row) => row.includes('Fictional Rail Ltd'))!;
  expect(train0).toEqual(expect.arrayContaining([3.2, 0]));
  expect(cells).toEqual(expect.arrayContaining([15.6, 2.07]));
});
