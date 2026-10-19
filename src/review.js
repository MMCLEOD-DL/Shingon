// src/review.js
import { clip } from './text.js';

// Fail closed: anything other than an explicit APPROVE from a healthy reviewer is a BLOCK.
// reason is the one-line VERDICT reason; detail is the reviewer's full notes (I3).
export function verdictOf(result) {
  if (!result || result.ok !== true) {
    return { decision: 'BLOCK', reason: `reviewer failed: ${result?.error ?? 'no result'}`, detail: '' };
  }
  const detail = clip(typeof result.text === 'string' ? result.text.trim() : '', 6000);
  const v = result.verdict;
  if (!v || (v.decision !== 'APPROVE' && v.decision !== 'BLOCK')) {
    return { decision: 'BLOCK', reason: 'reviewer gave no VERDICT line', detail };
  }
  const reason = typeof v.reason === 'string' ? v.reason.trim() : '';
  if (v.decision === 'BLOCK') return { decision: 'BLOCK', reason: reason || 'no reason given', detail };
  return { decision: 'APPROVE', reason, detail };
}

export async function reviewLoop({ produce, review, maxRounds }) {
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error(`maxRounds must be an integer >= 1 (got ${maxRounds})`);
  const history = [];
  let feedback = null;
  let feedbackKind = null; // 'blocked' | 'failed'
  let artifact = null;
  let lastGood = null;
  let lastReason = '';

  for (let round = 1; round <= maxRounds; round++) {
    artifact = await produce(round, feedback, feedbackKind);
    // No model left to do this at all: not a failed round, the run pauses (Seat 'no-participant').
    if (artifact?.pause) return { status: 'paused', artifact, lastGood, rounds: round, lastReason: String(artifact.pause), history };
    let v;
    if (artifact == null || artifact.error) {
      v = { decision: 'BLOCK', reason: `could not produce a result: ${artifact?.error ?? 'producer returned nothing'}` };
    } else {
      lastGood = artifact;
      const rv = await review(artifact, round);
      if (rv?.failure === 'no-participant') return { status: 'paused', artifact, lastGood, rounds: round, lastReason: String(rv.error), history };
      v = verdictOf(rv);
    }
    history.push({ round, ...v });
    lastReason = v.reason;
    if (artifact?.fatal) return { status: 'exhausted', artifact, lastGood, rounds: round, lastReason, history };
    if (v.decision === 'APPROVE') return { status: 'approved', artifact, lastGood, rounds: round, lastReason, history };
    // The fixer gets the reviewer's whole critique, not just the one-liner.
    feedback = v.detail ? `${v.reason}\n\nReviewer's full notes:\n${v.detail}` : v.reason;
    feedbackKind = artifact == null || artifact.error ? 'failed' : 'blocked';
  }
  return { status: 'exhausted', artifact, lastGood, rounds: maxRounds, lastReason, history };
}
