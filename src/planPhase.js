// src/planPhase.js
import { reviewLoop } from './review.js';
import { parsePlan } from './plan.js';
import * as prompts from './prompts.js';
import { settleDeadlock } from './deadlock.js';
import { callAgent } from './runlog.js';
import { askUser } from './askUser.js';

const PRODUCE_FAILED = 'could not produce a result';

export async function runPlanPhase(ctx) {
  const { request, team, options, ws, log } = ctx;
  const opts = { cwd: ws.dir, write: false, timeoutMs: options.agentTimeoutMs };
  log.event('phase', { name: 'plan' });

  const loop = await reviewLoop({
    maxRounds: options.planRounds,
    produce: async (round, feedback, feedbackKind) => {
      const r = await callAgent(ctx, team.author, 'author',
        prompts.planAuthor({ request, maxChunks: options.maxChunks, feedback, feedbackKind }), opts);
      if (!r.ok) return r.failure === 'no-participant' ? { error: r.error, pause: r.error } : { error: `author failed: ${r.error}` };
      const parsed = parsePlan(r.text, { maxChunks: options.maxChunks });
      return parsed.ok ? { plan: parsed.plan, text: r.text } : { error: parsed.error };
    },
    review: (a) => callAgent(ctx, team.reviewer, 'reviewer', prompts.planReview({ request, planText: a.text }), opts),
  });

  if (loop.status === 'paused') return { status: 'paused', reason: loop.lastReason };
  if (loop.status === 'approved') return { status: 'ok', plan: loop.artifact.plan, note: null };
  if (!loop.lastGood) {
    return { status: 'failed', reason: `No valid plan after ${loop.rounds} rounds. Last problem: ${loop.lastReason}` };
  }

  // Settle on the last valid plan, judged by the last real review of a plan.
  const lastReview = [...loop.history].reverse().find((h) => !h.reason.startsWith(PRODUCE_FAILED));
  const reason = lastReview?.reason ?? loop.lastReason;
  const settle = settleDeadlock({ reason, evidence: 'tests do not apply to a plan' });
  log.event('deadlock', { phase: 'plan', action: settle.action, situation: settle.situation, note: settle.note });
  if (settle.action === 'accept') return { status: 'ok', plan: loop.lastGood.plan, note: `Plan: ${settle.note}` };

  const decision = await askUser(ctx, { kind: 'plan', title: 'the plan', reason, recommendation: settle.recommendation, situation: settle.situation });
  if (decision === 'approve') {
    return { status: 'ok', plan: loop.lastGood.plan, note: `Plan: you approved it over the concern: ${reason}` };
  }
  return { status: 'stopped', reason: 'You rejected the plan.' };
}
