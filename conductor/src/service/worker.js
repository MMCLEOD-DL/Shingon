// One disposable worker per run: the engine's process-global child registry never
// shares a process with another run or a connection probe.
import { runTask, resume } from '../conductor.js';
import { buildTeam, LOCAL_DOWN_WARNING } from '../team.js';
import { Workspace } from '../workspace.js';
import { killAllChildren } from '../exec.js';
import { redact } from '../secrets.js';
import { appConfig } from './config.js';
import { randomUUID, createHash } from 'node:crypto';

let workspaceDir = null, pending = null, started = false;
const send = (message) => { if (process.connected) process.send(redact(message)); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function currentEvidence() {
  if (!workspaceDir) return null;
  const ws = await Workspace.open(workspaceDir);
  return { commit: await ws.head(), clean: await ws.isClean(), diff: await ws.diffRange(ws.baseSha, await ws.head()) };
}
async function ask(kind, payload) {
  const snapshot = kind === 'result' ? await currentEvidence() : null;
  if (snapshot && (!snapshot.clean || redact(snapshot.diff) !== payload.diff)) throw new Error('The work changed before review; resume for a fresh review.');
  if (JSON.stringify(payload).length > 1024 * 1024) throw new Error('This review is too large for the local app. Review the run through the CLI.');
  const evidence = { commit: snapshot?.commit ?? null,
    diffId: snapshot ? digest(payload.diff) : null,
    testReportIds: payload.tests ? [digest(payload.tests)] : [] };
  return new Promise((resolve, reject) => {
    pending = { id: randomUUID(), resolve, reject, snapshot, kind };
    send({ type: 'question', id: pending.id, kind, payload, evidence });
  });
}
process.on('message', async msg => {
  if (msg?.type === 'answer' && pending?.id === msg.id) {
    const question = pending;
    pending = null;
    try {
      if (question.snapshot && digest(await currentEvidence()) !== digest(question.snapshot)) throw new Error('The reviewed commit or files changed; resume for a fresh review.');
      question.resolve(msg.value);
    } catch (e) {
      if (question.kind === 'result' && msg.value === true) {
        // Approval has not reached the engine: land() cannot have run. Rejecting
        // the hook would be treated as a user rejection and archive/delete the
        // workspace. Leave that hook unresolved and exit after delivering this
        // explicit refusal, preserving engine state for a fresh review instead.
        process.send(redact({ type: 'finished', outcome: { status: 'failed',
          reasonCode: 'review-changed', landingState: 'not-started',
          reason: 'The reviewed commit or files could not be confirmed; nothing was landed. The work is kept. Resume for a fresh review.', workspaceDir } }),
        () => { if (process.connected) process.disconnect(); });
      } else question.reject(e);
    }
    return;
  }
  if (msg?.type !== 'start' || started) return;
  started = true;
  workspaceDir = msg.workspaceDir ?? null;
  try {
    const config = appConfig(msg.configFile);
    const prepare = async () => {
      const built = await buildTeam(config.participants, { routing: config.routing });
      if (!built.ok) return { outcome: { status: 'failed', reason: built.error } };
      if (built.localDown) {
        const answer = await ask('fallback', { summary: 'The local model is unavailable. Subscription fallback uses your allowance. Pause, or explicitly continue with subscription models.', reason: built.localDown.reason });
        if (answer !== true) return { outcome: {
          status: 'paused', reasonCode: msg.workspaceDir ? undefined : 'paused-before-work',
          reason: 'Local model unavailable; subscription fallback was not approved.',
        } };
        built.warnings.push(LOCAL_DOWN_WARNING);
      }
      return { team: built.team, warnings: built.warnings, options: { allowSameVendor: built.allowSameVendor } };
    };
    const hooks = {
      onEvent: e => { if (e.type === 'start' && e.workspace) workspaceDir = e.workspace; send({ type: 'event', event: e, workspaceDir }); },
      approveResult: p => ask('result', p), escalate: p => ask('escalation', p),
      approvePlan: p => ask('plan', p), approveChunk: p => ask('chunk', p), confirmLocalFallback: p => ask('fallback', p),
    };
    const options = { ...config.options, confirmLocalFallback: true };
    // Runs without a baseline retain the existing pre-work readiness flow.
    let args = { repoDir: msg.repoDir, hooks, options, prepare };
    if (!msg.workspaceDir && !options.testCommand) {
      const prepared = await prepare();
      if (prepared.outcome) { send({ type: 'finished', outcome: prepared.outcome }); return; }
      args = { ...args, ...prepared, prepare: undefined, options: { ...options, ...prepared.options } };
    }
    const outcome = msg.workspaceDir
      ? await resume({ ...args, workspaceDir: msg.workspaceDir })
      : await runTask({ ...args, request: msg.request, baseDir: msg.baseDir });
    send({ type: 'finished', outcome });
  } catch (e) { send({ type: 'finished', outcome: { status: 'failed', reason: String(e?.message ?? e), workspaceDir } }); }
  finally { killAllChildren(); if (process.connected) process.disconnect(); }
});
process.on('disconnect', () => { killAllChildren(); process.exit(0); });
process.on('SIGTERM', () => { killAllChildren(); process.exit(0); });
