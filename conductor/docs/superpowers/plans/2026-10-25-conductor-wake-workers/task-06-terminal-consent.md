# Task 6: Terminal — the consent question

This task adds the one new question the operator sees: the local model is down, so what now?

- **Before a run** there are three answers: check (or wake) it again, go ahead on the subscription, or stop. The first answer's label depends on the worker's wake method: with `warn` (the default) Conductor cannot wake anything, so it offers to **check again** once the operator has started it; with `wol` or `command` it offers to **try to wake it again**.
- **Mid-run** (Task 7) there are two: carry on with the subscription, or pause so the operator can start it and resume.

It follows every other prompt in `terminal.js`: bell first, type-ahead discarded, end-of-input means the safe answer, and no TTY means the safe answer plus a sentence saying why (Ruling 2).

**Files:**
- Modify: `src/ui/terminal.js`
- Test: `test/terminal.test.js` (append)

**Interfaces:**
- Consumes: the existing `prompt(fn)` wrapper, `ask(prompt, choices)` and `say` inside `createTerminal`.
- Produces:
  - `NO_TTY_LOCAL = 'There is no terminal to ask you, so Conductor did not use your subscription in place of the local model. Start the local model, or run Conductor in a terminal to choose.'` (exported).
  - `confirmLocalFallback({ message, midRun = false, method = 'warn' }) -> Promise<'wait' | 'frontier' | 'stop'>`, returned on the terminal object:
    - Prints `\n<message>\n`.
    - No TTY → `say(NO_TTY_LOCAL)` and return `'stop'`.
    - Before a run, the prompt is `<wait label> · [f] go ahead without it (Claude/Codex do its steps; uses your subscription) · [s] stop > ` with choices `w`, `f` and `s`. The wait label is `[w] check again (after you have started it)` for `method: 'warn'` (and any unknown method), and `[w] try to wake it again` for `wol` and `command`.
    - Mid-run, the prompt is `[f] carry on without it (Claude/Codex do its steps; uses your subscription) · [p] pause (start it, then run: conductor resume) > ` with choices `f` and `p`.
    - Answers map as `w` → `'wait'`, `f` → `'frontier'`, and `s`/`p`/EOF → `'stop'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/terminal.test.js`. Also extend its import line to `import { createTerminal, NO_TTY_ESCALATION, NO_TTY_GATE, NO_TTY_LOCAL } from '../src/ui/terminal.js';`:

