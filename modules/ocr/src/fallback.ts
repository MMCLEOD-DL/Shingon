import { CloudEngineError, type OcrEngine, type OcrResult } from './types.js';

export const FELL_BACK_WARNING = 'The cloud reader was unavailable, so this receipt was read on the box instead.';
const MUST_STAY_ON_BOX = 'A fallback must keep receipts on the box.';

/**
 * Reads with `primary` (a cloud engine) and, only when the cloud can't be reached, with `fallback` (a local one).
 * A receipt that can't be read is not retried elsewhere, and nothing ever falls back towards the cloud. The wrapper
 * carries the primary's identity, so the app reports what it was set up to use.
 */
export function withFallback(primary: OcrEngine, fallback: OcrEngine): OcrEngine {
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
        const r = await fallback.read(input);
        return { ...r, warnings: [...r.warnings, FELL_BACK_WARNING] };
      }
    },
    async close(): Promise<void> {
      await Promise.allSettled([primary.close(), fallback.close()]);
    },
  };
}
