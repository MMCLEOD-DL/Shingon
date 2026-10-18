// src/review.js
// Fail closed: anything other than an explicit APPROVE from a healthy reviewer is a BLOCK.
export function verdictOf(result) {
  if (!result || result.ok !== true) {
    return { decision: 'BLOCK', reason: `reviewer failed: ${result?.error ?? 'no result'}` };
  }
  const v = result.verdict;
  if (!v || (v.decision !== 'APPROVE' && v.decision !== 'BLOCK')) {
    return { decision: 'BLOCK', reason: 'reviewer gave no VERDICT line' };
  }
  if (v.decision === 'BLOCK') return { decision: 'BLOCK', reason: v.reason?.trim() || 'no reason given' };
  return { decision: 'APPROVE', reason: v.reason ?? '' };
}

export async function reviewLoop({ produce, review, maxRounds }) {
  if (!(maxRounds >= 1)) throw new Error(`maxRounds must be >= 1 (got ${maxRounds})`);
  const history = [];
  let feedback = null;
  let artifact = null;
  let lastGood = null;
  let lastReason = '';

  for (let round = 1; round <= maxRounds; round++) {
    artifact = await produce(round, feedback);
    let v;
    if (artifact?.error) {
      v = { decision: 'BLOCK', reason: `could not produce a result: ${artifact.error}` };
    } else {
      lastGood = artifact;
      v = verdictOf(await review(artifact, round));
    }
    history.push({ round, ...v });
    lastReason = v.reason;
    if (v.decision === 'APPROVE') return { status: 'approved', artifact, lastGood, rounds: round, lastReason, history };
    feedback = v.reason;
  }
  return { status: 'exhausted', artifact, lastGood, rounds: maxRounds, lastReason, history };
}
