# Task 9: Terminal hooks

This task implements Plan 2's hook contract for a real terminal, using injectable streams so it can be tested.

**Hooks:**
- **`onEvent`** feeds the `StatusModel` and redraws the live block. On a TTY it redraws in place; otherwise it prints only lines it has not printed before.
- **`escalate`** shows the written recommendation and asks `[a] approve · [r] reject · [s] see details`.
- **`approveResult`** is the spec §8 final gate: `[v] view diff · [a] approve → new branch · [r] reject · [n] reject with a note`.
- **`approveChunk`** is the optional per-step approval.
- **`approvePlan`** is the optional plan approval (spec §8 stop point 1).

**Prompts:**
- Each prompt rings the terminal bell first, since local steps are slow and the user may have walked away (spec §8).
- **Without a TTY every prompt fails closed** (Review Focus 3). Escalations answer `reject`, the gate and per-step approvals answer `false`, and the user is told why.

**Files:**
- Create: `src/ui/terminal.js`, `test/terminal.test.js`

**Interfaces:**
- Consumes:
  - `StatusModel` (Task 8);
  - the hook payloads: `escalate(esc)` with `esc = { kind, title, message, options, transcript }` (Task 7 added `transcript`); `approveResult({ summary, files, tests, finalReview, diff })`; `approveChunk({ index, title, total, files, note, tests })`; `onEvent(entry)`.
