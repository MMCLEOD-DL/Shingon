# Task 4: Engine choice under the data policy, and the cloud adapter

**Repo: `/root/highland-foundation`.**

Spec §6: the data policy decides local versus cloud OCR. Spec §3's anti-goal: receipts sent to a cloud API when the policy forbids it. This task makes that **impossible by configuration mistake**: the cloud engine exists only when the committed profile allows it, the residency fits its region, and the box's `.env` asks for it. Anything else stops the app at start, in one plain sentence per problem.

The adapter is Azure AI Document Intelligence `prebuilt-receipt` [call, index]. It is tested only against a stub on 127.0.0.1.

**Files:**
- Create: `modules/ocr/src/destinations.ts` (`OUTBOUND_DESTINATIONS`, `RESIDENCY_REGIONS`), `modules/ocr/src/azure.ts`, `modules/ocr/src/choose.ts` (`chooseEngine`, `OcrPolicyError`), `modules/ocr/src/fallback.ts`
- Modify: `modules/ocr/src/index.ts`, `CHANGELOG.md`
- Test: `modules/ocr/test/choose.test.ts`, `modules/ocr/test/azure.test.ts`, `modules/ocr/test/fallback.test.ts`, `modules/ocr/test/helpers/azureStub.ts`, `modules/ocr/test/helpers/fakeEngine.ts` (`fakeEngine(id, kind, cfg?)`: an `OcrEngine` that records its calls and returns empty lines)

**Interfaces:**
- Consumes: `AppProfile`, `Residency` (Task 1); `Config['ocr']` (Task 1); `OcrEngine`, `OcrResult`, `EngineFields`, `UnreadableError` (Task 3).
- Produces: `OUTBOUND_DESTINATIONS`, `RESIDENCY_REGIONS`, `createAzureReceiptEngine`, `chooseEngine`, `OcrPolicyError { problems: string[] }`, `withFallback` (signatures in the index).

Values this task pins:
- `OUTBOUND_DESTINATIONS = [{ id: 'azure-document-intelligence', hosts: ['*.cognitiveservices.azure.com'], carries: 'receipt photos and PDFs, for reading' }]`.
- `RESIDENCY_REGIONS = { uk: ['uksouth', 'ukwest'], 'uk-eu': ['uksouth', 'ukwest', 'northeurope', 'westeurope', 'francecentral', 'germanywestcentral', 'swedencentral', 'switzerlandnorth', 'norwayeast', 'italynorth', 'polandcentral', 'spaincentral'], any: 'any' }`. (Switzerland and Norway are not EU but have UK adequacy; the operator can trim this list.)
- Azure request: `POST {endpoint}/documentintelligence/documentModels/prebuilt-receipt:analyze?api-version=2024-11-30`, header `Ocp-Apim-Subscription-Key: <key>`, `Content-Type` = the file's type, body = the bytes. Expect **202** with an `Operation-Location` header; poll it with `GET` (same key header) every `pollMs` (default 1000) until `status` is `succeeded` or `failed`, within `timeoutMs` (default 30000). Fields read from `analyzeResult.documents[0].fields`: `Total.valueCurrency.amount` (and `currencyCode`), `TotalTax.valueCurrency.amount`, `TransactionDate.valueDate`, `MerchantName.valueString`, each with its `confidence`. Lines from `analyzeResult.pages[*].lines[*].content` with confidence 0.9 (Azure gives words, not line confidences). **Check these names against the live service in the operator follow-up before first real use.**

- [ ] **Step 1: Write the failing tests**

`modules/ocr/test/helpers/azureStub.ts`: a `node:http` server on `127.0.0.1:0` that records every request (method, path, headers minus the key, body length), answers the analyse call with 202 and an `Operation-Location` on itself, answers the first poll with `{ status: 'running' }` and the second with a canned `succeeded` result for the taxi receipt (Total 12.40 GBP, TotalTax 2.07, TransactionDate 2026-03-12, MerchantName "Northside Taxis", confidences 0.98/0.95/0.97/0.93). It can also be told to answer 500, or to hang.

`modules/ocr/test/choose.test.ts`:

