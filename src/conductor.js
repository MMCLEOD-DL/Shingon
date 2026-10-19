// src/conductor.js
import path from 'node:path';
import { Workspace, git } from './workspace.js';
import { RunLog, callRole } from './runlog.js';
import { DEFAULT_OPTIONS } from './options.js';
import { runPlanPhase } from './planPhase.js';
import { runChunk } from './chunkPhase.js';
import { verdictOf } from './review.js';
import * as prompts from './prompts.js';
import { buildSummary, plainReason } from './escalation.js';
import { redact } from './secrets.js';

export { DEFAULT_OPTIONS };

const FINISHED = new Set(['landed', 'rejected', 'stopped']);

export function validateTeam(team) {
  const { author, reviewer, local } = team ?? {};
  if (!author || !reviewer || !local) throw new Error('team needs author, reviewer and local participants');
  for (const p of [author, reviewer]) {
    for (const role of ['author', 'reviewer']) {
      if (!p.canPlay(role)) throw new Error(`${p.name} must be able to play ${role} (frontier participants rotate roles)`);
    }
  }
  if (!local.canPlay('grunt')) throw new Error(`${local.name} must be able to play grunt`);
  for (const p of [author, reviewer, local]) {
    if (!p.capabilities.can_edit_files) throw new Error(`${p.name} must have can_edit_files`);
  }
  if (author.adapter.kind === reviewer.adapter.kind) {
    throw new Error(`two-vendor rule: ${author.name} and ${reviewer.name} both use ${author.adapter.kind}; pick frontier participants from different vendors`);
  }
}

export function validateHooks(hooks, options) {
  if (typeof hooks?.escalate !== 'function') throw new Error('hooks.escalate is required');
  if (typeof hooks?.approveResult !== 'function') throw new Error('hooks.approveResult is required');
  if (options.approveEachChunk && typeof hooks.approveChunk !== 'function') {
    throw new Error('hooks.approveChunk is required when approveEachChunk is set');
  }
}

