# Task 10: Legal/data for client apps

On an ordinary repo, Legal is unchanged (Plan 5 Task 3). On a project build it also checks the app against the brief's data policy (spec §6, §4.3 "Legal / data"), with two more ToolRuns after `licences` and `scancode`:

1. **`data-flow`** (index Ruling 9): where can the app send data?
   - **URLs.** It scans `input.files` (the files changed since the foundation; not test files, docs, lockfiles or `node_modules`, and only text files up to 1 MB) for `http://`, `https://`, `ws://` and `wss://` hosts.
   - **Ignored hosts:** `localhost`; `127.0.0.1`; `0.0.0.0`; `[::1]`; any `*.test`, `*.example`, `*.invalid`, `*.local` or `*.localhost`; `example.com`/`.org`/`.net`; `www.w3.org`; `json-schema.org`; `schemas.*`.
   - **Packages.** It reads the **shipped** (non-dev) packages introduced since the foundation (`lockDelta` against the lockfile at `input.baseSha`, which on a project is the foundation commit). It matches them against `OUTBOUND_PACKAGES`:

     | Package (name or `prefix/`) | Service | Host |
     |---|---|---|
     | `@aws-sdk/`, `aws-sdk` | Amazon Web Services | `amazonaws.com` |
     | `@google-cloud/`, `googleapis` | Google Cloud | `googleapis.com` |
     | `@azure/` | Microsoft Azure | `azure.com` |
     | `openai` | OpenAI | `openai.com` |
     | `@anthropic-ai/sdk` | Anthropic | `anthropic.com` |
     | `stripe` | Stripe | `stripe.com` |
     | `@sendgrid/` | SendGrid | `sendgrid.com` |
     | `twilio` | Twilio | `twilio.com` |
     | `@sentry/` | Sentry | `sentry.io` |
     | `posthog-js`, `posthog-node` | PostHog | `posthog.com` |
     | `mixpanel`, `mixpanel-browser` | Mixpanel | `mixpanel.com` |
     | `tesseract.js` | jsDelivr (tesseract.js downloads its language files from there unless told otherwise) | `cdn.jsdelivr.net` |

   - **Allowed?** `policyAllows(dest, outbound)` is true when any entry `e = entry.trim().toLowerCase()` satisfies `e === host`, `host.endsWith('.' + e)`, or `e === service.toLowerCase()`.
   - **Findings.** Each destination that is not allowed is one **blocking** finding (not locked): `The app connects to <service, or host>, which the data policy does not allow`. Detail: up to 5 `file:line` places (or the package name), then `Outside services the policy allows: none` or the list. All allowed destinations together make one **note**: `Outside services the app uses, all allowed by the data policy: <list>`. `context`: the full destination list and the policy's `outbound`. With no `policy` in the brief, the ToolRun is `skipped` with the **locked warning** `The brief has no data policy, so the app's outside connections could not be checked`.
2. **`data-policy`**: personal data and retention.
   - **Personal data.** For each Drizzle schema file in `input.files` under `apps/server/src/db/schema/`, it reads the table name (`pgTable('<name>'`) and the column names (the first string argument of each column builder). Columns whose name matches `/(^|_)(name|first_name|last_name|full_name|email|phone|mobile|address|postcode|dob|birth|date_of_birth|ni_number|national_insurance|bank|sort_code|account_number|iban|salary|photo|signature|passport|licence|vehicle_reg)(_|$)/` make one **note** per table: `The <table> table holds personal data: <columns>`. Detail: `Check that it is covered by the retention rule, that only the right roles can see it (the role-crossing tests), and that it is never written to the activity log.`
   - **Retention.** When `policy.retention.days` is a number, a personal-data table was found, and no file in `input.files` (not tests) matches `/retention|RETENTION_DAYS|olderThan|older_than|purge|deleteExpired|delete_expired/i`, add a **warning**: `The data policy keeps records for <days> days, but nothing the factory added deletes them after that`. With no `days`, add a **note**: `The data policy gives no number of days for keeping records, so retention could not be checked`.

The interpreter (Task 7, `FOCUS_PROJECT.legal`) explains each risk against the policy and UK GDPR basics. It may set aside a `data-flow` block only with a reason. Whatever it adds is at most a warning.

**Files:**
- Create: `src/council/dataflow.js`
- Modify: `src/council/licences.js` (`LEGAL.collect`)
- Test: `test/council-dataflow.test.js` (new), `test/council-legal.test.js` (append)

**Interfaces:**
- Consumes: `lockPackages`, `readLock`, `lockDelta` (Plan 5); `TEST_FILE` (Plan 5); `makeFinding`, `skipped`; `applyInterpretation` (Plan 5).
- Produces (`src/council/dataflow.js`):
  - `OUTBOUND_PACKAGES`, `IGNORED_HOST`;
  - `outboundDestinations({ dir, files }) -> [{ host, service: null, file, line, how: 'url' }]`;
  - `packageDestinations(packages) -> [{ host, service, file: 'package-lock.json', line: null, how: 'package', pkg }]`;
  - `policyAllows(dest, outbound) -> boolean`;
  - `dataFlowFindings(dests, policy) -> Finding[]`;
  - `personalDataFindings({ dir, files }) -> { findings, tables: string[] }`;
  - `retentionFindings({ dir, files, policy, tables }) -> Finding[]`.
- `LEGAL.collect(input)`: Plan 5's `licences`, `scancode` when `!input.brief`; otherwise those plus `data-flow` and `data-policy`.

- [ ] **Step 1: Write the failing tests**

Create `test/council-dataflow.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { outboundDestinations, packageDestinations, policyAllows, dataFlowFindings, personalDataFindings, retentionFindings } from '../src/council/dataflow.js';
import { applyInterpretation } from '../src/council/interpret.js';

function app(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'df-'));
  for (const [f, s] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), s); }
  return { dir, files: Object.keys(files) };
}

