// src/planPhase.js
import { reviewLoop } from './review.js';
import { parsePlan } from './plan.js';
import * as prompts from './prompts.js';
import { settleDeadlock } from './deadlock.js';
import { callAgent, noteSameVendor } from './runlog.js';
import { vendorOf } from './vendors.js';
import { askUser } from './askUser.js';

const PRODUCE_FAILED = 'could not produce a result';

export async function runPlanPhase(ctx) {
  const { request, team, options, ws, log } = ctx;
  const opts = { cwd: ws.dir, write: false, timeoutMs: options.agentTimeoutMs };
  log.event('phase', { name: 'plan' });

  let lastReviewer = team.reviewer.name;
  const loop = await reviewLoop({
    maxRounds: options.planRounds,
    produce: async (round, feedback, feedbackKind) => {
      const r = await callAgent(ctx, team.author, 'author',
        prompts.planAuthor({ request, maxChunks: options.maxChunks, feedback, feedbackKind }), opts);
      if (!r.ok) return r.failure === 'no-participant' ? { error: r.error, pause: r.error } : { error: `author failed: ${r.error}` };
      const parsed = parsePlan(r.text, { maxChunks: options.maxChunks });
      const who = { producedBy: r.servedBy ?? team.author.name, vendor: vendorOf(r.servedKind ?? team.author.adapter.kind) };
      return parsed.ok ? { plan: parsed.plan, text: r.text, ...who } : { error: parsed.error };
    },
    review: async (a) => {
      const rv = await callAgent(ctx, team.reviewer, 'reviewer', prompts.planReview({ request, planText: a.text }), opts);
      noteSameVendor(ctx, { phase: 'plan', producerVendor: a.vendor, result: rv, participant: team.reviewer });
      if (rv.ok) lastReviewer = rv.servedBy ?? team.reviewer.name;
      return rv;
    },
  });
  const agreed = (artifact) => log.event('plan-agreed', {
    chunks: artifact.plan.chunks.map((c) => c.title), rounds: loop.rounds, author: artifact.producedBy, reviewer: lastReviewer,
  });

  if (loop.status === 'paused') return { status: 'paused', reason: loop.lastReason };
  if (loop.status === 'approved') {
    agreed(loop.artifact);
    return { status: 'ok', plan: loop.artifact.plan, note: null };
  }
  if (!loop.lastGood) {
    return { status: 'failed', reason: `No valid plan after ${loop.rounds} rounds. Last problem: ${loop.lastReason}` };
  }

  // Settle on the last valid plan, judged by the last real review of a plan.
  const lastReview = [...loop.history].reverse().find((h) => !h.reason.startsWith(PRODUCE_FAILED));
  const reason = lastReview?.reason ?? loop.lastReason;
  const settle = settleDeadlock({ reason, evidence: 'tests do not apply to a plan' });
  log.event('deadlock', { phase: 'plan', action: settle.action, situation: settle.situation, note: settle.note });
  if (settle.action === 'accept') {
    agreed(loop.lastGood);
    return { status: 'ok', plan: loop.lastGood.plan, note: `Plan: ${settle.note}` };
  }

  const decision = await askUser(ctx, { kind: 'plan', title: 'the plan', reason, recommendation: settle.recommendation, situation: settle.situation });
  if (decision === 'approve') {
    agreed(loop.lastGood);
    return { status: 'ok', plan: loop.lastGood.plan, note: `Plan: you approved it over the concern: ${reason}` };
  }
  return { status: 'stopped', reason: 'You rejected the plan.' };
}
