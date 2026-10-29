import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git, Workspace } from '../workspace.js';
import { redact } from '../secrets.js';
import { appConfig } from './config.js';
import { id, now, requireValue, opaqueId } from './state.js';

const ACTIVE = new Set(['running', 'awaiting-decision', 'queued', 'cancelling']);
const terminal = status => ({ landed: 'completed', stopped: 'paused', paused: 'paused', rejected: 'rejected', failed: 'failed' })[status] ?? 'failed';
const scrub = v => redact(String(v ?? '')).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 8000);
const choices = kind => kind === 'fallback'
  ? [{ id: 'pause', label: 'Pause', consequence: 'No subscription fallback.' }, { id: 'continue', label: 'Use subscriptions', consequence: 'Uses more subscription allowance.' }]
  : [{ id: 'reject', label: 'Reject', consequence: 'Do not proceed.' }, { id: 'approve', label: 'Approve', consequence: kind === 'result' ? 'Create a new branch; do not merge or deploy.' : 'Continue this step.' }];
export function summary(run) {
  const { events, decision, review, request, workspaceDir, clientRequestId, requestIdentity, decisionReceipts, ...out } = run;
  return out;
}
export class Runs {
  constructor({ store, dir, configFile, workerFile = fileURLToPath(new URL('./worker.js', import.meta.url)) }) {
    Object.assign(this, { store, dir, configFile, workerFile });
    this.active = null; this.probing = false; this.listeners = new Set(); this.accepting = true;
  }
  available() { requireValue(this.accepting && !this.store.poisoned, 'The service needs recovery.', 'storage-unavailable', 503); }
  idle() { this.available(); requireValue(!this.active && !this.probing, 'Another run or probe is active.', 'busy', 409); }
  get(runId) { const r = this.store.data.runs.find(r => r.id === runId); requireValue(r, 'Run not found.', 'not-found', 404); return r; }
  event(run, type, message, data = {}) {
    requireValue(run.events.length < 5000, 'The event limit was reached; resume through the CLI.', 'event-limit', 409);
    const event = { schema: 1, runId: run.id, seq: run.events.length + 1, at: now(), type,
      phase: run.phase ?? null, participant: data.participant ?? null, message: scrub(message), data };
    run.events.push(event); run.lastEventSeq = event.seq; run.updatedAt = event.at;
    this.store.save();
    for (const fn of this.listeners) { try { fn(run.id, event); } catch { /* a browser is not a worker */ } }
  }
  async register(body) {
    this.idle(); requireValue(typeof body?.path === 'string' && path.isAbsolute(body.path), 'Enter an absolute repository path.');
    let root;
    try { root = realpathSync(body.path); } catch { requireValue(false, 'Repository folder is unavailable.'); }
    const found = await git(root, ['rev-parse', '--show-toplevel']);
    requireValue(found.code === 0 && realpathSync(found.stdout.trim()) === root, 'Select the Git repository root.');
    const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
    requireValue(head.code === 0, 'Repository needs at least one commit.');
    const previous = this.store.data.repositories.find(r => r.path === root);
    if (previous) return previous;
    const repo = { id: id(), path: root, name: path.basename(root), registeredAt: now() };
    this.store.data.repositories.push(repo); this.store.save(); return repo;
  }
  create(body) {
    this.available();
    requireValue(body && opaqueId(body.clientRequestId) && typeof body.request === 'string' && body.request.trim().length > 0
      && body.request.length <= 16000 && !body.request.includes('\0') && body.presetId === 'default', 'Provide a request, default preset and unique clientRequestId.');
    const identity = JSON.stringify([body.repositoryId, body.request, body.presetId]);
    const previous = this.store.data.runs.find(r => r.clientRequestId === body.clientRequestId);
    if (previous) { requireValue(previous.requestIdentity === identity, 'That request ID was used for another request.', 'conflict', 409); return summary(previous); }
    this.idle(); appConfig(this.configFile);
    requireValue(this.store.data.runs.length < 500, 'Archive old service state before adding more runs.', 'run-limit', 409);
    requireValue(this.store.data.repositories.some(r => r.id === body.repositoryId), 'Register this repository first.');
    const run = { id: id(), repositoryId: body.repositoryId, title: scrub(body.request).slice(0, 120), request: body.request,
      clientRequestId: body.clientRequestId, requestIdentity: identity, createdAt: now(), updatedAt: now(), status: 'queued', phase: 'checking',
      resumable: false, lastEventSeq: 0, activeDecisionId: null, workspaceCommit: null, landedBranch: null,
      coverage: { local: 'unknown', vendors: [], weakened: false, reasons: [] }, events: [], decisionReceipts: {} };
    this.store.data.runs.push(run); this.store.save(); this.launch(run); return summary(run);
  }
  launch(run) {
    this.idle();
    run.status = 'running'; run.activeDecisionId = null; this.store.save();
    // Subscription-only mode must not inherit API billing credentials. Supported
    // subscription CLI authentication remains on the host's normal account store.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY;
    const child = fork(this.workerFile, ['--operator-worker'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env, windowsHide: true, execArgv: [] });
    this.active = { runId: run.id, child };
    let finished = false;
    child.on('message', msg => {
      if (finished || run.status === 'cancelling') return;
      try {
        if (msg.type === 'event') {
          if (msg.workspaceDir) {
            const base = path.resolve(this.dir, 'workspaces');
            const target = path.resolve(msg.workspaceDir);
            requireValue(target.startsWith(base + path.sep), 'Invalid engine workspace.');
            run.workspaceDir = target; run.resumable = true;
          }
          const e = msg.event;
          if (e.type === 'result' && e.ok) {
            const who = e.servedBy ?? e.participant;
            const participant = appConfig(this.configFile).participants.find(p => p.name === who);
            const vendor = participant?.adapter.kind === 'claude-code' ? 'anthropic' : participant?.adapter.kind === 'codex' ? 'openai' : 'local';
            if (vendor === 'local') run.coverage.local = 'used';
            else if (!run.coverage.vendors.includes(vendor)) run.coverage.vendors.push(vendor);
          }
          if (e.type === 'same-vendor-review') {
            run.coverage.weakened = true; run.coverage.reasons.push(scrub(e.detail ?? e.type));
          }
          run.phase = scrub(e.phase ?? e.type);
          const message = e.type === 'call' ? `${e.participant} is working as ${e.role}.`
            : e.type === 'result' ? `${e.servedBy ?? e.participant} ${e.ok ? 'finished' : 'could not complete'} its response.`
              : e.type === 'chunk-done' ? `Finished coding step ${e.index + 1}.`
                : e.detail ?? e.message ?? e.type;
          this.event(run, 'progress', message, { engineType: e.type, participant: scrub(e.participant ?? ''), role: scrub(e.role ?? ''), ok: e.ok ?? null });
        } else if (msg.type === 'question') {
          requireValue(!run.activeDecisionId && ['result', 'plan', 'chunk', 'escalation', 'fallback'].includes(msg.kind), 'Unexpected engine question.');
          const evidence = msg.evidence;
          requireValue(evidence && (evidence.commit === null || /^[a-f0-9]{40}$/.test(evidence.commit)), 'Invalid review evidence.');
          run.decision = { id: msg.id, runId: run.id, kind: msg.kind, createdAt: now(), status: 'pending',
            prompt: scrub(msg.payload.summary ?? msg.payload.message ?? msg.payload.reason ?? 'Review this step.'),
            choices: choices(msg.kind), evidence, revision: id(), resolvedAt: null };
          run.review = redact({ ...msg.payload, commit: evidence.commit, diffId: evidence.diffId, testReportIds: evidence.testReportIds });
          run.workspaceCommit = evidence.commit; run.activeDecisionId = msg.id; run.status = 'awaiting-decision';
          this.event(run, 'decision-pending', run.decision.prompt, { decisionId: msg.id });
        } else if (msg.type === 'finished') {
          finished = true; const outcome = msg.outcome;
          run.status = terminal(outcome.status); run.landedBranch = outcome.branch ?? null;
          run.resumable = ['paused', 'failed', 'interrupted'].includes(run.status) && Boolean(run.workspaceDir);
          run.activeDecisionId = null;
          if (run.coverage.local === 'unknown') run.coverage.local = 'not-used';
          if (run.coverage.vendors.length < 2) { run.coverage.weakened = true; run.coverage.reasons.push('Both subscription vendors did not complete calls in this run.'); }
          this.event(run, 'finished', outcome.reason ?? outcome.status);
        }
      } catch { run.status = 'failed'; run.activeDecisionId = null; child.disconnect(); child.kill(); }
    });
    child.on('error', () => {
      finished = true; run.status = 'failed'; run.activeDecisionId = null;
      run.resumable = Boolean(run.workspaceDir);
      if (!child.pid && this.active?.child === child) this.active = null;
      if (child.connected) child.disconnect();
      try { this.event(run, 'failed', 'The engine worker could not start or communicate. Check the run before retrying.'); }
      catch { this.accepting = false; }
    });
    let exited = false;
    const onExit = () => {
      if (exited) return;
      exited = true;
      if (this.active?.child === child) this.active = null;
      if (!finished || ACTIVE.has(run.status)) {
        run.status = 'interrupted'; run.resumable = Boolean(run.workspaceDir); run.activeDecisionId = null;
        if (run.decision) run.decision.status = 'invalidated';
        try { this.event(run, 'interrupted', 'Worker stopped. Check the run before resuming.'); } catch { this.accepting = false; }
      }
    };
    child.once('exit', onExit); child.once('close', onExit);
    child.send({ type: 'start', configFile: this.configFile, repoDir: this.store.data.repositories.find(r => r.id === run.repositoryId).path,
      baseDir: path.join(this.dir, 'workspaces'), request: run.request, workspaceDir: run.workspaceDir ?? null });
  }
  async answer(run, decisionId, body) {
    this.available(); requireValue(opaqueId(body?.clientRequestId), 'Provide a unique clientRequestId.');
    const identity = JSON.stringify([decisionId, body.choiceId, body.expectedRevision, body.reviewedCommit, body.feedback ?? null]);
    const receipt = run.decisionReceipts[body.clientRequestId];
    if (receipt) { requireValue(receipt.identity === identity, 'Request ID conflict.', 'conflict', 409); return receipt.result; }
    const d = run.decision;
    requireValue(this.active?.runId === run.id && run.status === 'awaiting-decision' && d?.id === decisionId && d.status === 'pending', 'This decision is no longer pending.', 'stale-decision', 409);
    requireValue(body.expectedRevision === d.revision && body.reviewedCommit === d.evidence.commit, 'Review the current evidence first.', 'stale-decision', 409);
    requireValue(d.choices.some(c => c.id === body.choiceId), 'Choose one of the offered decisions.');
    requireValue(body.feedback === undefined || typeof body.feedback === 'string' && body.feedback.length <= 2000, 'Feedback is too long.');
    if (d.kind === 'result' && run.workspaceDir) {
      const ws = await Workspace.open(run.workspaceDir);
      const current = await ws.head();
      if (current !== d.evidence.commit || !(await ws.isClean()) || redact(await ws.diffRange(ws.baseSha, current)) !== run.review.diff) {
        d.status = 'invalidated'; run.activeDecisionId = null;
        this.event(run, 'decision-invalidated', 'The reviewed work changed. Resume for a fresh review.');
        if (this.active?.child.connected) this.active.child.disconnect();
        requireValue(false, 'The reviewed work changed. Resume for a fresh review.', 'stale-decision', 409);
      }
      const saved = run.decisionReceipts[body.clientRequestId];
      if (saved) { requireValue(saved.identity === identity, 'Request ID conflict.', 'conflict', 409); return saved.result; }
      requireValue(d.status === 'pending' && run.activeDecisionId === decisionId && this.active?.runId === run.id,
        'This decision is no longer pending.', 'stale-decision', 409);
    }
    const value = d.kind === 'escalation' ? body.choiceId
      : d.kind === 'fallback' ? body.choiceId === 'continue'
        : body.choiceId === 'approve' ? true : d.kind === 'result' && body.feedback ? { note: body.feedback } : false;
    d.status = 'resolved'; d.resolvedAt = now(); run.activeDecisionId = null; run.status = 'running';
    const result = { accepted: true, decisionId };
    run.decisionReceipts[body.clientRequestId] = { identity, result };
    this.event(run, 'decision-resolved', body.choiceId, { decisionId });
    this.active.child.send({ type: 'answer', id: decisionId, value });
    return result;
  }
  cancel(run) {
    this.available();
    if (!ACTIVE.has(run.status)) return { requested: false, status: run.status };
    run.status = 'cancelling'; run.activeDecisionId = null;
    if (run.decision) run.decision.status = 'invalidated';
    this.event(run, 'cancel-requested', 'Stopping the owned worker; cancellation is not yet confirmed.');
    if (this.active?.runId === run.id) this.active.child.disconnect();
    return { requested: true, status: run.status };
  }
  resume(run) { this.idle(); requireValue(run.resumable && run.workspaceDir, 'This run has no resumable workspace.', 'not-resumable', 409); appConfig(this.configFile); this.launch(run); return summary(run); }
  async close() {
    this.accepting = false;
    if (this.active) {
      const { child } = this.active;
      await new Promise(resolve => { child.once('exit', resolve); child.once('close', resolve); if (child.connected) child.disconnect(); else child.kill(); });
    }
  }
}