test('outboundDestinations finds real hosts and ignores example, local and test ones', () => {
  const a = app({
    'apps/server/src/ocr/cloud.ts': "const u = 'https://vision.googleapis.com/v1/images:annotate';\nfetch('http://localhost:3000/x');\n",
    'apps/server/src/x.ts': "// see https://example.com/docs\nconst ns = 'http://www.w3.org/2000/svg';\nconst hook = 'https://hooks.slack.com/services/T0';\n",
    'apps/server/test/x.test.ts': "fetch('https://evil.example.org')\n",
    'README.md': 'https://mixpanel.com',
  });
  assert.deepEqual(outboundDestinations(a).map((d) => [d.host, d.file, d.line]), [
    ['vision.googleapis.com', 'apps/server/src/ocr/cloud.ts', 1], ['hooks.slack.com', 'apps/server/src/x.ts', 3]]);
});

test('known outside-service packages count, with their service names', () => {
  assert.deepEqual(packageDestinations([{ name: '@aws-sdk/client-s3', version: '3.0.0', dev: false }, { name: 'tesseract.js', version: '5.1.0', dev: false }, { name: 'zod', version: '4.6.7', dev: false }])
    .map((d) => [d.service.split(' (')[0], d.host, d.pkg]), [['Amazon Web Services', 'amazonaws.com', '@aws-sdk/client-s3@3.0.0'], ['jsDelivr', 'cdn.jsdelivr.net', 'tesseract.js@5.1.0']]);
});

test('policyAllows: exact host, parent domain, or service name; case and spaces ignored', () => {
  const d = { host: 'vision.googleapis.com', service: null };
  assert.equal(policyAllows(d, [' GoogleAPIs.com ']), true);
  assert.equal(policyAllows(d, ['vision.googleapis.com']), true);
  assert.equal(policyAllows(d, ['apis.com']), false);
  assert.equal(policyAllows({ host: 'stripe.com', service: 'Stripe' }, ['stripe']), true);
  assert.equal(policyAllows(d, []), false);
});

