// src/conductor.js
import path from 'node:path';
import { mkdirSync, copyFileSync, existsSync, constants as fsConstants } from 'node:fs';
import { Workspace, isUnderTmp } from './workspace.js';
import { RunLog, callAgent } from './runlog.js';
import { DEFAULT_OPTIONS } from './options.js';
import { runPlanPhase } from './planPhase.js';
import { runChunk } from './chunkPhase.js';
import { verdictOf } from './review.js';
import * as prompts from './prompts.js';
import { buildSummary, plainReason } from './escalation.js';
import { redact, REDACTED } from './secrets.js';
import { vendorOf } from './vendors.js';
import { SAME_VENDOR_WARNING } from './team.js';
import { clip } from './text.js';

export { DEFAULT_OPTIONS };

const FINISHED = new Set(['landed', 'rejected', 'stopped']);
const SUFFIXES = ['', '-2', '-3', '-4', '-5', '-6', '-7', '-8', '-9'];
const RESUMABLE_PHASES = new Set(['plan', 'chunks', 'final']);
const TMP_BASEDIR_WARNING = 'Warning: the workspace is under the temporary directory, where AI agents can also write; ' +
  'use the default location (~/.conductor/workspaces) for real work.';
const CREDENTIAL_WARNING = 'Warning: this change contains something that looks like a credential (shown as [redacted]); check it before approving.';
const INTERNAL_PROBLEM = 'Conductor hit an internal problem and stopped. Your repository was not changed. ' +
  'Details are in the run transcript; you can resume.';
const pausedReason = (why) => `Conductor paused: ${why}. Your repository is unchanged and the finished steps are kept; run "conductor resume" when it is available again.`;

export function validateTeam(team, { allowSameVendor = false } = {}) {
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
  if (!allowSameVendor && vendorOf(author.adapter.kind) === vendorOf(reviewer.adapter.kind)) {
    throw new Error(`two-vendor rule: ${author.name} and ${reviewer.name} are both ${vendorOf(author.adapter.kind)} models; pick frontier participants from different vendors`);
  }
}

export function validateHooks(hooks, options) {
  if (typeof hooks?.escalate !== 'function') throw new Error('hooks.escalate is required');
  if (typeof hooks?.approveResult !== 'function') throw new Error('hooks.approveResult is required');
  if (options.approveEachChunk && typeof hooks.approveChunk !== 'function') {
    throw new Error('hooks.approveChunk is required when approveEachChunk is set');
  }
  if (options.approvePlan && typeof hooks.approvePlan !== 'function') {
    throw new Error('hooks.approvePlan is required when approvePlan is set');
  }
  if (options.confirmLocalFallback && typeof hooks.confirmLocalFallback !== 'function') {
    throw new Error('hooks.confirmLocalFallback is required when confirmLocalFallback is set');
  }
}

// The workspace must sit exactly at `sha` with a clean tree; anything else
// (a test command or agent that committed or left files) is reset away.
async function holdAt(ws, log, sha, eventName) {
  const head = await ws.head();
  if (head === sha && (await ws.isClean())) return;
  log.event(eventName, { expected: sha, found: head });
  await ws.resetHard(sha);
}

async function safeHook(log, name, fn, arg) {
  try {
    return await fn(arg);
  } catch (e) {
    log.event('hook-error', { hook: name, error: String(e?.message ?? e) });
    return undefined;
  }
}

const message = (e) => String(e?.message ?? e);

export async function runTask({ repoDir, request, team, hooks, options = {}, baseDir, warnings = [] }) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  validateTeam(team, opts);
  validateHooks(hooks, opts);
  if (typeof request !== 'string' || !request.trim()) throw new Error('request must be a non-empty string');
  await Workspace.assertRepo(repoDir);

  let ws;
  try {
    ws = await Workspace.create({ repoDir, baseDir, taskId: request });
  } catch (e) {
    return redact({ status: 'failed', workspaceDir: null, reason: `Could not make a working copy of your repository: ${message(e)}` });
  }
  let log;
  let state;
  try {
    log = new RunLog(ws.metaDir, { onEvent: hooks.onEvent });
    state = {
      version: 1, taskId: ws.branch, request, repoDir: path.resolve(repoDir), options: opts, source: ws.source,
      phase: 'plan', plan: null, chunkIndex: 0, chunkShas: [], notes: [], warnings: [], status: 'running',
    };
    if (isUnderTmp(path.dirname(ws.dir))) state.warnings.push(TMP_BASEDIR_WARNING); // N4
    for (const w of warnings) if (!state.warnings.includes(w)) state.warnings.push(w);
    log.saveState(state);
  } catch (e) {
    return redact({ status: 'failed', workspaceDir: ws.dir, reason: `Conductor could not write its run state, so it did not start: ${message(e)}` });
  }
  log.event('start', { request, workspace: ws.dir, branch: ws.branch });
  if (state.warnings.includes(TMP_BASEDIR_WARNING)) {
    log.event('basedir-warning', { baseDir: path.dirname(ws.dir), detail: 'baseDir is under the temp dir, inside Codex workspace-write\'s default writable roots' });
  }
  if (ws.source?.dirty) {
    log.event('warning', { kind: 'uncommitted-changes', detail: 'the repository has uncommitted or untracked changes; the run starts from the last commit without them' });
  }
  return drive({ request, team, hooks, options: opts, ws, log, state });
}

