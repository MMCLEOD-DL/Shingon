// src/council/index.js
// One council round: members run one after another, independently; the result is saved in
// state.council so a resume re-runs only the unfinished round.
import path from 'node:path';
import { git } from '../workspace.js';
import { clip } from '../text.js';
import { makeFinding, findingKey, tally } from './findings.js';
import { resolveTool, TOOL_LABEL } from './tools.js';
import { SECURITY, addedLines, unquoteGitPath } from './security.js';
import { LEGAL } from './licences.js';
import { CORRECTNESS } from './correctness.js';
import { FOUNDATION } from './foundationRules.js';
import { DESIGN } from './design.js';
import { RELIABILITY } from './reliability.js';
import { collectEvidence } from './evidence.js';
import { writeCouncilReport } from './reportFile.js';
import { EXAMPLE_ID_RE } from '../factory/acceptance.js';
import { interpretMember } from './interpret.js';
import { buildReport } from './report.js';

export const MEMBERS_V1 = [SECURITY, LEGAL, CORRECTNESS];
export const MEMBERS = Object.freeze({ security: SECURITY, legal: LEGAL, correctness: CORRECTNESS, foundation: FOUNDATION, design: DESIGN, reliability: RELIABILITY });
export const FEATURE_COUNCIL = Object.freeze(['foundation', 'correctness']);
// The full council on a client app (Plan 9). Design and Reliability review client apps only (Ruling R24a).
export const PROJECT_COUNCIL = Object.freeze(['security', 'legal', 'correctness', 'design', 'reliability']);
const PROJECT_ONLY = new Set(['design', 'reliability']);

// null = the Plan 5 council (Security, Legal, Correctness); otherwise the named members, in order.
export function membersFor(names) {
  return names == null ? MEMBERS_V1 : names.map((n) => MEMBERS[n]);
}
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
  if (!Number.isInteger(o.councilToolTimeoutMs) || o.councilToolTimeoutMs <= 0) {
    throw new Error(`councilToolTimeoutMs must be a whole number of milliseconds above 0 (got ${shown(o.councilToolTimeoutMs)})`);
  }
  for (const k of ['councilGatesTimeoutMs', 'councilSmokeTimeoutMs']) {
    if (!Number.isInteger(o[k]) || o[k] <= 0) throw new Error(`${k} must be a whole number of milliseconds above 0 (got ${shown(o[k])})`);
  }
  if (typeof o.councilSemgrepConfig !== 'string' || !o.councilSemgrepConfig.trim()) {
    throw new Error(`councilSemgrepConfig must be a Semgrep rules pack name or a rules file path (got ${shown(o.councilSemgrepConfig)})`);
  }
  const tools = o.councilTools;
  if (tools === null || typeof tools !== 'object' || Array.isArray(tools)
    || Object.values(tools).some((v) => v !== false && typeof v !== 'string')) {
    throw new Error(`councilTools must map a tool name to a path or false (got ${shown(tools)})`);
  }
  for (const k of Object.keys(tools)) {
    if (k !== 'axe' && !COUNCIL_TOOLS.some(([n]) => n === k)) throw new Error(`councilTools: unknown tool "${k}" (known: ${COUNCIL_TOOLS.map(([n]) => n).join(', ')})`);
  }
  const names = o.councilMembers ?? null;
  if (names !== null) {
    if (!Array.isArray(names) || names.length === 0) throw new Error(`councilMembers must list at least one member (got ${shown(names)})`);
    const known = Object.keys(MEMBERS).filter((n) => !PROJECT_ONLY.has(n));
    for (const n of names) {
      if (PROJECT_ONLY.has(n)) throw new Error(`councilMembers: ${n} reviews client apps only (it runs in the full council of "conductor build")`);
      if (typeof n !== 'string' || !Object.hasOwn(MEMBERS, n)) throw new Error(`councilMembers: unknown member ${shown(n)} (known: ${known.join(', ')})`);
    }
    if (new Set(names).size !== names.length) throw new Error(`councilMembers must not name a member twice (got ${shown(names)})`);
  }
  const ff = o.factoryFeature ?? null;
  if (ff !== null && (typeof ff !== 'object' || Array.isArray(ff) || typeof ff.id !== 'string' || !ff.id.trim()
    || !Array.isArray(ff.tags) || ff.tags.some((t) => typeof t !== 'string' || !EXAMPLE_ID_RE.test(t)))) {
    throw new Error(`factoryFeature needs an id and a list of tags (got ${shown(ff)})`);
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

export async function runCouncilRound(ctx, { files, tests, diff, members = MEMBERS_V1, env = process.env, project = null }) {
  const { ws, state, log, options } = ctx;
  // Ruling R24b: a project round always reviews against the brief; without one the members would fall back to v1.
  if (project && !project.brief) throw new Error('A client-app council round needs the approved brief.');
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
    // Client-app rounds fill these (Task 12); null on an ordinary repo.
    project: null, brief: null, briefText: null, policy: null, evidence: null,
  };

  let findings = [];
  if (project) {
    Object.assign(input, { project, brief: project.brief, briefText: project.briefText ?? null, policy: project.policy ?? null });
    input.evidence = await collectEvidence(ctx, { project, head, round, deps: project.deps ?? {} });
    findings = projectFindings(project, input.evidence);
  }
  const checked = [];
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
      // A project round makes it a locked "not proven" warning (the interpreter cannot set it aside);
      // an ordinary round keeps the Plan 5 wording.
      const crashed = project
        ? makeFinding({ member: m.member, grade: 'warning', locked: true, title: `${m.label} was not proven: its checks hit a problem (${clip(msg, 120)})`, detail: msg })
        : makeFinding({ member: m.member, grade: 'warning', title: `The ${m.label} checks hit a problem (${clip(msg, 120)}), so they gave no answer.`, detail: msg });
      runs = [{ tool: m.member, label: `${m.label} checks`, status: 'error', note: `The ${m.label} checks hit a problem (${clip(msg, 200)}), so they gave no answer.`,
        findings: [crashed] }];
    }
    for (const r of runs) log.event('council-tool', { member: m.member, tool: r.tool, status: r.status, findings: r.findings.length });
    toolRuns.push(...runs);
    if (project) checked.push(checkedLine(m, runs, input.evidence));
    let mine = runs.flatMap((r) => r.findings);
    for (const f of mine) if ((f.tool === 'gitleaks' || f.secretHint) && !f.preExisting && f.file) hidden.add(f.file);
    input.diff = hideFiles(diff, hidden);
    let by = null;
    let interpreted = false;
    if (mine.length || m.alwaysInterpret) {
      log.event('council-member', { member: m.member, stage: 'interpreting' });
      const notes = runs.map((r) => r.note).filter(Boolean);
      const out = await interpretMember(ctx, { member: m.member, label: m.label, findings: mine, notes, input,
        context: runs.flatMap((r) => r.context ?? []), attach: runs.flatMap((r) => r.attach ?? []) });
      if (out.status === 'paused') {
        // A client-app round keeps what the secret scanner hid so far (Plan 8 squashes the build on it).
        // An ordinary round keeps the Plan 5 behaviour.
        if (project && hidden.size > 0 && !c.secretSeen) { c.secretSeen = true; log.saveState(state); }
        return { status: 'paused', reason: out.reason };
      }
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
  const projectParts = project ? {
    checked,
    coverage: toolRuns.find((r) => r.tool === 'coverage' && r.status === 'ran' && r.coverage)?.coverage ?? null,
    files: { md: path.join(project.buildDir, 'council-report.md'), json: path.join(project.buildDir, 'council-report.json'), screenshots: input.evidence?.shotsDir ?? null },
  } : {};
  const report = buildReport({ round, findings, toolRuns, by: [...names].join(', ') || null, history: earlier, interpreted: interpretedBy, ...projectParts });
  c.round = round;
  c.secretSeen = c.secretSeen || hidden.size > 0;
  c.history = [...earlier, { round, sha: head, fixRounds: c.fixRounds, blocking: report.blocking.map((f) => ({ key: findingKey(f), title: f.title, member: f.member })) }];
  log.saveState(state);
  log.event('council-verdict', { round, verdict: report.verdict, ...tally(findings) });
  if (project) {
    const { md } = await writeCouncilReport(project.buildDir, report, { sha: head, runId: project.runId, secretSeen: c.secretSeen === true });
    log.event('council-report-saved', { md });
  }
  return { status: 'ok', report };
}

