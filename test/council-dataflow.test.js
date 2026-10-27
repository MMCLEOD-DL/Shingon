import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { outboundDestinations, packageDestinations, hostMatches, policyAllows, dataFlowFindings, personalDataFindings, retentionFindings } from '../src/council/dataflow.js';
import { applyInterpretation } from '../src/council/interpret.js';

// A services table for tests, in OUTBOUND_SERVICES' shape (Plan 7 seeds only the first two)
const SERVICES = {
  'cloudflare-tunnel': { label: 'Cloudflare Tunnel', hosts: ['*.cloudflare.com', '*.argotunnel.com'], carries: "the app's web traffic" },
  'azure-document-intelligence': { label: 'Azure Document Intelligence', hosts: ['*.cognitiveservices.azure.com'], carries: 'receipt images' },
  stripe: { label: 'Stripe', hosts: ['*.stripe.com'], carries: 'card payments' },
};

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

test('policyAllows: only ids from the services table, matched on their hosts — never free text', () => {
  assert.equal(hostMatches('*.cloudflare.com', 'api.cloudflare.com'), true);
  assert.equal(hostMatches('*.cloudflare.com', 'cloudflare.com'), true);
  assert.equal(hostMatches('*.cloudflare.com', 'evilcloudflare.com'), false);
  assert.equal(hostMatches('api.stripe.com', 'files.stripe.com'), false);
  const az = { host: 'acme-receipts.cognitiveservices.azure.com', service: null };
  assert.equal(policyAllows(az, ['azure-document-intelligence'], SERVICES), 'azure-document-intelligence');
  assert.equal(policyAllows(az, ['cloudflare-tunnel'], SERVICES), null);
  assert.equal(policyAllows({ host: 'cognitiveservices.azure.com', service: 'Azure Document Intelligence' }, ['azure-document-intelligence'], SERVICES), 'azure-document-intelligence');
  assert.equal(policyAllows({ host: 'vision.googleapis.com', service: null }, ['googleapis.com', 'Google Cloud'], SERVICES), null);   // free text allows nothing
});

test('a destination the policy does not allow blocks; allowed ones are one note', () => {
  const f = dataFlowFindings([
    { host: 'vision.googleapis.com', service: null, file: 'apps/server/src/ocr/cloud.ts', line: 1, how: 'url' },
    { host: 'stripe.com', service: 'Stripe', file: 'package-lock.json', line: null, how: 'package', pkg: 'stripe@18.0.0' },
  ], { outbound: ['stripe', 'not-a-service'] }, SERVICES);
  assert.deepEqual(f.map((x) => [x.title, x.grade, x.locked, x.tool]), [
    ['The app connects to vision.googleapis.com, which the data policy does not allow', 'blocking', false, 'data-flow'],
    ['The data policy names an outside service Conductor does not know (not-a-service)', 'warning', false, 'data-flow'],
    ['Outside services the app uses, all allowed by the data policy: Stripe', 'note', false, 'data-flow'],
  ]);
  assert.match(f[0].detail, /apps\/server\/src\/ocr\/cloud\.ts:1/);
  assert.match(f[0].detail, /Outside services the policy allows: Stripe \(\*\.stripe\.com\)/);
});

test('the interpreter can set a data-flow block aside only with a reason', () => {
  const [f] = dataFlowFindings([{ host: 'docs.acme.co.uk', service: null, file: 'a.ts', line: 1, how: 'url' }], { outbound: [] }, SERVICES);
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

test('multi-line pgTable heads and builder-only column names (R10)', () => {
  const a = app({ 'apps/server/src/db/schema/people.ts': "export const people = pgTable(\n  'people',\n  {\n    id: uuid('id'),\n    email: text('email').default('none'),\n    notes: text('notes'),\n  },\n  (t) => [index('people_email_idx').on(t.email)],\n);\n" });
  assert.deepEqual(personalDataFindings(a).findings.map((x) => x.title), ['The people table holds personal data: email']);
});

test('a wildcard host does not match a look-alike, and data-flow groups by host', () => {
  assert.equal(policyAllows({ host: 'evilcloudflare.com', service: null }, ['cloudflare-tunnel'], SERVICES), null);
  assert.equal(policyAllows({ host: 'x.argotunnel.com', service: null }, ['cloudflare-tunnel'], SERVICES), 'cloudflare-tunnel');
  const f = dataFlowFindings([1, 2, 3, 4, 5, 6, 7].map((n) => ({ host: 'a.io', service: null, file: `f${n}.ts`, line: n, how: 'url' })), { outbound: [] }, SERVICES);
  assert.equal(f.length, 1);
  assert.match(f[0].detail, /and 2 more/);
  assert.match(f[0].detail, /allows: none/);
});
