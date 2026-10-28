/**
 * Azure AI Document Intelligence `prebuilt-receipt` (API 2024-11-30): send the file, then poll for the reading.
 * Tested only against a stand-in on 127.0.0.1 (Operator decision Q3). The field names below must be checked
 * against the live service before first real use.
 *
 * The answer is untrusted: it is size-bounded, time-bounded and checked against a schema, and the poll address must
 * be on the endpoint's own host so the key is never sent anywhere else. Every failure becomes a `CloudEngineError`
 * that carries no key, header or response body. The fields read here are proposals only: `readReceipt` still applies
 * its caps and cross-checks to them (Ruling 2).
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { toPence, type Pence, type Scored } from '@hf/shared';
import { z } from 'zod';
import { OcrPolicyError } from './choose.js';
import { NOT_POUNDS_WARNING, type OcrLine } from './extract.js';
import { CloudEngineError, type CloudFailure, type EngineFields, type OcrEngine, type OcrResult } from './types.js';

const ENGINE_ID = 'azure-document-intelligence';
const ANALYSE_PATH = '/documentintelligence/documentModels/prebuilt-receipt:analyze?api-version=2024-11-30';
const KEY_HEADER = 'Ocp-Apim-Subscription-Key';
const ENDPOINT_REFUSED = 'OCR_AZURE_ENDPOINT must start with https://.';
/** Azure gives confidences for words, not lines. */
const LINE_CONFIDENCE = 0.9;
/** The most an amount in another currency may be trusted (as the extraction caps its own). */
const NOT_POUNDS_CAP = 0.5;
/** The largest answer accepted, in bytes. A receipt's reading is a few tens of kilobytes. */
const MAX_ANSWER_BYTES = 5 * 1024 * 1024;
const MAX_MERCHANT = 200;

const Confidence = z.number().min(0).max(1);
const CurrencyField = z.object({
  valueCurrency: z.object({
    amount: z.number().min(-1e8).max(1e8),
    currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
  }).optional(),
  confidence: Confidence.optional(),
});
const DateField = z.object({ valueDate: z.string().max(40).optional(), confidence: Confidence.optional() });
const StringField = z.object({ valueString: z.string().max(2000).optional(), confidence: Confidence.optional() });
const AnalyzeResult = z.object({
  pages: z.array(z.object({ lines: z.array(z.object({ content: z.string().max(2000) })).max(5000).optional() })).max(100).optional(),
  documents: z.array(z.object({
    fields: z.object({
      Total: CurrencyField.optional(),
      TotalTax: CurrencyField.optional(),
      TransactionDate: DateField.optional(),
      MerchantName: StringField.optional(),
    }).optional(),
  })).max(20).optional(),
});
const PollAnswer = z.object({
  status: z.enum(['notStarted', 'running', 'succeeded', 'failed', 'canceled']),
  analyzeResult: AnalyzeResult.optional(),
});
type Analysis = z.infer<typeof AnalyzeResult>;

