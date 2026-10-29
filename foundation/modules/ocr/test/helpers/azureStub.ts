/**
 * A stand-in for Azure Document Intelligence on 127.0.0.1 (Operator decision Q3: no Azure account; tests never
 * reach the network beyond 127.0.0.1). It records every request, without the key, and answers the analyse call
 * with 202, the first poll with "running" and the second with a canned reading of the fictional taxi receipt.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const KEY_HEADER = 'ocp-apim-subscription-key';

export interface StubRequest {
  method: string;
  path: string;
  /** Every header except the key, which is replaced by `hasKey`. */
  headers: Record<string, string | string[] | undefined>;
  hasKey: boolean;
  bodyLength: number;
}

export type StubMode = 'ok' | 'error500' | 'hang' | 'failed';

export interface AzureStub {
  url: string;
  requests: StubRequest[];
  mode: StubMode;
  /** Changes the canned reading (for example the currency) before a test reads. */
  result: TaxiResult;
  stop(): Promise<void>;
}

export interface TaxiResult {
  currencyCode?: string;
  /** Replaces the whole `analyzeResult` (for malformed-response tests). */
  analyzeResult?: unknown;
  /** Where the analyse call says to poll; defaults to the stub itself. */
  operationLocation?: string;
}

const POLL_PATH = '/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/op-1';

function taxiAnalyzeResult(currencyCode: string): unknown {
  return {
    apiVersion: '2024-11-30',
    modelId: 'prebuilt-receipt',
    content: 'Northside Taxis\n12 Mar 2026\nFare £12.40\nVAT £2.07',
    pages: [{
      pageNumber: 1,
      lines: [
        { content: 'Northside Taxis', polygon: [0, 0, 1, 1] },
        { content: '12/03/2026' },
        { content: 'Total £12.40' },
        { content: 'VAT 20% £2.07' },
      ],
      words: [{ content: 'Northside', confidence: 0.99 }],
    }],
    documents: [{
      docType: 'receipt.retailMeal',
      confidence: 0.9,
      fields: {
        Total: { type: 'currency', valueCurrency: { amount: 12.4, currencyCode, currencySymbol: '£' }, content: '£12.40', confidence: 0.98 },
        TotalTax: { type: 'currency', valueCurrency: { amount: 2.07, currencyCode }, content: '£2.07', confidence: 0.95 },
        TransactionDate: { type: 'date', valueDate: '2026-03-12', content: '12/03/2026', confidence: 0.97 },
        MerchantName: { type: 'string', valueString: 'Northside Taxis', content: 'Northside Taxis', confidence: 0.93 },
      },
    }],
  };
}

export async function startAzureStub(mode: StubMode = 'ok'): Promise<AzureStub> {
  const requests: StubRequest[] = [];
  let polls = 0;
  const stub: AzureStub = { url: '', requests, mode, result: {}, stop: async () => undefined };

  const handle = (req: IncomingMessage, res: ServerResponse, bodyLength: number): void => {
    const { [KEY_HEADER]: key, ...headers } = req.headers;
    requests.push({ method: req.method ?? '', path: req.url ?? '', headers, hasKey: typeof key === 'string' && key.length > 0, bodyLength });
    if (stub.mode === 'hang') return; // never answers
    if (stub.mode === 'error500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'InternalServerError', message: 'boom' } }));
      return;
    }
    if (req.method === 'POST') {
      res.writeHead(202, { 'operation-location': stub.result.operationLocation ?? `${stub.url}${POLL_PATH}?api-version=2024-11-30` });
      res.end();
      return;
    }
    polls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (polls === 1) {
      res.end(JSON.stringify({ status: 'running' }));
      return;
    }
    if (stub.mode === 'failed') {
      res.end(JSON.stringify({ status: 'failed', error: { code: 'InvalidContent', message: 'bad' } }));
      return;
    }
    res.end(JSON.stringify({
      status: 'succeeded',
      createdDateTime: '2026-03-12T10:00:00Z',
      lastUpdatedDateTime: '2026-03-12T10:00:01Z',
      analyzeResult: stub.result.analyzeResult ?? taxiAnalyzeResult(stub.result.currencyCode ?? 'GBP'),
    }));
  };

  const server = createServer((req, res) => {
    let bodyLength = 0;
    req.on('data', (c: Buffer) => { bodyLength += c.length; });
    req.on('end', () => { handle(req, res, bodyLength); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${String(port)}`;
  stub.stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  };
  return stub;
}
