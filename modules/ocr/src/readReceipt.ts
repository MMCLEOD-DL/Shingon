import { CONFIDENT, type ReceiptProposal, type Scored } from '@hf/shared';
import { checkVat, extractReceipt, VAT_MISMATCH_WARNING } from './extract.js';
import type { OcrResult } from './types.js';

/** The cap the extraction puts on an amount that may not be in pounds. */
const NOT_POUNDS_CAP = 0.5;
/** The cap it puts on an amount when nothing on the receipt says which currency it is in. */
const NO_CURRENCY_CAP = 0.8;
/**
 * The cap on a field the engine read directly (Azure's fields): below CONFIDENT, so staff check it. A total or date the
 * lines read the same way keeps the engine's confidence; a merchant name is always capped (the lines' guess at a name
 * is no independent check).
 */
const ENGINE_FIELD_CAP = 0.8;

const clamp = <T>(s: Scored<T>): Scored<T> => ({ value: s.value, confidence: Math.min(1, Math.max(0, s.confidence)) });
const capped = <T>(s: Scored<T>): Scored<T> => ({ value: s.value, confidence: Math.min(clamp(s).confidence, ENGINE_FIELD_CAP) });
/**
 * An engine field, kept as it is only when the lines read the same value confidently; otherwise capped. A guess from
 * the lines (below CONFIDENT) agreeing with the engine is not corroboration.
 */
const checkedByLines = <T>(engine: Scored<T>, lines: Scored<T> | null): Scored<T> =>
  (lines !== null && lines.value === engine.value && lines.confidence >= CONFIDENT ? clamp(engine) : capped(engine));

/**
 * The proposal for one reading: the fields the engine read directly win, the extraction from the lines fills the
 * gaps, and the final VAT always goes through the same cross-check as the lines' own VAT (`checkVat`), against the
 * final total. An engine's total or date is at most 0.8 unless the lines read the same value; its merchant is at most 0.8. An amount is capped as the extraction caps its own, wherever it came from: never certain on a receipt that may
 * not be in pounds, at most 0.8 when nothing says which currency it is in.
 */
export function readReceipt(result: OcrResult, today: string): ReceiptProposal {
  const fromLines = extractReceipt(result.lines, { today });
  const fields = result.fields ?? {};
  let amountPence = fields.amountPence ? checkedByLines(fields.amountPence, fromLines.amountPence) : fromLines.amountPence;
  if (amountPence && fromLines.currency === 'other') amountPence = { ...amountPence, confidence: Math.min(amountPence.confidence, NOT_POUNDS_CAP) };
  if (amountPence && fromLines.currency === 'unknown') amountPence = { ...amountPence, confidence: Math.min(amountPence.confidence, NO_CURRENCY_CAP) };
  const vat = checkVat(amountPence, fields.vatPence ? clamp(fields.vatPence) : fromLines.vatPence, result.lines);
  const warnings = [...fromLines.warnings.filter((w) => w !== VAT_MISMATCH_WARNING), ...vat.warnings, ...result.warnings];
  return {
    amountPence,
    vatPence: vat.vatPence,
    date: fields.date ? checkedByLines(fields.date, fromLines.date) : fromLines.date,
    merchant: fields.merchant ? capped(fields.merchant) : fromLines.merchant,
    currency: fromLines.currency,
    warnings: [...new Set(warnings)],
  };
}