export interface AzureReceiptOptions {
  endpoint: string;
  key: string;
  region: string;
  /** Lets `http://127.0.0.1` through, for the test stand-in only. */
  allowHttpLoopback?: boolean;
  /** How long to wait between polls, in milliseconds. */
  pollMs?: number;
  /** The most one reading may take, sending and polling together, in milliseconds. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function endpointOrigin(endpoint: string, allowHttpLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new OcrPolicyError([ENDPOINT_REFUSED]);
  }
  const loopback = allowHttpLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((url.protocol !== 'https:' && !loopback) || url.username !== '' || url.password !== '') throw new OcrPolicyError([ENDPOINT_REFUSED]);
  return url.origin;
}

const realDate = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Maps Azure's fields to the engine's proposals. A field Azure couldn't read is left for the lines to fill. */
function fieldsOf(analysis: Analysis): { fields: EngineFields; warnings: string[] } {
  const f = analysis.documents?.[0]?.fields ?? {};
  const fields: EngineFields = {};
  const warnings: string[] = [];
  const money = (field: z.infer<typeof CurrencyField> | undefined): Scored<Pence> | undefined => {
    const v = field?.valueCurrency;
    if (!v) return undefined;
    let confidence = field.confidence ?? 0;
    if (v.currencyCode !== undefined && v.currencyCode !== 'GBP') {
      confidence = Math.min(confidence, NOT_POUNDS_CAP);
      warnings.push(NOT_POUNDS_WARNING);
    }
    return { value: toPence(v.amount.toFixed(2)), confidence };
  };
  const amount = money(f.Total);
  if (amount) fields.amountPence = amount;
  const vat = money(f.TotalTax);
  if (vat) fields.vatPence = vat;
  const date = f.TransactionDate?.valueDate;
  if (date !== undefined && realDate(date)) fields.date = { value: date, confidence: f.TransactionDate?.confidence ?? 0 };
  const merchant = f.MerchantName?.valueString?.replace(/\p{Cc}+/gu, ' ').trim().slice(0, MAX_MERCHANT);
  if (merchant) fields.merchant = { value: merchant, confidence: f.MerchantName?.confidence ?? 0 };
  return { fields, warnings: [...new Set(warnings)] };
}

const linesOf = (analysis: Analysis): OcrLine[] =>
  (analysis.pages ?? []).flatMap((p) => (p.lines ?? []).map((l) => ({ text: l.content, confidence: LINE_CONFIDENCE })));

/** Reads a response body, refusing anything over `MAX_ANSWER_BYTES`. */
async function readBounded(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_ANSWER_BYTES) {
    await res.body?.cancel();
    throw new CloudEngineError('bad-response');
  }
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ANSWER_BYTES) {
      await reader.cancel();
      throw new CloudEngineError('bad-response');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Whatever went wrong, as a reason that carries nothing from the request or the answer. */
function failureOf(err: unknown): CloudFailure {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  if (err instanceof TypeError) return 'network';
  return 'bad-response';
}

export function createAzureReceiptEngine(opts: AzureReceiptOptions): OcrEngine {
  const origin = endpointOrigin(opts.endpoint, opts.allowHttpLoopback ?? false);
  const base = opts.endpoint.replace(/\/+$/, '');
  const { key } = opts;
  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function analyse(bytes: Buffer, type: string): Promise<Analysis> {
    const deadline = performance.now() + timeoutMs;
    const timeLeft = (): number => {
      const left = Math.floor(deadline - performance.now());
      if (left <= 0) throw new CloudEngineError('timeout');
      return left;
    };
    const call = (url: string, init: RequestInit): Promise<Response> =>
      fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeLeft()) });

    const sent = await call(`${base}${ANALYSE_PATH}`, { method: 'POST', headers: { [KEY_HEADER]: key, 'Content-Type': type }, body: Uint8Array.from(bytes) });
    await sent.body?.cancel();
    if (sent.status !== 202) throw new CloudEngineError(`http-${String(sent.status)}`);
    const location = sent.headers.get('operation-location');
    if (location === null || location.length > 2000) throw new CloudEngineError('bad-response');
    let pollUrl: URL;
    try {
      pollUrl = new URL(location);
    } catch {
      throw new CloudEngineError('bad-response');
    }
    // The key goes only to the endpoint it was issued for.
    if (pollUrl.origin !== origin) throw new CloudEngineError('bad-response');

    for (;;) {
      await sleep(Math.min(pollMs, timeLeft()));
      const res = await call(pollUrl.href, { method: 'GET', headers: { [KEY_HEADER]: key } });
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new CloudEngineError(`http-${String(res.status)}`);
      }
      const answer = PollAnswer.safeParse(JSON.parse(await readBounded(res)));
      if (!answer.success) throw new CloudEngineError('bad-response');
      const { status, analyzeResult } = answer.data;
      if (status === 'failed' || status === 'canceled') throw new CloudEngineError('failed');
      if (status === 'succeeded') {
        if (!analyzeResult) throw new CloudEngineError('bad-response');
        return analyzeResult;
      }
    }
  }

  return {
    id: ENGINE_ID,
    kind: 'cloud',
    outboundId: ENGINE_ID,
    async read({ bytes, type }): Promise<OcrResult> {
      const started = performance.now();
      try {
        const analysis = await analyse(bytes, type);
        const { fields, warnings } = fieldsOf(analysis);
        return { engine: ENGINE_ID, lines: linesOf(analysis), fields, warnings, ms: Math.round(performance.now() - started) };
      } catch (err) {
        // A fresh error: the original may hold the address, a header or part of the answer.
        throw err instanceof CloudEngineError ? new CloudEngineError(err.reason) : new CloudEngineError(failureOf(err));
      }
    },
    close: () => Promise.resolve(),
  };
}
