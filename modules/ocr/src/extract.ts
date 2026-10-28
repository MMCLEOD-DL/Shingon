import { CONFIDENT, vatFromGross, type Pence, type ReceiptProposal, type Scored } from '@hf/shared';
import { findCardLineMoney, findMoney, isPhoneLine, type MoneyToken } from './money-tokens.js';
import { daysBetween, findDates, withoutDatesAndTimes } from './dates.js';

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
  /\bsub|\bsav(e|ed|es|ing|ings)\b|reduction|promo|tender|cash|change|paid|deposit|\btip\b|gratuity|suggest|points|\bvat\b|\btax\b|\bnet\b|discount|excl|\bexc\b|before|refund|credit/i;
// "Total incl. VAT £8.75" is a total; "Total excl. VAT" and "Total ex VAT" are not.
const INCLUDING_VAT = /\b(?:incl(?:uding|\.)?|inc\.?)\s*(?:of\s*)?vat\b/i;
const VAT_WORD = /\bvat\b|\btax\b/i;
// "Total before VAT £7.29", "excluding VAT": a net amount, never the VAT.
const NET_OF_VAT = /\b(?:excl(?:uding|\.)?|exc\.?|ex|before|less|without)\s*(?:of\s*)?vat\b/i;
// Words that say a line is about money owed or paid. A line carrying one is never left out of the
// largest-amount check, and one after the chosen total with a different amount makes the total unsure.
const OWED_WORD = /total|\bpay|paid|payable|charged|balance|due|amount/i;
// Lines that are clearly not money owed (money handed over, change, savings, VAT, net) — unless they carry an owed word.
const CLEARLY_NOT_OWED = /tender|change|cash|\bsav(e|ed|es|ing|ings)\b|\bvat\b|\btax\b|\bnet\b/i;
// After the total, a line is clearly not money owed only when it has no other words than these ("VAT @ 20% 1.46",
// "CASH 30.00", "Change 6.51", "Net 7.29"). "Cash tip", "Service incl. VAT" or "Change for parking" may add to the total.
const NOT_OWED_LINE_WORDS = new Set([
  'vat', 'tax', 'net', 'cash', 'cashback', 'back', 'change', 'given', 'tender', 'tendered', 'you', 'save', 'saved', 'saving', 'savings',
  'incl', 'inc', 'included', 'including', 'rate', 'code', 'gbp', 'at', 'a', 'b', 'c', 'd', 'e', 's', 'z',
]);
// Money taken off: after the total it means the total may not be what was paid; before it, it explains a subtotal.
const DISCOUNT_WORD = /\bless\b|voucher|discount|promo|offer|coupon|\bsav|reduction|deduct|points|loyalty|staff/i;
const SUBTOTAL = /\bsub/i;
// A refund or credit note anywhere (other than a payment card line) means the amounts may be money going back.
const REFUND_OR_CREDIT = /refund|credit/i;
// A VAT summary row: a rate code, the rate, then the net and the VAT, and optionally the gross ("A 20% 16.66 3.33 19.99").
const VAT_ROW = /^\s*[A-Z]\s+(\d{1,2})(?:\.(\d{1,2}))?\s?%/;
const OTHER_CURRENCY = /€|\bEUR\b|\$|\bUSD\b|\bTVA\b|\bMwSt\b/i;
const POUNDS = /£|\bGBP\b/;
// Only these labels make a date the transaction date ("Invoice date", "Date of issue", "Sale date").
const DATE_PREFERRED = /\b(invoice|issued?|transaction|sale|receipt|purchase)\b|tax point/i;
// The allow-list: a date is plausible only when every word left on its line is one of these. Any other label
// ("Sell by", "Member since", "Delivered", anything unknown) makes the date not the transaction date.
const DATE_LINE_WORDS = new Set([
  'date', 'time', 'invoice', 'issue', 'issued', 'transaction', 'sale', 'receipt', 'tax', 'point', 'purchase', 'of', 'on', 'at', 'am', 'pm',
  'mon', 'monday', 'tue', 'tues', 'tuesday', 'wed', 'wednesday', 'thu', 'thur', 'thurs', 'thursday', 'fri', 'friday', 'sat', 'saturday', 'sun', 'sunday',
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'jul', 'july', 'aug', 'august',
  'sep', 'sept', 'september', 'oct', 'october', 'nov', 'november', 'dec', 'december',
]);
// A line that is only a label, printed above its date ("Last visit" then "01/03/2026" on the next line).
const LABEL_ENDING = /(:|\b(until|by|since|visit|from|to|on|before|after|ends?|expires|expiry|exp|due|date|opened|packed|valid))\s*$/i;
// "Order date 01/03/2026" is the date of an online purchase (the word "order" alone is not on the allow-list).
const ORDER_DATE = /\border\s+date\b/gi;
// Labels known to mark a date that is not the transaction date. A date with any other label ("Booked", "Till 2",
// "Trans 2231") is not shown as certain, but it still competes: a confident date needs exactly one distinct date left.
// Whole words or word starts only: a stray match inside another word ("Showcase") would wrongly drop a competitor.
const NOT_TRANSACTION_DATE =
  /\b(?:due|reprint|return|exchange|expir|exp\b|valid|until|collect|deliver|dispatch|best before|use by|display|sell by|ends?\b|perform|travel|arriv|depart|check|since|member|opened|packed|appointment|next\b|guarantee|warranty|birth|visit|slot|events?\b|shows?\b|showing)/i;
