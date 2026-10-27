# Task 3: Brief schema — normalise and validate

This task builds roadmap Contract 2's `validateBrief`, plus `normalizeBrief`, the gate every model reply passes through (Rulings 4, 6, 8, 9). The validator is the contract Plans 8, 9, 11 and 12 rely on, so its problems are plain English and its stages are exact.

**Files:**
- Create: `src/factory/brief.js` (this task: constants, `cleanText`, `normalizeBrief`, `validateBrief`), `test/helpers/briefFixtures.js`
- Test: `test/factory-brief-validate.test.js`

**Interfaces:**
- Consumes: `exampleProblems` (Task 2); `secretValues` from `src/secrets.js`.
- Produces: the Task 3 exports in Shared Interfaces, plus these test fixtures:
  - `validBrief(over = {}) -> object` (content only, `ready`-valid);
  - `approvedBrief(over = {}) -> object` (adds `slug: 'thistle'`, `version: 1`, `createdAt: '2026-10-27T09:00:00.000Z'`, `revisedFrom: null`, `approvedAt: '2026-10-27T10:00:00.000Z'`, `approvedBy: 'Malcolm'`).

**Brief shape (schema 1).** Content keys come from the model through `normalizeBrief`. The meta keys are stamped by Conductor only.

```
content: client, purpose, kind,
  roles[{ name, whatTheyDo, sees, mapsTo }], records[{ name, description, holdsFiles, personalData }],
  features[{ id, title, story, roles[], data[], acceptance[{ given, when, then }] }],
  outputs[{ name, format, roles[], description }], integrations[{ name, purpose, dataSent }], modules[],
  policy{ hosting, outbound[], residency, retention{ text, days }, backupDestination{ kind, detail }, operatorAccess },
  assumptions[], openQuestions[{ id, question, why }]
meta:    schema (always 1), slug, version, createdAt, revisedFrom, approvedAt, approvedBy
```

- [ ] **Step 1: Write `test/helpers/briefFixtures.js`**

```js
// A complete, fictional brief (Thistle Joinery's expenses app) used across the brief tests.
export function validBrief(over = {}) {
  return {
    schema: 1,
    client: 'Thistle Joinery Ltd',
    purpose: 'Staff photograph receipts on their phones, managers approve them, and the finance lead gets a monthly expenses spreadsheet with VAT split out.',
    kind: 'web-app',
    roles: [
      { name: 'Staff', whatTheyDo: 'Upload receipts and claim them back', sees: 'Only their own claims', mapsTo: 'member' },
      { name: 'Manager', whatTheyDo: 'Approve or reject claims from their team', sees: "Their team's claims", mapsTo: 'manager' },
      { name: 'Finance', whatTheyDo: 'Run the monthly report and manage users', sees: 'All claims', mapsTo: 'admin' },
    ],
    records: [{ name: 'Claim', description: 'One receipt claimed back by one person', holdsFiles: true, personalData: true }],
    features: [
      { id: 'upload-receipt', title: 'Upload a receipt', story: 'A member of staff photographs a receipt and fills in the amount, VAT and category.', roles: ['Staff'], data: ['Claim'],
        acceptance: [{ given: 'Alice is signed in as Staff', when: 'she uploads a £12.40 receipt with £2.07 VAT dated 3 March 2026, category Travel', then: 'her claims list shows Travel £12.40 dated 3 March 2026, status Waiting' }] },
      { id: 'monthly-report', title: 'Monthly expenses report', story: 'Finance downloads a spreadsheet of approved claims for one month, with VAT split out.', roles: ['Finance'], data: ['Claim'],
        acceptance: [{ given: "Alice's £12.40 Travel claim with £2.07 VAT was approved in March 2026", when: 'Finance downloads the March 2026 report', then: 'the Travel row shows net £10.33, VAT £2.07, gross £12.40' }] },
    ],
    outputs: [{ name: 'Monthly expenses report', format: 'xlsx', roles: ['Finance'], description: 'Approved claims for one month, one row per claim, totals by category' }],
    integrations: [],
    modules: ['ocr', 'xlsx-export'],
    policy: {
      hosting: 'client-box', outbound: [], residency: 'uk',
      retention: { text: 'Claims and receipts are kept for 6 years, then deleted', days: 2190 },
      backupDestination: { kind: 'client-owned', detail: "A USB disk kept in the client's office safe" },
      operatorAccess: true,
    },
    assumptions: ['All receipts are in pounds sterling'],
    openQuestions: [],
    ...over,
  };
}

export function approvedBrief(over = {}) {
  return validBrief({ slug: 'thistle', version: 1, createdAt: '2026-10-27T09:00:00.000Z', revisedFrom: null,
    approvedAt: '2026-10-27T10:00:00.000Z', approvedBy: 'Malcolm', ...over });
}
```

