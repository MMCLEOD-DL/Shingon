# Task 4: Render, versioned save, load

This task completes Contract 2: `renderBrief`, the Markdown the operator reads and approves, and `loadBrief`, the one way later plans read the approved brief. It also adds the versioned, crash-safe save that sits between them (Ruling 5).

**Files:**
- Modify: `src/factory/brief.js` (append)
- Test: `test/factory-brief-store.test.js`

**Interfaces:**
- Consumes: `validateBrief` (Task 3); `testTag` (Task 2); `OUTBOUND_SERVICES` (Task 2); `writeFileAtomic`, `writeJsonAtomic`, `createFileExclusive` (Task 1); fixtures (Task 3).
- Produces: `ukDate`, `renderBrief`, `briefPaths`, `nextVersion`, `saveApprovedBrief`, `loadBrief`, `currentBriefInfo` (signatures in the index).
  - `briefPaths(projectDir)` returns:
    - `dir` = `<p>/brief`;
    - `current` = `<p>/brief/current.json`;
    - `session` = `<p>/brief/session.json`;
    - `draftMd` = `<p>/brief/draft.md`;
    - `logs` = `<p>/brief/logs`;
    - `json(v)` = `<p>/brief/brief-v${v}.json` and `md(v)` = `<p>/brief/brief-v${v}.md`.
  - The `current.json` pointer is `{ schema: 1, version, json: 'brief-vN.json', md: 'brief-vN.md', sha256, approvedAt, approvedBy }`, where `sha256` is the hex digest of the exact bytes written to `brief-vN.json`.