// Money that changed hands other than the total: a payment, a deposit. If it differs from the total, the total is unsure.
const PAYMENT_WORD = /paid|payment|received|deposit|settled|on account/i;
// A line that is only the VAT and its label ("Total VAT £40.00", "VAT amount £3.33", "VAT TOTAL 3.33").
const VAT_ONLY_LINE =
  /^\s*(?:total\s+(?:vat|tax)|(?:vat|tax)\s+(?:total|amount|due))\s*(?:@\s*\d{1,2}(?:\.\d{1,2})?\s*%)?\s*:?\s*(?:£|GBP)?\s*\d[\d,]*\.\d{2}\s*$/i;
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
  /** Amounts on a card or authorisation line (otherwise ignored). */
  cardMoney: MoneyToken[];
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

function isOnlyNotOwedWords(words: string): boolean {
  const found = words.match(/\p{L}+/gu) ?? [];
  return found.length > 0 && found.every((w) => NOT_OWED_LINE_WORDS.has(w.toLowerCase()));
}

/** True when a subtotal is explained: it is no more than the total, or the total plus the money taken off. */
function subtotalExplained(sub: Pence, total: Pence, lines: readonly Line[]): boolean {
  const takenOff = lines
    .filter((l) => DISCOUNT_WORD.test(l.words) && !SUBTOTAL.test(l.words))
    .flatMap((l) => l.money)
    .reduce((sum, t) => sum + t.pence, 0);
  return sub <= total || sub === total + takenOff;
}

