// src/chunkPhase.js
import { reviewLoop } from './review.js';
import * as prompts from './prompts.js';
import { settleDeadlock } from './deadlock.js';
import { callAgent } from './runlog.js';
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
  // Ignored paths present at the chunk base (deps, caches) survive every reset; new ones do not (T8-M4).
  const keepIgnored = await ctx.ws.ignoredPaths();
  const reset = (sha = base) => ctx.ws.resetHard(sha, { keepIgnored });
  try {
    return await runChunkFrom(ctx, chunk, index, base, reset);
  } catch (e) {
    let resetError = null;
    try { await reset(); } catch (re) { resetError = String(re?.message ?? re); }
    ctx.log.event('chunk-error', { index, error: String(e?.message ?? e), resetError });
    throw e;
  }
}

async function runChunkFrom(ctx, chunk, index, base, reset) {
  const { request, team, options, ws, log, state } = ctx;
  const plan = state.plan;
  const total = plan.chunks.length;
  const step = `Step ${index + 1} (${chunk.title})`;
  const { reviewer, fallback } = chunkRoles(index, team);
  const writeOpts = { cwd: ws.dir, write: true, timeoutMs: options.agentTimeoutMs };
  const readOpts = { cwd: ws.dir, write: false, timeoutMs: options.agentTimeoutMs };
  log.event('chunk', { index, title: chunk.title, base });

  const attempt = (who, role) => {
    // The last state that was successfully inspected in this loop: a later round
    // that leaves an uninspectable mess goes back here, not all the way to base.
    let snap = null;
    return async (round, feedback, feedbackKind) => {
      const r = await callAgent(ctx, who, role, prompts.chunkExec({ request, plan, chunk, index, total, feedback, feedbackKind }), writeOpts);
      // An agent that switched or detached the branch: put the run's branch back (T9).
      if (!(await ws.onOwnBranch())) {
        log.event('branch-switched', { index, participant: who.name, found: await ws.currentBranch() });
        await ws.returnToBranch(snap ?? base);
        await reset(snap ?? base);
        return { error: `${who.name} switched the workspace off its branch; that attempt was discarded` };
      }
      if (!r.ok) return { error: `${who.name} failed: ${r.error}` };
      // Nothing an agent leaves behind may crash the run: a workspace we cannot
      // inspect is a blocked round, and the bad state is reset away before the next.
      // A failing reset is real infrastructure trouble and throws to runChunk's catch.
      try {
        const tests = await ws.runTests(options.testCommand, { timeoutMs: options.testTimeoutMs });
        const diff = await ws.diff(base);
        snap = await ws.snapshot();
        return { diff, tests, base };
      } catch (e) {
        const msg = String(e?.message ?? e);
        log.event('inspect-failed', { index, participant: who.name, error: msg, resetTo: snap ?? base });
        await reset(snap ?? base);
        return { error: `could not inspect the workspace: ${msg}` };
      }
    };
  };
  const review = (a) => callAgent(ctx, reviewer, 'reviewer',
    prompts.chunkReview({ request, plan, chunk, index, total, diff: a.diff, tests: a.tests, base }), readOpts);

  let note = null;
  let loop = await reviewLoop({ maxRounds: options.localRounds, produce: attempt(team.local, 'grunt'), review });

  if (loop.status !== 'approved') {
    log.event('chunk-fallback', { index, to: fallback.name, reason: loop.lastReason });
    await reset();
    loop = await reviewLoop({ maxRounds: options.frontierRounds, produce: attempt(fallback, 'author'), review });
    note = `${step} was done by ${fallback.name} because the local model could not finish it.`;
  }

  if (loop.status !== 'approved') {
    // The workspace reflects the LAST attempt, so judge that one.
    const last = loop.artifact;
    if (!last || last.error) {
      // Nothing usable exists, so there is no real choice to put to the user (I4):
      // its edits are partial, never commit them, and fail so the step can be resumed.
      log.event('deadlock', { phase: 'chunk', index, action: 'fail', note: loop.lastReason });
      await reset();
      return {
        status: 'failed',
        reason: `Step ${index + 1} (${chunk.title}) could not be completed: neither the local model nor ${fallback.name} produced a usable result. ` +
          'Your repository is unchanged; you can resume to retry this step.',
      };
    }
    const settle = settleDeadlock({ reason: loop.lastReason, tests: last.tests ?? null });
    log.event('deadlock', { phase: 'chunk', index, action: settle.action, situation: settle.situation, note: settle.note });
    if (settle.action === 'accept') {
      note = join(note, `${step}: ${settle.note}`);
    } else {
      const decision = await askUser(ctx, {
        kind: 'chunk', title: `step ${index + 1}: ${chunk.title}`, reason: loop.lastReason,
        recommendation: settle.recommendation, situation: settle.situation,
      });
      if (decision !== 'approve') {
        await reset();
        return { status: 'stopped', reason: `You stopped the run at step ${index + 1} (${chunk.title}).` };
      }
      note = join(note, `${step}: you approved it over the concern: ${loop.lastReason}`);
    }
  }

  await ws.assertOnBranch(); // never squash onto a branch an agent (or reviewer) switched to
  const sha = await ws.squashSince(base, `conductor: step ${index + 1}/${total} — ${chunk.title}`);
  log.event('chunk-done', { index, sha });
  return { status: 'done', sha, note, tests: loop.artifact?.tests ?? null };
}
