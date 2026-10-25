// src/council/security.js
// Security member: Semgrep (SAST), Gitleaks (secrets), npm audit, and a scanner-settings check.
// Parsers throw on empty/unparseable output when the tool signalled failure, so a crashed
// scanner is reported as an error and never looks like a clean run.
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

// From `git diff -U0` text: the line numbers each file gained.
export function addedLines(text) {
  const out = new Map();
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('+++ ')) {
      let p = line.slice(4).replace(/\t+$/, '');
      if (p === '/dev/null') { cur = null; continue; }
      p = unquoteGitPath(p);
      cur = p.startsWith('b/') ? p.slice(2) : p;
      if (!out.has(cur)) out.set(cur, new Set());
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && cur !== null) {
      const c = Number(m[1]);
      const d = m[2] === undefined ? 1 : Number(m[2]);
      for (let i = 0; i < d; i++) out.get(cur).add(c + i);
    }
  }
  return out;
}

export function isIntroduced({ changed, added }, file, start, end = start) {
  if (!changed.has(file)) return false;
  if (!added) return true;
  const lines = added.get(file);
  if (!lines) return false;
  for (let l = start; l <= end; l++) if (lines.has(l)) return true;
  return false;
}

const stripDot = (p) => String(p ?? '').replace(/^\.\//, '');

export function parseSemgrep(text, { changed, added }) {
  const data = JSON.parse(text);
  if (!Array.isArray(data?.results)) throw new Error('Semgrep gave no results list');
  return data.results.map((r) => {
    const extra = r.extra ?? {};
    const file = stripDot(r.path);
    const start = r.start?.line;
    return makeFinding({
      member: 'security', tool: 'semgrep',
      grade: { ERROR: 'blocking', WARNING: 'warning' }[extra.severity] ?? 'note',
      title: String(extra.message ?? '').split('\n')[0] || r.check_id,
      detail: `rule ${r.check_id}`, file, line: start,
      preExisting: !isIntroduced({ changed, added }, file, start, r.end?.line ?? start),
    });
  });
}

// Never reads Secret or Match. Blank output is a clean run only when the tool did not fail.
export function parseGitleaks(text, { changed, added }, { code = 0 } = {}) {
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
      preExisting: !isIntroduced({ changed, added }, file, h.StartLine, h.EndLine ?? h.StartLine),
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

export const SECURITY = {
  member: 'security',
  label: 'Security',
  alwaysInterpret: false,
  async collect(input) {
    const base = { member: 'security', cwd: input.dir, options: input.options, env: input.env };
    const semgrep = await runTool({ ...base, name: 'semgrep', label: TOOL_LABEL.semgrep, bin: 'semgrep',
      args: ['scan', '--config', input.options.councilSemgrepConfig, '--json', '--quiet', '--metrics=off', '--disable-version-check', '.'],
      install: 'Install: pipx install semgrep (free, runs on this machine).',
      parse: (t) => parseSemgrep(t, input) });
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
    const settings = { tool: 'settings', label: TOOL_LABEL.settings, status: 'ran', findings: settingsTouched(input.files), note: null };
    return [semgrep, gitleaks, audit, settings];
  },
};
