/**
 * The PDF export: lays out a MoneyReport on A4 pages, and never calculates (Plan 12 Ruling 4). Every figure printed is
 * a cell, subtotal or total the report already holds, shown with formatCell / formatPounds.
 *
 * Only the standard Helvetica fonts are used (nothing embedded), so all text goes through toWinAnsi: characters outside
 * Windows-1252 print as `?`, and the minus sign of "−£5.00" prints as "-£5.00". Report text is only ever drawn as text,
 * never as a link, annotation or action, so nothing in the data can make the file open an address or run a script.
 * The same report always gives the same bytes: the file's date is the report's generatedAt and its id derives from it.
 */
import PDFDocument from 'pdfkit';
import { formatCell, formatPounds, type MoneyReport, type ReportColumn, type ReportRow } from '@hf/shared';
import { toWinAnsi } from './winAnsi.js';

export interface PdfOptions {
  /** Printed above the title on every page. */
  appName?: string;
}

type FontName = 'Helvetica' | 'Helvetica-Bold';
const REGULAR: FontName = 'Helvetica';
const BOLD: FontName = 'Helvetica-Bold';

const PAGE_WIDTH = 595.28; // A4 in points
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const RIGHT = PAGE_WIDTH - MARGIN;
const CONTENT_WIDTH = RIGHT - MARGIN;

const ROW_SIZE = 9;
const LINE = 11; // line height for 9 pt text
const ROW_PAD = 3; // space below each row
const HEAD_SIZE = 7.5; // column labels
const FOOTER_SIZE = 8;
const FOOTER_Y = PAGE_HEIGHT - MARGIN - FOOTER_SIZE;
const BODY_BOTTOM = FOOTER_Y - 12; // rows stop here, clear of the footer
const GAP = 8; // space between columns
const MIN_TEXT_WIDTH = 24;
/** A cell longer than this many lines is cut with "…", so one row always fits on a page. */
const MAX_CELL_LINES = 30;

const INK = '#1a1a1a';
const MUTED = '#555555';
const RULE = '#9a9a9a';

interface PlacedColumn {
  col: ReportColumn;
  x: number;
  width: number;
}

/** A cell's text as it prints. Money and dates come from formatCell; everything passes through toWinAnsi. */
function cellText(col: ReportColumn, v: string | number | undefined): string {
  if (v === undefined || v === '') return '';
  return toWinAnsi(formatCell(col, v));
}

const money = (pence: number | undefined): string => (pence === undefined ? '' : toWinAnsi(formatPounds(pence)));

class Layout {
  private readonly doc: PDFDocument;
  private readonly report: MoneyReport;
  private readonly appName: string | undefined;
  private readonly columns: PlacedColumn[];
  private y = MARGIN;
  private bodyTop = MARGIN;

  constructor(doc: PDFDocument, report: MoneyReport, appName: string | undefined) {
    this.doc = doc;
    this.report = report;
    this.appName = appName === undefined || appName.trim() === '' ? undefined : toWinAnsi(appName);
    this.columns = this.placeColumns();
  }

  private width(text: string, font: FontName, size: number): number {
    return this.doc.font(font).fontSize(size).widthOfString(text);
  }

  private headLabel(col: ReportColumn): string {
    // Column labels are capitals, so a heading like "Total" is never confused with the Total row.
    return toWinAnsi(col.label).toUpperCase();
  }