- [ ] **Step 1: Write the failing tests** in `test/factory-brief-store.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderBrief, ukDate, briefPaths, nextVersion, saveApprovedBrief, loadBrief, currentBriefInfo } from '../src/factory/brief.js';
import { validBrief, approvedBrief } from './helpers/briefFixtures.js';

const project = () => { const d = mkdtempSync(path.join(tmpdir(), 'brief-')); mkdirSync(path.join(d, 'brief')); return d; };

test('ukDate', () => {
  assert.equal(ukDate('2026-10-27T10:00:00.000Z'), '27 October 2026');
  assert.equal(ukDate('nonsense'), 'an unknown date');
});

test('renderBrief: plain UK English, policy first, every section', () => {
  const md = renderBrief(approvedBrief());
  for (const line of [
    '# Brief: Thistle Joinery Ltd',
    'Version 1 · approved by Malcolm on 27 October 2026',
    '## What the app is for',
    '## Data policy',
    "- **Hosting:** on the client's own computer (a box on their network)",
    '- **Where data may go:** nowhere outside the app',
    '- **Data residency:** UK only',
    '- **Retention:** Claims and receipts are kept for 6 years, then deleted (2190 days)',
    "- **Backups:** client-owned storage: A USB disk kept in the client's office safe",
    '- **Operator access:** the client accepts that you can reach the app remotely to support it',
    '## Who uses it',
    '| Staff | Upload receipts and claim them back | Only their own claims | member |',
    '## What it stores',
    '- **Claim:** One receipt claimed back by one person (holds files; personal data)',
    '## Features',
    '### 1. Upload a receipt (`upload-receipt`)',
    '- Used by: Staff',
    '  - [upload-receipt#1] Given Alice is signed in as Staff, when she uploads a £12.40 receipt with £2.07 VAT dated 3 March 2026, category Travel, then her claims list shows Travel £12.40 dated 3 March 2026, status Waiting.',
    '## Reports, exports and emails',
    '- **Monthly expenses report** (spreadsheet, for Finance): Approved claims for one month, one row per claim, totals by category',
    '## Outside systems',
    'None.',
    '## Optional modules',
    '- Reading receipts automatically (OCR)',
    '## Assumptions to check',
    '- All receipts are in pounds sterling',
    'This file is a copy for reading. Conductor builds from brief-v1.json.',
  ]) assert.ok(md.includes(line), `missing: ${line}\n---\n${md}`);
  assert.ok(md.indexOf('## Data policy') < md.indexOf('## Who uses it'));
  assert.equal(md.includes('## Open questions'), false);
});

test('renderBrief: drafts, open questions, table-safe cells, outbound list, determinism', () => {
  const d = validBrief({
    openQuestions: [{ id: 'q1', question: 'Where should backups go?', why: 'Never only on the same box' }],
    roles: [{ ...validBrief().roles[0], whatTheyDo: 'Upload | claim\nreceipts' }, ...validBrief().roles.slice(1)],
    policy: { ...validBrief().policy, outbound: ['cloudflare-tunnel', 'azure-document-intelligence'], hosting: null },
  });
  const md = renderBrief(d);
  assert.ok(md.includes('Draft: not yet approved'));
  assert.ok(md.includes('## Open questions\n\n1. Where should backups go? (Why it matters: Never only on the same box)'));
  assert.ok(md.includes('| Upload \\| claim receipts |'));
  assert.ok(md.includes("- **Where data may go:** only to Cloudflare Tunnel (carries the app's web traffic); Azure Document Intelligence (carries receipt images)"));
  assert.ok(md.includes('  - Given Alice is signed in as Staff, when'), 'a draft has no example ids yet, so no tag');
  assert.ok(md.includes('- **Hosting:** not decided yet'));
  assert.equal(renderBrief(d), md);
});

test('save → load round trip; pointer with fingerprint; numbers never reused or overwritten', () => {
  const p = project();
  assert.equal(nextVersion(p), 1);
  assert.equal(currentBriefInfo(p), null);
  assert.throws(() => loadBrief(p), /There is no approved brief for this project yet\. Make one with: conductor brief <slug> --notes <file>/);
  const r1 = saveApprovedBrief(p, approvedBrief());
  assert.deepEqual(r1, { version: 1, jsonPath: briefPaths(p).json(1), mdPath: briefPaths(p).md(1) });
  assert.deepEqual(loadBrief(p), approvedBrief());
  const ptr = JSON.parse(readFileSync(briefPaths(p).current, 'utf8'));
  assert.deepEqual(Object.keys(ptr).sort(), ['approvedAt', 'approvedBy', 'json', 'md', 'schema', 'sha256', 'version']);
  assert.match(ptr.sha256, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(r1.mdPath, 'utf8'), renderBrief(approvedBrief()));
  assert.deepEqual(currentBriefInfo(p), { version: 1, approvedAt: '2026-10-27T10:00:00.000Z', approvedBy: 'Malcolm' });

  writeFileSync(briefPaths(p).json(2), '{"left": "by a crash"}'); // written, pointer never moved
  assert.equal(nextVersion(p), 3);
  assert.throws(() => saveApprovedBrief(p, approvedBrief({ version: 2 })), /Brief version 2 already exists/);
  assert.equal(loadBrief(p).version, 1, 'the pointer did not move');
  const r3 = saveApprovedBrief(p, approvedBrief({ version: 3, revisedFrom: 1 }));
  assert.equal(r3.version, 3);
  assert.equal(loadBrief(p).revisedFrom, 1);
});

test('saveApprovedBrief refuses an unapproved or invalid brief and writes nothing', () => {
  const p = project();
  assert.throws(() => saveApprovedBrief(p, validBrief({ slug: 'thistle', version: 1 })), /cannot be saved as approved: The brief has not been approved/);
  assert.equal(existsSync(briefPaths(p).json(1)), false);
  assert.equal(existsSync(briefPaths(p).current), false);
});

test('loadBrief refuses tampering, traversal in the pointer and invalid content', () => {
  const p = project();
  saveApprovedBrief(p, approvedBrief());
  const f = briefPaths(p).json(1);
  writeFileSync(f, readFileSync(f, 'utf8').replace('£12.40', '£99.99'));
  assert.throws(() => loadBrief(p), /brief-v1\.json has changed since it was approved \(its fingerprint does not match\)\. Conductor will not use it/);
  assert.match(currentBriefInfo(p).broken, /fingerprint/);

  const q = project();
  writeFileSync(briefPaths(q).current, JSON.stringify({ schema: 1, version: 1, json: '../../etc/passwd', md: 'x.md', sha256: 'a'.repeat(64) }));
  assert.throws(() => loadBrief(q), /The brief pointer \(current\.json\) is damaged/);
  writeFileSync(briefPaths(q).current, '{broken');
  assert.throws(() => loadBrief(q), /The brief pointer \(current\.json\) is damaged/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-brief-store.test.js`
Expected: FAIL with `renderBrief is not a function` (or a missing export).

- [ ] **Step 3: Implement `ukDate` and `renderBrief`**

- `ukDate(iso)`:
  - uses `new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })`;
  - returns `'an unknown date'` for an invalid date.
