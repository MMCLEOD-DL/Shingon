// src/council/report.js
// The council report for the operator (plain English, not a scanner dump) and the fix chunk.
import { MEMBER_LABEL, findingKey, tally } from './findings.js';
import { TOOL_LABEL } from './tools.js';
import { clip } from '../text.js';

const ORDER = ['security', 'legal', 'correctness'];
const MAX_ITEMS = 20;
const FIX_MAX = 7000;

export function councilVerdict(findings) {
  const t = tally(findings);
  if (t.blocking > 0) return 'blocked';
  return t.warning > 0 ? 'approved-with-warnings' : 'approved';
}

const byMember = (list) => list
  .map((f, i) => [f, i])
  .sort((a, b) => (ORDER.indexOf(a[0].member) - ORDER.indexOf(b[0].member)) || a[1] - b[1])
  .map(([f]) => f);

export function buildReport({ round, findings, toolRuns, by, history = [], overridden = false, interpreted = null }) {
  const live = findings.filter((f) => !f.dismissed);
  const grade = (g) => byMember(live.filter((f) => f.grade === g));
  const blocking = grade('blocking');
  const nowKeys = new Set(blocking.map(findingKey));
  // Fixed = the check that found it ran again this round and the finding is gone from ALL live
  // findings (not merely downgraded or set aside). A tool that errored or went missing proves nothing.
  const liveKeys = new Set(findings.map(findingKey)); // includes set-aside ones: those are not fixed
  const ranTools = new Set((toolRuns ?? []).filter((r) => r.status === 'ran').map((r) => r.tool));
  const checkRan = (key) => {
    const [member, tool] = key.split('|');
    return tool === 'ai' ? Boolean(interpreted?.has(member)) : ranTools.has(tool);
  };
  const resolved = [];
  const seen = new Set();
  for (const h of history) {
    for (const b of h.blocking ?? []) {
      if (nowKeys.has(b.key) || liveKeys.has(b.key) || !checkRan(b.key) || seen.has(b.key)) continue;
      seen.add(b.key);
      resolved.push(`[${MEMBER_LABEL[b.member] ?? b.member}] ${b.title}`);
    }
  }
  const report = {
    round, verdict: councilVerdict(findings), blocking, warnings: grade('warning'), notes: grade('note'),
    dismissed: byMember(findings.filter((f) => f.dismissed)), resolved,
    toolNotes: (toolRuns ?? []).filter((r) => r.status !== 'ran').map((r) => r.note).filter(Boolean),
    by: by ?? null, overridden: Boolean(overridden),
  };
  report.text = reportText(report);
  return report;
}

function itemLine(f) {
  const where = [f.tool && `found by ${TOOL_LABEL[f.tool] ?? f.tool}`, f.file && (f.line ? `${f.file}:${f.line}` : f.file)].filter(Boolean);
  return `  - [${MEMBER_LABEL[f.member]}] ${f.title}${f.why ? `: ${f.why}` : ''}${where.length ? ` (${where.join(', ')})` : ''}${f.preExisting ? ' — already there before this change' : ''}`;
}

export function reportText(r) {
  const n = r.blocking.length;
  const w = r.warnings.length;
  const heading = r.verdict === 'approved' ? 'approved, nothing to fix'
    : r.verdict === 'approved-with-warnings' ? `approved, with ${w} warning${w === 1 ? '' : 's'} to read`
      : `NOT approved: ${n} blocking problem${n === 1 ? ' remains' : 's remain'}${r.overridden ? ', and you chose to continue' : ''}`;
  const lines = [`Council report: ${heading}`, `  Round ${r.round} · checked by ${r.by ?? 'the tools only'}`];
  const section = (title, items, count = true) => {
    if (!items.length) return;
    lines.push(count ? `${title} (${items.length}):` : `${title}:`, ...items.slice(0, MAX_ITEMS));
    if (items.length > MAX_ITEMS) lines.push(`  … and ${items.length - MAX_ITEMS} more (see the run log)`);
  };
  section('Fixed during the review', r.resolved.map((s) => `  - ${s}`));
  section('Still blocking', r.blocking.map(itemLine));
  section('Warnings', r.warnings.map(itemLine));
  section('Notes', r.notes.map(itemLine));
  section('Set aside as false alarms', r.dismissed.map(itemLine));
  section('Checks that did not run', r.toolNotes.map((s) => `  - ${s}`), false);
  return lines.join('\n');
}

export function fixChunk(report, fixRound) {
  let text = 'The review council found problems that must be fixed before this change can ship. Fix each one below with the smallest change that does it, and add or update tests where that makes sense. Do not change anything else.\n';
  const all = report.blocking;
  for (let i = 0; i < all.length; i++) {
    const f = all[i];
    const block = [
      `${i + 1}. [${MEMBER_LABEL[f.member]}] ${f.title}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : ''}`,
      f.detail && `   Evidence (${TOOL_LABEL[f.tool] ?? 'reviewer'}): ${clip(f.detail, 800)}`,
      f.why && `   Why it matters: ${f.why}`,
      f.fix && `   Suggested fix: ${f.fix}`,
    ].filter(Boolean).join('\n');
    const rest = all.length - i - 1;
    const reserve = 60;
    if (text.length + 1 + block.length + (rest > 0 ? reserve : 0) > FIX_MAX) {
      const k = all.length - i;
      text += `\n(${k} more problem${k === 1 ? ' is' : 's are'} listed in the council report.)`;
      break;
    }
    text += `\n${block}`;
  }
  return { title: `Council fixes, round ${fixRound}`, instructions: text, councilFix: fixRound };
}