  /**
   * Dates and money get the width of their widest entry. Text columns share what is left: a column that needs less
   * than an equal share gets what it needs, and the rest is shared again among the others.
   */
  private placeColumns(): PlacedColumn[] {
    const { columns, groups, totals } = this.report;
    const rows = groups.flatMap((g) => g.rows);
    const widths = columns.map((col) => {
      let w = this.width(this.headLabel(col), BOLD, HEAD_SIZE);
      for (const row of rows) w = Math.max(w, this.width(cellText(col, row[col.key]), REGULAR, ROW_SIZE));
      if (col.kind === 'money') {
        for (const figures of [totals, ...groups.map((g) => g.subtotals)]) w = Math.max(w, this.width(money(figures[col.key]), BOLD, ROW_SIZE));
      }
      return Math.ceil(w);
    });
    const textIdx = columns.flatMap((c, i) => (c.kind === 'text' ? [i] : []));
    const fixed = widths.reduce((sum, w, i) => (columns[i]?.kind === 'text' ? sum : sum + w), 0);
    let left = CONTENT_WIDTH - fixed - GAP * Math.max(0, columns.length - 1);
    let open = [...textIdx];
    const given = new Map<number, number>();
    while (open.length > 0) {
      const share = left / open.length;
      const fits = open.filter((i) => (widths[i] ?? 0) <= share);
      if (fits.length === 0) {
        for (const i of open) given.set(i, Math.max(MIN_TEXT_WIDTH, share));
        left = 0;
        break;
      }
      for (const i of fits) {
        given.set(i, widths[i] ?? 0);
        left -= widths[i] ?? 0;
      }
      open = open.filter((i) => !fits.includes(i));
    }
    // Space left over when every text column fits goes to the text columns, so money stays at the right edge.
    if (left > 0 && textIdx.length > 0) for (const i of textIdx) given.set(i, (given.get(i) ?? 0) + left / textIdx.length);
    let x = MARGIN;
    return columns.map((col, i) => {
      const w = col.kind === 'text' ? (given.get(i) ?? MIN_TEXT_WIDTH) : (widths[i] ?? 0) + (textIdx.length === 0 && i === 0 ? Math.max(0, left) : 0);
      const placed = { col, x, width: w };
      x += w + GAP;
      return placed;
    });
  }

