/**
 * A stand-in receipt reader for tests and the browser-test app. It never runs Tesseract and never leaves the process:
 * each read returns the lines of one of Task 2's text fixtures (taxi.txt unless told otherwise), and a HEIC photo is
 * refused with the same sentence as the real local engine.
 */
import { readFileSync } from 'node:fs';
import { HEIC_REFUSED, UnreadableError, type OcrEngine, type OcrLine, type OcrResult } from '@hf/ocr';

const FIXTURES = new URL('../../../../modules/ocr/test/text-fixtures/', import.meta.url);

/** One recognised line per non-empty line, optionally followed by a TAB and its confidence (default 0.95), as Task 2's tests read them. */
export function fixtureLines(name: string): OcrLine[] {
  return readFileSync(new URL(name, FIXTURES), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [text = '', c] = l.split('\t');
      return { text, confidence: c === undefined ? 0.95 : Number(c) };
    });
}

export interface FakeOcr extends OcrEngine {
  /** The next read returns this text fixture's lines. */
  next(fixture: string): void;
  /** The next read throws this error. */
  fail(error: unknown): void;
  /** The next read waits until `release()` is called. */
  hold(): { release(): void };
  /** How many reads were started. */
  readonly reads: number;
}

export function createFakeOcr(opts: { fixture?: string } = {}): FakeOcr {
  const queued: ({ fixture: string } | { error: unknown } | { gate: Promise<void> })[] = [];
  let reads = 0;
  return {
    id: 'fake',
    kind: 'local',
    outboundId: null,
    get reads() { return reads; },
    next(fixture) { queued.push({ fixture }); },
    fail(error) { queued.push({ error }); },
    hold() {
      let release: () => void = () => undefined;
      queued.push({ gate: new Promise<void>((r) => { release = r; }) });
      return { release: () => { release(); } };
    },
    async read({ type }): Promise<OcrResult> {
      reads++;
      if (type === 'image/heic') throw new UnreadableError(HEIC_REFUSED);
      let step = queued.shift();
      while (step && 'gate' in step) {
        await step.gate;
        step = queued.shift();
      }
      if (step && 'error' in step) throw step.error;
      const fixture = step && 'fixture' in step ? step.fixture : (opts.fixture ?? 'taxi.txt');
      return { engine: 'fake', lines: fixtureLines(fixture), warnings: [], ms: 1 };
    },
    async close() { /* nothing to stop */ },
  };
}
