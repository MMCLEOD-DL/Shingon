// src/council/index.js
// One council round: members run one after another, independently; the result is saved in
// state.council so a resume re-runs only the unfinished round.
import { git } from '../workspace.js';
import { clip } from '../text.js';
import { makeFinding, findingKey, tally } from './findings.js';
import { resolveTool, TOOL_LABEL } from './tools.js';
import { SECURITY, addedLines, unquoteGitPath } from './security.js';
import { LEGAL } from './licences.js';
import { CORRECTNESS } from './correctness.js';
import { interpretMember } from './interpret.js';
import { buildReport } from './report.js';

export const MEMBERS_V1 = [SECURITY, LEGAL, CORRECTNESS];
const COUNCIL_TOOLS = [['semgrep', 'semgrep'], ['gitleaks', 'gitleaks'], ['npm-audit', 'npm'], ['scancode', 'scancode']];

function diffPath(part) {
  const side = (re, prefix) => {
    const m = part.match(re);
    return m && m[1] !== '/dev/null' ? unquoteGitPath(m[1]).replace(prefix, '') : null;
  };
  const head = part.match(/^diff --git (?:"(?:[^"\\]|\\.)*"|a\/.+?) ("(?:[^"\\]|\\.)*"|b\/.+)$/m);
  return side(/^\+\+\+ (.+?)\t?$/m, /^b\//) ?? side(/^--- (.+?)\t?$/m, /^a\//)
    ?? (head ? unquoteGitPath(head[1]).replace(/^b\//, '') : null);
}

export function hideFiles(diff, files) {
  if (!files || files.size === 0) return diff;
  return String(diff).split(/^(?=diff --git )/m).map((part) => {
    const p = part.startsWith('diff --git ') ? diffPath(part) : null;
    if (p === null || !files.has(p)) return part;
    return `${part.split('\n')[0]}\n(changes to ${p} hidden: the secret scanner found a possible secret in it)\n`;
  }).join('');
}

export function validateCouncilOptions(o) {
  if (!o.council) return;
  const shown = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
  if (!Number.isInteger(o.councilFixRounds) || o.councilFixRounds < 0 || o.councilFixRounds > 10) {
    throw new Error(`councilFixRounds must be a whole number from 0 to 10 (got ${shown(o.councilFixRounds)})`);
  }
  if (!Array.isArray(o.councilAcceptLicences) || o.councilAcceptLicences.some((x) => typeof x !== 'string')) {
    throw new Error(`councilAcceptLicences must be a list of licence names (got ${shown(o.councilAcceptLicences)})`);
  }
  const tools = o.councilTools;
  if (tools === null || typeof tools !== 'object' || Array.isArray(tools)
    || Object.values(tools).some((v) => v !== false && typeof v !== 'string')) {
    throw new Error(`councilTools must map a tool name to a path or false (got ${shown(tools)})`);
  }
  for (const k of Object.keys(tools)) {
    if (!COUNCIL_TOOLS.some(([n]) => n === k)) throw new Error(`councilTools: unknown tool "${k}" (known: ${COUNCIL_TOOLS.map(([n]) => n).join(', ')})`);
  }
}

export function councilToolStatus({ options, env = process.env }) {
  return COUNCIL_TOOLS.map(([tool, bin]) => {
    const { path, off } = resolveTool(tool, bin, { options, env });
    return { tool, label: TOOL_LABEL[tool], ok: !!path, why: off ? 'turned off in the config' : path ? '' : 'not installed' };
  });
}

// One-off test run on the starting commit (Ruling 5). Always puts the workspace back.
async function testsAtBase({ ws, options }, head) {
  const keep = await ws.ignoredPaths();
  try {
    await ws.resetHard(ws.baseSha, { keepIgnored: keep });
    const t = await ws.runTests(options.testCommand, { timeoutMs: options.testTimeoutMs });
    return { ran: t.ran, passed: t.passed, code: t.code };
  } finally {
    await ws.resetHard(head, { keepIgnored: keep });
  }
}

// Files this change added or renamed: fully introduced. --no-renames makes git print a rename as
// delete + add, so only 'A' entries appear (git never prints R/C here).
async function addedFiles(ws, head) {
  const r = await git(ws.dir, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--name-status', '-z', ws.baseSha, head]);
  if (r.code !== 0) return null;
  const t = r.stdout.split('\0');
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i += 2) {
    const s = t[i][0];
    if (s === 'A') out.add(t[i + 1]);
  }
  return out;
}

export async function runCouncilRound(ctx, { files, tests, diff, members = MEMBERS_V1, env = process.env }) {
  const { ws, state, log, options } = ctx;
  const c = (state.council ??= { round: 0, fixRounds: 0, secretSeen: false, history: [] });
  const head = await ws.head();
  const last = c.history.at(-1);
  const rerun = !!last && last.sha === head && last.fixRounds === c.fixRounds;
  const round = rerun ? last.round : c.round + 1;
  const earlier = rerun ? c.history.slice(0, -1) : c.history;
  log.event('council-start', { round, members: members.map((m) => m.member) });

  if (tests?.ran && tests.passed === false && c.baseTests === undefined) {
    c.baseTests = await testsAtBase(ctx, head);
    log.event('council-base-tests', { passed: c.baseTests.passed, code: c.baseTests.code });
  }

  const u0 = await git(ws.dir, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '-U0', ws.baseSha, head]);
  const added = u0.code === 0 ? addedLines(u0.stdout) : null;
  const wholeFiles = added ? await addedFiles(ws, head) : null;
  const hidden = new Set();
  const input = {
    dir: ws.dir, files, changed: new Set(files), added, wholeFiles: wholeFiles ?? undefined, baseSha: ws.baseSha, tests,
    baseTests: c.baseTests ?? null, options, env, request: state.request, plan: state.plan, diff: hideFiles(diff, hidden),
  };

  let findings = [];
  const toolRuns = [];
  const names = new Set();
  const interpretedBy = new Set();
  for (const m of members) {
    log.event('council-member', { member: m.member, stage: 'tools' });
    let runs;
    try {
      runs = await m.collect(input);
    } catch (e) {
      const msg = String(e?.message ?? e);
      runs = [{ tool: m.member, label: `${m.label} checks`, status: 'error', note: `The ${m.label} checks hit a problem (${clip(msg, 200)}), so they gave no answer.`,
        findings: [makeFinding({ member: m.member, grade: 'warning', title: `The ${m.label} checks hit a problem and gave no answer`, detail: msg })] }];
    }
    for (const r of runs) log.event('council-tool', { member: m.member, tool: r.tool, status: r.status, findings: r.findings.length });
    toolRuns.push(...runs);
    let mine = runs.flatMap((r) => r.findings);
    for (const f of mine) if (f.tool === 'gitleaks' && !f.preExisting && f.file) hidden.add(f.file);
    input.diff = hideFiles(diff, hidden);
    let by = null;
    let interpreted = false;
    if (mine.length || m.alwaysInterpret) {
      log.event('council-member', { member: m.member, stage: 'interpreting' });
      const notes = runs.map((r) => r.note).filter(Boolean);
      const out = await interpretMember(ctx, { member: m.member, label: m.label, findings: mine, notes, input });
      if (out.status === 'paused') return { status: 'paused', reason: out.reason };
      mine = out.findings;
      by = out.by;
      interpreted = out.interpreted;
      if (interpreted && by) names.add(by);
      if (interpreted) interpretedBy.add(m.member);
    }
    findings = findings.concat(mine);
    log.event('council-member-done', { member: m.member, ...tally(mine), by, interpreted });
  }

  for (const f of findings) {
    log.event('council-finding', { member: f.member, tool: f.tool, grade: f.grade, title: f.title, file: f.file, line: f.line, preExisting: f.preExisting, dismissed: f.dismissed });
  }
  const report = buildReport({ round, findings, toolRuns, by: [...names].join(', ') || null, history: earlier, interpreted: interpretedBy });
  c.round = round;
  c.secretSeen = c.secretSeen || hidden.size > 0;
  c.history = [...earlier, { round, sha: head, fixRounds: c.fixRounds, blocking: report.blocking.map((f) => ({ key: findingKey(f), title: f.title, member: f.member })) }];
  log.saveState(state);
  log.event('council-verdict', { round, verdict: report.verdict, ...tally(findings) });
  return { status: 'ok', report };
}
