import { CONFIDENT, vatFromGross, type Pence, type ReceiptProposal, type Scored } from '@hf/shared';
import { findMoney, isPhoneLine, type MoneyToken } from './money-tokens.js';
import { daysBetween, findDates } from './dates.js';

/** One recognised line of a receipt and the engine's confidence in it, from 0 to 1. */
export interface OcrLine {
  text: string;
  confidence: number;
}

/**
 * Turns recognised lines into proposed fields with confidences (Plan 12 Task 2). A pure function: no engine,
 * no clock. The rule is "never confidently wrong" (Ruling 2, which overrides the brief's selection rules): whenever
 * the rules are unsure, the confidence falls below CONFIDENT so the form says "Please check". The text itself is
 * not kept (Ruling 5).
 */

export const NOT_POUNDS_WARNING = 'This receipt may not be in pounds. Please check the amount.';
export const VAT_MISMATCH_WARNING = "The VAT doesn't match the usual rates for this total. Please check it.";

/** The most an unsure field may score: always below CONFIDENT. */
const UNSURE = 0.6;
const DOUBTFUL = 0.5;

const TOTAL_WORD = /total|balance due|amount due|to pay|grand total|payable|\bpay\b|amount\b|charged|due/i;
// Lines that mention a total but are not the amount paid: subtotals, savings, money handed over, tips, points.
const NOT_TOTAL_WORD =
  /sub|\bsav(e|ed|es|ing|ings)\b|reduction|promo|tender|cash|change|paid|deposit|\btip\b|gratuity|suggest|points|\bvat\b|\btax\b|\bnet\b|discount|excl|\bexc\b|before|refund|credit/i;
// "Total incl. VAT £8.75" is a total; "Total excl. VAT" and "Total ex VAT" are not.
const INCLUDING_VAT = /\b(?:incl(?:uding|\.)?|inc\.?)\s*(?:of\s*)?vat\b/i;
const VAT_WORD = /\bvat\b|\btax\b/i;
// "Total before VAT £7.29", "excluding VAT": a net amount, never the VAT.
const NET_OF_VAT = /\b(?:excl(?:uding|\.)?|exc\.?|ex|before|less|without)\s*(?:of\s*)?vat\b/i;
// A refund or credit note anywhere (other than a payment card line) means the amounts may be money going back.
const REFUND_OR_CREDIT = /refund|credit/i;
// A VAT summary row: a rate code, the rate, then the net and the VAT, and optionally the gross ("A 20% 16.66 3.33 19.99").
const VAT_ROW = /^\s*[A-Z]\s+(\d{1,2})(?:\.(\d{1,2}))?\s?%/;
const OTHER_CURRENCY = /€|\bEUR\b|\$|\bUSD\b|\bTVA\b|\bMwSt\b/i;
const POUNDS = /£|\bGBP\b/;
// Only these labels make a date the transaction date ("Invoice date", "Date of issue", "Sale date").
const DATE_PREFERRED = /\b(invoice|issued?|transaction|sale|receipt)\b/i;
// Labelled dates that are not when the money was spent.
const NOT_TRANSACTION_DATE =
  /arriv|depart|check|due|reprint|print(ed)?|return|expir|valid|collect|deliver|best before|use by|\bends?\b|perform|travel/i;