function findTotal(lines: readonly Line[]): Scored<Pence> | null {
  // Each total line's last unsigned amount (a refund "-£8.75" is never a total).
  const keyword = lines.flatMap((l, at) => {
    const token = isTotalLine(l) ? l.money.filter((t) => !t.signed).at(-1) : undefined;
    return token ? [{ at, line: l, token }] : [];
  });
  if (keyword.length === 0) {
    // No total line: offer the largest amount anywhere, but never confidently.
    let largest: MoneyToken | undefined;
    for (const t of lines.flatMap((l) => l.money)) if (!t.signed && (!largest || t.pence > largest.pence)) largest = t;
    return largest ? scored(largest.pence, Math.min(largest.confidence, UNSURE)) : null;
  }
  // A zero "balance due" beside a real total: show the largest non-zero total line, never confidently.
  const nonZero = keyword.filter((k) => k.token.pence > 0);
  const zeroDropped = nonZero.length > 0 && nonZero.length < keyword.length;
  const pool = zeroDropped ? nonZero : keyword;
  const winner = zeroDropped ? nonZero.reduce((a, b) => (b.token.pence >= a.token.pence ? b : a)) : pool[pool.length - 1];
  if (!winner) return null;
  let total = scored(winner.token.pence, winner.token.confidence);
  const unsure = (): void => {
    total = capped(total, UNSURE);
  };
  if (zeroDropped) unsure();
  // Another money token on the line (a time "12.41", a price) means we may have picked the wrong one.
  if (winner.line.money.length > 1) unsure();
  // Total lines that disagree (a balance due after a deposit) mean we can't be sure which was paid.
  if (new Set(keyword.map((k) => k.token.pence)).size > 1) unsure();
  // Corroboration: a confident total is the largest amount on any line that could be money owed.
  const owedAmounts = lines
    .filter((l) => OWED_WORD.test(l.words) || !CLEARLY_NOT_OWED.test(l.words))
    .filter((l) => !SUBTOTAL.test(l.words) || !l.money.every((t) => subtotalExplained(t.pence, total.value, lines)))
    .flatMap((l) => l.money.filter((t) => !t.signed).map((t) => t.pence));
  if (total.value !== Math.max(...owedAmounts)) unsure();
  // Anything after the total that may change what was paid: any other amount (a tip, a share, a surcharge, a bare
  // amount, another owed amount), unless its line is clearly not money owed, a VAT summary row, or only the VAT that
  // fits this total; and any money taken off.
  for (const l of lines.slice(winner.at + 1)) {
    const differs = l.money.some((t) => !t.signed && t.pence !== total.value);
    const notOwed = !OWED_WORD.test(l.words) && (isOnlyNotOwedWords(l.words) || VAT_ROW.test(l.text));
    if (differs && !notOwed && !isFittingVatOnlyLine(l, total.value, lines)) unsure();
    if (l.money.some((t) => t.signed)) unsure();
    if (DISCOUNT_WORD.test(l.words) && l.money.length > 0) unsure();
  }
  // A payment or deposit of a different amount anywhere (before or after the total): the total may not be what was paid.
  if (lines.some((l) => PAYMENT_WORD.test(l.words) && l.money.some((t) => !t.signed && t.pence !== total.value))) unsure();
  // The card was charged a different amount.
  if (lines.some((l) => l.cardMoney.some((t) => t.pence !== total.value))) unsure();
  if (total.value === 0) total = capped(total, DOUBTFUL);
  if (lines.some((l) => REFUND_OR_CREDIT.test(l.words) && !/\bcard\b/i.test(l.text))) unsure();
  return total;
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

/**
 * True for a line after the total that is only the VAT ("Total VAT £40.00"): one unsigned amount, nothing else on
 * the line, and that amount is exactly the VAT this total would be read with confidently. Such a line does not make
 * the total unsure. Anything looser (a second amount, "VAT total incl service", a VAT that disagrees) still does.
 */
function isFittingVatOnlyLine(l: Line, total: Pence, lines: readonly Line[]): boolean {
  const [token, ...others] = l.money;
  if (!token || others.length > 0 || token.signed || !VAT_ONLY_LINE.test(l.text)) return false;
  const warnings: string[] = [];
  const vat = findVat(lines, scored(total, 1), warnings);
  return warnings.length === 0 && vat !== null && vat.value === token.pence && vat.confidence >= CONFIDENT;
}

/** True when every word left on the line, once its dates and times are taken out, is on the allow-list. */
function onlyDateWords(text: string): boolean {
  const words = withoutDatesAndTimes(text).replace(ORDER_DATE, ' ').match(/\p{L}+/gu) ?? [];
  return words.every((w) => DATE_LINE_WORDS.has(w.toLowerCase()));
}

function findDate(lines: readonly OcrLine[], today: string, currency: ReceiptProposal['currency']): Scored<string> | null {
  const all: { value: string; confidence: number; preferred: boolean; plausible: boolean; competes: boolean }[] = [];
  lines.forEach((l, at) => {
    // A date under a line of words with no digits belongs to that line ("Last visit" / "01/03/2026", "Your delivery
    // slot" / "Thursday 12 March 2026"), looking past lines that are only "Date" or a weekday. The first line (usually
    // the merchant's name) counts only when it ends like a label or is a known non-transaction label.
    let above = at - 1;
    while (above >= 0 && !/\d/.test(lines[above]?.text ?? '') && onlyDateWords(lines[above]?.text ?? '')) above -= 1;
    const prev = lines[above]?.text ?? '';
    const labelAbove =
      prev !== '' && !/\d/.test(prev) && (above > 0 || LABEL_ENDING.test(prev.trim()) || NOT_TRANSACTION_DATE.test(prev));
    const plausible = onlyDateWords(l.text) && !labelAbove;
    const label = labelAbove && onlyDateWords(l.text) ? prev : l.text;
    // Every date competes unless its label is known to mark something other than the transaction (due, delivery …).
    const competes = plausible || !NOT_TRANSACTION_DATE.test(withoutDatesAndTimes(label));
    for (const value of findDates(l.text)) {
      all.push({ value, confidence: l.confidence, preferred: DATE_PREFERRED.test(l.text), plausible, competes });
    }
  });
  const first = all[0];
  if (!first) return null;
  const plausible = all.filter((d) => d.plausible);
  const best = plausible.find((d) => d.preferred) ?? plausible[0];
  // Only labelled dates (a delivery date, a best-before date): offer the first, never confidently.
  if (!best) return capped(scored(first.value, first.confidence), UNSURE);
  let date = scored(best.value, best.confidence);
  // Confident only when exactly one distinct date competes, on a receipt not in another currency (day-first order).
  if (new Set(all.filter((d) => d.competes).map((d) => d.value)).size !== 1 || currency === 'other') date = capped(date, UNSURE);
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
    cardMoney: findCardLineMoney(l.text, l.confidence, { commaDecimals: currency === 'other' }),
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