- [ ] **Step 2: Write the failing tests** in `test/factory-brief-validate.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrief, validateBrief, cleanText, MODULES, LIMITS } from '../src/factory/brief.js';
import { validBrief, approvedBrief } from './helpers/briefFixtures.js';

const problems = (b, stage) => validateBrief(b, stage ? { stage } : undefined).problems;
const has = (b, re, stage) => {
  const p = problems(b, stage);
  assert.ok(p.some((m) => re.test(m)), JSON.stringify(p));
};
const withPolicy = (over) => validBrief({ policy: { ...validBrief().policy, ...over } });

test('the fixture is ready and, once stamped, approved', () => {
  assert.deepEqual(validateBrief(validBrief()), { ok: true, problems: [] });
  assert.deepEqual(validateBrief(approvedBrief(), { stage: 'approved' }), { ok: true, problems: [] });
  has(validBrief(), /has not been approved/, 'approved');
  assert.deepEqual(MODULES, ['ocr', 'pdf-export', 'xlsx-export', 'scheduled-jobs']);
});

test('cleanText strips control, escape and bidi characters, trims and clips', () => {
  assert.equal(cleanText('  \x1b[31mred\x1b[0m‮evil\u0007 ', 100), 'redevil');
  assert.equal(cleanText('line one\nline\ttwo', 100), 'line one\nline\ttwo');
  assert.equal(cleanText('abcdef', 4), 'abc…');
  assert.equal(cleanText(42, 10), undefined);
  assert.equal(cleanText('   ', 10), '');
});

test('normalizeBrief keeps known keys only, drops approval and meta, caps lists, never throws', () => {
  const raw = JSON.parse('{"__proto__": {"polluted": true}, "client": "\\u001b]0;pwn\\u0007Acme", "approvedAt": "2026-01-01T00:00:00Z", "approvedBy": "the model", "version": 9, "slug": "../x", "run": "rm -rf /", "features": "not a list"}');
  const b = normalizeBrief(raw);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.hasOwn(b, '__proto__'), false);
  assert.equal(b.client, 'Acme');
  for (const k of ['approvedAt', 'approvedBy', 'version', 'slug', 'run', 'createdAt', 'revisedFrom']) assert.equal(Object.hasOwn(b, k), false, k);
  assert.equal(b.schema, 1);
  assert.equal(b.features, undefined, 'a wrong type is dropped so the validator reports it missing');
  const many = normalizeBrief({ features: Array.from({ length: 100 }, (_, i) => ({ id: `f${i}` })) });
  assert.equal(many.features.length, LIMITS.features);
  for (const bad of [null, 'text', 42, [], undefined]) assert.equal(typeof normalizeBrief(bad), 'object');
  const kept = normalizeBrief(validBrief());
  assert.deepEqual(kept, validBrief(), 'a clean brief survives normalisation unchanged');
  assert.equal(normalizeBrief({ policy: { operatorAccess: 'yes' } }).policy.operatorAccess, undefined, 'only a real boolean is kept');
});

test('identity and kind', () => {
  has('nope', /The brief is not a JSON object/);
  has(validBrief({ schema: 2 }), /format this Conductor does not know \(schema 2; expected 1\)/);
  has(validBrief({ kind: 'game' }), /This brief is for "game", but the factory can only build web apps for now/);
  has(validBrief({ kind: undefined }), /does not say what kind of software it is/);
  has(validBrief({ client: '' }), /does not say who the client is/);
  has(validBrief({ purpose: 'An app.' }), /purpose is too short/);
});

test('roles, records and features cross-check each other', () => {
  const b = validBrief();
  has({ ...b, roles: [] }, /The brief has no roles/);
  has({ ...b, roles: [...b.roles, { ...b.roles[0] }] }, /Two roles are called "Staff"/);
  has({ ...b, roles: [{ ...b.roles[0], mapsTo: 'owner' }, ...b.roles.slice(1)] }, /Role "Staff": "mapsTo" must be admin, manager or member \(the foundation's fixed roles\), not "owner"/);
  has({ ...b, roles: b.roles.slice(0, 2) }, /No role maps to admin/);
  has({ ...b, roles: [{ ...b.roles[0], sees: '' }, ...b.roles.slice(1)] }, /Role "Staff" does not say what it may see/);
  has({ ...b, records: [] }, /The brief lists no records/);
  const f = b.features[0];
  has({ ...b, features: [] }, /The brief has no features/);
  has({ ...b, features: [{ ...f, id: 'Upload Receipt' }, b.features[1]] }, /Feature "Upload Receipt": its id must be lower-case words joined by hyphens/);
  has({ ...b, features: [f, { ...b.features[1], id: 'upload-receipt' }] }, /Two features have the id "upload-receipt"/);
  has({ ...b, features: [{ ...f, roles: ['Accounts'] }, b.features[1]] }, /Feature "upload-receipt" is used by "Accounts", which is not one of the roles/);
  has({ ...b, features: [{ ...f, data: ['Invoice'] }, b.features[1]] }, /Feature "upload-receipt" uses "Invoice", which is not one of the records/);
  has({ ...b, features: [{ ...f, acceptance: [] }, b.features[1]] }, /Feature "upload-receipt" has no worked examples/);
  has({ ...b, features: [{ ...f, acceptance: [{ given: 'a receipt is uploaded', when: 'the manager opens it', then: 'it works correctly' }] }, b.features[1]] }, /^Feature "upload-receipt", example 1: "works correctly" cannot be checked by a test/);
});

test('outputs, modules and integrations must agree with the policy', () => {
  const b = validBrief();
  has({ ...b, outputs: [{ ...b.outputs[0], format: 'pdf' }] }, /Output "Monthly expenses report" is a PDF, so the modules must include pdf-export/);
  has({ ...b, modules: ['ocr'] }, /Output "Monthly expenses report" is a spreadsheet, so the modules must include xlsx-export/);
  has({ ...b, outputs: [{ ...b.outputs[0], format: 'fax' }] }, /Output "Monthly expenses report": the format must be screen, pdf, xlsx, csv or email, not "fax"/);
  has({ ...b, modules: ['ocr', 'xlsx-export', 'payments'] }, /"payments" is not an optional module the foundation has \(ocr, pdf-export, xlsx-export, scheduled-jobs\)/);
  has({ ...b, integrations: [{ name: 'Xero', purpose: 'Send approved claims', dataSent: 'Claim totals' }] }, /The brief connects to "Xero", but the data policy does not allow any outside service by that name/);
  assert.deepEqual(problems({ ...b, integrations: [{ name: 'Xero', purpose: 'Send approved claims', dataSent: 'Claim totals' }], policy: { ...b.policy, outbound: ['xero'] } }), []);
});

test('the data policy profile (spec §6)', () => {
  has(validBrief({ policy: undefined }), /The brief has no data policy/);
  has(withPolicy({ hosting: 'aws' }), /Hosting must be client-box \(the client's own computer\) or operator-server \(a server you run\), not "aws"/);
  has(withPolicy({ residency: 'us' }), /Data residency must be uk, uk-eu or any, not "us"/);
  has(withPolicy({ outbound: 'none' }), /"outbound" must be a list of the outside services data may go to \(an empty list means none\)/);
  has(withPolicy({ retention: { text: '', days: null } }), /does not say how long records are kept/);
  has(withPolicy({ retention: { text: 'six years', days: 0 } }), /retention days must be a whole number from 1 to 36500, or null when not known/);
  has(withPolicy({ backupDestination: { kind: 'usb', detail: 'x' } }), /backup destination must be client-owned, operator-run or cloud-bucket, not "usb"/);
  has(withPolicy({ operatorAccess: false }), /The client has not accepted your remote access for support \(operatorAccess must be true\)\. The factory cannot take on a job without it\./);
  has(withPolicy({ backupDestination: { kind: 'cloud-bucket', detail: 's3://backup:Sup3rSecretPass@bucket.example' } }), /seems to contain a password or key \(at policy → backupDestination → detail\)\. Briefs must never hold credentials: remove it/);
  has(validBrief({ assumptions: ['The admin password: hunter2hunter2'] }), /seems to contain a password or key \(at assumptions → 1\)/);
});

test('stages: draft tolerates unknowns only while questions are open', () => {
  const q = [{ id: 'q1', question: 'Where should backups go?', why: 'Backups must never stay only on the same box' }];
  const unknownPolicy = withPolicy({ hosting: null, backupDestination: null });
  const unknownExamples = validBrief({ features: validBrief().features.map((f) => ({ ...f, acceptance: [] })) });
  assert.deepEqual(problems({ ...unknownPolicy, openQuestions: q }, 'draft'), []);
  assert.deepEqual(problems({ ...unknownExamples, openQuestions: q }, 'draft'), []);
  has(unknownPolicy, /Hosting must be/, 'draft'); // no open questions → nothing excuses the gap
  has({ ...validBrief(), openQuestions: q }, /There is still 1 open question; the brief can't be approved until it is answered/);
  has({ ...validBrief(), openQuestions: [...q, { ...q[0], id: 'q2' }] }, /There are still 2 open questions/);
  has({ ...validBrief({ features: [{ ...validBrief().features[0], acceptance: [{ given: 'x', when: 'y', then: 'z' }] }] }), openQuestions: q }, /example 1/, 'draft');
  has(approvedBrief({ approvedAt: 'yesterday' }), /has not been approved/, 'approved');
  has(approvedBrief({ version: 0 }), /version number/, 'approved');
  assert.throws(() => validateBrief(validBrief(), { stage: 'final' }), /stage must be draft, ready or approved/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/factory-brief-validate.test.js`