const ORDER_DATE = /order/i;
// "V.A.T.", "V A T" -> "VAT", before any other test.
const SPELLED_VAT = /\bV[.\s]?A[.\s]?T\b\.?/gi;
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
const STREET =
  /\b\d+[A-Za-z]?,?\s+(?:[\p{L}'.-]+\s+){0,3}(street|st|road|rd|lane|ln|avenue|ave|way|close|drive|dr|place|square|sq|crescent|terrace|parade|row|hill|court|gardens|walk|quay|mews)\b/iu;
const URL_LIKE = /www\.|https?:|\.co\.uk|\.com\b|@/i;
const NOT_MERCHANT_WORD = /\bvat\b|receipt|invoice|\b(copy|welcome|table|server|cashier|order|till)\b/i;
/** A merchant is a guess by position, so it is never shown as certain. */
const MERCHANT_CAP = 0.8;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const scored = <T>(value: T, confidence: number): Scored<T> => ({ value, confidence: round2(Math.min(1, Math.max(0, confidence))) });
const capped = <T>(s: Scored<T>, cap: number): Scored<T> => scored(s.value, Math.min(s.confidence, cap));

interface Line extends OcrLine {
  money: MoneyToken[];
  /** The text with digits inside words read back as letters ("T0TAL" -> "TOTAL"), for keyword tests only. */
  words: string;
}

const DIGIT_AS_LETTER: Record<string, string> = { '0': 'O', '1': 'L', '5': 'S', '8': 'B' };
function asWords(text: string): string {
  return text.replace(/[\p{L}\p{N}]+/gu, (w) => (/\p{L}/u.test(w) ? w.replace(/[0158]/g, (d) => DIGIT_AS_LETTER[d] ?? d) : w));
}

function currencyOf(lines: readonly OcrLine[]): ReceiptProposal['currency'] {
  const all = lines.map((l) => l.text).join('\n');
  if (OTHER_CURRENCY.test(all)) return 'other';
  if (POUNDS.test(all)) return 'GBP';
  return 'unknown';
}

/** A line about something other than the amount paid (subtotal, cash handed over, savings, VAT …). */
function isNotTotalLine(l: Line): boolean {
  return NOT_TOTAL_WORD.test(l.words.replace(INCLUDING_VAT, ' '));
}

function isTotalLine(l: Line): boolean {
  return TOTAL_WORD.test(l.words) && !isNotTotalLine(l);
}

function findTotal(lines: readonly Line[]): Scored<Pence> | null {
  // Each total line's last unsigned amount (a refund "-£8.75" is never a total).
  const keyword = lines.flatMap((l) => {
    const token = isTotalLine(l) ? l.money.filter((t) => !t.signed).at(-1) : undefined;
    return token ? [{ line: l, token }] : [];
  });
  const last = keyword.at(-1);
  if (last) {
    const { line: winner, token } = last;
    let total = scored(token.pence, token.confidence);
    // Another money token on the line (a time "12.41", a price) means we may have picked the wrong one.
    if (winner.money.length > 1) total = capped(total, UNSURE);
    // Total lines that disagree (a balance due after a deposit) mean we can't be sure which was paid.
    const values = new Set(keyword.map((k) => k.token.pence));
    if (values.size > 1) total = capped(total, UNSURE);
    // Corroboration: a confident total is the largest amount on any line that could be the amount paid.
    const largest = Math.max(...lines.filter((l) => !isNotTotalLine(l)).flatMap((l) => l.money.filter((t) => !t.signed).map((t) => t.pence)));
    if (total.value !== largest) total = capped(total, UNSURE);
    if (total.value === 0) total = capped(total, DOUBTFUL);
    if (lines.some((l) => REFUND_OR_CREDIT.test(l.words) && !/\bcard\b/i.test(l.text))) total = capped(total, UNSURE);
    return total;
  }
  // No total line: offer the largest amount anywhere, but never confidently.
  let largest: MoneyToken | undefined;
  for (const t of lines.flatMap((l) => l.money)) if (!t.signed && (!largest || t.pence > largest.pence)) largest = t;
  return largest ? scored(largest.pence, Math.min(largest.confidence, UNSURE)) : null;
}

/** VAT inside `net` at `basisPoints`, rounded half up, in integers. */
const vatOnNet = (net: Pence, basisPoints: number): Pence => Math.floor((2 * net * basisPoints + 10000) / 20000);

interface VatRow {
  basisPoints: number;
  net: MoneyToken;
  vat: MoneyToken;
}

/** The VAT summary rows, and whether some row-like line could not be read as one (net, VAT[, gross]). */
function vatRows(lines: readonly Line[]): { rows: VatRow[]; unreadable: boolean } {
  const rows: VatRow[] = [];
  let unreadable = false;
  for (const l of lines) {
    const m = VAT_ROW.exec(l.text);
    if (!m) continue;
    const [net, vat, gross] = l.money;
    const twoAmounts = l.money.length === 2;
    const threeThatAddUp = l.money.length === 3 && net !== undefined && vat !== undefined && gross !== undefined && net.pence + vat.pence === gross.pence;
    if (!net || !vat || l.money.some((t) => t.signed) || !(twoAmounts || threeThatAddUp)) {
      unreadable = true;
      continue;
    }
    rows.push({ basisPoints: Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')), net, vat });
  }
  return { rows, unreadable };
}

function findVat(lines: readonly Line[], amount: Scored<Pence> | null, warnings: string[]): ReceiptProposal['vatPence'] {
  if (!amount) return null;
  const { rows, unreadable } = vatRows(lines);
  // Every amount on a VAT line, except a total line ("Total incl. VAT £8.75") and the summary rows.
  const candidates = lines
    .filter((l) => VAT_WORD.test(l.words) && !NET_OF_VAT.test(l.words) && !VAT_ROW.test(l.text) && !isTotalLine(l))
    .flatMap((l) => l.money);

  let vat: Scored<Pence>;
  let fits: boolean;
  let ambiguous = unreadable;
  if (rows.length > 0) {
    vat = scored(
      rows.reduce((sum, r) => sum + r.vat.pence, 0),
      Math.min(...rows.map((r) => r.vat.confidence)),
    );
    const eachRowFits = rows.every((r) => Math.abs(r.vat.pence - vatOnNet(r.net.pence, r.basisPoints)) <= 1);
    const addsUp = rows.reduce((sum, r) => sum + r.net.pence + r.vat.pence, 0) === amount.value;
    fits = eachRowFits && addsUp;
    // A separate VAT figure that disagrees with the table.
    if (candidates.some((t) => t.pence !== vat.value)) ambiguous = true;
  } else {
    const token = candidates.at(-1);
    // "No VAT shown" is never confident: the VAT line may simply have been missed.
    if (!token) return unreadable ? null : { value: null, confidence: 0.7 };
    vat = scored(token.pence, token.confidence);
    if (new Set(candidates.map((t) => t.pence)).size > 1 || token.signed) ambiguous = true;
    // A VAT of 0 fits only when it is the only VAT figure on the receipt.
    const allowed = [vatFromGross(amount.value, 2000), vatFromGross(amount.value, 500), ...(candidates.length === 1 ? [0] : [])];
    fits = allowed.some((v) => Math.abs(vat.value - v) <= 1);
  }
  if (!fits) {
    warnings.push(VAT_MISMATCH_WARNING);
    return capped(vat, DOUBTFUL);
  }
  if (ambiguous) return capped(vat, DOUBTFUL);
  // The cross-check is only as good as the total it was checked against.
  if (amount.confidence < CONFIDENT) return capped(vat, 0.8);
  return vat;
}

function findDate(lines: readonly OcrLine[], today: string, currency: ReceiptProposal['currency']): Scored<string> | null {
  const all: { value: string; confidence: number; preferred: boolean; labelled: boolean; order: boolean }[] = [];
  for (const l of lines) {
    for (const value of findDates(l.text)) {
      all.push({
        value,
        confidence: l.confidence,
        preferred: DATE_PREFERRED.test(l.text),
        labelled: NOT_TRANSACTION_DATE.test(l.text),
        order: ORDER_DATE.test(l.text),
      });
    }
  }
  if (all.length === 0) return null;
  // An order date counts only when it is the only date on the receipt.
  const onlyOneDate = new Set(all.map((d) => d.value)).size === 1;
  const plausible = all.filter((d) => !d.labelled && (!d.order || onlyOneDate));
  const best = plausible.find((d) => d.preferred) ?? plausible[0];
  if (!best) {
    // Only labelled dates (a delivery date, a best-before date): offer the first, never confidently.
    const first = all[0];
    return first ? capped(scored(first.value, first.confidence), UNSURE) : null;
  }
  let date = scored(best.value, best.confidence);
  // Confident only when exactly one plausible date is left, on a receipt in pounds (day-first order).
  if (new Set(plausible.map((d) => d.value)).size !== 1 || currency === 'other') date = capped(date, UNSURE);
  const unlikely = daysBetween(today, date.value) > 0 || daysBetween(date.value, today) > 400;
  return unlikely ? capped(date, DOUBTFUL) : date;
}

function findMerchant(lines: readonly Line[]): Scored<string> | null {
  const line = lines.slice(0, 5).find((l) => {
    const t = l.text;
    return (
      (t.match(/\p{L}/gu)?.length ?? 0) >= 3 &&
      !POSTCODE.test(t) &&
      !STREET.test(t) &&
      !isPhoneLine(t) &&
      !URL_LIKE.test(t) &&
      !NOT_MERCHANT_WORD.test(l.words) &&
      findDates(t).length === 0 &&
      l.money.length === 0 &&
      !TOTAL_WORD.test(l.words)
    );
  });
  return line ? scored(line.text.trim().replace(/\s+/g, ' '), Math.min(line.confidence, MERCHANT_CAP)) : null;
}

export function extractReceipt(input: readonly OcrLine[], opts: { today: string }): ReceiptProposal {
  const recognised = input.filter((l) => l.text.trim() !== '').map((l) => ({ ...l, text: l.text.replace(SPELLED_VAT, 'VAT') }));
  const currency = currencyOf(recognised);
  const lines: Line[] = recognised.map((l) => ({
    ...l,
    money: findMoney(l.text, l.confidence, { commaDecimals: currency === 'other' }),
    words: asWords(l.text),
  }));
  const warnings: string[] = [];

  let amountPence = findTotal(lines);
  if (amountPence && currency === 'other') {
    amountPence = capped(amountPence, DOUBTFUL);
    warnings.push(NOT_POUNDS_WARNING);
  } else if (amountPence && currency === 'unknown') {
    amountPence = capped(amountPence, 0.8);
  }

  return {
    amountPence,
    vatPence: findVat(lines, amountPence, warnings),
    date: findDate(recognised, opts.today, currency),
    merchant: findMerchant(lines),
    currency,
    warnings,
  };
}
