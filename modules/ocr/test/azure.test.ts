import { afterEach, expect, test } from 'vitest';
import { CONFIDENT } from '@hf/shared';
import { CloudEngineError, createAzureReceiptEngine, readReceipt } from '../src/index.js';
import { KEY_HEADER, startAzureStub, type AzureStub } from './helpers/azureStub.js';

const bytes = Buffer.from('a fictional receipt photo');
const ANALYSE = '/documentintelligence/documentModels/prebuilt-receipt:analyze?api-version=2024-11-30';
const NOT_POUNDS = 'This receipt may not be in pounds. Please check the amount.';

let stub: AzureStub | undefined;
afterEach(async () => {
  await stub?.stop();
  stub = undefined;
});

const engineFor = (s: AzureStub, over: Record<string, unknown> = {}) =>
  createAzureReceiptEngine({ endpoint: s.url, key: 'k', region: 'uksouth', allowHttpLoopback: true, pollMs: 10, ...over });

test('reads a receipt through analyse and poll', async () => {
  stub = await startAzureStub();
  const engine = engineFor(stub);
  expect(engine).toMatchObject({ id: 'azure-document-intelligence', kind: 'cloud', outboundId: 'azure-document-intelligence' });
  const r = await engine.read({ bytes, type: 'image/jpeg' });
  expect(r.fields?.amountPence).toEqual({ value: 1240, confidence: 0.98 });
  expect(r.fields?.vatPence).toEqual({ value: 207, confidence: 0.95 });
  expect(r.fields?.date).toEqual({ value: '2026-03-12', confidence: 0.97 });
  expect(r.fields?.merchant).toEqual({ value: 'Northside Taxis', confidence: 0.93 });
  expect(r.lines).toEqual([
    { text: 'Northside Taxis', confidence: 0.9 },
    { text: '12/03/2026', confidence: 0.9 },
    { text: 'Total £12.40', confidence: 0.9 },
    { text: 'VAT 20% £2.07', confidence: 0.9 },
  ]);
  expect(r.engine).toBe('azure-document-intelligence');
  expect(r.warnings).toEqual([]);

  const posts = stub.requests.filter((q) => q.method === 'POST');
  const gets = stub.requests.filter((q) => q.method === 'GET');
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ path: ANALYSE, hasKey: true, bodyLength: bytes.length });
  expect(posts[0]?.headers['content-type']).toBe('image/jpeg');
  expect(gets).toHaveLength(2);
  expect(gets.every((g) => g.hasKey)).toBe(true);
  expect(stub.requests).toHaveLength(3);
  // The recorder drops the key, so it can't be in what a test might print.
  expect(JSON.stringify(stub.requests)).not.toContain(KEY_HEADER);
});

test('a non-GBP total is passed on as a warning and a low confidence', async () => {
  stub = await startAzureStub();
  stub.result.currencyCode = 'EUR';
  const r = await engineFor(stub).read({ bytes, type: 'image/jpeg' });
  expect(r.fields?.amountPence?.confidence).toBeLessThan(CONFIDENT);
  expect(r.warnings).toContain(NOT_POUNDS);
});

test("a cloud reading still goes through readReceipt's caps and cross-checks (Ruling 2)", async () => {
  stub = await startAzureStub();
  stub.result.analyzeResult = {
    pages: [{ lines: [{ content: 'Northside Taxis' }, { content: 'Total 12.40' }] }],
    documents: [{ fields: {
      Total: { valueCurrency: { amount: 12.4, currencyCode: 'GBP' }, confidence: 0.99 },
      TotalTax: { valueCurrency: { amount: 9.99, currencyCode: 'GBP' }, confidence: 0.99 },
    } }],
  };
  const p = readReceipt(await engineFor(stub).read({ bytes, type: 'image/jpeg' }), '2026-03-31');
  // Nothing on the lines says pounds: the amount is capped. A VAT that cannot fit the total is never certain.
  expect(p.amountPence?.confidence).toBeLessThan(CONFIDENT);
  expect(p.vatPence?.confidence ?? 0).toBeLessThan(CONFIDENT);
});

test('plain http is refused except to 127.0.0.1 in tests', async () => {
  stub = await startAzureStub();
  const base = { key: 'k', region: 'uksouth' };
  expect(() => createAzureReceiptEngine({ ...base, endpoint: 'http://example.com' })).toThrow('OCR_AZURE_ENDPOINT must start with https://.');
  expect(() => createAzureReceiptEngine({ ...base, endpoint: 'http://example.com', allowHttpLoopback: true })).toThrow('OCR_AZURE_ENDPOINT must start with https://.');
  expect(() => createAzureReceiptEngine({ ...base, endpoint: stub!.url })).toThrow('OCR_AZURE_ENDPOINT must start with https://.');
  expect(() => createAzureReceiptEngine({ ...base, endpoint: 'not a web address' })).toThrow('OCR_AZURE_ENDPOINT must start with https://.');
  expect(() => createAzureReceiptEngine({ ...base, endpoint: 'https://acme.cognitiveservices.azure.com' })).not.toThrow();
  expect(stub.requests).toEqual([]);
});

