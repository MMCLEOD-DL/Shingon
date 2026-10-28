/**
 * The spreadsheet export: lays out a MoneyReport, and never calculates (Plan 12 Ruling 4). Every subtotal and total is
 * written as the value the report already holds, never as a formula, so the file shows exactly the app's figures.
 * Text is always written as a string cell (shared string, `t="s"`), so a merchant like `=HYPERLINK(...)` or one starting
 * with + - @ is shown as text and never run as a formula.
 */
import writeXlsxFile from 'write-excel-file/node';
import type { CellObject, Row, SheetData } from 'write-excel-file/node';
import type { MoneyReport, ReportColumn } from '@hf/shared';

/** Pounds; a negative shows a minus sign (U+2212) before the pound sign, "−£5.00", as formatCell does. */
const MONEY_FORMAT = '£#,##0.00;"−"£#,##0.00';
const DATE_FORMAT = 'dd/mm/yyyy';
const MAX_SHEET_NAME = 31;

/** Excel's rules for a sheet name: none of []:*?/\, no apostrophe at either end, at most 31 characters, not empty. */
export function safeSheetName(title: string): string {
  const cleaned = title.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = Array.from(cleaned).slice(0, MAX_SHEET_NAME).join('').replace(/^'+|'+$/g, '').trim();
  return cut === '' ? 'Report' : cut;
}

const text = (value: string, bold = false): CellObject => ({ value, type: String, ...(bold ? { fontWeight: 'bold' as const } : {}) });

/** Whole pence to pounds for the cell: an integer divided by 100 is the nearest double to the exact decimal, so 9364 is stored as 93.64. */
const money = (pence: number, bold = false): CellObject => ({ value: pence / 100, type: Number, format: MONEY_FORMAT, ...(bold ? { fontWeight: 'bold' as const } : {}) });

function date(iso: string): CellObject {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return { value: new Date(Date.UTC(y, m - 1, d)), type: Date, format: DATE_FORMAT };
}

function cell(col: ReportColumn, v: string | number | undefined): CellObject | null {
  if (v === undefined || v === '') return null;
  if (col.kind === 'money') return money(v as number);
  if (col.kind === 'date') return date(v as string);
  return text(String(v));
}

/** A bold label in the first non-money column, with the given money figures in their own columns. */
function summaryRow(columns: readonly ReportColumn[], label: string, figures: Record<string, number> | null): Row {
  const labelAt = Math.max(0, columns.findIndex((c) => c.kind !== 'money'));
  return columns.map((c, i) => {
    if (c.kind === 'money' && figures) return money(figures[c.key] ?? 0, true);
    return i === labelAt ? text(label, true) : null;
  });
}

function columnWidth(col: ReportColumn): number {
  if (col.kind === 'date') return 12;
  if (col.kind === 'money') return 14;
  return Math.max(12, Math.min(40, col.label.length + 2));
}

/** The report as an .xlsx file: title, period, generated time, then the table with group headings, subtotals and the total. */
export async function renderXlsx(report: MoneyReport): Promise<Buffer> {
  const { columns } = report;
  const data: SheetData = [
    [text(report.title, true)],
    [text(report.periodLabel)],
    [text(`Generated ${report.generatedAtText}`)],
    [],
    columns.map((c) => text(c.label, true)),
  ];
  for (const group of report.groups) {
    if (group.label !== null) data.push(summaryRow(columns, group.label, null));
    for (const row of group.rows) data.push(columns.map((c) => cell(c, row[c.key])));
    if (group.label !== null) data.push(summaryRow(columns, `Subtotal: ${group.label}`, group.subtotals));
  }
  data.push(summaryRow(columns, 'Total', report.totals));
  return writeXlsxFile(data, { sheet: safeSheetName(report.title), columns: columns.map((c) => ({ width: columnWidth(c) })) }).toBuffer();
}
