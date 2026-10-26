// src/council/security.js
// Security member: Semgrep (SAST), Gitleaks (secrets), npm audit, and a scanner-settings check.
// Parsers throw on empty/unparseable output when the tool signalled failure, so a crashed
// scanner is reported as an error and never looks like a clean run.
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeFinding } from './findings.js';
import { runTool, skipped, TOOL_LABEL } from './tools.js';
import { lockPackages, readLock, lockDelta } from './lockfile.js';

const ESC = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
export function unquoteGitPath(s) {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const body = s.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { bytes.push(...Buffer.from(body[i])); continue; }
    const n = body[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; } else bytes.push(ESC[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

// From `git diff -U0` text: the line numbers each file gained. File headers (+++ / ---) are
// only read outside a hunk; inside one, exactly the counts in its @@ header are consumed, so an
// added line whose text starts with "++ " is not mistaken for a header.
export function addedLines(text) {
  const out = new Map();
  let cur = null;
  let del = 0;
  let add = 0;
  let next = 0;
  for (const line of String(text).split('\n')) {
    if (del > 0 || add > 0) {
      if (line.startsWith('-') && del > 0) { del--; continue; }
      if (line.startsWith('+') && add > 0) { add--; if (cur !== null) out.get(cur).add(next++); continue; }
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      del = 0; add = 0; // malformed hunk: fall through and read the line normally
    }
    if (line.startsWith('+++ ')) {
      let p = line.slice(4).replace(/\t+$/, '');
      if (p === '/dev/null') { cur = null; continue; }
      p = unquoteGitPath(p);
      cur = p.startsWith('b/') ? p.slice(2) : p;
      if (!out.has(cur)) out.set(cur, new Set());
      continue;
    }
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      del = m[1] === undefined ? 1 : Number(m[1]);
      next = Number(m[2]);
      add = m[3] === undefined ? 1 : Number(m[3]);
    }
  }
  return out;
}

// wholeFiles (optional): files this change added or renamed; they count as fully introduced
// whatever the line set says (a new binary file or a pure rename has no added text lines).
export function isIntroduced({ changed, added, wholeFiles }, file, start, end = start) {
  if (!changed.has(file)) return false;
  if (!added || wholeFiles?.has(file)) return true;
  const lines = added.get(file);
  if (!lines) return false;
  for (let l = start; l <= end; l++) if (lines.has(l)) return true;
  return false;
}

const stripDot = (p) => String(p ?? '').replace(/^\.\//, '');

export function parseSemgrep(text, { changed, added, wholeFiles }, { code = 0 } = {}) {
  const data = JSON.parse(text);
  if (!Array.isArray(data?.results)) throw new Error('Semgrep gave no results list');
  const fatal = (Array.isArray(data.errors) ? data.errors : []).find((e) => e?.level === 'error');
  if (fatal) throw new Error(`Semgrep reported an error: ${String(fatal.message ?? fatal.type ?? 'unknown').split('\n')[0]}`);
  if (code !== 0 && code !== null && code !== undefined && data.results.length === 0) throw new Error(`Semgrep failed with no results (exit code ${code})`);
  return data.results.map((r) => {
    const extra = r.extra ?? {};
    const file = stripDot(r.path);
    const start = r.start?.line;
    return makeFinding({
      member: 'security', tool: 'semgrep',
      grade: { ERROR: 'blocking', WARNING: 'warning' }[extra.severity] ?? 'note',
      title: String(extra.message ?? '').split('\n')[0] || r.check_id,
      detail: `rule ${r.check_id}`, file, line: start,
      // no line number: cannot tell, so fail closed (introduced if the file changed)
      preExisting: !(Number.isInteger(start) ? isIntroduced({ changed, added, wholeFiles }, file, start, r.end?.line ?? start) : isIntroduced({ changed, added: null }, file, 0)),
    });
  });
}

// Never reads Secret or Match. Blank output is a clean run only when the tool did not fail.
export function parseGitleaks(text, { changed, added, wholeFiles }, { code = 0 } = {}) {
  if (text === null || text === undefined || !String(text).trim()) {
    if (code !== 0 && code !== null && code !== undefined) throw new Error(`Gitleaks wrote no report (exit code ${code})`);
    return [];
  }
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('Gitleaks did not give a list of results');
  return data.map((h) => {
    const file = stripDot(h.File);
    return makeFinding({
      member: 'security', tool: 'gitleaks', grade: 'blocking',
      title: `Possible secret (${h.Description || h.RuleID})`,
      detail: `rule ${h.RuleID}`, file, line: h.StartLine,
      preExisting: !isIntroduced({ changed, added, wholeFiles }, file, h.StartLine, h.EndLine ?? h.StartLine),
    });
  });
}

export function parseNpmAudit(text, { introduced }) {
  const data = JSON.parse(text);
  if (data?.error) throw new Error(data.error.summary || data.error.code || 'npm audit failed');
  const out = [];
  for (const [name, v] of Object.entries(data?.vulnerabilities ?? {})) {
    const via = (Array.isArray(v?.via) ? v.via : []).find((x) => x !== null && typeof x === 'object');
    if (!via) continue;
    out.push(makeFinding({
      member: 'security', tool: 'npm-audit',
      grade: { critical: 'blocking', high: 'blocking', moderate: 'warning' }[v.severity] ?? 'note',
      title: `${name}: ${via.title || 'a known security hole'} (${v.severity})`,
      detail: v.fixAvailable ? 'An update that fixes it is available.' : 'No fixed version is available yet.',
      preExisting: !introduced.has(name),
    }));
  }
  return out;
}

const SCANNER_SETTINGS = /(^|\/)(\.gitleaks\.toml|\.gitleaksignore|\.semgrepignore|\.semgrep\.ya?ml|\.npmrc)$/;
export function settingsTouched(files) {
  return files.filter((f) => SCANNER_SETTINGS.test(f)).map((file) => makeFinding({
    member: 'security', tool: 'settings', grade: 'warning', locked: true, file,
    title: `This change edits ${file}, which tells a scanner what to ignore`,
    detail: 'Check that it does not hide a real problem.',
  }));
}

// A skip-this-line comment a step added can hide a problem instead of fixing it. Only lines this
// change added count (a new file counts as all added); old suppressions on unchanged lines are ignored.
const SUPPRESSION = /nosemgrep|gitleaks:allow|\bnosec\b/i;
const MAX_SUPPRESSION_FILE = 2 * 1024 * 1024;
export function suppressionsAdded({ dir, files, changed, added, wholeFiles }) {
  const out = [];
  for (const file of files) {
    let text;
    try {
      const p = path.join(dir, file);
      const st = lstatSync(p);
      if (!st.isFile() || st.size > MAX_SUPPRESSION_FILE) continue;
      text = readFileSync(p, 'utf8');
    } catch { continue; }
    if (text.includes('\0')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = SUPPRESSION.exec(lines[i]);
      if (!m || !isIntroduced({ changed, added, wholeFiles }, file, i + 1)) continue;
      out.push(makeFinding({
        member: 'security', tool: 'settings', grade: 'warning', locked: true, file, line: i + 1,
        title: 'This change adds a comment that tells a scanner to skip a line',
        detail: `The line carries "${m[0]}". Check that it does not hide a real problem.`,
      }));
    }
  }
  return out;
}

export const SECURITY = {
  member: 'security',
  label: 'Security',
  alwaysInterpret: false,
  async collect(input) {
    const base = { member: 'security', cwd: input.dir, options: input.options, env: input.env };
    const semgrep = await runTool({ ...base, name: 'semgrep', label: TOOL_LABEL.semgrep, bin: 'semgrep',
      args: ['scan', '--config', input.options.councilSemgrepConfig, '--json', '--quiet', '--metrics=off', '--disable-version-check', '--disable-nosem', '.'],
      install: 'Install: pipx install semgrep (free, runs on this machine).',
      parse: (t, r) => parseSemgrep(t, input, r) });
    const gitleaks = await runTool({ ...base, name: 'gitleaks', label: TOOL_LABEL.gitleaks, bin: 'gitleaks',
      args: ['detect', '--no-git', '--source', '.', '--report-format', 'json', '--report-path', '{report}', '--redact', '--no-banner', '--exit-code', '0'],
      install: 'Install: the gitleaks release for Linux from github.com/gitleaks/gitleaks (free, runs on this machine).',
      parse: (t, r) => parseGitleaks(t, input, r) });

    let audit;
    const head = await readLock(input.dir);
    if (!head) {
      audit = skipped('security', 'npm-audit', TOOL_LABEL['npm-audit'],
        'There is no package-lock.json, so dependencies were not checked for known security holes (only Node projects are checked in this version).');
    } else {
      const introduced = lockDelta(lockPackages(await readLock(input.dir, input.baseSha)), lockPackages(head));
      audit = await runTool({ ...base, name: 'npm-audit', label: TOOL_LABEL['npm-audit'], bin: 'npm',
        args: ['audit', '--json', '--package-lock-only'],
        install: 'Install Node.js with npm.',
        parse: (t) => parseNpmAudit(t, { introduced }) });
    }
    const settings = { tool: 'settings', label: TOOL_LABEL.settings, status: 'ran', findings: [...settingsTouched(input.files), ...suppressionsAdded(input)], note: null };
    return [semgrep, gitleaks, audit, settings];
  },
};
