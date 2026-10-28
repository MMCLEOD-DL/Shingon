// Splitting an approved brief into an ordered list of small build features (spec §4.2).
import { reviewLoop } from '../review.js';
import { callRole } from '../runlog.js';
import { askUser } from '../askUser.js';
import { extractJson } from '../plan.js';
import { acceptanceIds, EXAMPLE_ID_RE } from './acceptance.js';
import { featureRequest } from './featureRequest.js';
import { isApiKind } from '../vendors.js';
import { redact } from '../secrets.js';
import { clip } from '../text.js';
import { compareVersions } from './foundationLog.js';

export const MAX_UNITS = 30;
export const MAX_EXAMPLES_PER_UNIT = 6;
export const MAX_INSTRUCTIONS = 2000;
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const BRIEF_CLIP = 30000;

// Copy of the plan reviewer's rule (prompts.js does not export it).
const BLOCK_RULES =
  'Block only for substantive problems, each with a concrete reason. Not for style or preference. ' +
  'If a concern is about something hard to undo (data loss, deleting user work, a public API break, ' +
  'a schema or data migration), start your reason with "IRREVERSIBLE:".';

// The first foundation release with the optional modules (Plan 12). Before it, or with no tag, a brief with modules
// is refused as Plan 8 built it.
export const MODULES_SINCE = 'v0.2.0';
function hasModules(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) return false;
  try { return compareVersions(tag.slice(1), MODULES_SINCE.slice(1)) >= 0; } catch { return false; }   // not a release tag
}

export function briefProblems(brief, { foundationTag = null } = {}) {
  const out = [];
  if (brief.kind !== 'web-app') out.push(`This brief is for "${brief.kind}", and the factory only builds web apps.`);
  if (Array.isArray(brief.modules) && brief.modules.length && !hasModules(foundationTag)) {
    out.push(`The brief needs optional modules (${brief.modules.join(', ')}) that the foundation does not have yet, so building it now would leave them out.`);
  }
  const seenIds = new Set();
  for (const f of brief.features ?? []) {
    const examples = f.acceptance ?? [];
    if (examples.length === 0) out.push(`The feature "${f.title}" has no worked examples. Add at least one to the brief, so it can be tested.`);
    const redo = 'Approve the brief again with this version of Conductor (conductor brief <project> --revise).';
    examples.forEach((e, i) => {
      if (typeof e?.id !== 'string') {
        out.push(`The worked example ${i + 1} of "${f.title}" has no id, so its test could not be traced. ${redo}`);
        return;
      }
      const m = EXAMPLE_ID_RE.exec(e.id);
      if (!m) out.push(`The worked example ${i + 1} of "${f.title}" has the id "${e.id}", which is not in the form feature-id#number. ${redo}`);
      else if (m[1] !== f.id) out.push(`The worked example ${i + 1} of "${f.title}" has the id "${e.id}", which belongs to a different feature than "${f.id}". ${redo}`);
      if (seenIds.has(e.id)) out.push(`The worked example id "${e.id}" is used more than once in the brief. ${redo}`);
      seenIds.add(e.id);
    });
  }
  return out;
}

export function parseSplit(text) {
  const raw = extractJson(typeof text === 'string' ? text : '');
  if (raw == null) return { ok: false, error: 'no ```json block found in the reply' };
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return { ok: false, error: `not valid JSON (${e.message})` }; }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.units)) return { ok: false, error: 'the JSON has no "units" list' };
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const strs = (v) => (Array.isArray(v) ? v.map(str) : []);
  const units = obj.units.map((u) => ({
    id: str(u?.id), title: str(u?.title), covers: strs(u?.covers), acceptance: strs(u?.acceptance),
    instructions: str(u?.instructions), dependsOn: strs(u?.dependsOn),
  }));
  return { ok: true, units };
}

