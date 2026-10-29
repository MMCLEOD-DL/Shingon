# Task 2: Worked examples (concreteness and ids) and outside services

Spec §4.1 **[call]**: the brief carries acceptance examples, concrete worked cases that Plan 8 turns into tests before any feature code is written. A vague example ("it works correctly") cannot become a test. This task is the deterministic check (Ruling 7). The validator (Task 3) uses it, and the author prompt (Task 5) quotes its rules, so the model is told exactly what will be rejected.

It also builds the two other pieces of Contract 7 §7.4 that live beside it:
- **example ids** (Ruling 15): every example gets `id: '<featureId>#<n>'` when the brief is approved, keeps it on a revision while its words are unchanged, and an `n` is never reused. `acceptanceIds(brief)` and `testTag(id)` are the shared readers Plans 8, 9 and 12 import (moved here from Plan 8's `split.js` and Plan 9's `council/project.js`);
- **outside services** (`src/factory/outbound.js`): `policy.outbound` holds ids from `OUTBOUND_SERVICES`, never free text, so Plans 9 and 10 can match on ids and hosts.

**Files:**
- Create: `src/factory/acceptance.js`, `src/factory/outbound.js`
- Test: `test/factory-acceptance.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `EXAMPLE_RULES_TEXT: string` and `exampleProblems(example, where) -> string[]`. `where` is a plain label such as `Feature "upload-receipt", example 1`. Every problem starts with `${where}: `;
  - `EXAMPLE_ID_RE`, `assignExampleIds(brief, base = null) -> brief`, `acceptanceIds(brief) -> AcceptanceRef[]`, `testTag(id) -> '[<id>]'`;
  - `OUTBOUND_SERVICES`, `outboundProblems(ids) -> string[]`.

- [ ] **Step 1: Write the failing tests** in `test/factory-acceptance.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleProblems, EXAMPLE_RULES_TEXT, assignExampleIds, acceptanceIds, testTag, EXAMPLE_ID_RE } from '../src/factory/acceptance.js';
import { OUTBOUND_SERVICES, outboundProblems } from '../src/factory/outbound.js';

const W = 'Feature "x", example 1';
const ok = (ex) => assert.deepEqual(exampleProblems(ex, W), [], JSON.stringify(ex));
const bad = (ex, re) => {
  const p = exampleProblems(ex, W);
  assert.ok(p.some((m) => re.test(m)), `${JSON.stringify(ex)} → ${JSON.stringify(p)}`);
  assert.ok(p.every((m) => m.startsWith(`${W}: `)));
};

test('concrete examples pass', () => {
  ok({ given: 'a member uploads a £12.40 receipt with £2.07 VAT dated 3 March 2026, category Travel', when: 'the manager opens the March report', then: 'the receipt appears under Travel with net £10.33 and VAT £2.07' });
  ok({ given: 'Alice and Bob are both Staff', when: "Alice opens the address of one of Bob's claims", then: 'she sees the message “You can’t see this claim” and none of his details' });
  ok({ given: 'Finance is signed in', when: 'she exports the March 2026 claims', then: 'the file is called "expenses-2026-03.xlsx"' });
  ok({ given: 'a claim was rejected by the manager', when: 'the member opens it', then: 'it is marked Rejected with the reason the manager typed' });
  ok({ given: 'a claim is waiting for approval', when: 'the manager approves it on a Friday', then: 'friday payroll includes it' }); // weekday anchor, any case
});

test('the parts must all be there, long enough, and free of placeholders', () => {
  bad({ given: 'a receipt', then: 'the total shows £5.00' }, /needs "given", "when" and "then"/);
  bad(null, /needs "given", "when" and "then"/);
  bad({ given: 'x', when: 'the manager looks', then: 'the total shows £5.00' }, /the "given" part is too short to check \("x"\)/);
  bad({ given: 'a receipt, a mileage claim etc.', when: 'the manager looks', then: 'the total shows £5.00' }, /the "given" part still has a placeholder \("etc"\)/);
  bad({ given: 'a receipt for TBD pounds', when: 'the manager looks', then: 'the total shows £5.00' }, /placeholder \("TBD"\)/);
  bad({ given: 'a receipt is uploaded', when: 'the manager looks…', then: 'the total shows £5.00' }, /the "when" part still has a placeholder/);
  bad({ given: 'a receipt is uploaded', when: 'the manager looks', then: 'x'.repeat(601) }, /the "then" part is too long/);
});

