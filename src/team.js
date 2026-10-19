// src/team.js
// Preflight + preference (spec §7): probe everyone, pick author and reviewer from different
// vendors, order each Seat's fallbacks by the ladder, and say plainly when the run is degraded.
import { checkHealth } from './health.js';
import { HealthBoard, Seat, REASON_TEXT } from './router.js';
import { vendorOf, isApiKind, isSubscriptionKind } from './vendors.js';

export const SAME_VENDOR_WARNING = "Only one AI company's models were available, so the same company's AI checked its own work. The cross-checking is weaker this run.";
export const LOCAL_DOWN_WARNING = 'The local model was not available, so the subscription models did every step. This uses more of your subscription.';
export const API_KEY_BILLING_WARNING = 'ANTHROPIC_API_KEY is set in your environment, so Claude Code may charge your Anthropic API account instead of your subscription.';

const PROBE_TIMEOUT_MS = { 'local-agent': 60000 }; // the first local call may load the model
const ROUTING_DEFAULTS = { allowApi: false, preferTwoVendors: false, localDown: 'frontier', cooldownMs: 60000, maxWaitMs: 300000 };

const uniq = (list) => [...new Set(list)];

export async function buildTeam(participants, { routing = {}, health = checkHealth, env = process.env, board = new HealthBoard(), sleep } = {}) {
  const r = { ...ROUTING_DEFAULTS, ...routing };
  const named = (n) => participants.find((p) => p.name === n);
  const subs = participants.filter((p) => isSubscriptionKind(p.adapter.kind) && p.canPlay('author') && p.canPlay('reviewer'));
  const apis = r.allowApi ? participants.filter((p) => isApiKind(p.adapter.kind)) : [];
  const locals = participants.filter((p) => p.canPlay('grunt') && !isApiKind(p.adapter.kind));

  const probed = uniq([...subs, ...apis, ...locals]);
  const report = await Promise.all(probed.map(async (p) => {
    let h;
    try {
      h = await health(p.adapter, { timeoutMs: PROBE_TIMEOUT_MS[p.adapter.kind] ?? 15000 });
    } catch (e) {
      h = { ok: false, reason: 'unavailable', detail: String(e?.message ?? e) };
    }
    const ok = h?.ok === true;
    return { name: p.name, kind: p.adapter.kind, ok, reason: ok ? '' : (h?.reason || 'unavailable'), detail: h?.detail ?? null };
  }));
  const entry = (p) => report.find((x) => x.name === p.name);
  const healthy = (p) => entry(p)?.ok === true;
  for (const x of report) if (!x.ok) board.markDown(x.name, x.reason);
  const fail = (error) => ({ ok: false, error, report });
  const why = (p) => entry(p)?.detail ?? REASON_TEXT[entry(p)?.reason] ?? entry(p)?.reason ?? 'not available';

  for (const k of ['author', 'reviewer', 'local']) {
    if (r[k] && !named(r[k])) return fail(`The config's routing.${k} names "${r[k]}", but there is no participant with that name.`);
  }

  const warnings = [];
  const local = (r.local && named(r.local)) || locals[0];
  if (!local) return fail('The config has no local model (a participant with the "grunt" role).');
  if (!healthy(local)) {
    if (r.localDown === 'pause') return fail(`The local model ${local.name} is not available (${why(local)}). Start it, then run Conductor again.`);
    warnings.push(LOCAL_DOWN_WARNING);
  }

  const okSubs = subs.filter(healthy);
  const okApis = apis.filter(healthy);
  if (!okSubs.length && !okApis.length) {
    const reasons = subs.map((p) => `${p.name}: ${REASON_TEXT[entry(p).reason] ?? entry(p).reason}`).join('; ');
    return fail(`No AI subscription is available: ${reasons || 'none is configured'}. Sign in to Claude Code or Codex, then try again.`);
  }
  const preferred = (name, pool) => (name && pool.find((p) => p.name === name)) || null;
  const author = preferred(r.author, okSubs) ?? okSubs[0] ?? okApis[0];
  const otherVendor = (p) => vendorOf(p.adapter.kind) !== vendorOf(author.adapter.kind);
  const reviewer =
    preferred(r.reviewer, okSubs.filter(otherVendor)) ??
    okSubs.find(otherVendor) ??
    (r.preferTwoVendors ? okApis.find(otherVendor) : undefined) ??
    [...okSubs, ...okApis].find((p) => p !== author) ??
    author;
  const allowSameVendor = vendorOf(author.adapter.kind) === vendorOf(reviewer.adapter.kind);
  if (allowSameVendor) warnings.push(SAME_VENDOR_WARNING);
  if (env.ANTHROPIC_API_KEY && okSubs.some((p) => p.adapter.kind === 'claude-code')) warnings.push(API_KEY_BILLING_WARNING);

  const apisFor = (p) => [...apis.filter((a) => vendorOf(a.adapter.kind) === vendorOf(p.adapter.kind)), ...apis];
  const seatOpts = { board, cooldownMs: r.cooldownMs, maxWaitMs: r.maxWaitMs, ...(sleep ? { sleep } : {}) };
  const team = {
    author: new Seat({ name: author.name, candidates: uniq([author, ...subs, ...apisFor(author)]), ...seatOpts }),
    reviewer: new Seat({
      name: reviewer.name,
      candidates: uniq([reviewer, ...(r.preferTwoVendors ? apis.filter(otherVendor) : []), ...subs, ...apisFor(reviewer)]),
      ...seatOpts,
    }),
    local: new Seat({ name: local.name, candidates: [local], ...seatOpts }),
  };
  return { ok: true, team, warnings, report, allowSameVendor };
}
