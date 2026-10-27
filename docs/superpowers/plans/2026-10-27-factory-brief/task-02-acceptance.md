# Task 2: Concrete worked examples

Spec §4.1 **[call]**: the brief carries acceptance examples, concrete worked cases that Plan 8 turns into tests before any feature code is written. A vague example ("it works correctly") cannot become a test. This task is the deterministic check (Ruling 7). The validator (Task 3) uses it, and the author prompt (Task 5) quotes its rules, so the model is told exactly what will be rejected.

**Files:**
- Create: `src/factory/acceptance.js`
- Test: `test/factory-acceptance.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `EXAMPLE_RULES_TEXT: string` and `exampleProblems(example, where) -> string[]`. `where` is a plain label such as `Feature "upload-receipt", example 1`. Every problem starts with `${where}: `.

- [ ] **Step 1: Write the failing tests** in `test/factory-acceptance.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleProblems, EXAMPLE_RULES_TEXT } from '../src/factory/acceptance.js';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-acceptance.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/factory/acceptance.js`**

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-acceptance.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/acceptance.js test/factory-acceptance.test.js
git commit -m "feat(factory): deterministic check that worked examples are concrete"
```
