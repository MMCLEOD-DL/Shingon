import { vatFromGross, type Pence, type ReceiptProposal, type Scored } from '@hf/shared';
import { findMoney, isPhoneLine, type MoneyToken } from './money-tokens.js';
import { daysBetween, findDates } from './dates.js';

/** One recognised line of a receipt and the engine's confidence in it, from 0 to 1. */
export interface OcrLine {
  text: string;
  confidence: number;
}

/**
 * Turns recognised lines into proposed fields with confidences (Plan 12 Task 2). A pure function: no engine,
 * no clock. The rule is "never confidently wrong" (Ruling 2): whenever the rules are unsure, the confidence
 * falls below CONFIDENT so the form says "Please check". The text itself is not kept (Ruling 5).
 */

export const NOT_POUNDS_WARNING = 'This receipt may not be in pounds. Please check the amount.';
export const VAT_MISMATCH_WARNING = "The VAT doesn't match the usual rates for this total. Please check it.";

const TOTAL_WORD = /total|balance due|amount due|to pay|grand total/i;
const NOT_TOTAL_WORD = /sub|savings|\bvat\b|\btax\b|\bnet\b|discount/i;
const VAT_WORD = /\bvat\b|\btax\b|\bincl/i;
// A VAT summary row: a rate code, the rate, then the net and the VAT ("A 20% 16.66 3.33").
const VAT_ROW = /^\s*[A-Z]\s+(\d{1,2})(?:\.(\d{1,2}))?\s?%/;
const OTHER_CURRENCY = /€|\bEUR\b|\$|\bUSD\b|\bTVA\b|\bMwSt\b/i;
const POUNDS = /£|\bGBP\b/;
const DATE_PREFERRED = /invoice|date|issued/i;
const DATE_AVOIDED = /arriv|depart|check/i;
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
const URL_LIKE = /www\.|https?:|\.co\.uk|\.com\b|@/i;
const NOT_MERCHANT_WORD = /\bvat\b|receipt|invoice/i;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const scored = <T>(value: T, confidence: number): Scored<T> => ({ value, confidence: round2(Math.min(1, Math.max(0, confidence))) });
const capped = <T>(s: Scored<T>, cap: number): Scored<T> => scored(s.value, Math.min(s.confidence, cap));

interface Line extends OcrLine {
  money: MoneyToken[];
}

function currencyOf(lines: readonly OcrLine[]): ReceiptProposal['currency'] {
  const all = lines.map((l) => l.text).join('\n');
  if (OTHER_CURRENCY.test(all)) return 'other';
  if (POUNDS.test(all)) return 'GBP';
  return 'unknown';
}

function findTotal(lines: readonly Line[]): Scored<Pence> | null {
  const keyword = lines.filter((l) => TOTAL_WORD.test(l.text) && !NOT_TOTAL_WORD.test(l.text) && l.money.length > 0).at(-1);
  const token = keyword?.money.at(-1);
  if (token) return scored(token.pence, token.confidence);
  // No total line: offer the largest amount anywhere, but never confidently.
  let largest: MoneyToken | undefined;
  for (const t of lines.flatMap((l) => l.money)) if (!largest || t.pence > largest.pence) largest = t;
  return largest ? scored(largest.pence, Math.min(largest.confidence, 0.6)) : null;
}

/** VAT inside `net` at `basisPoints`, rounded half up, in integers. */
const vatOnNet = (net: Pence, basisPoints: number): Pence => Math.floor((2 * net * basisPoints + 10000) / 20000);

interface VatRow {
  basisPoints: number;
  net: MoneyToken;
  vat: MoneyToken;
}

