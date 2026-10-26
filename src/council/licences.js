// src/council/licences.js
// Legal member: dependency licences from the npm lockfile (permissive-only rule, spec §5a) and
// an optional ScanCode pass over the files this run changed (copied copyleft code).
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeFinding } from './findings.js';
import { runTool, skipped, TOOL_LABEL } from './tools.js';
import { isIntroduced } from './security.js';
import { lockPackages, readLock, lockDelta, hasLicenceData } from './lockfile.js';

export const PERMISSIVE = Object.freeze(['MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Unlicense', 'CC0-1.0', 'Zlib', 'BlueOak-1.0.0', 'Python-2.0', 'BSL-1.0', 'CC-BY-3.0', 'CC-BY-4.0']);

const COPYLEFT = /^(a?gpl|lgpl|mpl|epl|eupl|cddl|cpl|osl|sspl|cc-by-sa|cc-by-nc|sleepycat|rpl|qpl|ms-rl|cecill)/i;
const BEST = ['permissive', 'unknown', 'copyleft']; // OR takes the best alternative, AND the worst part

export function classifyLicence(expr, { accept = [] } = {}) {
  const raw = typeof expr === 'string' ? expr.trim() : '';
  if (!raw || /^unlicensed$/i.test(raw) || /^see licen[cs]e in/i.test(raw)) return 'unknown';
  const ok = new Set([...PERMISSIVE, ...accept].map((s) => String(s).toLowerCase()));
  const leaf = (id) => {
    const bare = id.replace(/\+$/, '').toLowerCase();
    if (ok.has(id.toLowerCase()) || ok.has(bare)) return 'permissive';
    return COPYLEFT.test(bare) ? 'copyleft' : 'unknown';
  };
  const tokens = raw.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const peek = () => tokens[i]?.toUpperCase();
  const pick = (a, b, best) => (BEST.indexOf(a) <= BEST.indexOf(b)) === best ? a : b;
  function atom() {
    if (tokens[i] === '(') { i++; const v = or(); if (tokens[i++] !== ')') throw new Error('unbalanced'); return v; }
    const id = tokens[i++];
    if (!id || id === ')' || ['AND', 'OR', 'WITH'].includes(id.toUpperCase())) throw new Error('bad token');
    if (peek() === 'WITH') { i++; if (!tokens[i++]) throw new Error('bad exception'); } // an exception never changes the family
    return leaf(id);
  }
  function and() { let v = atom(); while (peek() === 'AND') { i++; v = pick(v, atom(), false); } return v; }
  function or() { let v = and(); while (peek() === 'OR') { i++; v = pick(v, and(), true); } return v; }
  try { const v = or(); return i === tokens.length ? v : 'unknown'; } catch { return 'unknown'; }
}

export function splitAccept(accept) {
  const ids = [];
  const packages = new Set();
  for (const e of Array.isArray(accept) ? accept : []) {
    const s = String(e);
    if (s.lastIndexOf('@') > 0) packages.add(s.toLowerCase()); else ids.push(s);
  }
  return { ids, packages };
}

export function licenceFindings(packages, { introduced, accept = [] }) {
  const { ids, packages: acceptedPkgs } = splitAccept(accept);
  // The same name@version can sit at several lockfile paths with different dev flags: merge
  // them, and treat the package as shipped if ANY copy is non-dev.
  const merged = new Map();
  for (const p of packages) {
    const k = `${p.name}@${p.version}`;
    const prev = merged.get(k);
    if (!prev) merged.set(k, { ...p });
    else { prev.dev = prev.dev && p.dev; prev.license = prev.license ?? p.license; }
  }
  const out = [];
  for (const [key, p] of merged) {
    if (acceptedPkgs.has(key.toLowerCase())) continue;
    const kind = classifyLicence(p.license, { accept: ids });
    if (kind === 'permissive') continue;
    const isNew = introduced.has(p.name);
    const shipped = isNew && !p.dev;
    const title = kind === 'copyleft' ? `${p.name} ${p.version} uses ${p.license}, a copyleft licence`
      : !p.license ? `${p.name} ${p.version} has no licence`
        : `${p.name} ${p.version} has a licence Conductor does not recognise (${p.license})`;
    const detail = shipped
      ? 'Apps handed to clients may only use permissive licences (MIT, Apache-2.0, BSD, ISC). Replace it, or accept it for this project by adding its licence, or "name@version" for just this package, to "councilAcceptLicences" in conductor.json.'
      : p.dev ? 'It is only used while developing, so it is not shipped.' : 'It was already in the project before this change.';
    out.push(makeFinding({ member: 'legal', tool: 'licences', grade: shipped ? 'blocking' : 'warning', title, detail,
      file: 'package-lock.json', locked: shipped, preExisting: !isNew }));
  }
  return out;
}