Expected: FAIL with `Cannot find module '…/src/factory/brief.js'`.

- [ ] **Step 4: Implement the constants, `cleanText` and `normalizeBrief` in `src/factory/brief.js`**

- Constants:
  - `BRIEF_SCHEMA = 1`;
  - `ROLE_MAPS = ['admin','manager','member']`;
  - `MODULES = ['ocr','pdf-export','xlsx-export','scheduled-jobs']`;
  - `OUTPUT_FORMATS = ['screen','pdf','xlsx','csv','email']`;
  - `HOSTING = ['client-box','operator-server']`;
  - `RESIDENCY = ['uk','uk-eu','any']`;
  - `BACKUP_KINDS = ['client-owned','operator-run','cloud-bucket']`;
  - `LIMITS = Object.freeze({ short: 200, text: 2000, list: 50, features: 60, examples: 20, questions: 12 })`.
- `cleanText(value, max)`:
  - a non-string gives `undefined`;
  - remove ANSI CSI/OSC sequences (`/\x1b\[[0-?]*[ -/]*[@-~]/g`, `/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g`), then any remaining `[\x00-\x08\x0b-\x1f\x7f-\x9f]` and the bidi controls `[‪-‮⁦-⁩‎‏]`;
  - trim;
  - if longer than `max`, cut to `max - 1` characters and append `…`.