test('the result must say exactly what happens', () => {
  bad({ given: 'a receipt is uploaded', when: 'the manager opens the report', then: 'the totals are right' }, /the result \("then …"\) does not say exactly what should happen\. Give a figure, a name, a date or the exact words shown/);
  bad({ given: 'a receipt is uploaded', when: 'the manager opens the report', then: 'the report works correctly' }, /"works correctly" cannot be checked by a test\. Say what the person sees or what number comes out/);
  bad({ given: 'Bob uploads a receipt', when: 'the manager opens the report', then: 'it is shown to Bob as expected' }, /"as expected" cannot be checked by a test/);
  bad({ given: 'a receipt is uploaded', when: 'the manager opens it', then: 'the receipt is handled. It is saved' }, /does not say exactly what should happen/); // "It" starts a sentence: not a name
});

test('the rules text the author sees names every rule', () => {
  for (const s of ['given', 'when', 'then', 'placeholder', 'a figure, a name, a date or the exact words', 'works correctly', '£12.40']) {
    assert.ok(EXAMPLE_RULES_TEXT.includes(s), s);
  }
});

// Example ids (Contract 7 §7.4). The briefs here carry only what assignExampleIds reads.
const A = { given: 'Alice is signed in as Staff', when: 'she uploads a £12.40 receipt dated 3 March 2026', then: 'her list shows Travel £12.40' };
const B = { given: 'Bob is signed in as Staff', when: 'he uploads a £5.00 parking receipt', then: 'his list shows Parking £5.00' };
const C = { given: "Alice's £12.40 claim was approved in March 2026", when: 'Finance downloads the March report', then: 'the Travel row shows £12.40' };
const C2 = { ...C, then: 'the Travel row shows net £10.33 and VAT £2.07' };
const D = { given: 'Alice is signed in as Staff', when: 'she uploads a receipt with no amount', then: 'she sees "Please enter the amount"' };
const briefOf = (map) => ({ features: Object.entries(map).map(([id, acceptance]) => ({ id, title: `Title of ${id}`, acceptance })) });
const ids = (b) => b.features.flatMap((f) => f.acceptance.map((e) => e.id));

test('example ids: assigned at approval, kept on revision, an n is never reused', () => {
  const draft = briefOf({ 'upload-receipt': [A, B], 'monthly-report': [C] });
  const v1 = assignExampleIds(draft);
  assert.deepEqual(ids(v1), ['upload-receipt#1', 'upload-receipt#2', 'monthly-report#1']);
  assert.deepEqual(v1.exampleSeq, { 'upload-receipt': 2, 'monthly-report': 1 });
  assert.equal(draft.features[0].acceptance[0].id, undefined, 'pure: the input is not changed');

  // Revision: B removed, A unchanged (moved after a new D, extra spaces ignored), C reworded.
  const v2 = assignExampleIds(briefOf({ 'upload-receipt': [D, { ...A, when: `  ${A.when}  ` }], 'monthly-report': [C2] }), v1);
  assert.deepEqual(ids(v2), ['upload-receipt#3', 'upload-receipt#1', 'monthly-report#2']);
  assert.deepEqual(v2.exampleSeq, { 'upload-receipt': 3, 'monthly-report': 2 });

  // B comes back: it is new to v2, so it takes #4, never #2 again. A feature dropped and re-added keeps counting.
  const v3 = assignExampleIds(briefOf({ 'upload-receipt': [A, B] }), v2);
  assert.deepEqual(ids(v3), ['upload-receipt#1', 'upload-receipt#4']);
  assert.deepEqual(v3.exampleSeq, { 'upload-receipt': 4, 'monthly-report': 2 });
  const v4 = assignExampleIds(briefOf({ 'upload-receipt': [A], 'monthly-report': [C2] }), v3);
  assert.deepEqual(ids(v4), ['upload-receipt#1', 'monthly-report#3']);

  // Ids a model sneaks in are ignored: Conductor numbers examples itself.
  assert.deepEqual(ids(assignExampleIds(briefOf({ 'upload-receipt': [{ ...A, id: 'upload-receipt#99' }] }))), ['upload-receipt#1']);
});