  /** `text` broken into lines no wider than `width`: at spaces where it can, inside a word too long for a line. */
  private wrap(text: string, width: number, font: FontName, size: number): string[] {
    const fits = (s: string): boolean => this.width(s, font, size) <= width;
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(' ').filter((w) => w !== '')) {
      const joined = line === '' ? word : `${line} ${word}`;
      if (fits(joined)) {
        line = joined;
        continue;
      }
      if (line !== '') lines.push(line);
      line = '';
      for (const ch of Array.from(word)) {
        if (line !== '' && !fits(line + ch)) {
          lines.push(line);
          line = ch;
        } else line += ch;
      }
    }
    if (line !== '' || lines.length === 0) lines.push(line);
    if (lines.length <= MAX_CELL_LINES) return lines;
    const kept = lines.slice(0, MAX_CELL_LINES);
    let last = `${kept[MAX_CELL_LINES - 1] ?? ''}…`;
    while (last.length > 1 && !fits(last)) last = `${Array.from(last).slice(0, -2).join('')}…`;
    kept[MAX_CELL_LINES - 1] = last;
    return kept;
  }

  private draw(text: string, x: number, y: number, font: FontName, size: number, color = INK): void {
    if (text === '') return;
    this.doc.font(font).fontSize(size).fillColor(color).text(text, x, y, { lineBreak: false });
  }

  private drawRight(text: string, right: number, y: number, font: FontName, size: number, color = INK): void {
    this.draw(text, right - this.width(text, font, size), y, font, size, color);
  }

  private rule(y: number, from = MARGIN, weight = 0.5): void {
    this.doc.lineWidth(weight).strokeColor(RULE).moveTo(from, y).lineTo(RIGHT, y).stroke();
  }

  /** The page header: app name, title, period, then the column labels and a rule. */
  private pageHeader(): void {
    let y = MARGIN;
    if (this.appName !== undefined) {
      this.draw(this.appName, MARGIN, y, REGULAR, 8, MUTED);
      y += 12;
    }
    for (const line of this.wrap(toWinAnsi(this.report.title), CONTENT_WIDTH, BOLD, 14)) {
      this.draw(line, MARGIN, y, BOLD, 14);
      y += 17;
    }
    for (const line of this.wrap(toWinAnsi(this.report.periodLabel), CONTENT_WIDTH, REGULAR, ROW_SIZE)) {
      this.draw(line, MARGIN, y, REGULAR, ROW_SIZE, MUTED);
      y += LINE;
    }
    y += 10;
    let lines = 1;
    for (const { col, x, width } of this.columns) {
      const label = this.wrap(this.headLabel(col), width, BOLD, HEAD_SIZE);
      lines = Math.max(lines, label.length);
      label.forEach((l, i) => {
        if (col.kind === 'money') this.drawRight(l, x + width, y + i * 9, BOLD, HEAD_SIZE, MUTED);
        else this.draw(l, x, y + i * 9, BOLD, HEAD_SIZE, MUTED);
      });
    }
    y += lines * 9 + 2;
    this.rule(y);
    this.y = y + 5;
    this.bodyTop = this.y;
  }

  /** Starts a new page unless `height` still fits on this one (or this page has nothing on it yet). */
  private makeRoom(height: number): void {
    if (this.y + height <= BODY_BOTTOM || this.y === this.bodyTop) return;
    this.doc.addPage();
    this.pageHeader();
  }

  private rowLines(row: ReportRow): string[][] {
    return this.columns.map(({ col, width }) => {
      const text = cellText(col, row[col.key]);
      return col.kind === 'text' ? this.wrap(text, width, REGULAR, ROW_SIZE) : [text];
    });
  }

  private rowHeight(lines: string[][]): number {
    return Math.max(1, ...lines.map((l) => l.length)) * LINE + ROW_PAD;
  }

  private drawRow(lines: string[][]): void {
    this.makeRoom(this.rowHeight(lines));
    this.columns.forEach(({ col, x, width }, i) => {
      (lines[i] ?? []).forEach((line, n) => {
        if (col.kind === 'money') this.drawRight(line, x + width, this.y + n * LINE, REGULAR, ROW_SIZE);
        else this.draw(line, x, this.y + n * LINE, REGULAR, ROW_SIZE);
      });
    });
    this.y += this.rowHeight(lines);
  }

  /** A rule, a bold label across the columns before the first money column, and the given figures in their columns. */
  private drawSummary(label: string, figures: Record<string, number>, weight: number): void {
    const firstMoney = this.columns.find((c) => c.col.kind === 'money');
    const span = firstMoney ? Math.max(MIN_TEXT_WIDTH, firstMoney.x - GAP - MARGIN) : CONTENT_WIDTH;
    const lines = this.wrap(toWinAnsi(label), span, BOLD, ROW_SIZE);
    const height = lines.length * LINE + ROW_PAD + 4;
    this.makeRoom(height);
    this.rule(this.y, MARGIN, weight);
    const top = this.y + 3;
    lines.forEach((l, n) => { this.draw(l, MARGIN, top + n * LINE, BOLD, ROW_SIZE); });
    for (const { col, x, width } of this.columns) {
      if (col.kind === 'money') this.drawRight(money(figures[col.key]), x + width, top, BOLD, ROW_SIZE);
    }
    this.y += height;
  }

  render(): void {
    this.pageHeader();
    for (const group of this.report.groups) {
      const first = group.rows[0];
      const firstLines = first ? this.rowLines(first) : [];
      if (group.label !== null) {
        const heading = this.wrap(toWinAnsi(group.label), CONTENT_WIDTH, BOLD, ROW_SIZE);
        const headingHeight = heading.length * LINE + ROW_PAD + 3;
        // A group heading is never left alone at the foot of a page: it moves over with its first row.
        this.makeRoom(headingHeight + (first ? this.rowHeight(firstLines) : 0));
        heading.forEach((l, n) => { this.draw(l, MARGIN, this.y + 3 + n * LINE, BOLD, ROW_SIZE); });
        this.y += headingHeight;
      }
      group.rows.forEach((row, i) => { this.drawRow(i === 0 ? firstLines : this.rowLines(row)); });
      if (group.label !== null) this.drawSummary(`Subtotal: ${group.label}`, group.subtotals, 0.5);
      this.y += group.label !== null ? 4 : 0;
    }
    this.drawSummary('Total', this.report.totals, 1.2);
    this.footers();
  }

  /** `Generated …` and `Page N of M` on every page, once the number of pages is known. */
  private footers(): void {
    const { start, count } = this.doc.bufferedPageRange();
    const generated = toWinAnsi(`Generated ${this.report.generatedAtText}`);
    for (let i = 0; i < count; i += 1) {
      this.doc.switchToPage(start + i);
      this.draw(generated, MARGIN, FOOTER_Y, REGULAR, FOOTER_SIZE, MUTED);
      this.drawRight(`Page ${String(i + 1)} of ${String(count)}`, RIGHT, FOOTER_Y, REGULAR, FOOTER_SIZE, MUTED);
    }
  }
}

/** The report as an A4 PDF: a header on every page, rows that never split across pages, subtotals, then the total. */
export function renderPdf(report: MoneyReport, opts: PdfOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      bufferPages: true,
      info: { CreationDate: report.generatedAt, Producer: 'Highland', Creator: 'Highland' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => { resolve(Buffer.concat(chunks)); });
    doc.on('error', reject);
    try {
      new Layout(doc, report, opts.appName).render();
      doc.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