- `renderBrief(brief)` is pure and deterministic: no clock, no environment.
- Sections, in this order, each separated by a blank line:
  1. Title.
  2. Status line:
     - when approved: `Version ${v} · approved by ${by} on ${ukDate}`;
     - otherwise: `Draft: not yet approved`, plus ` (will become version ${v})` when `version` is set.
  3. `## What the app is for`.
  4. `## Data policy`, with these plain words:
     - hosting: `client-box` → `on the client's own computer (a box on their network)`; `operator-server` → `on a server you run for the client`;
     - residency: `uk` → `UK only`; `uk-eu` → `UK and EU`; `any` → `anywhere`;
     - a null field → `not decided yet`;
     - empty outbound → `nowhere outside the app`; otherwise `only to ` + each id as `${label} (carries ${carries})` from `OUTBOUND_SERVICES`, joined with `; `. An id that is not in the list (only possible in a draft) shows as `${id} (not a service Conductor knows)`;
     - backups: kind → `client-owned storage` / `storage you run` / `a cloud storage bucket`, then `: ${detail}`;
     - operator access: true → the sentence in the test;
     - retention: the text, plus ` (${days} days)` when `days` is set.
  5. `## Who uses it`: the table header `| Role | What they do | What they can see | Foundation role |` then `|---|---|---|---|`.
  6. `## What it stores`: flags in brackets, `holds files` and `personal data`, joined with `; `, and the brackets omitted when there are neither.
  7. `## Features`: `### ${n}. ${title} (\`${id}\`)`, then the story, then `- Used by:` and `- Uses:` lines, then `- Worked examples:` with each example as `  - Given ${given}, when ${when}, then ${then}.`, without doubling a trailing full stop. When the example has an `id` (an approved brief, or the copy shown for approval in Task 7), the line starts `  - ${testTag(id)} Given …`, so the operator sees the same tag the tests will carry.
  8. `## Reports, exports and emails`: format words `on screen`, `PDF`, `spreadsheet`, `CSV file`, `email`.
  9. `## Outside systems`: `None.` when empty, else `- **${name}:** ${purpose} (sends: ${dataSent} to ${label})`, where `label` comes from `OUTBOUND_SERVICES[service]` (the raw `service` text when unknown).
  10. `## Optional modules`: `ocr` → `Reading receipts automatically (OCR)`; `pdf-export` → `PDF reports`; `xlsx-export` → `Spreadsheet exports`; `scheduled-jobs` → `Scheduled jobs`. `None.` when empty.
  11. `## Assumptions to check`, only when non-empty.
  12. `## Open questions`, only when non-empty, numbered.
  13. Footer: `---` then `This file is a copy for reading. Conductor builds from brief-v${v}.json.` when `version` is set.
- Table cells:
  - newlines become spaces and `|` becomes `\|`;
  - inline fields everywhere collapse newlines to spaces;
  - long fields keep their paragraphs.
- Model text is already cleaned by `normalizeBrief`, so render does no further escaping beyond the table rules.

- [ ] **Step 4: Implement `briefPaths`, `nextVersion`, `saveApprovedBrief`, `loadBrief`, `currentBriefInfo`**

- `nextVersion`: the highest `N` among files matching `/^brief-v([1-9]\d{0,5})\.json$/` in `brief/`, plus one; 1 when none.
- `saveApprovedBrief(projectDir, brief)`:
  0. The version written is `v = brief.version`. The caller (Task 7) sets it from `nextVersion` before approval.
  1. Validate at stage `approved`. On failure, throw `This brief cannot be saved as approved: ${problems.slice(0, 3).join(' ')}`.
  2. `text = JSON.stringify(brief, null, 2) + '\n'`.
  3. `createFileExclusive(json(v), text)`. On `EEXIST`, throw `Brief version ${v} already exists; Conductor never overwrites an approved brief.`
  4. `writeFileAtomic(md(v), renderBrief(brief))`.
  5. `writeJsonAtomic(current, pointer)` **last**.
- `loadBrief(projectDir)`:
  - pointer missing → the "no approved brief yet" message;
  - pointer unreadable, wrong `schema`, `json` not matching `/^brief-v[1-9]\d{0,5}\.json$/`, or `sha256` not 64 hex characters → `The brief pointer (current.json) is damaged. Approve the brief again with conductor brief <slug> --revise --notes <file>.`;
  - read the file as a Buffer and compare its sha256 with the pointer. On a mismatch, throw the fingerprint message, which ends `Approve a new version with conductor brief <slug> --revise --notes <file>.`;
  - parse it and validate at `approved`. On failure, throw `The approved brief (v${version}) is not valid: ${first 3 problems}`;
  - return the parsed object.
- `currentBriefInfo(projectDir)`:
  - `null` when there is no pointer;
  - otherwise tries `loadBrief` and returns `{ version, approvedAt, approvedBy }`;
  - on any error returns `{ broken: e.message }`;
  - never throws.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/factory-brief-store.test.js && npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/factory/brief.js test/factory-brief-store.test.js
git commit -m "feat(factory): render, versioned save and fingerprinted load of approved briefs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
