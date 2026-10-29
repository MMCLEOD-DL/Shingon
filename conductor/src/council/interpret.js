// src/council/interpret.js
// The LLM half of a council member. The model explains and may set aside or re-grade;
// the CODE enforces the rules (locks, ceilings, evidence, extras cap) and redacts its text.
import { callAgent, noteSameVendor } from '../runlog.js';
import { vendorOf } from '../vendors.js';
import { redact } from '../secrets.js';
import { clip } from '../text.js';
import * as prompts from '../prompts.js';
import { makeFinding, clampGrade, GRADES } from './findings.js';

export const ID_PREFIX = Object.freeze({ security: 'S', legal: 'L', correctness: 'C', foundation: 'F', design: 'D', reliability: 'R' });
export const MAX_SENT = 40;
export const MAX_EXTRA = 10;

const text = (v, max) => {
  if (typeof v !== 'string') return null;
  const t = clip(redact(v), max).trim();
  return t || null;
};

export function parseInterpretation(reply) {
  const s = typeof reply === 'string' ? reply : '';
  const blocks = [...s.matchAll(/```json[ \t]*\n([\s\S]*?)\n```/gi)];
  const candidate = blocks.length ? blocks[blocks.length - 1][1] : (s.trim().startsWith('{') ? s.trim() : null);
  if (candidate === null) return { ok: false, error: 'the reply had no JSON block' };
  let obj;
  try { obj = JSON.parse(candidate); } catch { obj = null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: "the reply's JSON could not be read" };
  const findings = (Array.isArray(obj.findings) ? obj.findings : [])
    .filter((e) => e && typeof e.id === 'string' && e.id)
    .map((e) => ({
      id: e.id,
      decision: e.decision === 'dismiss' ? 'dismiss' : 'keep',
      grade: GRADES.includes(e.grade) ? e.grade : null,
      why: text(e.why, 1000),
      fix: text(e.fix, 1000),
    }));
  const extra = (Array.isArray(obj.extra) ? obj.extra : [])
    .filter((e) => e && typeof e.title === 'string' && e.title)
    .map((e) => ({
      title: e.title,
      why: text(e.why, 1000),
      grade: GRADES.includes(e.grade) ? e.grade : null,
      file: typeof e.file === 'string' ? e.file : null,
    }));
  return { ok: true, findings, extra };
}

export function applyInterpretation(findings, ids, reply, { member }) {
  const byId = new Map();
  // Conflicting duplicates: never a dismissal; keep the highest grade; first non-empty text.
  const groups = new Map();
  for (const e of reply.findings ?? []) groups.set(e.id, [...(groups.get(e.id) ?? []), e]);
  for (const [id, es] of groups) {
    if (es.length === 1) { byId.set(id, es[0]); continue; }
    const grades = es.map((e) => e.grade).filter((g) => GRADES.includes(g));
    byId.set(id, {
      id, decision: 'keep',
      grade: grades.length ? grades.sort((a, b) => GRADES.indexOf(a) - GRADES.indexOf(b))[0] : null,
      why: es.map((e) => e.why).find(Boolean) ?? null,
      fix: es.map((e) => e.fix).find(Boolean) ?? null,
    });
  }
  const out = findings.map((orig, i) => {
    const f = { ...orig };
    const e = ids[i] ? byId.get(ids[i]) : undefined;
    if (!e) return f;
    // The model's text is untrusted: redact and clip here, whoever called us.
    const why = text(e.why, 1000);
    const fix = text(e.fix, 1000);
    if (why !== null) f.why = why;
    if (fix !== null) f.fix = fix;
    if (f.locked) return f;
    if (e.decision === 'dismiss' && why) f.dismissed = true;
    if (GRADES.includes(e.grade)) f.grade = clampGrade(e.grade, f.maxGrade);
    return f;
  });
  for (const x of (reply.extra ?? []).slice(0, MAX_EXTRA)) {
    const why = text(x.why, 1000);
    const f = makeFinding({
      member, tool: null, grade: GRADES.includes(x.grade) ? x.grade : 'warning',
      title: x.title, detail: why ?? '', file: text(x.file, 300),
    });
    f.why = why;
    out.push(f);
  }
  return out;
}

// At most MAX_SHOTS workspace-relative paths, phone shots first, then by name. A path that is
// absolute, climbs out with "..", or holds control characters is dropped: the model opens these.
export const MAX_SHOTS = 40;
export function orderShots(paths) {
  const ok = [...new Set(Array.isArray(paths) ? paths : [])].filter((p) => typeof p === 'string' && p
    && !/[\u0000-\u001f\u007f]/.test(p) && !p.startsWith('/') && !p.startsWith('\\') && !/^[A-Za-z]:/.test(p)
    && !p.split(/[\\/]/).includes('..'));
  const phone = (p) => (p.includes('mobile') ? 0 : 1);
  return ok.sort((a, b) => phone(a) - phone(b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_SHOTS);
}

export async function interpretMember(ctx, { member, label, findings, notes, input, context = [], attach = [] }) {
  // Only this member's own findings are ever shown to the model.
  const order = findings.map((_, i) => i).filter((i) => findings[i].member === member).sort((a, b) => GRADES.indexOf(findings[a].grade) - GRADES.indexOf(findings[b].grade) || a - b);
  const ids = findings.map(() => null);
  const items = [];
  order.slice(0, MAX_SENT).forEach((idx, n) => {
    const id = `${ID_PREFIX[member]}${n + 1}`;
    ids[idx] = id;
    items.push({ id, finding: findings[idx] });
  });
  const r = await callAgent(ctx, ctx.team.reviewer, 'reviewer', prompts.councilMember({
    member, label, request: input.request, plan: input.plan, diff: input.diff, base: input.baseSha,
    tests: input.tests, items, notes,
    briefText: input.briefText ?? null, policy: input.policy ?? null, context, attachments: orderShots(attach),
  }), { cwd: input.dir, write: false, timeoutMs: ctx.options.agentTimeoutMs });
  const vendors = new Set([vendorOf(ctx.team.author.adapter.kind), ...(ctx.state.council?.fixVendors ?? [])]);
  for (const vendor of vendors) {
    noteSameVendor(ctx, { phase: 'council', producerVendor: vendor, result: r, participant: ctx.team.reviewer });
  }
  if (r.failure === 'no-participant') return { status: 'paused', reason: r.error };
  const by = r.servedBy ?? ctx.team.reviewer.name;
  const parsed = r.ok ? parseInterpretation(r.text) : null;
  if (!r.ok || !parsed.ok) {
    const note = makeFinding({
      member, grade: 'note',
      title: `The AI could not check the ${label} findings, so they are shown as the tools reported them`,
      detail: r.ok ? parsed.error : r.error,
    });
    return { status: 'ok', findings: [...findings, note], by, interpreted: false };
  }
  return { status: 'ok', findings: applyInterpretation(findings, ids, parsed, { member }), by, interpreted: true };
}
