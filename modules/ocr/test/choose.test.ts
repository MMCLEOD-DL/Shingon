import { afterEach, expect, test } from 'vitest';
import type { AppProfile, Residency } from '@hf/shared';
import { chooseEngine, createAzureReceiptEngine, OcrPolicyError, OUTBOUND_DESTINATIONS, RESIDENCY_REGIONS, type OcrEngine } from '../src/index.js';
import { startAzureStub, type AzureStub } from './helpers/azureStub.js';
import { fakeEngine } from './helpers/fakeEngine.js';

const local = fakeEngine('local-tesseract', 'local');
const make = { local: async () => local, azure: (c: any) => fakeEngine('azure-document-intelligence', 'cloud', c) };
const azureCfg = { endpoint: 'https://acme.cognitiveservices.azure.com', key: 'k-SECRET', region: 'uksouth' };
const profile = (outbound: string[], residency: Residency = 'uk'): AppProfile => ({ schema: 1, modules: ['ocr'], policy: { outbound, residency } });
const ocr = (engine: 'local' | 'azure', azure?: typeof azureCfg) => ({ engine, concurrency: 1, timeoutMs: 60000, ...(azure ? { azure } : {}) });

let stub: AzureStub | undefined;
afterEach(async () => {
  await stub?.stop();
  stub = undefined;
});

test('local is the default and needs no permission', async () => {
  expect((await chooseEngine(profile([]), ocr('local'), make)).id).toBe('local-tesseract');
});

test('cloud is refused when the policy does not allow it', async () => {
  await expect(chooseEngine(profile([]), ocr('azure', azureCfg), make)).rejects.toMatchObject({
    problems: ["OCR_ENGINE is set to azure, but this app's data policy does not allow receipts to be sent to Azure Document Intelligence. Use OCR_ENGINE=local, or change the policy through a change request."],
  });
});

test('cloud is refused when the region is outside the residency', async () => {
  await expect(chooseEngine(profile(['azure-document-intelligence'], 'uk'), ocr('azure', { ...azureCfg, region: 'eastus' }), make)).rejects.toMatchObject({
    problems: ['OCR_AZURE_REGION is eastus, but this app\'s data must stay in the UK. Use uksouth or ukwest.'],
  });
});

test('cloud is used, with local as its fallback, only when everything agrees', async () => {
  const e = await chooseEngine(profile(['azure-document-intelligence'], 'uk'), ocr('azure', azureCfg), make);
  expect(e).toMatchObject({ kind: 'cloud', outboundId: 'azure-document-intelligence' });
});

test('no problem text ever contains the key', async () => {
  const err = (await chooseEngine(profile([]), ocr('azure', azureCfg), make).catch((x: unknown) => x)) as OcrPolicyError;
  expect(JSON.stringify(err.problems)).not.toContain('k-SECRET');
  expect(err.message).not.toContain('k-SECRET');
});

test('a refused cloud engine sends nothing', async () => {
  stub = await startAzureStub();
  const s = stub;
  await expect(chooseEngine(profile([]), ocr('azure', { ...azureCfg, endpoint: s.url }), {
    local: make.local,
    azure: (c) => createAzureReceiptEngine({ ...c, allowHttpLoopback: true }),
  })).rejects.toBeInstanceOf(OcrPolicyError);
  expect(s.requests).toEqual([]);
});

test('every problem is reported at once, and the cloud engine is never made', async () => {
  let made = 0;
  const err = await chooseEngine(profile([], 'uk'), ocr('azure', { ...azureCfg, region: 'westeurope' }), {
    local: make.local,
    azure: (c) => { made += 1; return make.azure(c); },
  }).catch((x: unknown) => x);
  expect(err).toBeInstanceOf(OcrPolicyError);
  expect((err as OcrPolicyError).problems).toHaveLength(2);
  expect(made).toBe(0);
});

test('the UK-and-Europe residency names its regions, and "any" accepts every region', async () => {
  await expect(chooseEngine(profile(['azure-document-intelligence'], 'uk-eu'), ocr('azure', { ...azureCfg, region: 'eastus' }), make)).rejects.toMatchObject({
    problems: [expect.stringMatching(/^OCR_AZURE_REGION is eastus, but this app's data must stay in the UK or Europe\. Use uksouth, ukwest, .* or spaincentral\.$/)],
  });
  const eu = await chooseEngine(profile(['azure-document-intelligence'], 'uk-eu'), ocr('azure', { ...azureCfg, region: 'westeurope' }), make);
  expect(eu.kind).toBe('cloud');
  const anywhere = await chooseEngine(profile(['azure-document-intelligence'], 'any'), ocr('azure', { ...azureCfg, region: 'eastus' }), make);
  expect(anywhere.kind).toBe('cloud');
});

test('missing Azure settings are refused, each named', async () => {
  await expect(chooseEngine(profile(['azure-document-intelligence']), ocr('azure'), make)).rejects.toMatchObject({
    problems: ['OCR_AZURE_ENDPOINT is needed when OCR_ENGINE is azure.', 'OCR_AZURE_KEY is needed when OCR_ENGINE is azure.', 'OCR_AZURE_REGION is needed when OCR_ENGINE is azure.'],
  });
  await expect(chooseEngine(profile(['azure-document-intelligence']), ocr('azure', { ...azureCfg, key: '' }), make)).rejects.toMatchObject({
    problems: ['OCR_AZURE_KEY is needed when OCR_ENGINE is azure.'],
  });
});

test('an unknown engine name is refused', async () => {
  const cfg = { engine: 'google' as unknown as 'local', concurrency: 1, timeoutMs: 60000 };
  await expect(chooseEngine(profile([]), cfg, make)).rejects.toMatchObject({ problems: ['OCR_ENGINE must be local or azure.'] });
});

test('an Azure endpoint the adapter refuses stops the start as a policy problem, and the local engine is closed', async () => {
  const loc = fakeEngine('local-tesseract', 'local');
  const err = await chooseEngine(profile(['azure-document-intelligence']), ocr('azure', { ...azureCfg, endpoint: 'http://example.com' }), {
    local: async () => loc,
    azure: (c) => createAzureReceiptEngine(c),
  }).catch((x: unknown) => x);
  expect(err).toBeInstanceOf(OcrPolicyError);
  expect((err as OcrPolicyError).problems).toEqual(['OCR_AZURE_ENDPOINT must start with https://.']);
  expect(loc.closed).toBe(true);
});

test('the destinations list and residency regions are the pinned values', () => {
  expect(OUTBOUND_DESTINATIONS).toEqual([{ id: 'azure-document-intelligence', hosts: ['*.cognitiveservices.azure.com'], carries: 'receipt photos and PDFs, for reading' }]);
  expect(RESIDENCY_REGIONS.uk).toEqual(['uksouth', 'ukwest']);
  expect(RESIDENCY_REGIONS.any).toBe('any');
  expect(RESIDENCY_REGIONS['uk-eu']).toHaveLength(12);
});

test('the chosen cloud engine is a fallback wrapper over the local one', async () => {
  const loc = fakeEngine('local-tesseract', 'local');
  const e: OcrEngine = await chooseEngine(profile(['azure-document-intelligence']), ocr('azure', azureCfg), { local: async () => loc, azure: make.azure });
  expect(e.id).toBe('azure-document-intelligence');
  await e.close();
  expect(loc.closed).toBe(true);
});