// ---------- project rounds (Plan 9) ----------

// Locked warnings the round itself adds, outside any member (so no interpreter sees them):
//  - the foundation release could not be found (Task 3);
//  - Ruling R24c: axe-core missing or turned off leaves accessibility "not proven" (Design itself adds no finding).
function projectFindings(project, evidence) {
  const out = [];
  if (project.problem) out.push(makeFinding({ member: 'correctness', grade: 'warning', locked: true, title: project.problem, detail: project.problem }));
  const axe = evidence?.gates?.axe;
  if (axe && (axe.status === 'missing' || axe.status === 'off')) {
    const why = axe.status === 'off' ? 'axe-core is turned off in the config' : 'axe-core is not installed';
    out.push(makeFinding({ member: 'design', grade: 'warning', locked: true, title: `Accessibility was not proven: ${why}`, detail: axe.note || why }));
  }
  return out;
}

// Where a ToolRun's evidence came from, for "What was checked" (evidence.gates.source).
function fromBuild(member, tool, gates) {
  const src = gates?.source ?? {};
  if (member === 'correctness' && (tool === 'verify' || tool === 'coverage')) return src.verify === 'build';
  if ((member === 'design' && (tool === 'page-gate' || tool === 'registry')) || (member === 'correctness' && tool === 'journeys')) return src.browser === 'build';
  // The crossing report is the council's own only when its own test run made it.
  if (member === 'security' && tool === 'crossing') return src.verify !== 'council';
  return false;
}

function checkedLine(m, runs, evidence) {
  const ran = runs.filter((r) => r.status === 'ran')
    .map((r) => `${r.label ?? TOOL_LABEL[r.tool] ?? r.tool}${fromBuild(m.member, r.tool, evidence?.gates) ? " (from the build's checks)" : ''}`);
  return `${m.label}: ${ran.length ? ran.join(', ') : 'nothing could run'}`;
}
