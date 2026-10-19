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
    // Lines typed before a prompt is shown are not answers to it.
    drain: () => { queue.length = 0; },
    close: () => rl.close(),
  };
}

export function createTerminal({ input = process.stdin, output = process.stdout, isTTY = Boolean(input.isTTY && output.isTTY), bell = true, model = new StatusModel() } = {}) {
  let drawn = 0;
  const printed = new Set();
  let prompting = false;
  // On a terminal the reader starts now, so lines typed before the first question are queued
  // (and drained by it) rather than read later as its answer.
  let reader = isTTY ? lineReader(input) : null;
  let closed = false;
  const write = (s) => output.write(s);
  const nextLine = () => (closed ? Promise.resolve(null) : (reader ??= lineReader(input)).next());

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
    reader?.drain();
    try {
      return await fn(arg ?? {});
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

  const approveResult = prompt(async ({ summary, diff }) => {
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

  const approveChunk = prompt(async ({ index, title, total, files, note = null, tests = null }) => {
    files = files ?? [];
    const lines = [`\nStep ${index + 1}/${total} done: ${title}`, `Files: ${files.length ? files.join(', ') : '(none)'}`];
    if (note) lines.push(`Note: ${note}`);
    lines.push(`Tests: ${testsLine(tests)}`);
    say(lines.join('\n'));
    if (!isTTY) { say(NO_TTY_GATE); return false; }
    return (await ask('[a] continue · [r] stop here > ', ['a', 'r'])) === 'a';
  });

  const approvePlan = prompt(async ({ summary, steps, note = null }) => {
    const lines = ['\nProposed plan:', summary ?? '', ...(steps ?? []).map((s, i) => `  ${i + 1}. ${s}`)];
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
    close: () => { closed = true; reader?.close(); reader = null; },
  };
}