function vatRows(lines: readonly Line[]): VatRow[] {
  const rows: VatRow[] = [];
  for (const l of lines) {
    const m = VAT_ROW.exec(l.text);
    if (!m || l.money.length !== 2) continue;
    const [net, vat] = l.money as [MoneyToken, MoneyToken];
    rows.push({ basisPoints: Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')), net, vat });
  }
  return rows;
}

/** True when the VAT fits the total: within 1p of 20%, 5% or 0% of the gross, or (with a summary table) every row fits and the rows add up to the total. */
function vatFits(amount: Pence, vat: Pence, rows: readonly VatRow[]): boolean {
  if (rows.length > 0) {
    const eachRowFits = rows.every((r) => Math.abs(r.vat.pence - vatOnNet(r.net.pence, r.basisPoints)) <= 1);
    const addsUp = rows.reduce((sum, r) => sum + r.net.pence + r.vat.pence, 0) === amount;
    return eachRowFits && addsUp;
  }
  return [vatFromGross(amount, 2000), vatFromGross(amount, 500), 0].some((v) => Math.abs(vat - v) <= 1);
}

function findVat(lines: readonly Line[], amount: Scored<Pence> | null, warnings: string[]): ReceiptProposal['vatPence'] {
  if (!amount) return null;
  const rows = vatRows(lines);
  let vat: Scored<Pence> | null = null;
  if (rows.length > 0) {
    vat = scored(
      rows.reduce((sum, r) => sum + r.vat.pence, 0),
      Math.min(...rows.map((r) => r.vat.confidence)),
    );
  } else {
    const token = lines.filter((l) => VAT_WORD.test(l.text) && !VAT_ROW.test(l.text) && l.money.length > 0).at(-1)?.money.at(-1);
    if (token) vat = scored(token.pence, token.confidence);
  }
  // "No VAT shown" is never confident: the VAT line may simply have been missed.
  if (!vat) return { value: null, confidence: 0.7 };
  if (vatFits(amount.value, vat.value, rows)) return vat;
  warnings.push(VAT_MISMATCH_WARNING);
  return capped(vat, 0.5);
}

function findDate(lines: readonly OcrLine[], today: string): Scored<string> | null {
  let best: { rank: number; value: string; confidence: number } | null = null;
  for (const l of lines) {
    const first = findDates(l.text)[0];
    if (first === undefined) continue;
    const rank = DATE_AVOIDED.test(l.text) ? 0 : DATE_PREFERRED.test(l.text) ? 2 : 1;
    if (!best || rank > best.rank) best = { rank, value: first, confidence: l.confidence };
  }
  if (!best) return null;
  const date = scored(best.value, best.confidence);
  const unlikely = daysBetween(today, date.value) > 0 || daysBetween(date.value, today) > 400;
  return unlikely ? capped(date, 0.5) : date;
}

function findMerchant(lines: readonly Line[]): Scored<string> | null {
  const line = lines.slice(0, 5).find((l) => {
    const t = l.text;
    return (
      (t.match(/\p{L}/gu)?.length ?? 0) >= 3 &&
      !POSTCODE.test(t) &&
      !isPhoneLine(t) &&
      !URL_LIKE.test(t) &&
      !NOT_MERCHANT_WORD.test(t) &&
      findDates(t).length === 0 &&
      l.money.length === 0 &&
      !TOTAL_WORD.test(t)
    );
  });
  return line ? scored(line.text.trim().replace(/\s+/g, ' '), Math.min(line.confidence, 0.9)) : null;
}

export function extractReceipt(input: readonly OcrLine[], opts: { today: string }): ReceiptProposal {
  const recognised = input.filter((l) => l.text.trim() !== '');
  const currency = currencyOf(recognised);
  const lines: Line[] = recognised.map((l) => ({ ...l, money: findMoney(l.text, l.confidence, { commaDecimals: currency === 'other' }) }));
  const warnings: string[] = [];

  let amountPence = findTotal(lines);
  if (amountPence && currency === 'other') {
    amountPence = capped(amountPence, 0.5);
    warnings.push(NOT_POUNDS_WARNING);
  } else if (amountPence && currency === 'unknown') {
    amountPence = capped(amountPence, 0.8);
  }

  return {
    amountPence,
    vatPence: findVat(lines, amountPence, warnings),
    date: findDate(recognised, opts.today),
    merchant: findMerchant(lines),
    currency,
    warnings,
  };
}
