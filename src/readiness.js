// src/readiness.js
// Before a run (factory spec §4.2): check each worker, wake the ones that are down, and wait for them
// within a budget. The results feed buildTeam (so nothing is probed twice) and the plain-English lines.
import { checkHealth } from './health.js';
import { wakeWorker, normalizeWake, WAKE_METHOD_TEXT, DEFAULT_WAKE_HINT } from './wake.js';
import { isApiKind, isSubscriptionKind } from './vendors.js';
import { REASON_TEXT } from './router.js';
import { redact } from './secrets.js';

const PROBE_TIMEOUT_MS = { 'local-agent': 60000 }; // as in team.js: the first local call may load the model
const probeTimeout = (p) => PROBE_TIMEOUT_MS[p.adapter.kind] ?? 15000;
const isLocal = (p) => p.canPlay('grunt') && !isApiKind(p.adapter.kind);
const wakeable = (p) => !isApiKind(p.adapter.kind) && !isSubscriptionKind(p.adapter.kind) && (p.wake?.method ?? 'warn') !== 'warn';
const seconds = (ms) => Math.round((ms ?? 0) / 1000);
const plain = (reason) => REASON_TEXT[reason] ?? reason ?? 'not available';
const methodText = (m) => WAKE_METHOD_TEXT[m] ?? m;
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Only these mean the machine or its model server may be switched off; waking cannot fix anything else.
const REACHABILITY = new Set(['unavailable', 'worker-offline']);
const unreachable = (reason) => REACHABILITY.has(reason || 'unavailable');
const withDetail = (s) => `${plain(s.reason)}${s.detail ? ` (${s.detail})` : ''}`;
// What to do when the worker answers but something else is wrong.
const FIX_TEXT = Object.freeze({
  unauthorized: 'Check the key Conductor gives it (the environment variable named in its config) and that its model server accepts it, then try again.',
  'model-missing': 'Install that model on its model server, or correct the model name in the config, then try again.',
  'version-skew': 'Update its program, then try again.',
  'rate-limit': 'Wait a while, then try again.',
});
const fixText = (reason) => FIX_TEXT[reason] ?? 'Fix that, then run "conductor doctor" to check it.';

export function workersToCheck(participants, recalled = [], { local = null } = {}) {
  const locals = participants.filter(isLocal);
  const runLocal = (local && locals.find((p) => p.name === local)) || locals[0] || null;
  const configured = new Set(participants);
  const out = [];
  const add = (p) => { if (p && configured.has(p) && !out.includes(p)) out.push(p); };
  for (const { participant: p } of recalled) {
    if (isApiKind(p.adapter.kind)) continue;
    if (isLocal(p) || wakeable(p)) add(p);
  }
  add(runLocal);
  return out;
}

export async function ensureWorkers(workers, { health = checkHealth, wake = wakeWorker, sleep = sleepMs, now = Date.now, onProgress = () => {} } = {}) {
  const probe = async (p, timeoutMs) => {
    try {
      const h = await health(p.adapter, { timeoutMs });
      return h?.ok === true ? { ok: true, reason: '', detail: null } : { ok: false, reason: h?.reason || 'unavailable', detail: h?.detail ?? null };
    } catch (e) {
      return { ok: false, reason: 'unavailable', detail: redact(String(e?.message ?? e)) };
    }
  };
  return Promise.all(workers.map(async (p) => {
    const w = p.wake ?? normalizeWake(null, p.name);
    const status = (h, extra = {}) => ({
      name: p.name, kind: p.adapter.kind, local: isLocal(p), ok: h.ok, reason: h.reason, detail: h.detail,
      woke: 'not-needed', wakeDetail: '', waitedMs: 0, hint: w.hint, method: w.method, ...extra,
    });
    let h = await probe(p, probeTimeout(p));
    if (h.ok) return status(h);
    // A refused key or a missing model is not a sleeping machine: report it straight away.
    if (!unreachable(h.reason)) return status(h, { woke: 'not-tried' });
    if (w.method === 'warn') return status(h, { woke: 'not-configured' });

    onProgress({ type: 'waking', name: p.name, method: w.method });
    let r;
    try {
      r = await wake(p);
    } catch (e) {
      r = { attempted: true, ok: false, detail: redact(String(e?.message ?? e)) };
    }
    if (r?.ok !== true) {
      onProgress({ type: 'still-down', name: p.name, waitedMs: 0 });
      return status(h, { woke: 'failed', wakeDetail: r?.detail || 'the wake did not work' });
    }

    const start = now();
    for (;;) {
      const left = w.waitMs - (now() - start);
      if (left <= 0) break;
      await sleep(Math.min(w.pollMs, left));
      const remaining = w.waitMs - (now() - start);
      if (remaining <= 0) break;
      // Review Focus 1: a probe can hang until its timeout when the machine is off: never let it outrun the budget.
      h = await probe(p, Math.min(remaining, probeTimeout(p)));
      if (h.ok) break;
    }
    const waitedMs = now() - start;
    onProgress({ type: h.ok ? 'woke' : 'still-down', name: p.name, waitedMs });
    return status(h, { woke: 'sent', wakeDetail: r.detail ?? '', waitedMs });
  }));
}

// buildTeam's health function: a checked worker's adapter (matched by identity) answers from the
// readiness result; every other adapter is probed as usual.
export function cachedHealth(statuses, workers, health = checkHealth) {
  const cached = new Map();
  for (const p of workers) {
    const s = statuses.find((x) => x.name === p.name);
    if (s) cached.set(p.adapter, { ok: s.ok, reason: s.reason, ...(s.detail != null ? { detail: s.detail } : {}) });
  }
  return async (adapter, opts) => (cached.has(adapter) ? { ...cached.get(adapter) } : health(adapter, opts));
}

export function progressText(e) {
  if (e?.type === 'waking') return `Waking ${e.name} (${methodText(e.method)})…`;
  if (e?.type === 'woke') return `${e.name} is awake (after ${seconds(e.waitedMs)} s).`;
  if (e?.type === 'still-down') return e.waitedMs ? `${e.name} did not wake up within ${seconds(e.waitedMs)} s.` : `${e.name} could not be woken.`;
  return '';
}

export function downMessage(s) {
  const who = s.local === false ? `The worker "${s.name}"` : `The local model "${s.name}"`;
  if (!unreachable(s.reason)) return `${who} is not working: ${withDetail(s)}. ${fixText(s.reason)}`;
  const tried = s.woke === 'failed' ? `Conductor tried to wake it, but ${s.wakeDetail}.`
    : s.woke === 'sent' ? `Conductor tried ${methodText(s.method)} and waited ${seconds(s.waitedMs)} seconds.`
      : 'Conductor has no way to wake it set up.';
  return `${who} is not answering: ${plain(s.reason)}. ${tried} To fix it by hand: ${s.hint || DEFAULT_WAKE_HINT}`;
}

export function workerLine(s, lastUsedAt = null) {
  let line = `  ${s.ok ? '✓' : '✗'} ${s.name} (${s.kind})`;
  if (!s.ok) line += `: ${withDetail(s)}`;
  if (s.woke === 'sent') line += s.ok ? ` — woke it with ${methodText(s.method)}` : ` — tried ${methodText(s.method)} and waited ${seconds(s.waitedMs)} s`;
  if (s.woke === 'failed') line += ` — tried ${methodText(s.method)}: ${s.wakeDetail}`;
  if (Number.isFinite(lastUsedAt)) line += ` · last used ${new Date(lastUsedAt).toISOString().slice(0, 10)}`;
  return line;
}
