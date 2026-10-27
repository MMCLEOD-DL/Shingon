// src/ui/terminal.js
// The Plan 2 hooks on a real terminal (spec §8). Fails closed without a TTY: nobody can
// answer, so escalations reject and nothing is approved.
import { createInterface } from 'node:readline';
import { StatusModel } from './status.js';

export const NO_TTY_ESCALATION = 'There is no terminal to ask you, so Conductor answered "reject" to stay safe. Run Conductor in a terminal to answer questions.';
export const NO_TTY_GATE = 'There is no terminal to ask you, so the result was not approved and nothing was added to your repository. Run Conductor in a terminal to approve results.';
export const NO_TTY_LOCAL = 'There is no terminal to ask you, so Conductor did not use your subscription in place of the local model. Start the local model, or run Conductor in a terminal to choose.';
export const NO_TTY_BRIEF = 'There is no terminal to ask you, so the brief was not approved. Run Conductor in a terminal to answer its questions and approve the brief.';

// [w] must not promise a wake that will not happen: with warn-only, Conductor can only check again.
const WAIT_LABEL = Object.freeze({
  warn: '[w] check again (after you have started it)',
  wol: '[w] try to wake it again',
  command: '[w] try to wake it again',
});
const FRONTIER_BEFORE = '[f] go ahead without it (Claude/Codex do its steps; uses your subscription)';
const FRONTIER_MID_RUN = '[f] carry on without it (Claude/Codex do its steps; uses your subscription)';

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

  // Free text rather than a fixed choice. Rings the bell once (only when the bell option is on);
  // EOF answers null; a blank line is asked again unless allowEmpty.
  async function askText(promptText, { allowEmpty = false } = {}) {
    if (bell) write('\x07');
    for (;;) {
      write(promptText);
      const raw = await nextLine();
      if (raw == null) {
        write('\n');
        return null;
      }
      const a = raw.trim();
      if (a || allowEmpty) return a;
      write('Please type an answer, "skip" or "stop".\n');
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

  // Brief intake (Plan 7). Fails closed: no terminal or end of input means "stop for now"; only [a] approves.
  const askBriefQuestion = prompt(async ({ index, total, question, why }) => {
    say(`\nQuestion ${index} of ${total}: ${question}${why ? `\n(Why it matters: ${why})` : ''}`);
    if (!isTTY) { say(NO_TTY_BRIEF); return { stop: true }; }
    const a = await askText('Your answer (or "skip" to leave it open, "stop" to finish for now) > ');
    if (a == null) return { stop: true };
    const word = a.toLowerCase();
    if (word === 'skip') return { skip: true };
    if (word === 'stop') return { stop: true };
    return { answer: a };
  });

  const approveBrief = prompt(async ({ markdown, draftPath }) => {
    say(`\n=== The brief, ready for your approval ===\n${markdown ?? ''}\n\nA copy is saved at: ${draftPath ?? '(not available)'}\n`);
    if (!isTTY) { say(NO_TTY_BRIEF); return { decision: 'stop' }; }
    const a = await ask('[a] approve · [c] ask for changes · [s] stop for now > ', ['a', 'c', 's']);
    if (a === 'a') return { decision: 'approve' };
    if (a !== 'c') return { decision: 'stop' };
    write('What should change? (one line): ');
    const note = (await nextLine())?.trim();
    return note ? { decision: 'change', note } : { decision: 'stop' };
  });

  const confirmDiscard = prompt(async ({ slug }) => {
    say(`\nThis throws away the unfinished brief for ${slug}. Your notes are kept.`);
    if (!isTTY) { say('There is no terminal to ask you, so nothing was thrown away.'); return false; }
    return (await ask('[y] throw it away · [n] keep it > ', ['y', 'n'])) === 'y';
  });

  function onEvent(e) {
    model.apply(e);
    if (e?.type === 'chunk-done' && typeof e.diff === 'string') say(`--- Step ${e.index + 1} changes ---\n${e.diff}`);
    if (e?.type === 'warning' && e.detail) say(`Note: ${e.detail}`);
    draw();
  }

  return {
    onEvent, escalate, approveResult, approveChunk, approvePlan, confirmLocalFallback, askBriefQuestion, approveBrief, confirmDiscard, say, model,
    close: () => { closed = true; reader?.close(); reader = null; },
  };
}
