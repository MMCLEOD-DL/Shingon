/**
 * The money report model (Plan 12 Ruling 4: exports never calculate). `buildMoneyReport` checks every cell and works
 * out every subtotal and total once, in whole pence; the screen, the spreadsheet and the PDF only lay the result out.
 */
import { MoneyError, formatPounds, sumPence, type Pence } from './money.js';

export interface ReportColumn {
  key: string;
  label: string;
  /** `money` cells are whole pence; `date` cells are `YYYY-MM-DD`; `text` cells are shown as they are. */
  kind: 'text' | 'date' | 'money';
}

export type ReportRow = Record<string, string | number>;

/**
 * What a report is built from. Every money cell must be a whole number of pence: a missing money cell is refused, so
 * map "no VAT" to 0 before building.
 */
export interface ReportInput {
  title: string;
  periodLabel: string;
  generatedAt: Date;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** The key of a column to group by; without it the report is one group with `label: null`. */
  groupBy?: string;
}

export interface MoneyReportGroup {
  label: string | null;
  rows: ReportRow[];
  /** Every money column, summed over this group's rows. */
  subtotals: Record<string, Pence>;
}

export interface MoneyReport {
  title: string;
  periodLabel: string;
  /** When the report was generated: the PDF's creation date, so the same report always gives the same file. */
  generatedAt: Date;
  /** `generatedAt` in Europe/London, like `27 October 2026, 14:05`. */
  generatedAtText: string;
  columns: ReportColumn[];
  groups: MoneyReportGroup[];
  /** Every money column, summed over every row. */
  totals: Record<string, Pence>;
  rowCount: number;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for `YYYY-MM-DD` naming a day that exists (no 30 February). */
function isRealDay(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = ISO_DATE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const LONDON = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** A moment as `27 October 2026, 14:05`, in UK time (BST or GMT as the date requires). */
function londonText(at: Date): string {
  if (Number.isNaN(at.getTime())) throw new Error('A report needs the time it was generated.');
  const part = (type: Intl.DateTimeFormatPartTypes): string => LONDON.formatToParts(at).find((p) => p.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')}`;
}

/** Checks one cell and returns it as the report keeps it. */
function checkCell(col: ReportColumn, value: unknown, rowNumber: number): string | number {
  const where = `Row ${String(rowNumber)}, column "${col.label}"`;
  if (col.kind === 'money') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new MoneyError(`${where} is not a whole number of pence.`);
    return value;
  }
  if (col.kind === 'date') {
    if (!isRealDay(value)) throw new MoneyError(`${where} is not a date like 2026-03-12.`);
    return value;
  }
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new MoneyError(`${where} is not text.`);
  return value;
}

function totalsOf(moneyKeys: readonly string[], rows: readonly ReportRow[]): Record<string, Pence> {
  const out: Record<string, Pence> = {};
  for (const key of moneyKeys) out[key] = sumPence(rows.map((r) => r[key] as Pence));
  return out;
}

/**
 * Builds the report: checks every cell (money in whole pence, dates real days), groups the rows (groups sorted by
 * label; rows by date, then input order) and sums every money column per group and overall. The input is not changed.
 */
export function buildMoneyReport(input: ReportInput): MoneyReport {
  const { columns } = input;
  const groupCol = input.groupBy === undefined ? undefined : columns.find((c) => c.key === input.groupBy);
  if (input.groupBy !== undefined && !groupCol) throw new Error(`The report has no column "${input.groupBy}" to group by.`);
  const moneyKeys = columns.filter((c) => c.kind === 'money').map((c) => c.key);
  const dateKey = columns.find((c) => c.kind === 'date')?.key;

  const rows: ReportRow[] = input.rows.map((raw, i) => {
    const row: ReportRow = {};
    for (const col of columns) row[col.key] = checkCell(col, raw[col.key], i + 1);
    return row;
  });

  // Rows by date (ISO dates sort as text), then in the order they were given: Array.prototype.sort is stable.
  const ordered = dateKey === undefined ? rows : [...rows].sort((a, b) => {
    const x = a[dateKey] as string;
    const y = b[dateKey] as string;
    return x < y ? -1 : x > y ? 1 : 0;
  });

  const byLabel = new Map<string | null, ReportRow[]>();
  for (const row of ordered) {
    const label = groupCol ? String(row[groupCol.key]) : null;
    const list = byLabel.get(label);
    if (list) list.push(row);
    else byLabel.set(label, [row]);
  }
  const labels = [...byLabel.keys()].sort((a, b) => (a ?? '').localeCompare(b ?? '', 'en-GB'));

  return {
    title: input.title,
    periodLabel: input.periodLabel,
    generatedAt: new Date(input.generatedAt.getTime()),
    generatedAtText: londonText(input.generatedAt),
    columns: columns.map((c) => ({ ...c })),
    groups: labels.map((label) => {
      const groupRows = byLabel.get(label) ?? [];
      return { label, rows: groupRows, subtotals: totalsOf(moneyKeys, groupRows) };
    }),
    totals: totalsOf(moneyKeys, rows),
    rowCount: rows.length,
  };
}

/** A cell as people read it: money as `−£5.00`, a date as `12/03/2026`, text as it is. Used by the screen and the PDF. */
export function formatCell(col: ReportColumn, v: string | number): string {
  if (col.kind === 'money') return formatPounds(v as Pence);
  if (col.kind === 'date') {
    const m = typeof v === 'string' ? ISO_DATE.exec(v) : null;
    return m ? `${m[3] ?? ''}/${m[2] ?? ''}/${m[1] ?? ''}` : String(v);
  }
  return String(v);
}
