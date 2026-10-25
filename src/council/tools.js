// src/council/tools.js
// Optional external checkers (semgrep, gitleaks, ...): found at runtime, run with no credentials.
// A missing or broken tool never throws; it becomes a ToolRun.
import { statSync, accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../exec.js';
import { redact, strictChildEnv } from '../secrets.js';
import { clip } from '../text.js';
import { makeFinding } from './findings.js';

export const TOOL_LABEL = Object.freeze({
  semgrep: 'Semgrep (code scanner)', gitleaks: 'Gitleaks (secret scanner)', 'npm-audit': 'npm audit (dependency security check)',
  scancode: 'ScanCode (licence scanner)', licences: 'dependency licence check', settings: 'scanner settings check',
  tests: 'the test command', 'test-files': 'test coverage check',
});

const isExecutableFile = (p) => {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch { return false; }
};

export function findBin(bin, { env = process.env } = {}) {
  if (typeof bin !== 'string' || !bin || bin.includes('/')) return null;
  for (const dir of String(env?.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    if (isExecutableFile(p)) return p;
  }
  return null;
}

export function resolveTool(name, bin, { options, env = process.env } = {}) {
  const v = options?.councilTools?.[name];
  if (v === false) return { path: null, off: true };
  if (typeof v === 'string' && v) return { path: isExecutableFile(v) ? v : null, off: false };
  return { path: findBin(bin, { env }), off: false };
}

export function skipped(member, name, label, note) {
  return { tool: name, label, status: 'skipped', findings: [], note };
}

export async function runTool({ member, name, label, bin, args = [], cwd, options, env = process.env, parse, install }) {
  const res = resolveTool(name, bin, { options, env });
  if (res.off) return { tool: name, label, status: 'off', findings: [], note: `${label} is turned off in the config.` };
  if (!res.path) {
    return { tool: name, label, status: 'missing', findings: [],
      note: `${label} is not installed, so this check did not run.${install ? ` ${install}` : ''}` };
  }

  let dir = null;
  let why = null;
  let findings = [];
  try {
    let finalArgs = args;
    let reportFile = null;
    if (args.includes('{report}')) {
      dir = mkdtempSync(path.join(tmpdir(), 'council-'));
      reportFile = path.join(dir, 'report.json');
      finalArgs = args.map((a) => (a === '{report}' ? reportFile : a));
    }
    const r = await runCommand({ cmd: res.path, args: finalArgs, cwd, timeoutMs: options.councilToolTimeoutMs, env: strictChildEnv({ env }) });
    if (r.timedOut) {
      why = 'it took longer than the time allowed';
    } else {
      let text = r.stdout;
      if (reportFile) {
        try { text = readFileSync(reportFile, 'utf8'); } catch { text = null; }
      }
      if (text === null) why = 'it wrote no report';
      else {
        try { findings = parse(text, { code: r.code, stderr: r.stderr }); }
        catch (err) { why = clip(redact(String(err?.message ?? err)), 200); }
      }
    }
  } catch (err) {
    why = clip(redact(String(err?.message ?? err)), 200);
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  }

  if (why !== null) {
    return { tool: name, label, status: 'error',
      findings: [makeFinding({ member, tool: name, grade: 'warning', title: `${label} could not run`, detail: why })],
      note: `${label} did not finish (${why}), so this check gave no answer.` };
  }
  return { tool: name, label, status: 'ran', findings, note: null };
}