// An agent can run git in the workspace. Never record, squash onto or land a
// branch other than the run's own: a switched or detached HEAD fails the run.
async function currentBranch(ws) {
  const r = await git(ws.dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function assertOnBranch(ws) {
  const cur = await currentBranch(ws);
  if (cur !== ws.branch) {
    throw new Error(`the workspace is no longer on its branch ${ws.branch} (found ${cur ?? 'a detached HEAD'}); nothing was landed`);
  }
}

async function safeHook(log, name, fn, arg) {
  try {
    return await fn(arg);
  } catch (e) {
    log.event('hook-error', { hook: name, error: String(e?.message ?? e) });
    return undefined;
  }
}

export async function runTask({ repoDir, request, team, hooks, options = {}, baseDir }) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  validateTeam(team);
  validateHooks(hooks, opts);
  if (typeof request !== 'string' || !request.trim()) throw new Error('request must be a non-empty string');

  const ws = await Workspace.create({ repoDir, baseDir, taskId: request });
  const log = new RunLog(ws.dir, { onEvent: hooks.onEvent });
  const state = {
    version: 1, taskId: ws.branch, request, repoDir: path.resolve(repoDir), options: opts,
    phase: 'plan', plan: null, chunkIndex: 0, chunkShas: [], notes: [], status: 'running',
  };
  log.saveState(state);
  log.event('start', { request, workspace: ws.dir, branch: ws.branch });
  return drive({ request, team, hooks, options: opts, ws, log, state });
}

export async function resume({ workspaceDir, team, hooks, options = {} }) {
  validateTeam(team);
  let ws = await Workspace.open(workspaceDir);
  const log = new RunLog(ws.dir, { onEvent: hooks?.onEvent });
  const state = log.loadState();
  if (!state) throw new Error(`no Conductor run state in ${workspaceDir}`);
  if (FINISHED.has(state.status)) {
    return { status: state.status, workspaceDir: ws.dir, branch: state.branch, reason: state.reason };
  }
  const opts = { ...DEFAULT_OPTIONS, ...state.options, ...options };
  validateHooks(hooks, opts);
  state.options = opts;
  state.status = 'running';
  // If an agent switched branches before the crash, go back to the run's own branch.
  if (state.taskId && ws.branch !== state.taskId) {
    const co = await git(ws.dir, ['checkout', '-q', '-f', state.taskId]);
    if (co.code !== 0) throw new Error(`cannot return the workspace to branch ${state.taskId}: ${co.stderr.trim()}`);
    ws = new Workspace(ws.dir, state.taskId, ws.baseSha);
  }
  // Anything after the last completed chunk is a half-done step: discard it.
  await ws.resetHard(state.chunkShas.at(-1) ?? ws.baseSha);
  log.event('resume', { phase: state.phase, chunkIndex: state.chunkIndex });
  return drive({ request: state.request, team, hooks, options: opts, ws, log, state });
}

async function drive(ctx) {
  const { team, hooks, options, ws, log, state } = ctx;
  const finish = (status, extra = {}) => {
    Object.assign(state, { status }, extra);
    log.saveState(state);
    log.event('finish', { status, ...extra });
    return redact({ status, workspaceDir: ws.dir, ...extra });
  };

  try {
    if (state.phase === 'plan') {
      const p = await runPlanPhase(ctx);
      if (p.status === 'failed') {
        // p.reason carries raw adapter/parser detail: keep it in the transcript, give the user plain words.
        log.event('plan-failed', { detail: p.reason });
        return finish('failed', { reason: 'Conductor could not get a usable plan from the AI planner, so nothing was changed. The technical details are in the run transcript; you can resume to try again.' });
      }
      if (p.status !== 'ok') return finish(p.status, { reason: p.reason });
      state.plan = p.plan;
      if (p.note) state.notes.push(p.note);
      Object.assign(state, { phase: 'chunks', chunkIndex: 0, chunkShas: [] });
      log.saveState(state);
    }

    if (state.phase === 'chunks') {
      const total = state.plan.chunks.length;
      for (let i = state.chunkIndex; i < total; i++) {
        const chunk = state.plan.chunks[i];
        const c = await runChunk(ctx, chunk, i);
        if (c.status !== 'done') return finish('stopped', { reason: c.reason });
        await assertOnBranch(ws);
        if (c.note) state.notes.push(c.note);
        state.chunkShas.push(await ws.head());
        state.chunkIndex = i + 1;
        log.saveState(state);
        if (options.approveEachChunk && i < total - 1) {
          const ok = await safeHook(log, 'approveChunk', hooks.approveChunk, { index: i, title: chunk.title, total });
          if (ok !== true) return finish('stopped', { reason: `You stopped the run after step ${i + 1}.` });
        }
      }
      state.phase = 'final';
      log.saveState(state);
    }

    // Final whole-branch review, then the user's gate.
    await assertOnBranch(ws);
    log.event('phase', { name: 'final' });
    const diff = await ws.diff(ws.baseSha);
    const files = await ws.listFiles(ws.baseSha);
    const tests = await ws.runTests(options.testCommand, { timeoutMs: options.testTimeoutMs });
    const r = await callRole(log, team.reviewer, 'reviewer',
      prompts.finalReview({ request: state.request, plan: state.plan, diff, tests }), '',
      { cwd: ws.dir, write: false, timeoutMs: options.agentTimeoutMs });
    const finalReview = verdictOf(r);
    const notes = [...state.notes];
    if (finalReview.decision === 'BLOCK') notes.push(`Final review concern: ${plainReason(finalReview.reason)}`);
    const summary = buildSummary({ request: state.request, plan: state.plan, notes, files, tests });

    const approved = await safeHook(log, 'approveResult', hooks.approveResult, redact({ summary, files, tests, finalReview, diff }));
    if (approved !== true) return finish('rejected', { reason: 'You did not approve the result.' });

    await assertOnBranch(ws);

    for (const suffix of ['', '-2', '-3', '-4', '-5', '-6', '-7', '-8', '-9']) {
      const landed = await ws.land({ repoDir: state.repoDir, branch: `${ws.branch}${suffix}` });
      if (landed.ok) return finish('landed', { branch: landed.branch });
      if (!/already exists/.test(landed.error)) return finish('failed', { reason: landed.error });
    }
    return finish('failed', { reason: `every branch name ${ws.branch}[-2..-9] is taken; the result is kept in ${ws.dir}` });
  } catch (e) {
    return finish('failed', { reason: String(e?.message ?? e) });
  }
}
