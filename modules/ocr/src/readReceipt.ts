import { type ReceiptProposal, type Scored } from '@hf/shared';
import { checkVat, extractReceipt, VAT_MISMATCH_WARNING } from './extract.js';
import type { OcrResult } from './types.js';

/** The cap the extraction puts on an amount that may not be in pounds. */
const NOT_POUNDS_CAP = 0.5;

const clamp = <T>(s: Scored<T>): Scored<T> => ({ value: s.value, confidence: Math.min(1, Math.max(0, s.confidence)) });

/**
 * The proposal for one reading: the fields the engine read directly win, the extraction from the lines fills the
 * gaps, and the final VAT always goes through the same cross-check as the lines' own VAT (`checkVat`), against the
 * final total. An amount on a receipt that may not be in pounds is never certain, wherever it came from.
 */
export function readReceipt(result: OcrResult, today: string): ReceiptProposal {
  const fromLines = extractReceipt(result.lines, { today });
  const fields = result.fields ?? {};
  let amountPence = fields.amountPence ? clamp(fields.amountPence) : fromLines.amountPence;
  if (amountPence && fromLines.currency === 'other') amountPence = { ...amountPence, confidence: Math.min(amountPence.confidence, NOT_POUNDS_CAP) };
  const vat = checkVat(amountPence, fields.vatPence ? clamp(fields.vatPence) : fromLines.vatPence, result.lines);
  const warnings = [...fromLines.warnings.filter((w) => w !== VAT_MISMATCH_WARNING), ...vat.warnings, ...result.warnings];
  return {
    amountPence,
    vatPence: vat.vatPence,
    date: fields.date ? clamp(fields.date) : fromLines.date,
    merchant: fields.merchant ? clamp(fields.merchant) : fromLines.merchant,
    currency: fromLines.currency,
    warnings: [...new Set(warnings)],
  };
}
