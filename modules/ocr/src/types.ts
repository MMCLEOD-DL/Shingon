import type { Pence, Scored } from '@hf/shared';
import type { OcrLine } from './extract.js';

/** What a receipt file may be. HEIC is accepted as a type only so it can be refused with a plain sentence. */
export type OcrInputType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'application/pdf';

/** Fields an engine read directly (a cloud receipt model does; Tesseract gives lines only). */
export interface EngineFields {
  amountPence?: Scored<Pence>;
  vatPence?: Scored<Pence | null>;
  date?: Scored<string>;
  merchant?: Scored<string>;
}

/** What an engine read from one receipt. The lines are personal data and are never stored (Ruling 5). */
export interface OcrResult {
  engine: string;
  lines: OcrLine[];
  fields?: EngineFields;
  warnings: string[];
  /** How long the reading took, in milliseconds. */
  ms: number;
}

export interface OcrEngine {
  readonly id: string;
  readonly kind: 'local' | 'cloud';
  /** The outbound destination this engine sends receipts to, or null when it never leaves the box. */
  readonly outboundId: string | null;
  read(input: { bytes: Buffer; type: OcrInputType }): Promise<OcrResult>;
  close(): Promise<void>;
}

/** A receipt that can't be read automatically. `userMessage` is the sentence staff see; they then type the details. */
export class UnreadableError extends Error {
  readonly userMessage: string;

  constructor(userMessage: string) {
    super(userMessage);
    this.name = 'UnreadableError';
    this.userMessage = userMessage;
  }
}