test('acceptanceIds and testTag read the stored ids', () => {
  const v1 = assignExampleIds(briefOf({ 'upload-receipt': [A, B], 'monthly-report': [C] }));
  assert.deepEqual(acceptanceIds(v1)[2], { id: 'monthly-report#1', featureId: 'monthly-report', n: 1, title: 'Title of monthly-report', example: { given: C.given, when: C.when, then: C.then } });
  assert.deepEqual(acceptanceIds(v1).map((a) => a.id), ['upload-receipt#1', 'upload-receipt#2', 'monthly-report#1']);
  assert.throws(() => acceptanceIds(briefOf({ 'upload-receipt': [A] })), /Feature "upload-receipt", example 1 has no valid id; only an approved brief carries example ids/);
  assert.equal(testTag('upload-receipt#2'), '[upload-receipt#2]');
  assert.throws(() => testTag('upload receipt'), /testTag: "upload receipt" is not an example id/);
  assert.ok(EXAMPLE_ID_RE.test('monthly-report#12') && !EXAMPLE_ID_RE.test('monthly-report#0'));
});

test('outside services: a fixed list of ids; unknown ids are refused', () => {
  assert.deepEqual(Object.keys(OUTBOUND_SERVICES), ['cloudflare-tunnel', 'azure-document-intelligence']);
  assert.deepEqual(OUTBOUND_SERVICES['cloudflare-tunnel'].hosts, ['*.cloudflare.com', '*.argotunnel.com']);
  assert.deepEqual(OUTBOUND_SERVICES['azure-document-intelligence'].hosts, ['*.cognitiveservices.azure.com']);
  for (const s of Object.values(OUTBOUND_SERVICES)) assert.ok(s.label && s.carries, JSON.stringify(s));
  assert.ok(Object.isFrozen(OUTBOUND_SERVICES) && Object.isFrozen(OUTBOUND_SERVICES['cloudflare-tunnel']));
  assert.deepEqual(outboundProblems([]), []);
  assert.deepEqual(outboundProblems(['cloudflare-tunnel', 'azure-document-intelligence']), []);
  assert.match(outboundProblems('none')[0], /"outbound" must be a list of the outside services data may go to \(an empty list means none\)/);
  assert.match(outboundProblems(['Xero'])[0], /"Xero" is not an outside service Conductor knows \(known: cloudflare-tunnel, azure-document-intelligence\)/);
  assert.match(outboundProblems(['cloudflare-tunnel', 'cloudflare-tunnel'])[0], /"cloudflare-tunnel" is listed twice/);
  assert.match(outboundProblems([42])[0], /42 is not an outside service Conductor knows/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-acceptance.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement the concreteness check in `src/factory/acceptance.js`**

Rules, in this order, collecting every problem that applies:

1. `example` is not a plain object, or any of `given`, `when` or `then` is not a non-empty string after trimming → the single problem `${where}: it needs "given", "when" and "then", each in plain words.` Return it straight away.
2. For each part:
   - shorter than 8 characters (trimmed) → `the "${part}" part is too short to check ("${value}").`;
   - longer than 600 → `the "${part}" part is too long (keep each part under 600 characters).`
3. Placeholder in any part. The regex is `/\b(tbd|tbc|todo|etc|lorem ipsum|xxx|and so on)\b|\.\.\.|…|\?\?/i`. The problem is `the "${part}" part still has a placeholder ("${match}"). Replace it with the real detail.`, quoting the match exactly as written (`etc`, `TBD`, `…`).
4. Vague outcome in `then`. Regex:

   ```js
   /\b(works?|working|behaves?) (correctly|properly|fine|as expected)\b|\bas expected\b|\b(correctly|properly|appropriately|successfully) (handled|processed|shown|displayed|saved)\b|\bis handled\b/i
   ```

   The problem is `"${match}" cannot be checked by a test. Say what the person sees or what number comes out.`, quoting the first match only, lower-cased.
5. Anchor in `then`. When `then` has none, the problem is `the result ("then …") does not say exactly what should happen. Give a figure, a name, a date or the exact words shown, e.g. "then March's report shows Travel: £12.40".` An anchor is any of:
   - a digit;
   - quoted text: `"…"`, `“…”` or `‘…’` with at least 2 characters inside, or `'…'` opened at the start or after whitespace;
   - a month or weekday name, matched case-insensitively on word boundaries;
   - a capitalised word (`/^[A-Z][A-Za-z'’]*$/` once trailing punctuation is stripped, at least 2 letters, not `I`) that is not the first word and does not follow `.`, `!`, `?` or `:`.

`EXAMPLE_RULES_TEXT` is a short bulleted block for the prompt. Use this exact copy:

```
Worked examples ("acceptance") are checked by Conductor before you see them again:
- Each example has "given", "when" and "then", each a full plain-English phrase.
- No placeholder words: TBD, TBC, TODO, etc, "and so on", "...", lorem ipsum.
- "then" must say exactly what happens: a figure, a name, a date or the exact words shown on screen.
- Never write outcomes such as "works correctly", "as expected" or "is handled".
- Good: given a member uploads a £12.40 receipt with £2.07 VAT dated 3 March 2026, category Travel; when the manager opens the March report; then the receipt appears under Travel with net £10.33 and VAT £2.07.
- If you need real figures or names from the client to write an example, ask the operator for them as an open question.
```

- [ ] **Step 4: Implement example ids in `src/factory/acceptance.js`**

- `EXAMPLE_ID_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)#([1-9]\d{0,3})$/`.
- `assignExampleIds(brief, base = null)` is pure and returns a new brief:
  - `seq` starts as a copy of `base?.exampleSeq ?? {}`, raised (never lowered) to the highest `n` among `base`'s stored ids, so a damaged counter cannot cause reuse;
  - for each feature, in order, `pool` is the base feature with the same `id` (if any): its examples that carry a valid id, keyed by `given|when|then` with each part trimmed and inner whitespace collapsed to one space;
  - for each example, any incoming `id` is ignored. If its key is in `pool` and that id is not yet used in this feature, it keeps that id. Otherwise `seq[featureId] = (seq[featureId] ?? 0) + 1` and the id is `${featureId}#${seq[featureId]}`;
  - each example is rebuilt as `{ id, given, when, then }`; the brief gets `exampleSeq: seq`. Counters for features no longer in the brief stay in `seq`, which is what stops a re-added feature reusing a number.
- `acceptanceIds(brief)`: for each feature in order, each example at position `k` (1-based) must have an `id` matching `EXAMPLE_ID_RE` whose feature part equals the feature's `id`; otherwise throw `acceptanceIds: Feature "${featureId}", example ${k} has no valid id; only an approved brief carries example ids.` Returns `{ id, featureId, n, title: feature.title, example: { given, when, then } }` (`n` from the id, not the position). This is the one shape Plans 8, 9 and 12 use.
- `testTag(id)`: `[${id}]` when `EXAMPLE_ID_RE` matches, else throw `testTag: "${id}" is not an example id`. A test proves an example by putting this tag in its title (Contract 7 §7.4).

- [ ] **Step 5: Implement `src/factory/outbound.js`**

- `OUTBOUND_SERVICES` is deep-frozen, in this order:
  - `'cloudflare-tunnel': { label: 'Cloudflare Tunnel', hosts: ['*.cloudflare.com', '*.argotunnel.com'], carries: "the app's web traffic" }`;
  - `'azure-document-intelligence': { label: 'Azure Document Intelligence', hosts: ['*.cognitiveservices.azure.com'], carries: 'receipt images' }`.
  
  A later plan that needs a new service adds its id here (Contract 7 §7.4); nothing else in the factory keeps a list of services.
- `outboundProblems(ids)`:
  - not an array → the single problem `"outbound" must be a list of the outside services data may go to (an empty list means none).`;
  - each entry that is not a string or not an own key of `OUTBOUND_SERVICES` → `${JSON.stringify(id)} is not an outside service Conductor knows (known: ${Object.keys(OUTBOUND_SERVICES).join(', ')}). Leave it out, or have it added to Conductor's list first.` (a string shows in quotes, `42` shows bare);
  - an id listed more than once → `"${id}" is listed twice in "outbound".` (once per id).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/factory-acceptance.test.js && npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/factory/acceptance.js src/factory/outbound.js test/factory-acceptance.test.js
git commit -m "feat(factory): concrete worked examples, stable example ids and the outside-services list" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
