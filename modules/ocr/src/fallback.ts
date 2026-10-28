import { CloudEngineError, type CloudFailure, type OcrEngine, type OcrResult } from './types.js';

export const FELL_BACK_WARNING = 'The cloud reader was unavailable, so this receipt was read on the box instead.';
const MUST_STAY_ON_BOX = 'A fallback must keep receipts on the box.';

/**
 * Reads with `primary` (a cloud engine) and, only when the cloud can't be reached, with `fallback` (a local one).
 * A receipt that can't be read is not retried elsewhere, and nothing ever falls back towards the cloud. The wrapper
 * carries the primary's identity, so the app reports what it was set up to use. `onFallback` lets the app log or
 * alert each fallback.
 */
export interface FallbackOptions {
  /** Told each time the cloud couldn't be reached, with a reason that carries no key, address or answer. */
  onFallback?: (reason: CloudFailure) => void;
}

export function withFallback(primary: OcrEngine, fallback: OcrEngine, opts: FallbackOptions = {}): OcrEngine {
  if (primary.kind !== 'cloud' || fallback.kind !== 'local' || fallback.outboundId !== null) throw new Error(MUST_STAY_ON_BOX);
  return {
    id: primary.id,
    kind: primary.kind,
    outboundId: primary.outboundId,
    async read(input): Promise<OcrResult> {
      try {
        return await primary.read(input);
      } catch (err) {
        if (!(err instanceof CloudEngineError)) throw err;
        try {
          opts.onFallback?.(err.reason);
        } catch {
          // A failing logger must not cost staff the reading.
        }
        const r = await fallback.read(input);
        return { ...r, warnings: [...r.warnings, FELL_BACK_WARNING] };
      }
    },
    async close(): Promise<void> {
      await Promise.allSettled([primary.close(), fallback.close()]);
    },
  };
}