// A run state resume can safely continue (T9-M3). Returns a problem or null.
async function stateProblem(state, ws) {
  if (!['running', 'failed', 'paused'].includes(state.status)) return `its status is ${state.status}`;
  if (!RESUMABLE_PHASES.has(state.phase)) return `its phase is ${state.phase}`;
  if (typeof state.taskId !== 'string' || !state.taskId.startsWith('conductor/')) return 'its branch name is missing';
  if (typeof state.request !== 'string' || !state.request.trim()) return 'its request is missing';
  if (!Array.isArray(state.chunkShas) || !Number.isInteger(state.chunkIndex) || state.chunkIndex !== state.chunkShas.length) {
    return 'its record of completed steps is inconsistent';
  }
  if (state.phase !== 'plan' && !state.plan?.chunks?.length) return 'it has no plan';
  let prev = ws.baseSha;
  for (const sha of state.chunkShas) {
    if (typeof sha !== 'string' || !(await ws.isAncestor(prev, sha))) return 'a completed step is missing from the workspace';
    prev = sha;
  }
  return null;
}

// repoDir: the repository the caller expects this run to land in. It must match
// the one recorded when the workspace was created (Ruling 11 / I2).
// Always resolves: anything that stops a resume is a 'failed' outcome with a plain reason.
export async function resume({ workspaceDir, repoDir, team, hooks, options = {}, warnings = [] }) {
  validateTeam(team, options);
  if (typeof repoDir !== 'string' || !repoDir) throw new Error('resume needs the repoDir the run belongs to');
  const refuse = (detail, log, dir = workspaceDir) => {
    try { log?.event('resume-refused', { detail }); } catch {}
    return redact({ status: 'failed', workspaceDir: dir, reason: `Conductor will not resume this run: ${detail}. Nothing was changed.` });
  };

  let ws;
  let log;
  let state;
  try {
    Workspace.unpoison(workspaceDir);
    ws = await Workspace.open(workspaceDir);
    log = new RunLog(ws.metaDir, { onEvent: hooks?.onEvent });
    state = log.loadState();
  } catch (e) {
    return refuse(message(e), log);
  }
  if (!state) return refuse(`there is no Conductor run state in ${workspaceDir}`, log);
  if (FINISHED.has(state.status)) {
    return redact({ status: state.status, workspaceDir: ws.dir, branch: state.branch, reason: state.reason });
  }
  const repoProblem = (await ws.checkRepo(repoDir)) ?? (path.resolve(repoDir) === state.repoDir ? null : 'the run state names a different repository');
  if (repoProblem) return refuse(repoProblem, log, ws.dir);
  const opts = { ...DEFAULT_OPTIONS, ...state.options, ...options };
  validateHooks(hooks, opts);

  try {
    const { gitdir, config: tampered } = await ws.guardGitDir(); // throws (and poisons) if unrepairable
    if (gitdir) log.event('gitdir-tampered', { participant: null, role: null, ...gitdir });
    if (tampered) log.event('config-tampered', { participant: null, role: null, ...tampered });
    ws = new Workspace(ws.dir, state.taskId, ws.baseSha);
    const problem = await stateProblem(state, ws);
    if (problem) return refuse(`its saved state is not usable (${problem})`, log, ws.dir);
    // Put the run's own branch back at the last completed chunk (an agent may have
    // switched branches before the crash); anything after it is a half-done step.
    const at = state.chunkShas.at(-1) ?? ws.baseSha;
    await ws.returnToBranch(at);
    await ws.resetHard(at);
  } catch (e) {
    log.event('resume-error', { detail: message(e) });
    return redact({ status: 'failed', workspaceDir: ws.dir, reason: 'Conductor could not prepare the workspace to resume. Details are in the run transcript.' });
  }
  state.warnings ??= [];
  for (const w of warnings) if (!state.warnings.includes(w)) state.warnings.push(w);
  // Consent covers one run of the process: a resumed run asks again if the local model is still down.
  if (state.flags) delete state.flags.localFallbackOk;
  state.options = opts;
  state.status = 'running';
  log.event('resume', { phase: state.phase, chunkIndex: state.chunkIndex });
  return drive({ request: state.request, team, hooks, options: opts, ws, log, state });
}

