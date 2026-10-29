import { test, expect } from 'vitest';
import readXlsxFile from 'read-excel-file/node';
import { strFromU8, unzipSync } from 'fflate';
import { buildMoneyReport, type MoneyReport, type ReportInput } from '@hf/shared';
import { renderXlsx } from '../src/index.js';
import { W1_MARCH, W2_LARGE, W3_AWKWARD } from '../../../packages/shared/test/worked-examples.js';

type Cell = string | number | boolean | Date | null;

async function readBack(buf: Buffer): Promise<{ name: string; rows: Cell[][] }> {
  const sheets = await readXlsxFile(buf, { trim: false });
  expect(sheets).toHaveLength(1);
  return { name: sheets[0]!.sheet, rows: sheets[0]!.data as unknown as Cell[][] };
}

function parts(buf: Buffer): { sheet: string; styles: string; strings: string } {
  const files = unzipSync(new Uint8Array(buf));
  const text = (name: string): string => {
    const f = files[name];
    if (!f) throw new Error(`missing ${name}`);
    return strFromU8(f);
  };
  return { sheet: text('xl/worksheets/sheet1.xml'), styles: text('xl/styles.xml'), strings: files['xl/sharedStrings.xml'] ? text('xl/sharedStrings.xml') : '' };
}

/** The <c> element for a cell address, e.g. 'E20'. */
function cellXml(sheet: string, ref: string): string {
  const m = new RegExp(`<c r="${ref}"[^>]*?(?:/>|>.*?</c>)`).exec(sheet);
  if (!m) throw new Error(`no cell ${ref}`);
  return m[0];
}

/** The number format code applied to a cell, through its style index. */
function formatCodeOf(xml: { sheet: string; styles: string }, ref: string): string {
  const s = /\ss="(\d+)"/.exec(cellXml(xml.sheet, ref))?.[1];
  if (s === undefined) throw new Error(`cell ${ref} has no style`);
  const cellXfs = /<cellXfs[^>]*>(.*?)<\/cellXfs>/s.exec(xml.styles)![1]!;
  const xf = [...cellXfs.matchAll(/<xf\b[^>]*?(?:\/>|>.*?<\/xf>)/gs)][Number(s)]![0];
  const id = /numFmtId="(\d+)"/.exec(xf)![1]!;
  const fmt = new RegExp(`<numFmt numFmtId="${id}" formatCode="([^"]*)"`).exec(xml.styles);
  if (!fmt) throw new Error(`format ${id} is not a custom format`);
  return fmt[1]!.replaceAll('&amp;', '&').replaceAll('&quot;', '"');
}

const rowStarting = (rows: Cell[][], first: string): Cell[] => {
  const r = rows.find((row) => row[0] === first);
  if (!r) throw new Error(`no row starting ${first}`);
  return r;
};
const W1_GROSS = 4;
const W1_VAT = 5;

test('W1: the layout is title, period, generated, blank, headings, then the groups', async () => {
  const report = buildMoneyReport(W1_MARCH);
  const { rows } = await readBack(await renderXlsx(report));
  expect(rows[0]![0]).toBe('March 2026 expenses');
  expect(rows[1]![0]).toBe('1 to 31 March 2026');
  expect(rows[2]![0]).toBe(`Generated ${report.generatedAtText}`);
  expect(rows[3]!.every((c) => c === null)).toBe(true);
  expect(rows[4]).toEqual(['Date', 'Person', 'Category', 'Merchant', 'Total', 'VAT']);
  expect(rows.slice(5).map((r) => r[0] instanceof Date ? 'row' : r[0])).toEqual([
    'Office', 'row', 'row', 'Subtotal: Office',
    'Subsistence', 'row', 'row', 'Subtotal: Subsistence',
    'Travel', 'row', 'row', 'row', 'Subtotal: Travel',
    'Total',
  ]);
});

