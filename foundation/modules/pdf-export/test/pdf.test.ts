import { test, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildMoneyReport, type ReportInput } from '@hf/shared';
import { renderPdf } from '../src/index.js';
import { pdfPages, seq } from './helpers/pdfText.js';
import { LONG_MERCHANT, W1_MARCH, W2_LARGE, W3_AWKWARD } from '../../../packages/shared/test/worked-examples.js';

test('W1: the figures on the page are the figures the app computed', async () => {
  const pages = await pdfPages(await renderPdf(buildMoneyReport(W1_MARCH), { appName: 'Acme Expenses' }));
  const all = pages.flat();
  expect(pages).toHaveLength(1);
  expect(all).toEqual(expect.arrayContaining(['Acme Expenses', 'March 2026 expenses', '1 to 31 March 2026', '12/03/2026', 'Northside Taxis', '£12.40', '£2.07']));
  expect(seq(all, ['Subtotal: Office', '£0.30', '£0.05'])).toBe(true);
  expect(seq(all, ['Subtotal: Subsistence', '£32.74', '£5.46'])).toBe(true);
  expect(seq(all, ['Subtotal: Travel', '£60.60', '£9.57'])).toBe(true);
  expect(seq(all, ['Total', '£93.64', '£15.08'])).toBe(true);
  expect(all).toContain('Generated 1 April 2026, 09:30');
  expect(all).toContain('Page 1 of 1');
});

test('W1: the rows of a group follow its heading, in the order the report holds them', async () => {
  const all = (await pdfPages(await renderPdf(buildMoneyReport(W1_MARCH)))).flat();
  expect(seq(all, ['Travel', '02/03/2026', 'Alice Example', 'Travel', 'Fictional Rail Ltd', '£3.20', '£0.00'])).toBe(true);
  expect(all.indexOf('Subtotal: Office')).toBeLessThan(all.indexOf('Subtotal: Subsistence'));
  expect(all.indexOf('Subtotal: Subsistence')).toBeLessThan(all.indexOf('Subtotal: Travel'));
});

test('W2: many pages, a header on each, the total once on the last', async () => {
  const pages = await pdfPages(await renderPdf(buildMoneyReport(W2_LARGE)));
  expect(pages.length).toBeGreaterThanOrEqual(3);
  for (const [i, p] of pages.entries()) {
    expect(p).toContain(W2_LARGE.title);
    expect(p).toContain(W2_LARGE.periodLabel);
    expect(p).toEqual(expect.arrayContaining(['DATE', 'MERCHANT', 'TOTAL', 'VAT']));
    expect(p).toContain(`Page ${String(i + 1)} of ${String(pages.length)}`);
  }
  expect(pages.flat().filter((t) => t === 'Total')).toHaveLength(1);
  expect(seq(pages.at(-1)!, ['Total', '£246,912.00', '£41,152.00'])).toBe(true);
  expect(pages.flat().filter((t) => t === '£1,234.56')).toHaveLength(200);    // no row lost or split across a page break
  expect(pages.flat().filter((t) => t === '£205.76')).toHaveLength(200);
});

test('W3: awkward text never breaks the document', async () => {
  const all = (await pdfPages(await renderPdf(buildMoneyReport(W3_AWKWARD)))).flat().join(' ');
  expect(all).toContain('=HYPERLINK("http://x","click")');
  expect(all).toContain('?ód? Café ?');
  expect(all).toContain('-£5.00');            // Windows-1252 has no U+2212, so toWinAnsi prints a hyphen-minus
  expect(all).toContain('-£0.83');
  expect(seq(all.split(' '), ['Total', '£10.50', '£1.76'])).toBe(true);
});

test('W3: the 200-character merchant wraps within its column: every word printed, no line wider than the column', async () => {
  const pages = await pdfPages(await renderPdf(buildMoneyReport(W3_AWKWARD)));
  const all = pages.flat();
  const start = all.findIndex((t) => t.startsWith('The Long-Named'));
  expect(start).toBeGreaterThan(-1);
  const lines: string[] = [];
  for (let i = start; !all[i]!.startsWith('£'); i += 1) lines.push(all[i]!);
  expect(lines.length).toBeGreaterThan(2);
  expect(lines.join(' ')).toBe(LONG_MERCHANT);
});

test('a row never splits across a page break, even with long wrapped names', async () => {
  const input: ReportInput = { ...W3_AWKWARD, rows: Array.from({ length: 60 }, (_, i) => ({ date: '2026-03-05', person: 'Ben Sample', merchant: `${String(i + 1)} ${LONG_MERCHANT}`, gross: 100, vat: 17 })) };
  const pages = await pdfPages(await renderPdf(buildMoneyReport(input)));
  expect(pages.length).toBeGreaterThan(1);
  for (const p of pages) {
    // Every merchant that starts on a page ends on it: its amount follows on the same page.
    const starts = p.filter((t) => / The Long-Named/.test(t)).length;
    expect(p.filter((t) => t === '£1.00')).toHaveLength(starts);
  }
  expect(pages.flat().filter((t) => t === '£1.00')).toHaveLength(60);
  expect(seq(pages.at(-1)!, ['Total', '£60.00', '£10.20'])).toBe(true);
});

test('an ungrouped report has no subtotal, only the total', async () => {
  const all = (await pdfPages(await renderPdf(buildMoneyReport(W3_AWKWARD)))).flat();
  expect(all.some((t) => t.startsWith('Subtotal'))).toBe(false);
});

/** Every object and every inflated stream of the file, as text. */
function rawText(buf: Buffer): string {
  const s = buf.toString('latin1');
  const out = [s];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const begin = m.index + m[0].length;
    const end = s.indexOf('endstream', begin);
    try { out.push(inflateSync(buf.subarray(begin, end)).toString('latin1')); } catch { /* not compressed */ }
  }
  return out.join('\n');
}

test('report text cannot add links, scripts or actions to the file', async () => {
  const hostile = '/URI (http://evil) /JavaScript (app.alert(1)) /Launch ) Tj ET';
  const input: ReportInput = { ...W3_AWKWARD, title: hostile, periodLabel: hostile, rows: [{ date: '2026-03-03', person: hostile, merchant: '=HYPERLINK("http://x","click")', gross: 1, vat: 0 }] };
  const buf = await renderPdf(buildMoneyReport(input), { appName: hostile });
  const raw = rawText(buf);
  for (const name of ['/URI', '/JavaScript', '/JS', '/Launch', '/Annots', '/OpenAction', '/AA', '/Link', '/EmbeddedFile', 'http://']) expect(raw).not.toContain(name);
  expect(raw).toContain('/BaseFont /Helvetica');
  expect(raw).not.toContain('/FontFile');    // the standard fonts, nothing embedded
  expect((await pdfPages(buf)).flat().join(' ')).toContain(hostile);
});

test('the PDF is the same every time for the same report (no random ids)', async () => {
  const r = buildMoneyReport(W1_MARCH);
  expect((await renderPdf(r)).equals(await renderPdf(r))).toBe(true);
});
