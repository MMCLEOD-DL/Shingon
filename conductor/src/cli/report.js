// src/cli/report.js
// `conductor report`: per-step numbers read from run transcripts. Read-only; no engine change.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { clip } from '../text.js';
import { redact } from '../secrets.js';
import { classifyFailure } from '../health.js';
import { metaDirOf } from '../workspace.js';

const CLIP = 200;
const TRANSCRIPT = 'transcript.jsonl';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const time = (ts) => { const t = Date.parse(ts); return Number.isNaN(t) ? null : t; };

// One JSON object per line. Blank lines are skipped; a malformed line is recorded in `.warnings`, never thrown.
export function parseTranscript(text) {
  const events = [];
  events.warnings = [];
  String(text ?? '').split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    try {
      const e = JSON.parse(raw);
      if (e && typeof e === 'object' && !Array.isArray(e) && typeof e.type === 'string') events.push(e);
      else events.warnings.push(`line ${i + 1}: not an event, skipped`);
    } catch {
      events.warnings.push(`line ${i + 1}: not valid JSON, skipped`);
    }
  });
  return events;
}

const emptyLimits = () => ({ failovers: 0, failedCalls: 0 });
const emptyCost = () => ({ reportedUsd: 0, reportedCalls: 0, unreportedCalls: 0 });
const costOf = (calls) => {
  const cost = emptyCost();
  for (const c of calls) {
    if (isNum(c.costUsd)) { cost.reportedUsd += c.costUsd; cost.reportedCalls++; } else cost.unreportedCalls++;
  }
  cost.reportedUsd = Math.round(cost.reportedUsd * 1e6) / 1e6;
  return cost;
}

function newBlock(e, resumed) {
  return {
    index: e.index ?? null, title: clip(String(e.title ?? ''), CLIP), resumed,
    producedBy: null, outcome: 'incomplete', localAttempts: 0,
    blockedByTests: { local: 0, frontier: 0 }, blockedByReviewer: 0,
    frontierTookOver: null, frontierCalls: 0, allowanceLimits: emptyLimits(), calls: [], cost: emptyCost(), ms: 0,
    _pending: new Map(), _deadlock: null, _error: false, _done: false,
  };
}

function finishBlock(b) {
  if (b._done) b.outcome = b.frontierTookOver ? 'fallback-then-done' : 'done';
  else if (b._deadlock) b.outcome = `deadlock:${b._deadlock}`;
  else if (b._error) b.outcome = 'error';
  b.cost = costOf(b.calls);
  b.ms = b.calls.reduce((s, c) => s + (c.ms ?? 0), 0);
  for (const k of Object.keys(b)) if (k.startsWith('_')) delete b[k];
  return b;
}

export function stepReport(events, { source = '' } = {}) {
  const warnings = [...(events.warnings ?? [])];
  const steps = [];
  const seen = new Set();
  let cur = null;
  let fallbackSeen = false;
  let status = null;
  let baseline = null;
  let resumed = 0;
  const runLimits = emptyLimits();
  let started = null;
  let finished = null;
  for (const e of events) {
    if (typeof e.ts === 'string') { started ??= e.ts; finished = e.ts; }
    switch (e.type) {
      case 'finish': status = typeof e.status === 'string' ? e.status : null; break;
      case 'baseline-tests': baseline = { passed: e.passed ?? null, commit: e.commit ?? null }; break;
      case 'resume': resumed++; break;
      case 'chunk':
        if (cur) steps.push(finishBlock(cur));
        cur = newBlock(e, seen.has(e.index));
        seen.add(e.index);
        fallbackSeen = false;
        break;
      default:
    }
    if (e.type !== 'chunk') {
      const limits = cur ? cur.allowanceLimits : runLimits;
      if (e.type === 'route-failover' && e.reason === 'rate-limit') limits.failovers++;
      else if (e.type === 'result' && e.ok === false && classifyFailure(typeof e.error === 'string' ? e.error : '') === 'rate-limit') limits.failedCalls++;
    }
    if (!cur || e.type === 'chunk') continue;
    switch (e.type) {
      case 'call': {
        const call = { participant: e.participant ?? null, role: e.role ?? null, servedBy: null, ok: null, ms: null, costUsd: null, _ts: time(e.ts) };
        cur.calls.push(call);
        cur._pending.set(`${call.participant}|${call.role}`, call);
        if (call.role === 'grunt') cur.localAttempts++;
        if (call.role === 'author' || call.role === 'reviewer') cur.frontierCalls++;
        break;
      }
      case 'result': {
        const key = `${e.participant ?? null}|${e.role ?? null}`;
        let call = cur._pending.get(key);
        if (call) cur._pending.delete(key);
        else {
          call = { participant: e.participant ?? null, role: e.role ?? null, servedBy: null, ok: null, ms: null, costUsd: null, _ts: null };
          cur.calls.push(call);
        }
        call.servedBy = e.servedBy ?? null;
        call.ok = typeof e.ok === 'boolean' ? e.ok : null;
        call.costUsd = isNum(e.costUsd) ? e.costUsd : null;
        const end = time(e.ts);
        if (call._ts !== null && end !== null) call.ms = Math.max(0, end - call._ts);
        if (e.role === 'reviewer' && (e.ok === false || e.verdict?.decision !== 'APPROVE')) cur.blockedByReviewer++;
        break;
      }
      case 'chunk-tests-failed': cur.blockedByTests[fallbackSeen ? 'frontier' : 'local']++; break;
      case 'chunk-fallback':
        fallbackSeen = true;
        cur.frontierTookOver = { to: e.to ?? null, reason: clip(String(e.reason ?? ''), CLIP) };
        break;
      case 'deadlock': cur._deadlock = e.action ?? 'unknown'; break;
      case 'chunk-error': cur._error = true; break;
      case 'chunk-done': cur._done = true; cur.producedBy = e.by ?? null; break;
      default:
    }
  }
  if (cur) steps.push(finishBlock(cur));
  for (const s of steps) for (const c of s.calls) delete c._ts;
  const runStatus = status ?? (events.some((e) => e.type === 'run-error') ? 'failed' : events.length ? 'running' : 'unknown');
  const report = { source, run: { status: runStatus, baseline, started, finished, resumed, allowanceLimits: runLimits }, steps, warnings };
  report.totals = totalsOf([report]);
  return report;
}