```ts
const local = fakeEngine('local-tesseract', 'local');
const make = { local: async () => local, azure: (c: any) => fakeEngine('azure-document-intelligence', 'cloud', c) };
const azureCfg = { endpoint: 'https://acme.cognitiveservices.azure.com', key: 'k-SECRET', region: 'uksouth' };
const profile = (outbound: string[], residency: Residency = 'uk'): AppProfile => ({ schema: 1, modules: ['ocr'], policy: { outbound, residency } });
const ocr = (engine: 'local' | 'azure', azure?: typeof azureCfg) => ({ engine, concurrency: 1, timeoutMs: 60000, ...(azure ? { azure } : {}) });

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
  const err = await chooseEngine(profile([]), ocr('azure', azureCfg), make).catch((x) => x);
  expect(JSON.stringify(err.problems)).not.toContain('k-SECRET');
});
```

`modules/ocr/test/azure.test.ts` (each test starts and stops its own stub):
- `'reads a receipt through analyse and poll'`: `createAzureReceiptEngine({ endpoint: stub.url, key: 'k', region: 'uksouth', allowHttpLoopback: true, pollMs: 10 })`, then `read({ bytes, type: 'image/jpeg' })` gives `fields.amountPence = { value: 1240, confidence: 0.98 }`, `vatPence 207`, `date '2026-03-12'`, `merchant 'Northside Taxis'`; the stub saw exactly one POST to `/documentintelligence/documentModels/prebuilt-receipt:analyze?api-version=2024-11-30` with the key header present, and two GETs.
- `'a non-GBP total is passed on as a warning and a low confidence'`: stub returns `currencyCode: 'EUR'` → `fields.amountPence.confidence < CONFIDENT` and the warning `This receipt may not be in pounds. Please check the amount.`
- `'plain http is refused except to 127.0.0.1 in tests'`: `createAzureReceiptEngine({ endpoint: 'http://example.com', … })` throws `OCR_AZURE_ENDPOINT must start with https://.` (constructing it makes no request).
- `'a failed analysis or a timeout throws an engine error, never hangs'`: stub `500` → rejects with `CloudEngineError`; stub hangs with `timeoutMs: 200` → rejects within 1 s.
- `'the key never appears in errors'`: the rejection's message and `userMessage` don't contain the key.

`modules/ocr/test/fallback.test.ts`:
- `'a cloud failure falls back to local and says so'`: primary throws `CloudEngineError` → result from the local fake with warning `The cloud reader was unavailable, so this receipt was read on the box instead.`
- `'an unreadable file is not retried elsewhere'`: primary throws `UnreadableError` → same error rethrown, local never called.
- `'the fallback only ever goes from cloud to local'`: `withFallback(local, cloud)` throws `A fallback must keep receipts on the box.`

**The test for Review Focus 3**, in `choose.test.ts`:
- `'a refused cloud engine sends nothing'`: start the stub; `chooseEngine(profile([]), ocr('azure', { ...azureCfg, endpoint: stub.url }), { local: make.local, azure: (c) => createAzureReceiptEngine({ ...c, allowHttpLoopback: true }) })` rejects, and `stub.requests` is empty.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run modules/ocr/test/choose.test.ts modules/ocr/test/azure.test.ts modules/ocr/test/fallback.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

- `chooseEngine`: collects every problem before throwing (unknown engine name, missing Azure settings, outbound not allowed, region outside residency). With `engine: 'azure'` and no problems it returns `withFallback(make.azure(cfg), await make.local())`. It never constructs the Azure engine when there is any problem.
- `createAzureReceiptEngine`: `fetchImpl ?? fetch`; `AbortSignal.timeout` on every call; maps Azure's fields to `EngineFields` (amount via `toPence(amount.toFixed(2))`), and a non-GBP currency to a confidence of at most 0.5 plus the warning.
- `CloudEngineError extends Error` with `userMessage: 'The cloud reader could not be reached.'`; any HTTP status other than 202/200, a `failed` status, a network error or a timeout becomes this error. Errors never include the key, request headers or response bodies.
- `withFallback`: tries the primary; on `CloudEngineError` calls the fallback and adds the warning; `UnreadableError` passes straight through.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run modules/ocr` → PASS. `npm run verify` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ocr): engine choice under the data policy, Azure receipt adapter (stub-tested), cloud-to-local fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
