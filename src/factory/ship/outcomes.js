// Turns the foundation v0.1.0 updater's exit code and message text into one of Contract 4's outcomes.
// v0.1.0 has no machine-readable result, so this parser is pinned to its wording (fixtures in test/factory-outcomes.test.js).
// Anything it cannot read fails closed as 'lost-contact': never read as success.
import { redact } from '../../secrets.js';

export const SHIP_EXIT = Object.freeze({ done: 0, notDone: 1, partway: 2, urgent: 3, usage: 64, interrupted: 130 });

const OUTCOME_EXIT = {
  updated: 0, installed: 0, confirmed: 0,
  'rolled-back': 1, cancelled: 1, 'already-on': 1, busy: 1, 'settings-error': 1,
  urgent: 3, 'lost-contact': 2,
};

export function exitFor(outcome) {
  return Object.hasOwn(OUTCOME_EXIT, outcome) ? OUTCOME_EXIT[outcome] : SHIP_EXIT.partway;
}

const STARTS = ['Updated from ', 'Update to ', 'URGENT: update to ', 'Already on ',
  'Another update is already running.', 'A backup or restore is still running'];

// The foundation's notATag() refusal has no prefix: "<tag>" is not a version name (...).
const NOT_A_TAG = /^".*" is not a version name \(/;
const MONITOR_DOWN = '(The monitor did not restart; run: docker compose up -d ops)';

function outcomeLine(output) {
  const lines = String(output ?? '').split(/\r?\n/).map((l) => l.replace(/^\[[^\]]*\] /, ''));
  for (let i = lines.length - 1; i >= 0; i--) if (STARTS.some((s) => lines[i].startsWith(s)) || NOT_A_TAG.test(lines[i])) return lines[i];
  return null;
}

function lastLine(output) {
  const lines = String(output ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].replace(/\.+$/, '') : 'the box gave no reason';
}

export function interpretUpdate({ code, output, to, from, name, bundleDir }) {
  const finish = (outcome, text, extra = {}) => ({
    outcome, backup: null, warnings: [], ...extra, text: redact(text),
  });
  const urgentText = (said) => `URGENT: the update to ${to} failed and could not be undone, or an earlier update was left half done. ${name} may be down or on the wrong data. `
    + `Follow "Recovering from a failed update" in RUNBOOK.md in ${bundleDir} on the box, then run there: docker compose run --rm updater update --mark-recovered. `
    + `The box said: ${said}`;
  const lost = () => finish('lost-contact',
    `Conductor could not tell how the update to ${to} ended. It may still be running on the box, or have finished. Run: conductor deployments status`);
  const line = outcomeLine(output);

  if (code === 2) {
    return finish('settings-error', `The box refused the update because of a settings or command problem: ${lastLine(output)}. Nothing was changed.`);
  }
  if (code === 3) {
    return finish('urgent', urgentText(line ?? lastLine(output)));
  }
  if (line === null) return lost();

  if (code === 0) {
    const m = /^Updated from (\S+) to (\S+)\. A backup \(([0-9a-f]{8})\) was taken first\.(.*)$/.exec(line);
    if (!m || m[2] !== to) return lost();
    let rest = m[4];
    const notes = [];
    const mon = / \(The monitor did not restart; run: docker compose up -d ops\)/.exec(rest);
    if (mon) {
      rest = rest.replace(mon[0], '');
      notes.push('Note from the box: the monitor did not restart. Run on the box: docker compose up -d ops');
    }
    const parts = rest.split(/ (?=Warning: )/).map((s) => s.trim()).filter(Boolean);
    const warnings = parts.filter((s) => s.startsWith('Warning: '));
    for (const p of parts) notes.push(`Note from the box: ${p}`);
    const text = [`${name} is now on ${m[2]} (it was on ${m[1]}). The box took a backup (${m[3]}) first.`, ...notes].join('\n');
    return finish('updated', text, { backup: m[3], warnings: warnings.map((w) => redact(w)) });
  }

  if (code === 1) {
    if (line.startsWith('Already on ')) return finish('already-on', `${name} is already on ${to}. Nothing was done.`);
    if (line.startsWith('Another update is already running.') || line.startsWith('A backup or restore is still running')) {
      return finish('busy', `The box was busy with another update, backup or restore, so the update to ${to} did not start. Nothing was changed. Try again in a few minutes.`);
    }
    if (NOT_A_TAG.test(line)) return finish('cancelled', `The update to ${to} was cancelled before anything changed: ${line.replace(/\.?$/, '.')}`);
    if (line.startsWith('Update to ')) {
      if (/ cancelled: an earlier update could not be undone and has not been marked as recovered/.test(line)) return finish('urgent', urgentText(line));
      const down = /^Update to \S+ cancelled: (.*?) Nothing was changed, but the app could not be started again: run docker compose up -d app ops/.exec(line);
      if (down) return finish('urgent', `The app is NOT running: on the box run: docker compose up -d app ops. The update to ${to} was cancelled before anything changed: ${down[1].replace(/\.?$/, '.')}`);
      const failed = /^Update to \S+ failed \((.*)\), so it was undone automatically\./.exec(line);
      if (failed) {
        const head = `The update to ${to} did not work (${failed[1]}), so the box undid it by itself. ${name} is back on ${from} with its data exactly as before.`;
        if (line.includes(MONITOR_DOWN)) {
          return finish('rolled-back', `${head} The monitor did not restart: on the box run docker compose up -d ops. Then find out why the new version failed before shipping it again.`);
        }
        return finish('rolled-back', `${head} Nothing needs recovering; find out why the new version failed before shipping it again.`);
      }
      const cancelled = /^Update to \S+ cancelled: (.*?)(?: Nothing was changed.*)?$/.exec(line);
      if (cancelled) return finish('cancelled', `The update to ${to} was cancelled before anything changed: ${cancelled[1].replace(/\.?$/, ".")}`);
    }
  }
  return lost();
}