function scancodeRanges(f) {
  const out = [];
  const add = (m) => { const a = Number(m?.start_line); const b = Number(m?.end_line ?? m?.start_line); if (Number.isInteger(a) && a > 0 && Number.isInteger(b) && b >= a) out.push([a, b]); };
  for (const d of Array.isArray(f.license_detections) ? f.license_detections : []) for (const m of Array.isArray(d?.matches) ? d.matches : []) add(m);
  for (const m of Array.isArray(f.licenses) ? f.licenses : []) add(m);
  for (const m of Array.isArray(f.matches) ? f.matches : []) add(m);
  return out;
}

// `code` is the scanner's exit code. A crashed scanner must never look clean: unparseable output
// always throws (JSON.parse), and a failure exit with no scanned files throws too.
export function parseScancode(text, { accept = [], code = 0, input = null } = {}) {
  const data = JSON.parse(text);
  if (!Array.isArray(data?.files)) throw new Error('ScanCode gave no file list');
  const failed = code !== 0 && code !== null && code !== undefined;
  if (failed && !data.files.some((f) => f?.type === 'file')) throw new Error(`ScanCode failed with no scanned files (exit code ${code})`);
  const out = [];
  for (const f of data.files) {
    if (f?.type !== 'file') continue;
    const expr = f.detected_license_expression_spdx ?? (Array.isArray(f.license_expressions) ? f.license_expressions.join(' AND ') : null);
    if (!expr) continue;
    const kind = classifyLicence(expr, { accept });
    if (kind === 'permissive') continue;
    const file = String(f.path ?? '').replace(/^\.\//, '');
    // With line numbers, only a match on a line this run added counts as introduced; with none,
    // the changed-file rule stands.
    let preExisting = false;
    if (input) {
      const ranges = scancodeRanges(f);
      if (ranges.length) preExisting = !ranges.some(([a, b]) => isIntroduced(input, file, a, b));
    }
    out.push(makeFinding({ member: 'legal', tool: 'scancode', grade: kind === 'copyleft' ? 'blocking' : 'warning',
      title: `${file} contains text matching ${expr}`,
      detail: 'This may be code copied from a copyleft project. If it is, it cannot ship: rewrite or remove it.',
      file, locked: false, preExisting }));
  }
  return out;
}

const SCAN_EXCLUDE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|package\.json|(LICEN[CS]E|COPYING|NOTICE)(\.\w+)?)$|(^|\/)node_modules\//i;
const MAX_SCAN_FILES = 200;
const MAX_SCAN_BYTES = 1024 * 1024;

async function collectLicences(input) {
  const label = TOOL_LABEL.licences;
  const head = await readLock(input.dir);
  if (!head) return skipped('legal', 'licences', label, 'There is no package-lock.json, so dependency licences were not checked (only Node projects are checked in this version).');
  if (!hasLicenceData(head)) {
    return skipped('legal', 'licences', label, 'package-lock.json is in the old format (lockfileVersion 1), which does not record licences, so dependency licences were not checked. Updating it with npm 7 or later (run npm install) lets the council check them.');
  }
  const headPkgs = lockPackages(head);
  // A missing base lockfile fails closed: every package counts as introduced.
  const base = input.baseSha ? await readLock(input.dir, input.baseSha) : null;
  const introduced = lockDelta(lockPackages(base), headPkgs);
  return { tool: 'licences', label, status: 'ran', findings: licenceFindings(headPkgs, { introduced, accept: input.options.councilAcceptLicences }), note: null };
}

async function collectScancode(input) {
  const label = TOOL_LABEL.scancode;
  const candidates = [];
  for (const f of input.files ?? []) {
    if (SCAN_EXCLUDE.test(f)) continue;
    try {
      // lstat: a symlink (even to a file) is skipped, so nothing outside the workspace is copied.
      const st = lstatSync(path.join(input.dir, f));
      if (st.isFile() && st.size <= MAX_SCAN_BYTES) candidates.push(f);
    } catch { /* deleted or unreadable */ }
    if (candidates.length >= MAX_SCAN_FILES) break;
  }
  if (!candidates.length) return skipped('legal', 'scancode', label, 'No changed files to scan for copied licensed code.');
  const scanDir = mkdtempSync(path.join(tmpdir(), 'council-scan-'));
  try {
    for (const f of candidates) {
      const dest = path.join(scanDir, f);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(path.join(input.dir, f), dest);
    }
    const accept = splitAccept(input.options.councilAcceptLicences).ids;
    return await runTool({
      member: 'legal', name: 'scancode', label, bin: 'scancode', cwd: input.dir, options: input.options, env: input.env,
      args: ['--license', '--strip-root', '--quiet', '-n', '2', '--json-pp', '{report}', scanDir],
      install: 'Install: pipx install scancode-toolkit (free, runs on this machine; slow on big changes).',
      parse: (t, { code } = {}) => parseScancode(t, { accept, code, input }),
    });
  } finally {
    try { rmSync(scanDir, { recursive: true, force: true }); } catch {}
  }
}

export const LEGAL = {
  member: 'legal', label: 'Legal', alwaysInterpret: false,
  async collect(input) { return [await collectLicences(input), await collectScancode(input)]; },
};
