import { toPence, type Pence } from '@hf/shared';

/** An amount found on a recognised line, with how sure we are of it. */
export interface MoneyToken {
  pence: Pence;
  confidence: number;
  /** How many letters were read as digits (O→0, S→5 …) to make the amount. */
  repairs: number;
  /** True when a minus sign comes before the amount ("-£8.75", "£-8.75"): a refund or a discount. */
  signed: boolean;
}

// Letters that OCR often returns in place of digits. Repaired only inside a money token, never elsewhere.
const REPAIR: Record<string, string> = { O: '0', o: '0', S: '5', l: '1', I: '1', B: '8' };
const D = '[0-9OoSlIB]';

// Exactly two decimals. The token must not touch other letters, digits, separators or a % sign, so a rate
// ("20.00%"), litres ("37.50L"), a quantity ("2.00x"), a price per litre ("120.00p") or part of a date
// ("19.03.26") is never an amount.
const EDGE_BEFORE = '(?<![\\p{L}\\p{N}.,])';
const EDGE_AFTER = '(?![\\p{L}\\p{N}.,%])';
const POUNDS_RE = new RegExp(`${EDGE_BEFORE}(\\d{1,3}(?:,\\d{3}){1,2}|${D}{1,7})\\.(${D}{2})${EDGE_AFTER}`, 'gu');
const COMMA_DECIMAL_RE = new RegExp(`${EDGE_BEFORE}(${D}{1,7})[.,](${D}{2})${EDGE_AFTER}`, 'gu');

// Lines whose numbers are never money: phone numbers, VAT registration numbers, card and authorisation lines.
const PHONE_WORD = /\b(tel|telephone|phone|fax|mob|mobile)\b/i;
const PHONE_NUMBER = /(?<![\d.])(?:\+44\s?|0)\d{2,4}\s?\d{3}\s?\d{3,4}(?![\d.])/;
export const VAT_NUMBER = /\bVAT\s*(no|reg|number)\b/i;
const CARD_OR_AUTH = /\b(card|auth|authorisation|authorization)\b/i;

export function isPhoneLine(text: string): boolean {
  return PHONE_WORD.test(text) || PHONE_NUMBER.test(text);
}

/** True for a line whose numbers must never be taken as an amount. */
export function isIgnoredLine(text: string): boolean {
  return isPhoneLine(text) || VAT_NUMBER.test(text) || CARD_OR_AUTH.test(text);
}

/**
 * The amounts on one line, left to right. `commaDecimals` allows "14,50" (only for a receipt that is not in
 * pounds). Each letter repaired to a digit costs 0.3 of the line's confidence.
 */
export function findMoney(text: string, lineConfidence: number, opts: { commaDecimals: boolean }): MoneyToken[] {
  if (isIgnoredLine(text)) return [];
  const re = opts.commaDecimals ? COMMA_DECIMAL_RE : POUNDS_RE;
  const out: MoneyToken[] = [];
  for (const m of text.matchAll(re)) {
    const [, whole = '', decimals = ''] = m;
    const raw = whole + decimals;
    if (!/\d/.test(raw)) continue; // all letters: a word, not an amount
    let repairs = 0;
    const fix = (s: string): string =>
      s.replace(/[OoSlIB]/g, (c) => {
        repairs += 1;
        return REPAIR[c] ?? c;
      });
    const pence = toPence(`${fix(whole)}.${fix(decimals)}`);
    const signed = /[-−]\s*(?:£|GBP\s?)?\s*$/.test(text.slice(0, m.index));
    out.push({ pence, confidence: Math.max(0, lineConfidence - 0.3 * repairs), repairs, signed });
  }
  return out;
}