export function validateSplit(units, brief) {
  const problems = [];
  if (!Array.isArray(units) || units.length < 1 || units.length > MAX_UNITS) {
    return { ok: false, problems: [`the list has ${Array.isArray(units) ? units.length : 0} features (it must have 1 to ${MAX_UNITS})`] };
  }
  const known = new Map(acceptanceIds(brief).map((a) => [a.id, a]));
  const briefIds = new Set((brief.features ?? []).map((f) => f.id));
  const covered = new Set();
  const placed = new Map();
  const seen = new Map();
  units.forEach((u, i) => {
    const name = u.id || `#${i + 1}`;
    if (!ID_RE.test(u.id ?? '')) problems.push(`"${u.id}" is not a valid feature id (lowercase letters, digits and hyphens, 2 to 40 characters, starting with a letter)`);
    else if (u.id === 'brand') problems.push('"brand" is reserved; pick another feature id');
    if (seen.has(u.id)) problems.push(`feature id ${u.id} is used more than once`);
    seen.set(u.id, i);
    if (!u.title || u.title.length > 80) problems.push(`the title of ${name} must be 1 to 80 characters`);
    if (!u.instructions) problems.push(`${name} has no instructions`);
    else if (u.instructions.length > MAX_INSTRUCTIONS) problems.push(`instructions for ${name} are ${u.instructions.length} characters (the limit is ${MAX_INSTRUCTIONS})`);
    if (!u.covers?.length) problems.push(`${name} covers no feature of the brief`);
    for (const c of u.covers ?? []) {
      if (!briefIds.has(c)) problems.push(`${name} covers "${c}", which is not a feature in the brief`);
      else covered.add(c);
    }
    const ex = u.acceptance ?? [];
    if (ex.length === 0) problems.push(`${name} has no worked examples`);
    if (ex.length > MAX_EXAMPLES_PER_UNIT) problems.push(`${name} has ${ex.length} worked examples (at most ${MAX_EXAMPLES_PER_UNIT}); split it`);
    for (const id of ex) {
      const a = known.get(id);
      if (!a) { problems.push(`"${id}" is not a worked example in the brief`); continue; }
      if (!(u.covers ?? []).includes(a.featureId)) problems.push(`${name} has ${id}, but does not cover ${a.featureId}`);
      if (placed.has(id) && placed.get(id) !== i) problems.push(`${id} is in more than one feature`);
      placed.set(id, i);
    }
    for (const d of u.dependsOn ?? []) {
      const at = seen.get(d);
      if (at === undefined || at >= i) problems.push(`${name} depends on ${d}, which comes later or is not in the list`);
    }
  });
  for (const id of known.keys()) if (!placed.has(id)) problems.push(`${id} is not in any feature`);
  for (const id of briefIds) if (!covered.has(id)) problems.push(`brief feature ${id} is not covered by any feature`);
  const unique = [...new Set(problems)];
  if (unique.length === 0) {
    units.forEach((_, index) => {
      try { featureRequest({ brief, units, index }); } catch (e) {
        if (e?.code === 'too-long') unique.push(`${units[index].id}: ${e.message}`); else throw e;
      }
    });
  }
  if (unique.length) return { ok: false, problems: unique };
  return { ok: true, units: units.map((u) => ({ ...u, kind: 'feature' })) };
}

function briefText(sctx, brief) {
  return clip(redact(sctx.renderBrief(brief)), BRIEF_CLIP);
}

function exampleList(brief) {
  return acceptanceIds(brief).map((a) => `- ${a.id} (${a.title}): given ${a.example.given}, when ${a.example.when}, then ${a.example.then}`).join('\n');
}

const SHAPE = '{"units": [{"id": "kebab-case", "title": "...", "covers": ["brief feature id"], "acceptance": ["feature-id#1"], "instructions": "...", "dependsOn": ["earlier id"]}]}';

