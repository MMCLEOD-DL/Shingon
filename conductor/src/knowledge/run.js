// K8 slice 3: knowledge-base evidence in an ordinary Conductor run (conductor/docs/knowledge-base/k8-conductor-evidence.md
// §9, the interfaces agreed in Codex's review of PR96). runlog.callAgent asks knowledgeForCall() before EVERY agent
// call what context that call may carry. It never throws: evidence is optional, but once evidence has been used, a
// call that cannot be confirmed safe is stopped (a resumable pause) rather than sent.
//
// What lives where:
//   - passages and the client: process-local (a WeakMap keyed by the run's state object), never written to disk;
//   - state.knowledge: only the provenance a later call (or a resumed run) needs to enforce the rule:
//     { sent, scope (every candidate that may receive text), origin, viewRevision }.

import { createKbClient, checkKbUrl, privateHost, KbError } from './client.js';
import { selectEvidence, evidenceFor, recipientsOf, stillFresh, LIMITS } from './evidence.js';
import { KB_TOKEN_ENV, redact } from '../secrets.js';

const SETTINGS = new Set(['url', 'participants', 'collections', 'maxPassages', 'maxChars']);
const DESTINATIONS = new Set(['local-model', 'claude-subscription', 'codex-subscription']);
// Environment settings that send Claude Code or Codex somewhere other than the operator's subscription (Codex review
// of PR101): with any of them set, the route cannot be verified and the candidate gets no destination.
const CLAUDE_ROUTE_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];
const CODEX_ROUTE_ENV = ['OPENAI_BASE_URL'];
const set = (env, names) => names.some((n) => typeof env[n] === 'string' && env[n].trim() !== '');

/**
 * The destination a candidate may be treated as, or null. A candidate counts only if the operator approved it by
 * name in options.knowledge.participants AND the engine can see nothing contradicting that route:
 *   local-model: a local-agent whose configured endpoint is on this machine or a private network (necessary, not
 *     sufficient: the operator's approval vouches for what is behind it);
 *   claude-subscription: Claude Code with no API key, base URL, Bedrock or Vertex setting in its environment;
 *   codex-subscription: Codex in Conductor's frontier home, with no provider or base-URL override and no OPENAI_BASE_URL.
 * Anything else (API kinds, unknown kinds, unapproved names) is no destination, so evidence is withheld from it.
 */
export function trustedDestination(approved = {}, env = process.env) {
  return (candidate) => {
    const claimed = Object.hasOwn(approved, candidate?.name ?? '') ? approved[candidate.name] : null;
    const a = candidate?.adapter;
    if (!claimed || !a) return null;
    if (claimed === 'local-model' && a.kind === 'local-agent') {
      let host;
      try { host = new URL(String(a.baseUrl)).hostname; } catch { return null; }
      return privateHost(host) ? claimed : null;
    }
    if (claimed === 'claude-subscription' && a.kind === 'claude-code') return set(env, CLAUDE_ROUTE_ENV) ? null : claimed;
    if (claimed === 'codex-subscription' && a.kind === 'codex') {
      const frontierHome = Array.isArray(a.homeIdentity) && a.homeIdentity[0] === 'frontier';
      const overridden = (a.extraConfig ?? []).some((kv) => /provider|base_url/i.test(String(kv)));
      return frontierHome && !overridden && !set(env, CODEX_ROUTE_ENV) ? claimed : null;
    }
    return null;
  };
}
const live = new WeakMap(); // state object -> { off } | { client, selection, origin, scope }

/** Validates options.knowledge (null or absent = off). Throws a plain-English Error. */
export function checkKnowledgeOptions(options) {
  const k = options?.knowledge;
  if (k === undefined || k === null) return;
  if (typeof k !== 'object' || Array.isArray(k)) throw new Error('options.knowledge must be an object such as { "url": "http://127.0.0.1:8700" }, or null to turn it off.');
  for (const key of Object.keys(k)) if (!SETTINGS.has(key)) throw new Error(`options.knowledge has an unknown setting "${key}" (known: ${[...SETTINGS].join(', ')}).`);
  try { checkKbUrl(k.url); } catch (e) { throw new Error(`options.knowledge.url: ${e.message}`); }
  const p = k.participants;
  if (!p || typeof p !== 'object' || Array.isArray(p) || !Object.keys(p).length ||
      !Object.entries(p).every(([name, d]) => name && DESTINATIONS.has(d))) {
    throw new Error('options.knowledge.participants must approve each participant that may receive evidence, with its destination, ' +
      'e.g. { "local": "local-model", "claude": "claude-subscription", "codex": "codex-subscription" }.');
  }
  if (k.collections !== undefined) {
    const c = k.collections;
    if (!Array.isArray(c) || c.length < 1 || c.length > 50 || new Set(c).size !== c.length || !c.every((x) => typeof x === 'string' && x && x.length <= 200)) {
      throw new Error('options.knowledge.collections must list 1 to 50 different collection ids.');
    }
  }
  for (const name of ['maxPassages', 'maxChars']) {
    if (k[name] === undefined) continue;
    const [lo, hi] = LIMITS[name];
    if (!Number.isSafeInteger(k[name]) || k[name] < lo || k[name] > hi) throw new Error(`options.knowledge.${name} must be a whole number from ${lo} to ${hi}.`);
  }
  if (options.council) throw new Error('options.knowledge cannot be used with the council yet: turn one of them off.');
}

