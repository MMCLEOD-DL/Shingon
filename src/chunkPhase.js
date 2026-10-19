// src/chunkPhase.js
import { reviewLoop } from './review.js';
import * as prompts from './prompts.js';
import { settleDeadlock } from './deadlock.js';
import { callRole } from './runlog.js';
import { askUser } from './askUser.js';

// Rotate vendors: the frontier that reviews a chunk is never the one that implements its fallback.
export function chunkRoles(index, team) {
  return index % 2 === 0
    ? { reviewer: team.reviewer, fallback: team.author }
    : { reviewer: team.author, fallback: team.reviewer };
}

const join = (a, b) => (a ? `${a} ${b}` : b);

// Review Focus 3: whatever happens, the workspace ends either as exactly one
// squashed commit on top of the chunk base or exactly at the base.
export async function runChunk(ctx, chunk, index) {
  const base = await ctx.ws.head();
  try {
    return await runChunkFrom(ctx, chunk, index, base);
  } catch (e) {
    let resetError = null;
    try { await ctx.ws.resetHard(base); } catch (re) { resetError = String(re?.message ?? re); }
    ctx.log.event('chunk-error', { index, error: String(e?.message ?? e), resetError });
    throw e;
  }
}

async function runChunkFrom(ctx, chunk, index, base) {
  const { request, team, options, ws, log, state } = ctx;
  const plan = state.plan;
  const total = plan.chunks.length;
  const step = `Step ${index + 1} (${chunk.title})`;
  const { reviewer, fallback } = chunkRoles(index, team);
  const writeOpts = { cwd: ws.dir, write: true, timeoutMs: options.agentTimeoutMs };
  const readOpts = { cwd: ws.dir, write: false, timeoutMs: options.agentTimeoutMs };
  log.event('chunk', { index, title: chunk.title, base });

  const attempt = (who, role) => async (round, feedback) => {
    const r = await callRole(log, who, role, prompts.chunkExec({ request, plan, chunk, index, total, feedback }), '', writeOpts);
    if (!r.ok) return { error: `${who.name} failed: ${r.error}` };
    const tests = await ws.runTests(options.testCommand, { timeoutMs: options.testTimeoutMs });
    return { diff: await ws.diff(base), tests };
  };
  const review = (a) => callRole(log, reviewer, 'reviewer',
    prompts.chunkReview({ request, plan, chunk, index, total, diff: a.diff, tests: a.tests }), '', readOpts);

  let note = null;
  let loop = await reviewLoop({ maxRounds: options.localRounds, produce: attempt(team.local, 'grunt'), review });

  if (loop.status !== 'approved') {
    log.event('chunk-fallback', { index, to: fallback.name, reason: loop.lastReason });
    await ws.resetHard(base);
    loop = await reviewLoop({ maxRounds: options.frontierRounds, produce: attempt(fallback, 'author'), review });
    note = `${step} was done by ${fallback.name} because the local model could not finish it.`;
  }

  if (loop.status !== 'approved') {
    // The workspace reflects the LAST attempt, so judge that one.
    const last = loop.artifact;
    const settle = settleDeadlock({ reason: loop.lastReason, tests: last?.tests ?? null, produced: !last?.error });
    log.event('deadlock', { phase: 'chunk', index, action: settle.action, note: settle.note });
    if (settle.action === 'accept') {
      note = join(note, `${step}: ${settle.note}`);
    } else {
      const decision = await askUser(ctx, {
        kind: 'chunk', title: `step ${index + 1}: ${chunk.title}`, reason: loop.lastReason, recommendation: settle.recommendation,
      });
      if (decision !== 'approve') {
        await ws.resetHard(base);
        return { status: 'stopped', reason: `You stopped the run at step ${index + 1} (${chunk.title}).` };
      }
      if (last?.error) {
        // The last attempt crashed or timed out: its edits are partial, never commit them.
        await ws.resetHard(base);
        return { status: 'stopped', reason: `Step ${index + 1} (${chunk.title}) produced nothing usable to keep, so the run stopped there.` };
      }
      note = join(note, `${step}: you approved it over the concern: ${loop.lastReason}`);
    }
  }

  const sha = await ws.squashSince(base, `conductor: step ${index + 1}/${total} — ${chunk.title}`);
  log.event('chunk-done', { index, sha });
  return { status: 'done', sha, note };
}
