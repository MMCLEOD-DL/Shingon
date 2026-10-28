import { z } from 'zod';
import type { Pence } from './money.js';

/**
 * Receipt readings (Plan 12, OCR module). The OCR proposes; a person confirms (Ruling 1).
 * Every proposed field carries a confidence; below CONFIDENT the form says "Please check".
 */

export type ReceiptField = 'amount' | 'vat' | 'date' | 'merchant';

/** A proposed value and how sure the reading is of it, from 0 to 1. */
export interface Scored<T> {
  value: T;
  confidence: number;
}

export interface ReceiptProposal {
  amountPence: Scored<Pence> | null;
  /** A value of null means "no VAT shown on the receipt". */
  vatPence: Scored<Pence | null> | null;
  /** YYYY-MM-DD. */
  date: Scored<string> | null;
  merchant: Scored<string> | null;
  currency: 'GBP' | 'other' | 'unknown';
  warnings: string[];
}

/** At or above this a field is shown as read; below it the form says "Please check". */
export const CONFIDENT = 0.85;

/** True when a YYYY-MM-DD string names a day that exists (no 30 February). */
function dayExists(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export const IsoDate = z.iso.date('Enter the date as a real day, like 2026-03-05.').refine(dayExists, 'Enter the date as a real day, like 2026-03-05.');

export const ConfirmReadingInput = z
  .strictObject({
    amountPence: z.int().min(1).max(10_000_000),
    vatPence: z.int().min(0).nullable(),
    date: IsoDate,
    merchant: z.string().trim().min(1).max(120),
  })
  .refine((v) => v.vatPence === null || v.vatPence <= v.amountPence, { message: "The VAT can't be more than the total.", path: ['vatPence'] });
export type ConfirmReadingInput = z.infer<typeof ConfirmReadingInput>;
export type ConfirmedReceipt = ConfirmReadingInput;

/**
 * The fields whose confirmed value differs from the proposal, in the order amount, vat, date, merchant.
 * A missing proposal, or a missing proposed field, counts as corrected. Only the names are kept (Ruling 5).
 */
export function correctedFields(p: ReceiptProposal | null, c: ConfirmedReceipt): ReceiptField[] {
  const out: ReceiptField[] = [];
  if (!p?.amountPence || p.amountPence.value !== c.amountPence) out.push('amount');
  if (!p?.vatPence || p.vatPence.value !== c.vatPence) out.push('vat');
  if (!p?.date || p.date.value !== c.date) out.push('date');
  if (!p?.merchant || p.merchant.value !== c.merchant) out.push('merchant');
  return out;
}

export interface ReadingView {
  id: string;
  fileId: string;
  status: 'pending' | 'read' | 'unreadable' | 'confirmed';
  engine: string | null;
  proposal: ReceiptProposal | null;
  /** The plain sentence shown when a receipt could not be read. */
  problem: string | null;
  confirmed: ConfirmedReceipt | null;
  corrected: ReceiptField[];
  ownerId: string;
  createdAt: string;
  confirmedAt: string | null;
}
