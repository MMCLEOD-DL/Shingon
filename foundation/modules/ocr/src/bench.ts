import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIDENT, type ReceiptField, type ReceiptProposal } from '@hf/shared';
import { createLocalEngine } from './local.js';
import { readReceipt } from './readReceipt.js';
import { UnreadableError, type OcrEngine, type OcrInputType } from './types.js';

/** What a corpus file should be read as (`expected.json`, keyed by file name). */
export interface ExpectedReceipt {
  amountPence: number;
  vatPence: number | null;
  date: string;
  merchant: string;
}

/** right: equal to the expected value; wrongFlagged: wrong but marked "Please check"; confidentlyWrong: wrong and shown as certain. */
export type FieldOutcome = 'right' | 'wrongFlagged' | 'confidentlyWrong' | 'missing';

export interface BenchCase {
  file: string;
  ms: number;
  /** The sentence staff would see, when the engine could not read the file at all. */
  unreadable: string | null;
  expected: ExpectedReceipt;
  proposal: ReceiptProposal | null;
  outcome: Record<ReceiptField, FieldOutcome>;
  right: Record<ReceiptField, boolean>;
}

export interface BenchReport {
  cases: BenchCase[];
  perField: Record<ReceiptField, { right: number; wrongFlagged: number; confidentlyWrong: number; missing: number }>;
  msMedian: number;
  msMax: number;
}

const FIELDS: readonly ReceiptField[] = ['amount', 'vat', 'date', 'merchant'];
const TYPES: Record<string, OcrInputType> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.pdf': 'application/pdf' };

/** `expected.json` in the folder itself, or else in its parent (the rendered corpus shares `receipts/expected.json`). */
function readExpected(dir: string): Record<string, ExpectedReceipt> {
  for (const file of [path.join(dir, 'expected.json'), path.join(dir, '..', 'expected.json')]) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Record<string, ExpectedReceipt>;
  }
  return {};
}

function outcomeOf<T>(field: { value: T; confidence: number } | null, isRight: (v: T) => boolean): FieldOutcome {
  if (field === null) return 'missing';
  if (isRight(field.value)) return 'right';
  return field.confidence >= CONFIDENT ? 'confidentlyWrong' : 'wrongFlagged';
}

/** How each field of a proposal compares with what the receipt says. The merchant is right when the proposal contains it, ignoring case. */
export function scoreProposal(p: ReceiptProposal | null, e: ExpectedReceipt): Record<ReceiptField, FieldOutcome> {
  if (!p) return { amount: 'missing', vat: 'missing', date: 'missing', merchant: 'missing' };
  return {
    amount: outcomeOf(p.amountPence, (v) => v === e.amountPence),
    vat: outcomeOf(p.vatPence, (v) => v === e.vatPence),
    date: outcomeOf(p.date, (v) => v === e.date),
    merchant: outcomeOf(p.merchant, (v) => v.toLowerCase().includes(e.merchant.toLowerCase())),
  };
}

/**
 * Reads every image or PDF in `dir` that has an `expected.json` entry, one at a time (so each time is the engine's
 * own), and scores each field against Ruling 2: a wrong field is acceptable only when it is marked "Please check".
 */
export async function benchCorpus(engine: OcrEngine, dir: string, today: string): Promise<BenchReport> {
  const expected = readExpected(dir);
  const files = readdirSync(dir)
    .filter((f) => TYPES[path.extname(f).toLowerCase()] !== undefined && expected[f] !== undefined)
    .sort();
  const cases: BenchCase[] = [];
  for (const file of files) {
    const type = TYPES[path.extname(file).toLowerCase()];
    const want = expected[file];
    if (!type || !want) continue;
    const started = performance.now();
    let proposal: ReceiptProposal | null = null;
    let unreadable: string | null = null;
    try {
      const result = await engine.read({ bytes: readFileSync(path.join(dir, file)), type });
      proposal = readReceipt(result, today);
    } catch (e) {
      if (!(e instanceof UnreadableError)) throw e;
      unreadable = e.userMessage;
    }
    const outcome = scoreProposal(proposal, want);
    const right = { amount: outcome.amount === 'right', vat: outcome.vat === 'right', date: outcome.date === 'right', merchant: outcome.merchant === 'right' };
    cases.push({ file, ms: Math.round(performance.now() - started), unreadable, expected: want, proposal, outcome, right });
  }
  const perField = Object.fromEntries(
    FIELDS.map((f) => {
      const count = (o: FieldOutcome): number => cases.filter((c) => c.outcome[f] === o).length;
      return [f, { right: count('right'), wrongFlagged: count('wrongFlagged'), confidentlyWrong: count('confidentlyWrong'), missing: count('missing') }];
    }),
  ) as BenchReport['perField'];
  const times = cases.map((c) => c.ms).sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  const msMedian = times.length === 0 ? 0 : times.length % 2 === 1 ? (times[mid] ?? 0) : Math.round(((times[mid - 1] ?? 0) + (times[mid] ?? 0)) / 2);
  return { cases, perField, msMedian, msMax: times.at(-1) ?? 0 };
}