/** Entry points that do not use knowledge evidence in this slice (factory, change, council) refuse a config that turns it on. */
export function refuseKnowledge(options, where) {
  if (options?.knowledge) {
    throw new Error(`Knowledge-base evidence (options.knowledge) is for ordinary Conductor runs only; ${where} does not use it yet. Remove options.knowledge from the config, or run without ${where}.`);
  }
}

const STOP = 'The company knowledge-base policy for this run could not be confirmed after evidence had been used, so nothing derived from it was sent on. ' +
  'Resume once the knowledge service is reachable and its policy is unchanged, or start a fresh run.';

async function assemble(ctx) {
  if (live.has(ctx.state)) return live.get(ctx.state);
  const cfg = ctx.options.knowledge;
  let k;
  try {
    const token = process.env[KB_TOKEN_ENV];
    if (!token) throw new KbError('config', `${KB_TOKEN_ENV} is not set`);
    const client = createKbClient({ url: cfg.url, token });
    const seats = [ctx.team?.author, ctx.team?.reviewer, ctx.team?.local].filter(Boolean);
    const maxPassages = cfg.maxPassages ?? 8;
    const collections = await client.collections();
    const query = redact(String(ctx.request ?? '')).trim().slice(0, 1000) || 'the requested change';
    const search = await client.search({ query, limit: maxPassages, ...(cfg.collections ? { collections: cfg.collections } : {}) });
    const trust = trustedDestination(cfg.participants);
    const selection = selectEvidence({ collections, search, seats, maxPassages, maxChars: cfg.maxChars ?? 12000, destinationOf: trust });
    for (const report of selection.reports) ctx.log.event('evidence-withheld', { report });
    for (const u of selection.unreported) ctx.log.event('evidence-withheld', { collectionId: u.collectionId, documents: u.documentIds.length, allowedDestinations: [] });
    k = { client, selection, trust, origin: client.origin, scope: [...new Set(seats.flatMap(recipientsOf).map((r) => r.name))] };
  } catch (e) {
    k = { off: true };
    ctx.log.event('evidence-unavailable', { reason: e instanceof KbError ? e.code : 'error' });
  }
  live.set(ctx.state, k);
  return k;
}

function stop(ctx, reason) {
  ctx.log.event('evidence-stopped', { reason });
  return { stop: STOP };
}

/**
 * What one call to `participant` (a Seat or a participant) may carry: { context } (the evidence block, the
 * no-support wording, the withheld notice, or '') or { stop } when evidence was already used and this call can no
 * longer be confirmed safe.
 */
export async function knowledgeForCall(ctx, participant) {
  const cfg = ctx.options?.knowledge;
  const prov = ctx.state?.knowledge ?? null;
  if (!cfg) return prov?.sent ? stop(ctx, 'knowledge settings missing on a run that used evidence') : { context: '' };
  if (ctx.options.council || ctx.options.factoryFeature) {
    // Backstop: the entry points refuse this combination; never fetch evidence for them.
    if (!live.has(ctx.state)) { live.set(ctx.state, { off: true }); ctx.log.event('evidence-unavailable', { reason: 'not-for-this-run' }); }
    return prov?.sent ? stop(ctx, 'evidence on a council or factory run') : { context: '' };
  }
  const k = await assemble(ctx);
  if (k.off) return prov?.sent ? stop(ctx, 'knowledge service unavailable') : { context: '' };
  if (!(await stillFresh(k.client, k.selection.viewRevision))) {
    if (prov?.sent) return stop(ctx, 'policy changed or could not be confirmed');
    live.set(ctx.state, { off: true });
    ctx.log.event('evidence-dropped', { reason: 'policy changed or could not be confirmed before any evidence was used' });
    return { context: '' };
  }
  if (prov?.sent) {
    const outOfScope = recipientsOf(participant).some((r) => !prov.scope.includes(r.name) || !k.trust?.(r));
    if (prov.viewRevision !== k.selection.viewRevision || prov.origin !== k.origin || outOfScope) {
      return stop(ctx, outOfScope ? 'a recipient outside the approved scope' : 'policy revision or service changed since evidence was used');
    }
  }
  const { text, sent } = evidenceFor(k.selection, participant);
  if (sent && !prov?.sent) {
    ctx.state.knowledge = { sent: true, scope: k.scope, origin: k.origin, viewRevision: k.selection.viewRevision };
    try { ctx.log.saveState(ctx.state); } catch { /* the next checkpoint saves it */ }
    ctx.log.event('evidence-used', { count: k.selection.passages.length, evidence: k.selection.evidence, viewRevision: k.selection.viewRevision });
  }
  return { context: text };
}

/**
 * The per-dispatch gate (Codex review of PR101): runlog.callAgent passes it to Seat.run as opts.beforeDispatch, which
 * calls it immediately before EACH candidate is tried, fallbacks and retries after a wait included. Once evidence has
 * been used, a candidate is sent nothing unless the pinned policy revision still holds, it is in the approved scope
 * and its route is still trusted; otherwise { stop } ends the call as a resumable pause (never a failover).
 */
export async function knowledgeGate(ctx, candidate) {
  const prov = ctx.state?.knowledge;
  if (!prov?.sent) return {};
  const k = live.get(ctx.state);
  if (!k || k.off) return stop(ctx, 'knowledge service unavailable');
  if (k.origin !== prov.origin || k.selection.viewRevision !== prov.viewRevision) return stop(ctx, 'policy revision or service changed since evidence was used');
  if (!prov.scope.includes(candidate?.name) || !k.trust(candidate)) return stop(ctx, 'a recipient outside the approved scope');
  if (!(await stillFresh(k.client, prov.viewRevision))) return stop(ctx, 'policy changed or could not be confirmed');
  return {};
}
