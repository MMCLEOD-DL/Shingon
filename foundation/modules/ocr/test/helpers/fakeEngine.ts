import type { OcrEngine, OcrInputType, OcrResult } from '../../src/index.js';

export interface FakeEngine extends OcrEngine {
  /** Every read, in order. */
  readonly calls: { bytes: Buffer; type: OcrInputType }[];
  /** The settings it was made with, if any. */
  readonly cfg: unknown;
  closed: boolean;
}

/** An engine that records its calls and reads every receipt as no lines at all. */
export function fakeEngine(id: string, kind: 'local' | 'cloud', cfg?: unknown): FakeEngine {
  const calls: { bytes: Buffer; type: OcrInputType }[] = [];
  const engine: FakeEngine = {
    id,
    kind,
    outboundId: kind === 'cloud' ? id : null,
    calls,
    cfg,
    closed: false,
    read(input): Promise<OcrResult> {
      calls.push(input);
      return Promise.resolve({ engine: id, lines: [], warnings: [], ms: 0 });
    },
    close(): Promise<void> {
      engine.closed = true;
      return Promise.resolve();
    },
  };
  return engine;
}