test('a destination the policy does not allow blocks; allowed ones are one note', () => {
  const f = dataFlowFindings([
    { host: 'vision.googleapis.com', service: null, file: 'apps/server/src/ocr/cloud.ts', line: 1, how: 'url' },
    { host: 'stripe.com', service: 'Stripe', file: 'package-lock.json', line: null, how: 'package', pkg: 'stripe@18.0.0' },
  ], { outbound: ['Stripe'] });
  assert.deepEqual(f.map((x) => [x.title, x.grade, x.locked, x.tool]), [
    ['The app connects to vision.googleapis.com, which the data policy does not allow', 'blocking', false, 'data-flow'],
    ['Outside services the app uses, all allowed by the data policy: Stripe', 'note', false, 'data-flow'],
  ]);
  assert.match(f[0].detail, /apps\/server\/src\/ocr\/cloud\.ts:1/);
  assert.match(f[0].detail, /Outside services the policy allows: Stripe/);
});

test('the interpreter can set a data-flow block aside only with a reason', () => {
  const [f] = dataFlowFindings([{ host: 'docs.acme.co.uk', service: null, file: 'a.ts', line: 1, how: 'url' }], { outbound: [] });
  const noWhy = applyInterpretation([f], ['L1'], { findings: [{ id: 'L1', decision: 'dismiss', why: null }], extra: [] }, { member: 'legal' });
  assert.equal(noWhy[0].dismissed, false);
  const why = applyInterpretation([f], ['L1'], { findings: [{ id: 'L1', decision: 'dismiss', why: 'it is a link in a help comment, never fetched' }], extra: [] }, { member: 'legal' });
  assert.equal(why[0].dismissed, true);
});

test('personal data and retention', () => {
  const a = app({ 'apps/server/src/db/schema/claims.ts': "export const claims = pgTable('claims', {\n  id: uuid('id'),\n  claimant_name: text('claimant_name'),\n  vehicle_reg: text('vehicle_reg'),\n  miles: integer('miles'),\n});\n" });
  const p = personalDataFindings(a);
  assert.deepEqual(p.findings.map((x) => [x.title, x.grade]), [['The claims table holds personal data: claimant_name, vehicle_reg', 'note']]);
  assert.deepEqual(retentionFindings({ ...a, policy: { retention: { text: 'six years', days: 2190 } }, tables: p.tables }).map((x) => [x.title, x.grade]),
    [['The data policy keeps records for 2190 days, but nothing the factory added deletes them after that', 'warning']]);
  const kept = app({ ...Object.fromEntries(a.files.map((f) => [f, 'x'])), 'apps/server/src/jobs/purge-claims.ts': 'const RETENTION_DAYS = 2190;' });
  assert.deepEqual(retentionFindings({ ...kept, policy: { retention: { days: 2190 } }, tables: ['claims'] }), []);
  assert.equal(retentionFindings({ ...a, policy: { retention: { text: 'as long as needed' } }, tables: p.tables })[0].grade, 'note');
});
```

Append to `test/council-legal.test.js`: `LEGAL.collect` with `brief: null` returns the tools `['licences', 'scancode']` exactly as before. With `brief: { policy: { outbound: [] } }` and a file `apps/server/src/ocr.ts` containing `https://vision.googleapis.com`, it returns `['licences', 'scancode', 'data-flow', 'data-policy']`, and the `data-flow` finding is blocking. With `brief: {}` (no policy), `data-flow` is skipped with the locked warning.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-dataflow.test.js test/council-legal.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `src/council/dataflow.js` and the `LEGAL.collect` addition** as described. Keep the first URL occurrence per host per file. Group findings by host (or by service for packages). Cap the `data-flow` findings at 20.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/dataflow.js src/council/licences.js test/council-dataflow.test.js test/council-legal.test.js
git commit -m "feat(council): Legal/data checks outside connections against the data policy, plus personal data and retention"
```
