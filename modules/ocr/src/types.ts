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

/** Why a cloud reading failed, in words that never carry the key, a request header or a response body. */
export type CloudFailure = 'timeout' | 'network' | 'failed' | 'bad-response' | `http-${string}`;

/**
 * The cloud reader could not give a reading (no answer, an error status, a failed analysis, a timeout or an answer
 * that doesn't make sense). The app then reads the receipt on the box instead.
 */
export class CloudEngineError extends Error {
  readonly userMessage = 'The cloud reader could not be reached.';
  readonly reason: CloudFailure;

  constructor(reason: CloudFailure) {
    super(`The cloud reader could not be reached (${reason}).`);
    this.name = 'CloudEngineError';
    this.reason = reason;
  }
}