// After a landed or rejected run nothing is left to resume: keep the transcript
// at <baseDir>/logs/<taskId>.jsonl and delete the workspace (m4).
function archive(ws, log, state) {
  const logsDir = path.join(path.dirname(ws.dir), 'logs');
  mkdirSync(logsDir, { recursive: true });
  const stem = state.taskId.replace(/[^A-Za-z0-9._-]+/g, '-');
  for (let n = 1; n < 1000; n++) {
    const dest = path.join(logsDir, `${stem}${n === 1 ? '' : `-${n}`}.jsonl`);
    if (existsSync(dest)) continue;
    try {
      copyFileSync(log.transcript, dest, fsConstants.COPYFILE_EXCL);
    } catch (e) {
      if (e?.code === 'EEXIST') continue;
      throw e;
    }
    ws.remove();
    return dest;
  }
  throw new Error('no free transcript name');
}

async function drive(ctx) {
  const { team, hooks, options, ws, log, state } = ctx;
  const finish = (status, extra = {}) => {
    Object.assign(state, { status }, extra);
    if (FINISHED.has(status)) state.phase = 'done';
    // Neither may stop drive from resolving: the outcome still reaches the caller.
    try { log.saveState(state); } catch (e) { try { log.event('state-error', { detail: message(e) }); } catch {} }
    try { log.event('finish', { status, ...extra }); } catch {}
    const out = { status, workspaceDir: ws.dir, ...extra };
    if ((status === 'landed' || status === 'rejected') && options.keepWorkspace !== true) {
      try {
        out.transcript = archive(ws, log, state);
        out.workspaceDir = null;
      } catch (e) {
        try { log.event('cleanup-error', { detail: message(e) }); } catch {}
      }
    }
    return redact(out);
  };

  for (const member of new Set([team.author, team.reviewer, team.local])) member.bind?.((type, data) => log.event(type, data));

  try {
    if (state.phase === 'plan') {
      const p = await runPlanPhase(ctx);
      if (p.status === 'failed') {
        // p.reason carries raw adapter/parser detail: keep it in the transcript, give the user plain words.
        log.event('plan-failed', { detail: p.reason });
        return finish('failed', { reason: 'Conductor could not get a usable plan from the AI planner, so nothing was changed. The technical details are in the run transcript; you can resume to try again.' });
      }
      if (p.status === 'paused') return finish('paused', { reason: pausedReason(p.reason) });
      if (p.status !== 'ok') return finish(p.status, { reason: p.reason });
      state.plan = p.plan;
      if (p.note) state.notes.push(p.note);
      // Spec §8 stop point 1 (off by default). Asked before phase moves on, so a Ctrl-C here re-plans and asks again on resume.
      if (options.approvePlan) {
        const ok = await safeHook(log, 'approvePlan', hooks.approvePlan, redact({
          summary: state.plan.summary, steps: state.plan.chunks.map((c) => c.title), note: p.note ? plainReason(p.note) : null,
        }));
        if (ok !== true) return finish('stopped', { reason: 'You did not approve the plan, so nothing was changed.' });
      }
      Object.assign(state, { phase: 'chunks', chunkIndex: 0, chunkShas: [] });
      log.saveState(state);
    }

    if (state.phase === 'chunks') {
      const total = state.plan.chunks.length;
      for (let i = state.chunkIndex; i < total; i++) {
        const chunk = state.plan.chunks[i];
        const prevSha = state.chunkShas.at(-1) ?? ws.baseSha;
        const c = await runChunk(ctx, chunk, i);
        if (c.status === 'failed') return finish('failed', { reason: c.reason });
        if (c.status === 'paused') return finish('paused', { reason: pausedReason(c.reason) });
        if (c.status !== 'done') return finish('stopped', { reason: c.reason });
        await ws.assertOnBranch();
        if (c.note) state.notes.push(c.note);
        const sha = await ws.head();
        state.chunkShas.push(sha);
        state.chunkIndex = i + 1;
        log.saveState(state);
        if (options.approveEachChunk && i < total - 1) {
          // Give the user something to judge (m1): what changed, any note, the tests.
          const ok = await safeHook(log, 'approveChunk', hooks.approveChunk, redact({
            index: i, title: chunk.title, total,
            files: await ws.filesRange(prevSha, sha), note: c.note ? plainReason(c.note) : null, tests: c.tests ?? null,
          }));
          if (ok !== true) return finish('stopped', { reason: `You stopped the run after step ${i + 1}.` });
        }
      }
      state.phase = 'final';
      log.saveState(state);
    }

    // A crash between land and finish: the branch may already be there (T9-M1).
    const approvedSha = state.chunkShas.at(-1) ?? ws.baseSha;
    if (state.landing?.sha === approvedSha && approvedSha !== ws.baseSha) {
      const already = await Workspace.findBranchAt(state.repoDir, SUFFIXES.map((x) => `${state.taskId}${x}`), approvedSha);
      if (already) {
        log.event('landed-before-crash', { branch: already, sha: approvedSha });
        return finish('landed', { branch: already });
      }
    }
    delete state.landing; // nothing was landed: this is a fresh pass through the gate

    // Final whole-branch review, then the user's gate. What the user approves is
    // exactly approvedSha: diffs are commit-to-commit, and land ships that sha.
    await ws.assertOnBranch();
    log.event('phase', { name: 'final' });
    await holdAt(ws, log, approvedSha, 'final-reset');
    const diff = await ws.diffRange(ws.baseSha, approvedSha);
    const files = await ws.filesRange(ws.baseSha, approvedSha);
    const tests = await ws.runTests(options.testCommand, { timeoutMs: options.testTimeoutMs });
    const r = await callAgent(ctx, team.reviewer, 'reviewer',
      prompts.finalReview({ request: state.request, plan: state.plan, diff, tests, base: ws.baseSha }),
      { cwd: ws.dir, write: false, timeoutMs: options.agentTimeoutMs });
    if (r.failure === 'no-participant') return finish('paused', { reason: pausedReason(r.error) });
    const finalReview = verdictOf(r);
    const notes = [...state.notes];
    if (finalReview.decision === 'BLOCK') notes.push(`Final review concern: ${plainReason(finalReview.reason)}`);
    const warnings = [...(state.warnings ?? [])];
    if (state.usage?.apiCalls) {
      const n = state.usage.apiCalls;
      const cost = state.usage.apiCostUsd > 0 ? `, about $${state.usage.apiCostUsd.toFixed(2)}.` : ' (the cost was not reported).';
      warnings.push(`Paid API use this run: ${n} call${n === 1 ? '' : 's'}${cost}`);
    }
    if (state.flags?.sameVendor && !warnings.includes(SAME_VENDOR_WARNING)) warnings.push(SAME_VENDOR_WARNING);
    if (redact(diff).includes(REDACTED)) warnings.push(CREDENTIAL_WARNING); // N2: redaction hides it; the file still lands
    const summary = buildSummary({ request: state.request, plan: state.plan, notes, files, tests, source: state.source, warnings });

    // The hook never sees the raw IRREVERSIBLE marker (m2).
    const shownReview = { ...finalReview, reason: plainReason(finalReview.reason), detail: plainReason(finalReview.detail) };
    const approved = await safeHook(log, 'approveResult', hooks.approveResult, redact({ summary, files, tests, finalReview: shownReview, diff }));
    if (approved !== true) {
      // "[n] reject with a note" (spec §8): keep the user's words with the run.
      const raw = approved && typeof approved === 'object' && typeof approved.note === 'string' ? approved.note.trim() : '';
      const note = raw ? clip(redact(raw), 2000) : null;
      if (note) log.event('gate-note', { note });
      return finish('rejected', { reason: 'You did not approve the result.', ...(note ? { note } : {}) });
    }

    // The test command and the reviewer ran after the diff was taken: re-check.
    const tampered = ws.restoreConfigIfTampered();
    if (tampered) log.event('config-tampered', { participant: null, role: null, ...tampered });
    await ws.assertOnBranch();
    await holdAt(ws, log, approvedSha, 'final-drift');

    state.landing = { sha: approvedSha };
    log.saveState(state);
    for (const suffix of SUFFIXES) {
      const landed = await ws.land({ repoDir: state.repoDir, branch: `${ws.branch}${suffix}`, sha: approvedSha });
      if (landed.ok) return finish('landed', { branch: landed.branch });
      if (!/already exists/.test(landed.error)) {
        log.event('land-failed', { detail: landed.error });
        return finish('failed', { reason: `Could not create the result branch in your repository: ${landed.error}; the finished work is kept in ${ws.dir}.` });
      }
    }
    return finish('failed', { reason: `Could not create the result branch in your repository: every branch name ${ws.branch}[-2..-9] is taken; the finished work is kept in ${ws.dir}.` });
  } catch (e) {
    const detail = message(e);
    try { log.event('run-error', { detail }); } catch {}
    // The branch-guard sentence is already plain; everything else gets plain words (m8).
    if (/is no longer on its branch/.test(detail)) return finish('failed', { reason: detail });
    if (state.landing) {
      return finish('failed', { reason: 'Conductor hit an internal problem while creating the result branch in your repository. Details are in the run transcript; resume to finish.' });
    }
    return finish('failed', { reason: INTERNAL_PROBLEM });
  }
}
