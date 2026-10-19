// src/deadlock.js
// Frontier-vs-frontier deadlock: evidence first; only reversible, tested,
// actually-reviewed work is accepted without asking the user.
import { IRREVERSIBLE_MARK } from './prompts.js';
import { plainReason } from './escalation.js';

const UNREVIEWED = /^(reviewer failed|reviewer gave no VERDICT)/;

// situation says WHY it ended this way, so the user is told what really happened:
// 'unproduced' | 'unreviewed' | 'tests-failing' | 'irreversible' | 'disagree'.
export function settleDeadlock({ reason, tests = null, produced = true }) {
  const r = String(reason ?? '');
  const shown = plainReason(r); // user-facing text never carries the marker; detection below uses raw r
  const escalate = (situation, note, recommendation) => ({ action: 'escalate', situation, note, recommendation });
  if (!produced) return escalate('unproduced', `No usable result was produced. Last problem: ${shown}`, 'Reject: there is nothing usable to continue with.');
  if (UNREVIEWED.test(r)) return escalate('unreviewed', `The work could not be reviewed: ${shown}`, 'Reject: this work was never successfully checked.');
  if (tests?.ran && tests.passed === false) return escalate('tests-failing', `Tests are failing and the reviewers still disagree: ${shown}`, 'Reject: the tests do not pass.');
  if (r.toUpperCase().includes(IRREVERSIBLE_MARK)) {
    return escalate('irreversible', `The reviewer flagged a hard-to-undo concern: ${shown}`, 'Reject, unless you are sure this change is what you want; it is hard to undo.');
  }
  const evidence = tests?.ran ? 'tests pass' : 'no tests configured';
  return { action: 'accept', situation: 'disagree', note: `Accepted over an unresolved reviewer objection (reversible, ${evidence}): ${shown}`, recommendation: null };
}