test('a failed analysis or a timeout throws an engine error, never hangs', async () => {
  stub = await startAzureStub('error500');
  await expect(engineFor(stub).read({ bytes, type: 'image/jpeg' })).rejects.toBeInstanceOf(CloudEngineError);

  stub.mode = 'failed';
  await expect(engineFor(stub).read({ bytes, type: 'image/jpeg' })).rejects.toBeInstanceOf(CloudEngineError);

  stub.mode = 'hang';
  const started = Date.now();
  await expect(engineFor(stub, { timeoutMs: 200 }).read({ bytes, type: 'image/jpeg' })).rejects.toBeInstanceOf(CloudEngineError);
  expect(Date.now() - started).toBeLessThan(1000);
});

test('a poll that stays "running" stops at the time limit', async () => {
  stub = await startAzureStub();
  // Every poll answers "running".
  const running = { status: 'running' };
  const started = Date.now();
  const err = await createAzureReceiptEngine({
    endpoint: stub.url, key: 'k', region: 'uksouth', allowHttpLoopback: true, pollMs: 10, timeoutMs: 200,
    fetchImpl: async (url, init) => (init?.method === 'GET' ? Response.json(running) : fetch(url, init)),
  }).read({ bytes, type: 'image/jpeg' }).catch((x: unknown) => x);
  expect(err).toBeInstanceOf(CloudEngineError);
  expect(Date.now() - started).toBeLessThan(1000);
});

test('the key never appears in errors', async () => {
  const key = 'k-VERY-SECRET-123';
  for (const mode of ['error500', 'hang', 'failed'] as const) {
    stub = await startAzureStub(mode);
    const err = await engineFor(stub, { key, timeoutMs: 200 }).read({ bytes, type: 'image/jpeg' }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(CloudEngineError);
    const e = err as CloudEngineError;
    expect(e.userMessage).toBe('The cloud reader could not be reached.');
    expect(e.message).not.toContain(key);
    expect(e.userMessage).not.toContain(key);
    expect(JSON.stringify(e)).not.toContain(key);
    expect(String(e.stack)).not.toContain(key);
    expect(e.cause).toBeUndefined();
    await stub.stop();
    stub = undefined;
  }
});

test('a poll address on another host is refused, so the key is never sent there', async () => {
  stub = await startAzureStub();
  const other = await startAzureStub();
  try {
    stub.result.operationLocation = `${other.url}/steal`;
    await expect(engineFor(stub).read({ bytes, type: 'image/jpeg' })).rejects.toBeInstanceOf(CloudEngineError);
    expect(other.requests).toEqual([]);
  } finally {
    await other.stop();
  }
});

test('a malformed or oversized answer is an engine error, not a reading', async () => {
  stub = await startAzureStub();
  stub.result.analyzeResult = { documents: [{ fields: { Total: { valueCurrency: { amount: 'twelve' }, confidence: 0.99 } } }] };
  await expect(engineFor(stub).read({ bytes, type: 'image/jpeg' })).rejects.toBeInstanceOf(CloudEngineError);
  await stub.stop();

  stub = await startAzureStub();
  stub.result.analyzeResult = { pages: [{ lines: [{ content: 'x'.repeat(6 * 1024 * 1024) }] }] };
  await expect(engineFor(stub).read({ bytes, type: 'image/jpeg' })).rejects.toBeInstanceOf(CloudEngineError);
  await stub.stop();

  stub = await startAzureStub();
  stub.result.analyzeResult = { documents: [{ fields: { Total: { valueCurrency: { amount: 12.4, currencyCode: 'GBP' }, confidence: 7 } } }] };
  await expect(engineFor(stub).read({ bytes, type: 'image/jpeg' })).rejects.toBeInstanceOf(CloudEngineError);
});

test('fields Azure could not read are left for the lines to fill', async () => {
  stub = await startAzureStub();
  stub.result.analyzeResult = { pages: [{ lines: [{ content: 'Total £3.00' }] }], documents: [] };
  const r = await engineFor(stub).read({ bytes, type: 'application/pdf' });
  expect(r.fields).toEqual({});
  expect(r.lines).toEqual([{ text: 'Total £3.00', confidence: 0.9 }]);
});

test('a redirect is never followed', async () => {
  stub = await startAzureStub();
  const s = stub;
  const modes: (RequestRedirect | undefined)[] = [];
  const r = await createAzureReceiptEngine({
    endpoint: s.url, key: 'k', region: 'uksouth', allowHttpLoopback: true, pollMs: 10,
    fetchImpl: async (url, init) => {
      modes.push(init?.redirect);
      return fetch(url, init);
    },
  }).read({ bytes, type: 'image/jpeg' });
  expect(r.fields?.amountPence?.value).toBe(1240);
  expect(modes).toEqual(['error', 'error', 'error']);
});
