// src/ui/ask.js — the operator's questions. One reader over the input stream; nothing is asked without a terminal.
// Secrets are read with no echo and handed to rememberSecret the moment they are typed.
import { StringDecoder } from 'node:string_decoder';
import { rememberSecret } from '../secrets.js';

export function createAsk({ input, output, isTTY }) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let ended = false;
  let lastWasCR = false;
  const waiters = [];

  function wake() {
    while (waiters.length && (buf.length > 0 || ended)) {
      const w = waiters.shift();
      if (buf.length > 0) { const c = buf[0]; buf = buf.slice(1); w(c); } else w(null);
    }
  }
  const onData = (d) => { buf += typeof d === 'string' ? d : decoder.write(d); wake(); };
  const onEnd = () => { ended = true; wake(); };
  if (isTTY) { input.on('data', onData); input.on('end', onEnd); input.on('close', onEnd); }

  const getChar = () => new Promise((resolve) => { waiters.push(resolve); wake(); });
  const write = (s) => { output.write(s); };

  // Reads up to Enter. A CR followed by LF counts once. Returns null at end of input (or Ctrl-C when `raw`).
  async function readLine({ raw }) {
    let line = '';
    lastWasCR = false; // a CR that ended an earlier prompt must not swallow this prompt's Enter
    for (;;) {
      const c = await getChar();
      if (c === null) return null;
      if (c === '\x1b') { // drop the rest of an escape sequence (arrow keys etc.)
        const n = await getChar();
        if (n === '[') { for (;;) { const f = await getChar(); if (f === null || (f >= '@' && f <= '~')) break; } }
        else if (n === 'O') await getChar();
        continue;
      }
      if (c === '\n' && lastWasCR) { lastWasCR = false; continue; }
      lastWasCR = c === '\r';
      if (c === '\n' || c === '\r') return line;
      if (c === '\x03' && raw) return null;
      if (c === '\x7f' || c === '\b') { line = Array.from(line).slice(0, -1).join(''); continue; }
      if (c < ' ') continue; // other control characters (escape sequences, tabs) are ignored
      line += c;
    }
  }

  return {
    isTTY: Boolean(isTTY),

    async text(q, { def, check } = {}) {
      if (!isTTY) return null;
      for (;;) {
        write(`${q}${def !== undefined ? ` [${def}]` : ''} > `);
        const raw = await readLine({ raw: false });
        if (raw === null) return null;
        let answer = raw.trim();
        if (answer === '' && def !== undefined) answer = def;
        const problem = check ? check(answer) : null;
        if (problem) { write(`${problem}\n`); continue; }
        return answer;
      }
    },

    async secret(q, { check, optional = false } = {}) {
      if (!isTTY) return null;
      for (;;) {
        write(`${q} (hidden) > `);
        let answer;
        try {
          input.setRawMode?.(true);
          answer = await readLine({ raw: true });
        } finally {
          try { input.setRawMode?.(false); } catch { /* not a terminal any more */ }
        }
        write('\n');
        if (answer === null) return null;
        if (answer === '') {
          if (optional) return '';
          write('Please type a value, or press Ctrl-C to stop.\n');
          continue;
        }
        rememberSecret(answer); // before anything can print or check it
        const problem = check ? check(answer) : null;
        if (problem) { write(`${problem}\n`); continue; }
        return answer;
      }
    },

    async choose(q, choices) {
      if (!isTTY) return null;
      for (;;) {
        write(`${q}\n${choices.map((c) => `  [${c.key}] ${c.label}\n`).join('')}> `);
        const raw = await readLine({ raw: false });
        if (raw === null) return null;
        const key = raw.trim().toLowerCase();
        if (choices.some((c) => c.key === key)) return key;
        write('Type one of the letters in brackets.\n');
      }
    },

    async confirm(q) {
      if (!isTTY) return false;
      write(`${q} [y] yes · [n] no > `);
      const raw = await readLine({ raw: false });
      return raw !== null && raw.trim().toLowerCase() === 'y';
    },

    say(text) { if (isTTY) write(`${text}\n`); },
    sayOnce(text) { if (isTTY) write(`${text}\n`); },

    close() {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      try { input.pause?.(); } catch { /* ignore */ }
    },
  };
}