test('W1: the totals in the file are the totals the app computed', async () => {
  const report = buildMoneyReport(W1_MARCH);
  const { rows } = await readBack(await renderXlsx(report));
  const total = rowStarting(rows, 'Total');
  expect([total[W1_GROSS], total[W1_VAT]]).toEqual([93.64, 15.08]);
  expect([rowStarting(rows, 'Subtotal: Office')[W1_GROSS], rowStarting(rows, 'Subtotal: Office')[W1_VAT]]).toEqual([0.3, 0.05]);
  expect([rowStarting(rows, 'Subtotal: Subsistence')[W1_GROSS], rowStarting(rows, 'Subtotal: Subsistence')[W1_VAT]]).toEqual([32.74, 5.46]);
  expect([rowStarting(rows, 'Subtotal: Travel')[W1_GROSS], rowStarting(rows, 'Subtotal: Travel')[W1_VAT]]).toEqual([60.6, 9.57]);

  // Every money cell, read back and turned into pence, is exactly the model's pence, in the model's order.
  const expected: number[] = [];
  for (const g of report.groups) {
    for (const row of g.rows) expected.push(row.gross as number, row.vat as number);
    expected.push(g.subtotals.gross!, g.subtotals.vat!);
  }
  expected.push(report.totals.gross!, report.totals.vat!);
  const money = rows.slice(5).filter((r) => typeof r[W1_GROSS] === 'number').flatMap((r) => [r[W1_GROSS] as number, r[W1_VAT] as number]);
  expect(money.map((v) => Math.round(v * 100))).toEqual(expected);
});

test('money is stored as exact decimals with a pounds format that shows a negative as −£5.00', async () => {
  const buf = await renderXlsx(buildMoneyReport(W1_MARCH));
  const xml = parts(buf);
  expect(xml.sheet).toContain('<v>93.64</v>');
  expect(xml.sheet).toContain('<v>15.08</v>');
  // Row 19 is the Total row: 5 header rows, 3 group headings, 7 rows, 3 subtotals, then Total.
  expect(cellXml(xml.sheet, 'E19')).toContain('<v>93.64</v>');
  expect(cellXml(xml.sheet, 'F19')).toContain('<v>15.08</v>');
  // The second section is for negatives: a minus sign (U+2212) before the pound sign, as formatCell shows it.
  const MONEY = '£#,##0.00;"\u2212"£#,##0.00';
  expect(formatCodeOf(xml, 'E19')).toBe(MONEY);
  expect(formatCodeOf(xml, 'F19')).toBe(MONEY);
  expect(formatCodeOf(xml, 'E7')).toBe(MONEY);
});

test('totals are values, not formulas', async () => {
  for (const input of [W1_MARCH, W2_LARGE, W3_AWKWARD]) {
    const xml = parts(await renderXlsx(buildMoneyReport(input)));
    expect(xml.sheet).not.toMatch(/<f[\s>/]/);
  }
});

test('headings, group rows, subtotals and the total are bold', async () => {
  const xml = parts(await renderXlsx(buildMoneyReport(W1_MARCH)));
  const boldFonts = new Set<number>();
  const fonts = [...(/<fonts[^>]*>(.*?)<\/fonts>/s.exec(xml.styles)![1]!).matchAll(/<font\b.*?<\/font>|<font\b[^>]*\/>/gs)];
  fonts.forEach((f, i) => { if (/<b\s*\/>/.test(f[0])) boldFonts.add(i); });
  const cellXfs = [...(/<cellXfs[^>]*>(.*?)<\/cellXfs>/s.exec(xml.styles)![1]!).matchAll(/<xf\b[^>]*?(?:\/>|>.*?<\/xf>)/gs)];
  const isBold = (ref: string): boolean => {
    const s = /\ss="(\d+)"/.exec(cellXml(xml.sheet, ref))?.[1];
    if (s === undefined) return false;
    return boldFonts.has(Number(/fontId="(\d+)"/.exec(cellXfs[Number(s)]![0])?.[1] ?? '0'));
  };
  for (const ref of ['A5', 'F5', 'A6', 'A9', 'E9', 'A19', 'E19', 'F19']) expect(isBold(ref), ref).toBe(true);
  expect(isBold('A7')).toBe(false);
  expect(isBold('E7')).toBe(false);
});

test('dates are real dates', async () => {
  const buf = await renderXlsx(buildMoneyReport(W1_MARCH));
  const { rows } = await readBack(buf);
  // The report's earliest row (the train, first in Travel) and the sheet's first data row (Office's first, on row 7).
  const train = rows.find((r) => r[3] === 'Fictional Rail Ltd')!;
  expect(train[0]).toBeInstanceOf(Date);
  expect((train[0] as Date).toISOString()).toBe('2026-03-02T00:00:00.000Z');
  expect((rows[6]![0] as Date).toISOString()).toBe('2026-03-30T00:00:00.000Z');
  const xml = parts(buf);
  expect(formatCodeOf(xml, 'A7')).toBe('dd/mm/yyyy');
  expect(cellXml(xml.sheet, 'A7')).not.toContain('t="s"');
});

