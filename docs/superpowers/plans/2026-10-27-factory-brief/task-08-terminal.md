# Task 8: Terminal prompts for the brief

This task adds the three terminal prompts the brief command needs. Like every other prompt, they fail closed: no terminal, or end of input, means "stop for now", and only `a` approves.

**Files:**
- Modify: `src/ui/terminal.js`
- Test: `test/terminal.test.js` (append only)

**Interfaces:**
- Consumes: the existing `prompt`, `ask`, `say`, `nextLine` and `bell` internals of `createTerminal`.
- Produces:
  - `NO_TTY_BRIEF` (exported);
  - three new methods on the object `createTerminal` returns, which match the `io` contract of Task 7:
    - `askBriefQuestion({ index, total, question, why }) -> { answer } | { skip: true } | { stop: true }`;
    - `approveBrief({ markdown, draftPath }) -> { decision: 'approve' } | { decision: 'change', note } | { decision: 'stop' }`;
    - `confirmDiscard({ slug }) -> boolean`.

- [ ] **Step 1: Write the failing tests.** Append to `test/terminal.test.js` (it already has the `term()` helper; its `isPrompt` treats a trailing `> ` or `(one line): ` as a question):

```js
import { NO_TTY_BRIEF } from '../src/ui/terminal.js';

test('askBriefQuestion: shows one question with why; free text, skip, stop; blank is asked again; EOF stops', async () => {
  const q = { index: 2, total: 4, question: 'Where should backups go?', why: 'Backups must never stay only on the same box' };
  const a = term({ answers: ['', '  A USB disk in their safe  '] });
  assert.deepEqual(await a.t.askBriefQuestion(q), { answer: 'A USB disk in their safe' });
  assert.match(a.text(), /Question 2 of 4: Where should backups go\?\n\(Why it matters: Backups must never stay only on the same box\)/);
  assert.match(a.text(), /Your answer \(or "skip" to leave it open, "stop" to finish for now\) > /);
  assert.match(a.text(), /Please type an answer, "skip" or "stop"\./);
  assert.deepEqual(await term({ answers: ['SKIP'] }).t.askBriefQuestion(q), { skip: true });
  assert.deepEqual(await term({ answers: ['stop'] }).t.askBriefQuestion(q), { stop: true });
  assert.deepEqual(await term({ answers: [] }).t.askBriefQuestion(q), { stop: true });
});

test('approveBrief: shows the brief and where it is saved; a / c with a note / s; EOF stops', async () => {
  const arg = { markdown: '# Brief: Thistle Joinery Ltd\n\nDraft: not yet approved', draftPath: '/p/thistle/brief/draft.md' };
  const a = term({ answers: ['x', 'a'] });
  assert.deepEqual(await a.t.approveBrief(arg), { decision: 'approve' });
  assert.match(a.text(), /=== The brief, ready for your approval ===\n# Brief: Thistle Joinery Ltd/);
  assert.match(a.text(), /A copy is saved at: \/p\/thistle\/brief\/draft\.md/);
  assert.match(a.text(), /\[a\] approve · \[c\] ask for changes · \[s\] stop for now > /);
  assert.match(a.text(), /Please type one of: a, c, s/);
  assert.deepEqual(await term({ answers: ['c', 'Call Finance "Accounts"'] }).t.approveBrief(arg), { decision: 'change', note: 'Call Finance "Accounts"' });
  assert.deepEqual(await term({ answers: ['c'] }).t.approveBrief(arg), { decision: 'stop' }, 'EOF at the note stops');
  assert.deepEqual(await term({ answers: ['s'] }).t.approveBrief(arg), { decision: 'stop' });
  assert.deepEqual(await term({ answers: [] }).t.approveBrief(arg), { decision: 'stop' });
});

test('brief prompts fail closed without a terminal; confirmDiscard needs a clear yes', async () => {
  const n = term({ answers: ['a'], isTTY: false });
  assert.deepEqual(await n.t.approveBrief({ markdown: '# B', draftPath: '/d' }), { decision: 'stop' });
  assert.deepEqual(await n.t.askBriefQuestion({ index: 1, total: 1, question: 'Q?', why: 'w' }), { stop: true });
  assert.ok(n.text().includes(NO_TTY_BRIEF));
  assert.match(NO_TTY_BRIEF, /There is no terminal to ask you, so the brief was not approved/);
  assert.equal(await term({ answers: ['y'] }).t.confirmDiscard({ slug: 'thistle' }), true);
  assert.equal(await term({ answers: ['n'] }).t.confirmDiscard({ slug: 'thistle' }), false);
  assert.equal(await term({ answers: [] }).t.confirmDiscard({ slug: 'thistle' }), false);
  assert.equal(await term({ answers: ['y'], isTTY: false }).t.confirmDiscard({ slug: 'thistle' }), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/terminal.test.js`
Expected: FAIL with `t.askBriefQuestion is not a function`.

- [ ] **Step 3: Implement in `src/ui/terminal.js`**

- `NO_TTY_BRIEF = 'There is no terminal to ask you, so the brief was not approved. Run Conductor in a terminal to answer its questions and approve the brief.'`
- Add a private free-text helper, `askText(promptText, { allowEmpty = false })`:
  - rings the bell once;
  - writes the prompt and reads `nextLine()`;
  - `null` means EOF, and returns `null`;
  - returns the line trimmed;
  - when the line is empty and `allowEmpty` is false, writes `Please type an answer, "skip" or "stop".\n` and asks again.
- Wrap each new method in the existing `prompt(...)`, so the live status pauses and type-ahead is drained.
- `askBriefQuestion`:
  - says `\nQuestion ${index} of ${total}: ${question}`, plus `\n(Why it matters: ${why})` when `why` is set;
  - without a TTY: says `NO_TTY_BRIEF` and returns `{ stop: true }`;
  - `askText` with the prompt in the test;
  - `null` → stop. Lower-cased `skip` → skip, and `stop` → stop. Anything else → `{ answer }`.
- `approveBrief`:
  - says `\n=== The brief, ready for your approval ===\n${markdown}\n\nA copy is saved at: ${draftPath}\n`;
  - without a TTY: `NO_TTY_BRIEF`, then stop;
  - `ask('[a] approve · [c] ask for changes · [s] stop for now > ', ['a', 'c', 's'])`;
  - for `c`, writes `What should change? (one line): ` and reads one line. EOF or an empty line → stop; otherwise `{ decision: 'change', note }`;
  - `null` (EOF) → stop.
- `confirmDiscard`:
  - says `\nThis throws away the unfinished brief for ${slug}. Your notes are kept.`;
  - without a TTY: says `There is no terminal to ask you, so nothing was thrown away.` and returns `false`;
  - `ask('[y] throw it away · [n] keep it > ', ['y', 'n'])` returns `=== 'y'`.
- Add all three to the returned object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/terminal.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/terminal.js test/terminal.test.js
git commit -m "feat(ui): terminal prompts for brief questions, approval and discarding a draft" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