const FIELD_NAMES: Record<ReceiptField, string> = { amount: 'Total', vat: 'VAT', date: 'Date', merchant: 'Merchant' };
const OUTCOME_WORDS: Record<FieldOutcome, string> = {
  right: 'right',
  wrongFlagged: 'wrong, marked "Please check"',
  confidentlyWrong: '**WRONG and shown as certain**',
  missing: 'not found',
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

function shown(p: ReceiptProposal | null, f: ReceiptField): string {
  const field = p === null ? null : { amount: p.amountPence, vat: p.vatPence, date: p.date, merchant: p.merchant }[f];
  if (!field) return '';
  const value = field.value === null ? 'no VAT shown' : typeof field.value === 'number' ? `£${(field.value / 100).toFixed(2)}` : field.value;
  return ` (${value.replace(/\|/g, '/')}, ${String(Math.round(field.confidence * 100))}%)`;
}

/** The report as plain-English Markdown: a table per field, then one row per file. */
export async function writeAccuracyReport(r: BenchReport, file: string): Promise<void> {
  const total = r.cases.length;
  const certainWrong = FIELDS.reduce((n, f) => n + r.perField[f].confidentlyWrong, 0);
  const out = [
    '# OCR accuracy',
    '',
    `${String(total)} receipts read. ${certainWrong === 0 ? 'No field was wrong and shown as certain.' : `${String(certainWrong)} fields were wrong and shown as certain.`}` +
      ` Each reading took ${seconds(r.msMedian)} in the middle case and ${seconds(r.msMax)} at most.`,
    '',
    'A field is **right** when it matches the receipt, **wrong, marked "Please check"** when it does not but the form asks staff to check it, ' +
      '**wrong and shown as certain** when it does not and the form would show it as read (this must never happen), and **not found** when nothing was proposed.',
    '',
    '## By field',
    '',
    '| Field | Right | Wrong, marked "Please check" | Wrong and shown as certain | Not found |',
    '|---|---|---|---|---|',
    ...FIELDS.map((f) => {
      const c = r.perField[f];
      return `| ${FIELD_NAMES[f]} | ${[`${String(c.right)} of ${String(total)}`, c.wrongFlagged, c.confidentlyWrong, c.missing].map(String).join(' | ')} |`;
    }),
    '',
    '## By receipt',
    '',
    '| Receipt | Total | VAT | Date | Merchant | Time |',
    '|---|---|---|---|---|---|',
    ...r.cases.map((c) => {
      if (c.unreadable !== null) return `| ${c.file} | could not be read: ${c.unreadable} | | | | ${seconds(c.ms)} |`;
      return `| ${c.file} | ${FIELDS.map((f) => `${OUTCOME_WORDS[c.outcome[f]]}${shown(c.proposal, f)}`).join(' | ')} | ${seconds(c.ms)} |`;
    }),
    '',
  ];
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, out.join('\n'));
}

const USAGE = 'Usage: node modules/ocr/dist/bench.js <folder> [--today YYYY-MM-DD] [--json <file>]';

/** `node modules/ocr/dist/bench.js <dir> [--today YYYY-MM-DD] [--json <file>]`: prints the report as JSON. */
async function main(argv: string[]): Promise<number> {
  let dir: string | undefined;
  let today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  let json: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--today' || arg === '--json') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        process.stderr.write(`${arg} needs a value.\n${USAGE}\n`);
        return 2;
      }
      if (arg === '--today') today = value;
      else json = value;
      i += 1;
    } else if (arg !== undefined && !arg.startsWith('--') && dir === undefined) dir = arg;
    else {
      process.stderr.write(`Unexpected argument: ${String(arg)}\n${USAGE}\n`);
      return 2;
    }
  }
  if (dir === undefined || !existsSync(dir)) {
    process.stderr.write(`${dir === undefined ? 'Give the folder of receipts to read.' : `There is no folder at ${dir}.`}\n${USAGE}\n`);
    return 2;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    process.stderr.write(`--today must be a date like 2026-03-31.\n${USAGE}\n`);
    return 2;
  }
  const engine = await createLocalEngine({ workers: 1 });
  try {
    const report = await benchCorpus(engine, dir, today);
    const text = JSON.stringify(report);
    if (json !== undefined) await writeFile(json, `${text}\n`);
    process.stdout.write(`${text}\n`);
    return 0;
  } finally {
    await engine.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