```js
const DOWN_MSG = 'The local model "local" is not answering: its GPU worker is not connected.';

test('local consent before a run: wait, frontier, stop; message shown, bell rung', async () => {
  for (const [answer, expected] of [['w', 'wait'], ['f', 'frontier'], ['s', 'stop']]) {
    const { t, text } = term({ answers: [answer] });
    assert.equal(await t.confirmLocalFallback({ message: DOWN_MSG, method: 'wol' }), expected);
    assert.match(text(), /its GPU worker is not connected/);
    assert.match(text(), /\[w\] try to wake it again · \[f\] go ahead without it \(Claude\/Codex do its steps; uses your subscription\) · \[s\] stop > /);
    assert.ok(text().includes('\x07'));
  }
});

test('local consent: with no wake method set up, [w] only promises to check again', async () => {
  for (const args of [{ message: DOWN_MSG }, { message: DOWN_MSG, method: 'warn' }]) {
    const { t, text } = term({ answers: ['w'] });
    assert.equal(await t.confirmLocalFallback(args), 'wait');
    assert.match(text(), /\[w\] check again \(after you have started it\) · \[f\] go ahead without it/);
    assert.doesNotMatch(text(), /try to wake it again/);
  }
  const cmd = term({ answers: ['s'] });
  await cmd.t.confirmLocalFallback({ message: DOWN_MSG, method: 'command' });
  assert.match(cmd.text(), /\[w\] try to wake it again/);
});

test('local consent mid-run: no wait option; p pauses; an unknown answer is asked again', async () => {
  const { t, text } = term({ answers: ['w', 'p'] });
  assert.equal(await t.confirmLocalFallback({ message: DOWN_MSG, midRun: true }), 'stop');
  assert.match(text(), /Please type one of: f, p/);
  assert.match(text(), /\[p\] pause \(start it, then run: conductor resume\) > /);
  const f = term({ answers: ['f'] });
  assert.equal(await f.t.confirmLocalFallback({ message: DOWN_MSG, midRun: true }), 'frontier');
});

test('local consent fails closed: EOF and no terminal both stop, and say why', async () => {
  const eof = term({ answers: [] });
  assert.equal(await eof.t.confirmLocalFallback({ message: DOWN_MSG }), 'stop');
  const noTty = term({ isTTY: false });
  assert.equal(await noTty.t.confirmLocalFallback({ message: DOWN_MSG }), 'stop');
  assert.ok(noTty.text().includes(NO_TTY_LOCAL));
  assert.ok(noTty.text().includes(DOWN_MSG), 'the operator is still told what is wrong');
});

test('local consent: type-ahead cannot answer it', async () => {
  const input = new PassThrough();
  let text = '';
  const out = new Writable({ write(c, e, cb) { text += c; if (String(c).endsWith('> ')) setImmediate(() => input.write('s\n')); cb(); } });
  const t = createTerminal({ input, output: out, isTTY: true });
  input.write('f\n'); // typed before the question
  await new Promise((r) => setImmediate(r));
  assert.equal(await t.confirmLocalFallback({ message: DOWN_MSG }), 'stop');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/terminal.test.js`
Expected: FAIL with `t.confirmLocalFallback is not a function`.

- [ ] **Step 3: Implement `confirmLocalFallback` and `NO_TTY_LOCAL` in `src/ui/terminal.js`**

Under the existing `NO_TTY_GATE` export, add:

```js
export const NO_TTY_LOCAL = 'There is no terminal to ask you, so Conductor did not use your subscription in place of the local model. Start the local model, or run Conductor in a terminal to choose.';

// [w] must not promise a wake that will not happen: with warn-only, Conductor can only check again.
const WAIT_LABEL = Object.freeze({
  warn: '[w] check again (after you have started it)',
  wol: '[w] try to wake it again',
  command: '[w] try to wake it again',
});
const FRONTIER_BEFORE = '[f] go ahead without it (Claude/Codex do its steps; uses your subscription)';
const FRONTIER_MID_RUN = '[f] carry on without it (Claude/Codex do its steps; uses your subscription)';
```

Inside `createTerminal`, after `approvePlan`, add:

```js
  // The local model is down: may the subscription models do its steps? (factory spec §4.2)
  // Fails closed: no terminal, end of input, [s] and [p] all answer 'stop'.
  const confirmLocalFallback = prompt(async ({ message, midRun = false, method = 'warn' }) => {
    say(`\n${message ?? 'The local model is not answering.'}\n`);
    if (!isTTY) { say(NO_TTY_LOCAL); return 'stop'; }
    if (midRun) {
      const a = await ask(`${FRONTIER_MID_RUN} · [p] pause (start it, then run: conductor resume) > `, ['f', 'p']);
      return a === 'f' ? 'frontier' : 'stop';
    }
    const a = await ask(`${WAIT_LABEL[method] ?? WAIT_LABEL.warn} · ${FRONTIER_BEFORE} · [s] stop > `, ['w', 'f', 's']);
    return a === 'w' ? 'wait' : a === 'f' ? 'frontier' : 'stop';
  });
```

and add `confirmLocalFallback` to the returned object:

```js
  return {
    onEvent, escalate, approveResult, approveChunk, approvePlan, confirmLocalFallback, say, model,
    close: () => { closed = true; reader?.close(); reader = null; },
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/terminal.js test/terminal.test.js
git commit -m "feat: terminal asks before the subscription covers for a down local model"
```