- Produces:
  - `createTerminal({ input = process.stdin, output = process.stdout, isTTY = Boolean(input.isTTY && output.isTTY), bell = true, model = new StatusModel() } = {})`, which returns `{ onEvent, escalate, approveResult, approveChunk, approvePlan, say, close, model }`.
  - **Answers.** Answers are read one line at a time with `node:readline` (`terminal: false`; the TTY's own line editing echoes typing). The reader is created lazily on the first prompt, and `close()` releases stdin.
    - Answers are trimmed and lower-cased; anything not offered is asked again, after `Please type one of: …`.
    - End of input (EOF) counts as reject, or `false`.
  - **`say(text)`** prints permanent text above the live block (on a TTY it clears the block first, and the next event redraws it).
  - **`approveResult` answers:**
    - `a` → `true`;
    - `r` → `false`;
    - `n` → asks `Your note (one line): ` and returns `{ approved: false, note }`;
    - `v` → prints the diff (or `(no changes)`), then asks again.
  - **`escalate` answers:** `a` → `'approve'`; `r`, or EOF → `'reject'`; `s` prints `Full details of this run are saved in: <transcript>` and asks again.
  - **`approveChunk`** prints `Step <i>/<n> done: <title>`, the files, the note if any, and the test status, then asks `[a] continue · [r] stop here > `.
  - **`approvePlan({ summary, steps, note })`** prints `Proposed plan:`, the summary, the numbered steps and the note if any, then asks `[a] go ahead · [r] stop > `. `a` → `true`; anything else → `false`. Without a TTY it says `NO_TTY_GATE` and returns `false`.
  - **`onEvent`.** Besides redrawing: a `chunk-done` event with a `diff` (from `--watch-diffs`) is printed with `say` under `--- Step <i> changes ---`, and a `warning` event is printed as `Note: <detail>`.
  - Exported fail-closed messages:

```js
export const NO_TTY_ESCALATION = 'There is no terminal to ask you, so Conductor answered "reject" to stay safe. Run Conductor in a terminal to answer questions.';
export const NO_TTY_GATE = 'There is no terminal to ask you, so the result was not approved and nothing was added to your repository. Run Conductor in a terminal to approve results.';
```

- [ ] **Step 1: Write the failing tests**

Create `test/terminal.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { createTerminal, NO_TTY_ESCALATION, NO_TTY_GATE } from '../src/ui/terminal.js';

function sink() {
  let text = '';
  const out = new Writable({ write(chunk, enc, cb) { text += chunk.toString(); cb(); } });
  return { out, text: () => text };
}
function term({ answers = null, isTTY = true, bell = true } = {}) {
  const input = new PassThrough();
  const o = sink();
  if (answers != null) {
    input.write(answers.map((a) => `${a}\n`).join(''));
    input.end();
  }
  return { t: createTerminal({ input, output: o.out, isTTY, bell }), text: o.text };
}
const ESC = { kind: 'chunk', title: 'step 2', message: 'Conductor needs your decision on: step 2', options: ['approve', 'reject'], transcript: '/runs/x/transcript.jsonl' };
const GATE = { summary: 'Request: add X\nTests: passing', diff: 'diff --git a/x b/x\n+hello', files: ['x'], tests: { ran: true, passed: true }, finalReview: { decision: 'APPROVE' } };

test('escalate: see details, then approve; rings the bell first', async () => {
  const { t, text } = term({ answers: ['s', 'a'] });
  assert.equal(await t.escalate(ESC), 'approve');
  assert.match(text(), /Conductor needs your decision on: step 2/);
  assert.match(text(), /Full details of this run are saved in: \/runs\/x\/transcript\.jsonl/);
  assert.ok(text().includes('\x07'));
  t.close();
});

test('escalate: an unknown answer is asked again; EOF rejects', async () => {
  const a = term({ answers: ['yes please', 'r'] });
  assert.equal(await a.t.escalate(ESC), 'reject');
  assert.match(a.text(), /Please type one of: a, r, s/);
  const b = term({ answers: [] });
  assert.equal(await b.t.escalate(ESC), 'reject');
});

test('gate: view the diff, then reject with a note', async () => {
  const { t, text } = term({ answers: ['v', 'n', 'Please keep the old button'] });
  assert.deepEqual(await t.approveResult(GATE), { approved: false, note: 'Please keep the old button' });
  assert.match(text(), /Request: add X/);
  assert.match(text(), /\+hello/);
  assert.match(text(), /\[v\] view diff · \[a\] approve → new branch · \[r\] reject · \[n\] reject with a note/);
});

test('gate: a approves (exactly true), r rejects, EOF rejects', async () => {
  assert.equal(await term({ answers: ['A'] }).t.approveResult(GATE), true);
  assert.equal(await term({ answers: ['r'] }).t.approveResult(GATE), false);
  assert.equal(await term({ answers: [] }).t.approveResult(GATE), false);
});

test('per-step approval shows what changed', async () => {
  const { t, text } = term({ answers: ['a'] });
  assert.equal(await t.approveChunk({ index: 0, title: 'export util', total: 3, files: ['a.js', 'b.js'], note: null, tests: { ran: true, passed: false } }), true);
  assert.match(text(), /Step 1\/3 done: export util/);
  assert.match(text(), /a\.js, b\.js/);
  assert.match(text(), /Tests: FAILING/);
  assert.equal(await term({ answers: ['r'] }).t.approveChunk({ index: 0, title: 'x', total: 1, files: [], tests: null }), false);
});

test('plan approval lists the steps', async () => {
  const { t, text } = term({ answers: ['a'] });
  assert.equal(await t.approvePlan({ summary: 'Add an export util, then a button.', steps: ['export util', 'button'], note: null }), true);
  assert.match(text(), /Proposed plan:\nAdd an export util, then a button\.\n  1\. export util\n  2\. button/);
  assert.equal(await term({ answers: ['r'] }).t.approvePlan({ summary: '', steps: [] }), false);
  assert.equal(await term({ isTTY: false }).t.approvePlan({ summary: '', steps: [] }), false);
});

test('no terminal: every prompt fails closed and says why (Review Focus 3)', async () => {
  const { t, text } = term({ isTTY: false });
  assert.equal(await t.escalate(ESC), 'reject');
  assert.equal(await t.approveResult(GATE), false);
  assert.equal(await t.approveChunk({ index: 0, title: 'x', total: 1, files: [], tests: null }), false);
  assert.ok(text().includes(NO_TTY_ESCALATION));
  assert.ok(text().includes(NO_TTY_GATE));
  assert.ok(!text().includes('\x07'), 'no bell when nobody can answer');
});

test('onEvent redraws in place on a TTY', () => {
  const { t, text } = term();
  t.onEvent({ type: 'phase', name: 'plan' });
  t.onEvent({ type: 'call', participant: 'claude', role: 'author', write: false });
  assert.match(text(), /\x1b\[\d+F\x1b\[J/);
  assert.match(text(), /claude drafting the plan…/);
});

test('onEvent without a TTY prints each line once, no escape codes', () => {
  const { t, text } = term({ isTTY: false });
  t.onEvent({ type: 'phase', name: 'plan' });
  t.onEvent({ type: 'plan-agreed', chunks: ['One'], rounds: 1, author: 'claude', reviewer: 'codex' });
  t.onEvent({ type: 'plan-agreed', chunks: ['One'], rounds: 1, author: 'claude', reviewer: 'codex' });
  assert.equal(text().split('Plan agreed').length, 2);
  assert.ok(!text().includes('\x1b['));
});

test('watch-diffs and warnings are printed above the status', () => {
  const { t, text } = term({ isTTY: false });
  t.onEvent({ type: 'plan-agreed', chunks: ['One'], rounds: 1, author: 'claude', reviewer: 'codex' });
  t.onEvent({ type: 'chunk-done', index: 0, by: 'local', files: ['a'], diff: '+added line' });
  t.onEvent({ type: 'warning', kind: 'uncommitted-changes', detail: 'the repository has uncommitted changes' });
  assert.match(text(), /--- Step 1 changes ---\n\+added line/);
  assert.match(text(), /Note: the repository has uncommitted changes/);
});

test('bell can be turned off', async () => {
  const { t, text } = term({ answers: ['a'], bell: false });
  await t.escalate(ESC);
  assert.ok(!text().includes('\x07'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, because `src/ui/terminal.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/ui/terminal.js`:

```js
// src/ui/terminal.js
// The Plan 2 hooks on a real terminal (spec §8). Fails closed without a TTY: nobody can
// answer, so escalations reject and nothing is approved.
import { createInterface } from 'node:readline';
import { StatusModel } from './status.js';

export const NO_TTY_ESCALATION = 'There is no terminal to ask you, so Conductor answered "reject" to stay safe. Run Conductor in a terminal to answer questions.';
export const NO_TTY_GATE = 'There is no terminal to ask you, so the result was not approved and nothing was added to your repository. Run Conductor in a terminal to approve results.';

const CLEAR_DOWN = '\x1b[J';
const up = (n) => (n > 0 ? `\x1b[${n}F` : '\r');
const testsLine = (t) => (!t?.ran ? 'not configured' : t.passed ? 'passing' : 'FAILING');

// One answer per line; EOF (closed input) answers null.
function lineReader(input) {
  const rl = createInterface({ input, terminal: false });
  const queue = [];
  let waiting = null;
  let closed = false;
  rl.on('line', (l) => {
    if (waiting) { const w = waiting; waiting = null; w(l); } else queue.push(l);
  });
  rl.on('close', () => {
    closed = true;
    if (waiting) { const w = waiting; waiting = null; w(null); }
  });
  return {
    next: () => (queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve(null) : new Promise((r) => { waiting = r; })),
    close: () => rl.close(),
  };
}

export function createTerminal({ input = process.stdin, output = process.stdout, isTTY = Boolean(input.isTTY && output.isTTY), bell = true, model = new StatusModel() } = {}) {
  let drawn = 0;
  const printed = new Set();
  let prompting = false;
  let reader = null;
  const write = (s) => output.write(s);
  const nextLine = () => (reader ??= lineReader(input)).next();

  function draw() {
    if (prompting) return;
    const lines = model.lines();
    if (isTTY) {
      write(up(drawn) + CLEAR_DOWN + lines.join('\n') + '\n');
      drawn = lines.length;
    } else {
      for (const l of lines) {
        if (printed.has(l)) continue;
        printed.add(l);
        write(`${l}\n`);
      }
    }
  }

  function say(text) {
    if (isTTY && drawn) {
      write(up(drawn) + CLEAR_DOWN);
      drawn = 0;
    }
    write(String(text).endsWith('\n') ? String(text) : `${text}\n`);
  }

  async function ask(prompt, choices) {
    if (bell) write('\x07');
    for (;;) {
      write(prompt);
      const raw = await nextLine();
      if (raw == null) {
        write('\n');
        return null;
      }
      const a = raw.trim().toLowerCase();
      if (choices.includes(a)) return a;
      write(`Please type one of: ${choices.join(', ')}\n`);
    }
  }

  // Every prompt pauses the live redraw and puts the status back afterwards.
  const prompt = (fn) => async (arg) => {
    prompting = true;
    try {
      return await fn(arg);
    } finally {
      prompting = false;
      draw();
    }
  };

  const escalate = prompt(async (esc) => {
    say(`\n${esc?.message ?? 'Conductor needs your decision.'}\n`);
    if (!isTTY) { say(NO_TTY_ESCALATION); return 'reject'; }
    for (;;) {
      const a = await ask('[a] approve · [r] reject · [s] see details > ', ['a', 'r', 's']);
      if (a === 's') { say(`Full details of this run are saved in: ${esc?.transcript ?? '(not available)'}`); continue; }
      return a === 'a' ? 'approve' : 'reject';
    }
  });

  const approveResult = prompt(async ({ summary, diff } = {}) => {
    say(`\n=== Ready for your approval ===\n${summary ?? ''}\n`);
    if (!isTTY) { say(NO_TTY_GATE); return false; }
    for (;;) {
      const a = await ask('[v] view diff · [a] approve → new branch · [r] reject · [n] reject with a note > ', ['v', 'a', 'r', 'n']);
      if (a === 'v') { say(diff && diff.trim() ? diff : '(no changes)'); continue; }
      if (a === 'a') return true;
      if (a === 'n') {
        write('Your note (one line): ');
        const note = await nextLine();
        return { approved: false, note: note ?? '' };
      }
      return false;
    }
  });

  const approveChunk = prompt(async ({ index, title, total, files = [], note = null, tests = null } = {}) => {
    const lines = [`\nStep ${index + 1}/${total} done: ${title}`, `Files: ${files.length ? files.join(', ') : '(none)'}`];
    if (note) lines.push(`Note: ${note}`);
    lines.push(`Tests: ${testsLine(tests)}`);
    say(lines.join('\n'));
    if (!isTTY) { say(NO_TTY_GATE); return false; }
    return (await ask('[a] continue · [r] stop here > ', ['a', 'r'])) === 'a';
  });

  const approvePlan = prompt(async ({ summary = '', steps = [], note = null } = {}) => {
    const lines = ['\nProposed plan:', summary, ...steps.map((s, i) => `  ${i + 1}. ${s}`)];
    if (note) lines.push(`Note: ${note}`);
    say(lines.join('\n'));
    if (!isTTY) { say(NO_TTY_GATE); return false; }
    return (await ask('[a] go ahead · [r] stop > ', ['a', 'r'])) === 'a';
  });

  function onEvent(e) {
    model.apply(e);
    if (e?.type === 'chunk-done' && typeof e.diff === 'string') say(`--- Step ${e.index + 1} changes ---\n${e.diff}`);
    if (e?.type === 'warning' && e.detail) say(`Note: ${e.detail}`);
    draw();
  }

  return {
    onEvent, escalate, approveResult, approveChunk, approvePlan, say, model,
    close: () => { reader?.close(); reader = null; },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS. The process must not hang after the suite: every test either ends its input or never reads it.

- [ ] **Step 5: Commit**

```bash
git add src/ui/terminal.js test/terminal.test.js
git commit -m "feat: terminal hooks — live status, escalation and gate prompts, fail closed without a TTY"
```