function totalsOf(reports) {
  const t = {
    runs: reports.length, steps: 0, calls: 0, callsByParticipant: {}, ms: 0,
    blockedByTests: { local: 0, frontier: 0 }, blockedByReviewer: 0, fallbacks: 0, frontierCalls: 0, localAttempts: 0, cost: emptyCost(), allowanceLimits: emptyLimits(),
  };
  for (const r of reports) {
    t.allowanceLimits.failovers += r.run.allowanceLimits?.failovers ?? 0;
    t.allowanceLimits.failedCalls += r.run.allowanceLimits?.failedCalls ?? 0;
    for (const s of r.steps) {
      t.allowanceLimits.failovers += s.allowanceLimits.failovers;
      t.allowanceLimits.failedCalls += s.allowanceLimits.failedCalls;
      t.steps++;
      t.ms += s.ms;
      t.blockedByTests.local += s.blockedByTests.local;
      t.blockedByTests.frontier += s.blockedByTests.frontier;
      t.blockedByReviewer += s.blockedByReviewer;
      t.fallbacks += s.frontierTookOver ? 1 : 0;
      t.frontierCalls += s.frontierCalls;
      t.localAttempts += s.localAttempts;
      for (const c of s.calls) {
        t.calls++;
        const k = c.participant ?? 'unknown';
        t.callsByParticipant[k] = (t.callsByParticipant[k] ?? 0) + 1;
      }
      t.cost.reportedUsd += s.cost.reportedUsd;
      t.cost.reportedCalls += s.cost.reportedCalls;
      t.cost.unreportedCalls += s.cost.unreportedCalls;
    }
  }
  t.cost.reportedUsd = Math.round(t.cost.reportedUsd * 1e6) / 1e6;
  return t;
}

export const aggregate = (reports) => totalsOf(reports);

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const allowance = (a) => (a.failovers || a.failedCalls
  ? `${plural(a.failovers, 'limit failover')}, ${plural(a.failedCalls, 'call')} failed on a limit` : null);
const money = (c) => (c.reportedCalls === 0
  ? 'not reported'
  : `$${c.reportedUsd.toFixed(2)} (${plural(c.reportedCalls, 'call')} reported, ${c.unreportedCalls} not reported)`);