function authorPrompt(sctx, brief, feedback, feedbackKind) {
  const fb = !feedback ? '' : feedbackKind === 'failed'
    ? `Your previous list could not be used: ${clip(String(feedback).replace(/^could not produce a result: /, ''), 4000)}\nReply again, ending with the \`\`\`json block described above.`
    : `A reviewer blocked your previous list:\n${clip(String(feedback), 4000)}\nRevise the list to address it.`;
  return [
    `The approved brief:\n${briefText(sctx, brief)}`,
    `Worked examples (ids you must place):\n${exampleList(brief)}`,
    'Split this approved brief into an ordered list of build features. Each feature is built in one run by a modest local coding model and checked by reviewers, so keep each one small: at most one new database table, at most 6 worked examples, instructions under 2000 characters, and no more than about 10 steps of work. Put what others depend on first. Every worked example id must appear in exactly one feature; every brief feature must be covered. The app\'s name is already set; do not include it. The foundation already provides sign-in, roles, teams, files, email, the activity log, backups and the page shell: never rebuild them.',
    `End your reply with one \`\`\`json block of exactly this shape:\n${SHAPE}`,
    fb,
  ].filter(Boolean).join('\n\n');
}

function reviewPrompt(sctx, brief, units) {
  return [
    `The approved brief:\n${briefText(sctx, brief)}`,
    `Proposed list of build features:\n${clip(JSON.stringify({ units }, null, 2), 20000)}`,
    'Review this list of build features. Check: is anything in the brief missing, is any feature too big for one run of a modest model, is the order right, would any feature rebuild something the foundation already provides?',
    BLOCK_RULES,
  ].join('\n\n');
}

function addUsage(sctx, participant, result) {
  const kind = result.servedKind ?? participant.adapter?.kind;
  const cost = result.usage?.costUsd;
  if (typeof cost === 'number' && Number.isFinite(cost)) {
    sctx.usage.costUsd += cost;
    if (isApiKind(kind)) sctx.usage.apiCostUsd += cost;
  }
  if (isApiKind(kind)) sctx.usage.apiCalls += 1;
}

export async function runSplit(sctx, brief) {
  const { team, log, cwd, options } = sctx;
  const opts = { cwd, write: false, timeoutMs: options.agentTimeoutMs };
  log.event('phase', { name: 'split' });
  const call = async (participant, role, task) => {
    const r = await callRole(log, participant, role, task, '', opts);
    addUsage(sctx, participant, r);
    return r;
  };
  const loop = await reviewLoop({
    maxRounds: options.planRounds,
    produce: async (round, feedback, feedbackKind) => {
      const r = await call(team.author, 'author', authorPrompt(sctx, brief, feedback, feedbackKind));
      if (!r.ok) return r.failure === 'no-participant' ? { error: r.error, pause: r.error } : { error: `author failed: ${r.error}` };
      const parsed = parseSplit(r.text);
      if (!parsed.ok) return { error: parsed.error };
      const v = validateSplit(parsed.units, brief);
      return v.ok ? { units: v.units } : { error: v.problems.join('; ') };
    },
    review: (a) => call(team.reviewer, 'reviewer', reviewPrompt(sctx, brief, a.units)),
  });
  const agreed = (units) => log.event('split-agreed', { units: units.map((u) => u.id), rounds: loop.rounds });

  if (loop.status === 'paused') return { status: 'paused', reason: loop.lastReason };
  if (loop.status === 'approved') {
    agreed(loop.artifact.units);
    return { status: 'ok', units: loop.artifact.units, note: null };
  }
  if (!loop.lastGood) {
    return { status: 'failed', reason: 'Conductor could not get a usable list of features from the AI author, so nothing was built. The details are in the build log; run the same command again to retry.' };
  }
  const lastReview = [...loop.history].reverse().find((h) => !h.reason.startsWith('could not produce a result'));
  const reason = lastReview?.reason ?? loop.lastReason;
  const decision = await askUser(sctx, {
    kind: 'plan', title: 'the list of features', reason,
    recommendation: 'Approve only if the concern above does not matter for this client.', situation: 'disagree',
  });
  if (decision === 'approve') {
    agreed(loop.lastGood.units);
    return { status: 'ok', units: loop.lastGood.units, note: `Feature list: you approved it over the concern: ${reason}` };
  }
  return { status: 'stopped', reason: 'You rejected the list of features, so nothing was built.' };
}
