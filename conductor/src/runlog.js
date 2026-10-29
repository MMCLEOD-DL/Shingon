// src/runlog.js
import { mkdirSync, appendFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { makeResult } from './result.js';
import { clip } from './text.js';
import { redact } from './secrets.js';
import { vendorOf, isApiKind } from './vendors.js';

// Two-vendor rule at run time (spec §7): a frontier model's work reviewed by the same
// vendor is allowed, but the run is flagged so the summary can say so. Local work never counts.
export function noteSameVendor(ctx, { phase, index = null, producerVendor, result, participant }) {
  if (!producerVendor || producerVendor === 'local' || !result?.ok) return;
  const vendor = vendorOf(result.servedKind ?? participant.adapter?.kind);
  if (vendor !== producerVendor) return;
  ctx.state.flags ??= {};
  ctx.state.flags.sameVendor = true;
  ctx.log.event('same-vendor-review', { phase, index, vendor });
}

export class RunLog {
  // metaDir: the workspace's metadata directory (Workspace#metaDir, `<ws>.conductor/`),
  // outside the agents' cwd so they cannot rewrite the run state or the transcript.
  constructor(metaDir, { onEvent } = {}) {
    this.dir = metaDir;
    mkdirSync(this.dir, { recursive: true });
    this.transcript = path.join(this.dir, 'transcript.jsonl');
    this.statePath = path.join(this.dir, 'state.json');
    this.onEvent = onEvent;
    this.writeErrors = 0;
  }

  // Never throws: a transcript that cannot be written is counted and reported
  // through onEvent, so callRole keeps its never-throws contract.
  event(type, data = {}) {
    let entry = redact({ ts: new Date().toISOString(), type, ...data });
    try {
      appendFileSync(this.transcript, JSON.stringify(entry) + '\n');
    } catch (e) {
      this.writeErrors++;
      entry = { ...entry, logError: String(e?.message ?? e) };
    }
    try { this.onEvent?.(entry); } catch {}
    return entry;
  }

  saveState(state) {
    const tmp = `${this.statePath}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify(redact(state), null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.statePath);
  }

  loadState() {
    if (!existsSync(this.statePath)) return null;
    let s;
    try {
      s = JSON.parse(readFileSync(this.statePath, 'utf8'));
    } catch (e) {
      throw new Error(`corrupt run state at ${this.statePath}: ${e.message}`);
    }
    if (!s || typeof s !== 'object' || Array.isArray(s) || s.version !== 1) {
      throw new Error(`corrupt run state at ${this.statePath}: not a version 1 state object`);
    }
    return s;
  }
}

export async function callRole(log, participant, role, task, context = '', opts = {}) {
  // Prompts leave for third-party vendors: no secret value may be in them.
  task = redact(task);
  context = redact(context);
  log.event('call', { participant: participant.name, role, write: opts.write === true, task: clip(task, 1000) });
  let result;
  try {
    result = await participant.run(role, task, context, opts);
  } catch (e) {
    result = makeResult({ ok: false, error: String(e?.message ?? e) });
  }
  const v = result.verdict;
  log.event('result', {
    participant: participant.name, role, servedBy: result.servedBy ?? null, ok: result.ok,
    error: clip(redact(typeof result.error === 'string' ? result.error : (result.error == null ? '' : String(result.error))), 2000) || null,
    verdict: v && { ...v, reason: clip(redact(typeof v.reason === 'string' ? v.reason : ''), 1000) },
    costUsd: result.usage?.costUsd ?? null, text: clip(redact(result.text), 2000),
  });
  return result;
}

// Every agent call the loop makes. An agent may have written the workspace's
// .git/config (core.fsmonitor, diff drivers, filters...) so that Conductor's next
// own git call runs its commands: restore the sealed config before anything else runs.
// The git dir itself is checked first (N3): a gitfile or commondir redirect would
// make even the config restore, and every later git call, act on another repo.
// A repaired git-dir tamper turns the call into ok:false with `gitdirTampered`,
// so it counts as a failed attempt / BLOCK; an unrepairable one throws.
export async function callAgent(ctx, participant, role, task, opts = {}) {
  let result = await callRole(ctx.log, participant, role, task, '', opts);
  // Usage totals (spec §7 budget awareness): cost as the CLIs/APIs report it, and paid API calls.
  const servedKind = result.servedKind ?? participant.adapter?.kind;
  const usage = (ctx.state.usage ??= { costUsd: 0, apiCostUsd: 0, apiCalls: 0 });
  const cost = result.usage?.costUsd;
  if (typeof cost === 'number' && Number.isFinite(cost)) {
    usage.costUsd += cost;
    if (isApiKind(servedKind)) usage.apiCostUsd += cost;
  }
  if (isApiKind(servedKind)) usage.apiCalls += 1;
  let gitdir;
  let tampered;
  try {
    ({ gitdir, config: tampered } = await ctx.ws.guardGitDir());
  } catch (e) {
    ctx.log.event('gitdir-tampered', { participant: participant.name, role, repaired: false, detail: String(e?.message ?? e) });
    throw e;
  }
  if (tampered) ctx.log.event('config-tampered', { participant: participant.name, role, ...tampered });
  if (gitdir) {
    ctx.log.event('gitdir-tampered', { participant: participant.name, role, ...gitdir });
    result = makeResult({ ok: false, error: `${participant.name} tampered with the workspace git directory (${gitdir.problems.join('; ')}); that attempt was discarded` });
    result.gitdirTampered = true;
  }
  return result;
}
