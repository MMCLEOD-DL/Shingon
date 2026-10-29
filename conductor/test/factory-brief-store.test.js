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

test('renderBrief: a draft with null retention and backups shows "not decided yet" and does not crash', () => {
  const d = validBrief({ policy: { ...validBrief().policy, retention: null, backupDestination: null } });
  const md = renderBrief(d);
  assert.ok(md.includes('- **Retention:** not decided yet'));
  assert.ok(md.includes('- **Backups:** not decided yet'));
  const { retention, backupDestination, ...rest } = d.policy;
  assert.ok(renderBrief({ ...d, policy: rest }).includes('- **Retention:** not decided yet'));
});

test('loadBrief refuses a pointer whose version or file name does not match the brief', () => {
  const p = project();
  saveApprovedBrief(p, approvedBrief());
  const ptr = JSON.parse(readFileSync(briefPaths(p).current, 'utf8'));
  // The pointer says version 2 but names (and fingerprints) the version 1 file.
  writeFileSync(briefPaths(p).current, JSON.stringify({ ...ptr, version: 2 }));
  assert.throws(() => loadBrief(p), /The brief pointer \(current\.json\) does not match the brief it points to/);
  // A copy of version 1 saved as brief-v2.json, pointed at as version 2: the brief inside still says version 1.
  writeFileSync(briefPaths(p).json(2), readFileSync(briefPaths(p).json(1)));
  writeFileSync(briefPaths(p).current, JSON.stringify({ ...ptr, version: 2, json: 'brief-v2.json' }));
  assert.throws(() => loadBrief(p), /The brief pointer \(current\.json\) does not match the brief it points to/);
  // Version 1 pointing at the brief-v2.json copy: the file name is not the one for version 1.
  writeFileSync(briefPaths(p).current, JSON.stringify({ ...ptr, json: 'brief-v2.json' }));
  assert.throws(() => loadBrief(p), /The brief pointer \(current\.json\) does not match the brief it points to/);
  writeFileSync(briefPaths(p).current, JSON.stringify(ptr));
  assert.equal(loadBrief(p).version, 1);
});

test('an approved brief still loads when an environment secret appears in its text; saving still checks', () => {
  const key = 'CONDUCTOR_TEST_BRIEF_TOKEN';
  const text = "A USB disk kept in the client's office safe";
  const p = project();
  saveApprovedBrief(p, approvedBrief());
  const before = process.env[key];
  process.env[key] = text;
  try {
    assert.equal(loadBrief(p).version, 1, 'a brief approved in one environment loads in another');
    assert.equal(currentBriefInfo(p).version, 1);
    assert.throws(() => saveApprovedBrief(project(), approvedBrief()), /seems to contain a password or key/);
  } finally {
    if (before === undefined) delete process.env[key]; else process.env[key] = before;
  }
});