export function formatReport(reports, totals = aggregate(reports)) {
  const out = [];
  for (const r of reports) {
    out.push(`Run: ${r.source}`);
    out.push(`  ${'status'.padEnd(10)}${r.run.status}${r.run.resumed ? `, resumed ${plural(r.run.resumed, 'time')}` : ''}`);
    if (r.run.baseline) out.push(`  ${'baseline'.padEnd(10)}tests ${r.run.baseline.passed === true ? 'passed' : r.run.baseline.passed === false ? 'failed' : 'unknown'}${r.run.baseline.commit ? ` at ${String(r.run.baseline.commit).slice(0, 8)}` : ''}`);
    for (const w of r.warnings) out.push(`  warning   ${w}`);
    for (const s of r.steps) {
      out.push(`  Step ${(s.index ?? 0) + 1}: ${s.title}${s.resumed ? ' (resumed)' : ''}`);
      const by = s.producedBy ? `${s.producedBy}, ${plural(s.localAttempts, 'attempt')}` : `not finished, ${plural(s.localAttempts, 'attempt')}`;
      out.push(`    ${'produced'.padEnd(12)}${by}  [${s.outcome}]`);
      out.push(`    ${'blocked'.padEnd(12)}${s.blockedByTests.local + s.blockedByTests.frontier} by tests (${s.blockedByTests.local} local, ${s.blockedByTests.frontier} frontier), ${s.blockedByReviewer} by reviewer`);
      out.push(`    ${'frontier'.padEnd(12)}${s.frontierTookOver ? `took over: ${s.frontierTookOver.to} (${s.frontierTookOver.reason})` : '0 fallbacks'}, ${plural(s.frontierCalls, 'call')}`);
      for (const c of s.calls) out.push(`    ${'call'.padEnd(12)}${`${c.participant}/${c.role}`.padEnd(24)}${(c.ms === null ? 'n/a' : secs(c.ms)).padStart(8)}  ${c.costUsd === null ? 'cost not reported' : `$${c.costUsd.toFixed(2)}`}`);
      const al = allowance(s.allowanceLimits);
      if (al) out.push(`    ${'allowance'.padEnd(12)}${al}`);
      out.push(`    ${'time'.padEnd(12)}${secs(s.ms)}`);
      out.push(`    ${'cost'.padEnd(12)}${money(s.cost)}`);
    }
    out.push('');
  }
  out.push(`Total across ${plural(totals.runs, 'run')}`);
  out.push(`  ${'steps'.padEnd(10)}${totals.steps}, ${plural(totals.localAttempts, 'local attempt')}, ${plural(totals.fallbacks, 'frontier fallback')}, ${plural(totals.frontierCalls, 'frontier call')}`);
  out.push(`  ${'blocked'.padEnd(10)}${totals.blockedByTests.local + totals.blockedByTests.frontier} by tests (${totals.blockedByTests.local} local, ${totals.blockedByTests.frontier} frontier), ${totals.blockedByReviewer} by reviewer`);
  out.push(`  ${'calls'.padEnd(10)}${totals.calls}${Object.keys(totals.callsByParticipant).length ? ` (${Object.entries(totals.callsByParticipant).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  const tal = allowance(totals.allowanceLimits);
  if (tal) out.push(`  ${'allowance'.padEnd(10)}${tal}`);
  out.push(`  ${'time'.padEnd(10)}${secs(totals.ms)}`);
  out.push(`  ${'cost'.padEnd(10)}${money(totals.cost)}`);
  return redact(out.join('\n'));
}

const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

function resolveOne(p) {
  let st;
  try { st = statSync(p); } catch (e) { throw new Error(`${p}: ${e.code === 'ENOENT' ? 'no such file or directory' : e.message}`); }
  if (!st.isDirectory()) return p;
  const inside = path.join(p, TRANSCRIPT);
  if (existsSync(inside)) return inside;
  const meta = path.join(metaDirOf(p), TRANSCRIPT);
  if (existsSync(meta)) return meta;
  throw new Error(`${p}: no ${TRANSCRIPT} here or in ${metaDirOf(p)}`);
}

// Explicit paths: a transcript file, a *.conductor dir, or a workspace dir. None: every transcript under baseDir,
// plus archived finished runs (archive() in conductor.js writes them to <baseDir>/logs; <baseDir>/../logs is checked too).
export function findTranscripts({ baseDir, paths = [] }) {
  if (paths.length) return [...new Set(paths.map((p) => resolveOne(path.resolve(p))))].sort((a, b) => mtime(a) - mtime(b));
  const found = new Set();
  let names = [];
  try { names = readdirSync(baseDir); } catch { /* no base dir yet */ }
  for (const n of names) {
    const f = path.join(baseDir, n, TRANSCRIPT);
    if (n.endsWith('.conductor') && existsSync(f)) found.add(f);
  }
  for (const dir of new Set([path.join(baseDir, 'logs'), path.join(path.dirname(baseDir), 'logs')])) {
    if (!isDir(dir)) continue;
    for (const n of readdirSync(dir)) if (n.endsWith('.jsonl')) found.add(path.join(dir, n));
  }
  return [...found].sort((a, b) => mtime(a) - mtime(b));
}

// Returns an exit code; prints through `print`.
export function runReport({ baseDir, paths = [], json = false, print }) {
  let files;
  try { files = findTranscripts({ baseDir, paths }); } catch (e) { print(redact(e.message)); return 64; }
  if (!files.length) { print('No run transcripts found.'); return 0; }
  const reports = [];
  for (const f of files) {
    try { reports.push(stepReport(parseTranscript(readFileSync(f, 'utf8')), { source: f })); } catch (e) { print(redact(`${f}: ${e.message}`)); return 64; }
  }
  const totals = aggregate(reports);
  print(json ? JSON.stringify(redact({ runs: reports, totals }), null, 2) : formatReport(reports, totals));
  return 0;
}
