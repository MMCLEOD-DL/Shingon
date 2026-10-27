// A scripted stand-in for createAsk: each question takes the next answer. Text and secret run `check` and throw if it fails.
import { rememberSecret } from '../../src/secrets.js';

export function scriptedAsk(answers) {
  const queue = [...answers];
  const asked = [];
  const said = [];
  const next = (q) => {
    asked.push(q);
    if (queue.length === 0) throw new Error(`scriptedAsk: no answer left for "${q}"`);
    return queue.shift();
  };
  return {
    asked, said,
    async text(q, { def, check } = {}) {
      let a = next(q);
      if (a === null) return null;
      if (a === '' && def !== undefined) a = def;
      const problem = check ? check(a) : null;
      if (problem) throw new Error(`scriptedAsk: "${a}" fails the check for "${q}": ${problem}`);
      return a;
    },
    async secret(q, { check, optional = false } = {}) {
      const a = next(q);
      if (a === null) return null;
      if (a === '' && optional) return '';
      if (a === '') throw new Error(`scriptedAsk: empty answer for required secret "${q}"`);
      rememberSecret(a);
      const problem = check ? check(a) : null;
      if (problem) throw new Error(`scriptedAsk: the answer fails the check for "${q}": ${problem}`);
      return a;
    },
    async choose(q, choices) {
      const a = next(q);
      if (a === null) return null;
      if (!choices.some((c) => c.key === a)) throw new Error(`scriptedAsk: "${a}" is not offered for "${q}" (offered: ${choices.map((c) => c.key).join(', ')})`);
      return a;
    },
    async confirm(q) { const a = next(q); return a === true; },
    say(t) { said.push(t); },
    sayOnce(t) { said.push(t); },
    close() {},
  };
}