- `normalizeBrief(raw)` never throws. A non-object becomes `{}`.
  - The output always has `schema: 1`.
  - Short fields (names, ids, titles, `mapsTo`, `format`, enum values, `client`) use `cleanText(v, LIMITS.short)`. Long fields (`purpose`, `story`, `whatTheyDo`, `sees`, `description`, `given`/`when`/`then`, `retention.text`, `detail`, `question`, `why`, assumptions) use `LIMITS.text`.
  - Arrays keep only plain-object (or string, for string lists) entries, capped at `LIMITS.list`, `LIMITS.features` for features, `LIMITS.examples` per feature and `LIMITS.questions` for `openQuestions`.
  - A value of the wrong type is **omitted** (not coerced), so the validator reports it missing. A key absent from the input stays absent: nothing is invented, which is why the clean fixture round-trips unchanged.
  - Booleans (`holdsFiles`, `personalData`, `operatorAccess`) are kept only when `typeof === 'boolean'`.
  - `retention.days` is kept only when it is a number or `null`.
  - Policy enum fields keep a string or `null`.
  - Build every object as a fresh literal with only the listed keys, so `__proto__` and unknown keys can never be copied.

- [ ] **Step 5: Implement `validateBrief(obj, { stage = 'ready' } = {})`**

Collect every problem in this order:

