// src/factory/briefTeam.js — the brief's author seat (Plan 7, Task 10): frontier models only.
// The meeting notes go to this seat alone, so a local-agent is never a candidate, whatever its roles,
// and is not even probed. Paid API participants join only with routing.allowApi === true.
// Ruling P8: the probing and the API-key warning repeat buildTeam's (src/team.js) on purpose; that is its twin.
import { checkHealth } from '../health.js';
import { HealthBoard, Seat, REASON_TEXT } from '../router.js';
import { API_KEY_BILLING_WARNING } from '../team.js';
import { isApiKind, isSubscriptionKind } from '../vendors.js';
import { assertFrontierSeat } from './briefRun.js';

export async function briefAuthorSeat(participants, { routing = {}, env = process.env, health = checkHealth, board = new HealthBoard() } = {}) {
  const r = routing ?? {};
  const canAuthor = (p) => p.adapter.kind !== 'local-agent' && p.canPlay('author');
  const subs = participants.filter((p) => canAuthor(p) && isSubscriptionKind(p.adapter.kind));
  const apis = r.allowApi === true ? participants.filter((p) => canAuthor(p) && isApiKind(p.adapter.kind)) : [];

  const probed = [...new Set([...subs, ...apis])];
  const report = new Map(await Promise.all(probed.map(async (p) => {
    let h;
    try { h = await health(p.adapter, { timeoutMs: 15000 }); } catch { h = { ok: false, reason: 'unavailable' }; }
    const ok = h?.ok === true;
    return [p, { ok, reason: ok ? '' : (h?.reason || 'unavailable') }];
  })));
  for (const [p, x] of report) if (!x.ok) board.markDown(p.name, x.reason);
  const healthy = (p) => report.get(p)?.ok === true;

  const okSubs = subs.filter(healthy);
  const okApis = apis.filter(healthy);
  const author = (r.author && [...okSubs, ...okApis].find((p) => p.name === r.author)) || okSubs[0] || okApis[0];
  if (!author) {
    const reasons = probed.map((p) => { const why = report.get(p).reason; return `${p.name}: ${REASON_TEXT[why] ?? why}`; }).join('; ');
    return { ok: false, error: `No AI subscription can write the brief (${reasons || 'none is configured'}). Sign in to Claude Code or Codex, then run the same command again. Nothing was sent to any AI model.` };
  }

  const seat = new Seat({
    name: author.name, candidates: [...new Set([author, ...subs, ...apis])], board,
    cooldownMs: r.cooldownMs ?? 60000, maxWaitMs: r.maxWaitMs ?? 300000,
  });
  assertFrontierSeat(seat); // belt and braces: the filters above already exclude every local-agent
  const warnings = [];
  if (env.ANTHROPIC_API_KEY && okSubs.some((p) => p.adapter.kind === 'claude-code')) warnings.push(API_KEY_BILLING_WARNING);
  return { ok: true, seat, warnings };
}