test('formula-looking text stays text', async () => {
  const buf = await renderXlsx(buildMoneyReport(W3_AWKWARD));
  const { rows } = await readBack(buf);
  expect(rows.map((r) => r[2])).toContain('=HYPERLINK("http://x","click")');
  const xml = parts(buf);
  expect(xml.sheet).not.toMatch(/<f[\s>/]/);
  // Kept in the shared strings table (text), and nowhere in the sheet itself.
  expect(xml.strings).toContain('<t>=HYPERLINK("http://x","click")</t>');
  expect(xml.sheet).not.toContain('HYPERLINK');
  // The merchant column (C) of the first data row (row 6, ungrouped) is a string cell.
  expect(cellXml(xml.sheet, 'C6')).toMatch(/t="(s|inlineStr)"/);
});

test('every formula prefix (= + - @ tab, carriage return) is stored as a string cell', async () => {
  const awkward = ['=1+2', '+44 20 7946 0000', '-2+3', '@SUM(A1:A2)', '\t=1+2', '\r=1+2', '=cmd|\' /C calc\'!A0'];
  const input: ReportInput = {
    ...W3_AWKWARD,
    title: '=HYPERLINK("http://x","title")',
    rows: awkward.map((merchant) => ({ date: '2026-03-03', person: '-Alice', merchant, gross: 100, vat: 17 })),
  };
  const buf = await renderXlsx(buildMoneyReport(input));
  const xml = parts(buf);
  expect(xml.sheet).not.toMatch(/<f[\s>/]/);
  for (let i = 0; i < awkward.length; i++) {
    expect(cellXml(xml.sheet, `B${String(6 + i)}`)).toMatch(/t="(s|inlineStr)"/);
    expect(cellXml(xml.sheet, `C${String(6 + i)}`)).toMatch(/t="(s|inlineStr)"/);
  }
  expect(cellXml(xml.sheet, 'A1')).toMatch(/t="(s|inlineStr)"/);
  const { rows } = await readBack(buf);
  expect(rows[0]![0]).toBe('=HYPERLINK("http://x","title")');
  const merchants = rows.slice(5, 5 + awkward.length).map((r) => r[2]);
  // Every one reads back exactly, the tab and carriage return included (kept with xml:space="preserve").
  expect(merchants).toEqual(awkward);
  expect(xml.strings).toContain('<t xml:space="preserve">\r=1+2</t>');
});

test('unusual characters survive', async () => {
  const { rows } = await readBack(await renderXlsx(buildMoneyReport(W3_AWKWARD)));
  const merchants = rows.map((r) => r[2]);
  expect(merchants).toContain('Łódź Café 🍕');
  expect(merchants).toContain(W3_AWKWARD.rows[2]!.merchant);
  expect((W3_AWKWARD.rows[2]!.merchant as string).length).toBe(200);
});

test('W3: a refund is a negative number and the totals stay exact', async () => {
  const { rows } = await readBack(await renderXlsx(buildMoneyReport(W3_AWKWARD)));
  const refund = rows.find((r) => r[2] === 'Corner Café (refund)')!;
  expect([refund[3], refund[4]]).toEqual([-5, -0.83]);
  const total = rowStarting(rows, 'Total');
  expect([total[3], total[4]]).toEqual([10.5, 1.76]);
  // Ungrouped: no group heading and no subtotal row.
  expect(rows.some((r) => typeof r[0] === 'string' && r[0].startsWith('Subtotal'))).toBe(false);
});

test('W2: 200 rows and the large total', async () => {
  const buf = await renderXlsx(buildMoneyReport(W2_LARGE));
  const { rows } = await readBack(buf);
  expect(rows.filter((r) => r[0] instanceof Date)).toHaveLength(200);
  const total = rowStarting(rows, 'Total');
  expect([total[W1_GROSS], total[W1_VAT]]).toEqual([246912, 41152]);
  expect(parts(buf).sheet).toContain('<v>246912</v>');
});

test('the sheet name is made safe', async () => {
  const name = async (title: string): Promise<string> => (await readBack(await renderXlsx({ ...buildMoneyReport(W1_MARCH), title }))).name;
  expect(await name('Expenses: March/April [draft]')).toBe('Expenses March April draft');
  expect(await name('A very long report title that goes on beyond the limit')).toBe('A very long report title that g');
  expect(await name('?*:')).toBe('Report');
});

test('a report with no rows still has its headings and a zero total', async () => {
  const report: MoneyReport = buildMoneyReport({ ...W1_MARCH, rows: [] });
  const { rows } = await readBack(await renderXlsx(report));
  expect(rows[4]).toEqual(['Date', 'Person', 'Category', 'Merchant', 'Total', 'VAT']);
  const total = rowStarting(rows, 'Total');
  expect([total[W1_GROSS], total[W1_VAT]]).toEqual([0, 0]);
});