1. identity and kind;
2. roles;
3. records;
4. features (with `exampleProblems(ex, \`Feature "${id}", example ${n}\`)`);
5. outputs and modules;
6. integrations;
7. policy;
8. credentials;
9. assumptions and open questions;
10. the `approved` stage checks.

Return `{ ok: problems.length === 0, problems }`. An unknown stage throws `validateBrief: stage must be draft, ready or approved`.

The message wording must match the tests. The others:
- **Purpose:** `The purpose is too short: one paragraph saying what the app is for (at least 40 characters).` Purpose must be at least 40 characters.
- **Roles:** `The brief has no roles: say who will use the app.`
- **Records:** `The brief lists no records: say what the app stores (for example claims, receipts, customers).`
- **Features:** `The brief has no features.`
- **Feature examples:** `Feature "${id}" has no worked examples: add at least one given / when / then with real figures.`
- **Missing policy:** `The brief has no data policy: hosting, where data may go, residency, retention, backups and operator access.`

Enum fields that are missing or `null` use the same sentence as a wrong value, ending `; the brief does not say.` instead of `, not "…".`. For example: `Hosting must be client-box (the client's own computer) or operator-server (a server you run); the brief does not say.` The retention message is `The data policy does not say how long records are kept (retention).`

Credential sniff:
- walk every string with a path such as `policy → backupDestination → detail` or `assumptions → 1` (array positions 1-based);
- it is a problem if the string matches any of:
  - `/[a-z][a-z0-9+.-]*:\/\/[^\s\/:@]+:[^\s\/@]+@/i`;
  - `/-----BEGIN [A-Z ]*PRIVATE KEY-----/`;
  - `/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/`;
  - `/\bAKIA[0-9A-Z]{16}\b/`;
  - `/\b(password|passwd|secret|api[ _-]?key|token)\b\s*[:=]\s*\S{6,}/i`;
- it is also a problem if the string contains any value from `secretValues()`;
- report at most 3 credential problems.

Draft leniency (Ruling 6), only when `stage === 'draft'` **and** `openQuestions` is non-empty:
- `policy.hosting`, `residency`, `retention`, `backupDestination` and `operatorAccess` may be `null` or absent;
- a feature's `acceptance` may be `[]`.

Open questions:
- each needs `id`, `question` and `why` (`Open question ${n} is missing its question or why it matters.`);
- at `ready` or `approved`, any open question is a problem. Use the exact singular/plural wording in the test.

The `approved` stage also needs:
- `slug` passing `validateSlug`;
- `version` an integer ≥ 1 (`The brief has no valid version number.`);
- `approvedAt` a string where `Date.parse` is finite and `new Date(x).toISOString() === x`;
- `approvedBy` a non-empty string;

otherwise `The brief has not been approved by the operator (approvedAt / approvedBy are missing or invalid).`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/factory-brief-validate.test.js && npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/factory/brief.js test/helpers/briefFixtures.js test/factory-brief-validate.test.js
git commit -m "feat(factory): brief schema, defensive normalisation and plain-English validator (Contract 2)"
```
