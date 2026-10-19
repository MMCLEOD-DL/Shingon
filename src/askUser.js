// src/askUser.js
// The single path to the user. Fails closed: only an explicit 'approve' continues.
import { buildEscalation } from './escalation.js';
import { redact } from './secrets.js';

export async function askUser(ctx, { kind, title, reason, recommendation, situation }) {
  const esc = redact(buildEscalation({ kind, title, reason, recommendation, situation }));
  ctx.log.event('escalation', { kind, title, situation: situation ?? 'disagree', message: esc.message });
  let answer;
  try {
    answer = await ctx.hooks.escalate(esc);
  } catch (e) {
    ctx.log.event('hook-error', { hook: 'escalate', error: String(e?.message ?? e) });
    answer = null;
  }
  const decision = answer === 'approve' ? 'approve' : 'reject';
  ctx.log.event('decision', { kind, title, decision });
  return decision;
}
