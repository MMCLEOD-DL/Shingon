// src/council/design.js
// Design member (spec §2 item 3, "it must look professional"). Reads only input.evidence.gates.
// It blocks ONLY on the page check failing (sideways scrolling, tiny tap targets, script errors, page not
// loading) or a page missing from the screen list. Accessibility and house style only warn (index Ruling 6).
// Ruling R23: gates.a11y == null is "accessibility not proven", a locked warning, never clean.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { makeFinding } from './findings.js';
import { TOOL_LABEL } from './tools.js';

export const WIDTH = Object.freeze({ 'desktop-chromium': 'desktop', 'mobile-chromium': 'a phone (Chrome)', 'mobile-webkit': 'a phone (Safari)' });

const MEMBER = 'design';
const MAX_HOUSE = 20;
const MAX_AXE = 15;
const MAX_FILE = 1024 * 1024;
const label = (t) => TOOL_LABEL[t];
const width = (project) => WIDTH[project] ?? String(project);
const specOf = (c) => path.basename(String(c?.file ?? ''));
const failed = (c) => c && !c.ok && !c.skipped;

const finding = (tool, spec) => makeFinding({ member: MEMBER, tool, ...spec });

function pageName(title) {
  return /^(.*?)\s+works at this width$/.exec(String(title))?.[1] ?? String(title);
}

function gateTitle(page, project, message) {
  const m = String(message ?? '').toLowerCase();
  const w = width(project);
  if (m.includes('the page scrolls sideways')) return `The ${page} page scrolls sideways on ${w}`;
  if (m.includes('buttons and fields too small to tap')) return `The ${page} page has buttons or fields too small to tap on ${w}`;
  if (m.includes('script errors on the page')) return `The ${page} page has script errors on ${w}`;
  return `The ${page} page does not load properly on ${w}`;
}

export function pageGateFindings(browser) {
  return (browser ?? []).filter((c) => specOf(c) === 'responsive.spec.ts' && failed(c)).map((c) => finding('page-gate', {
    grade: 'blocking', locked: true,
    title: gateTitle(pageName(c.title), c.project, c.message),
    detail: c.message || 'The page check failed.',
  }));
}

export function registryFindings(browser) {
  const bad = (browser ?? []).filter((c) => specOf(c) === 'registry.spec.ts' && failed(c));
  if (!bad.length) return [];
  const detail = [...new Set(bad.map((c) => c.message).filter(Boolean))].join('\n');
  return [finding('registry', {
    grade: 'blocking', locked: true,
    title: 'A page has no screenshot check, so it was never looked at on a phone',
    detail: detail || 'The screen list check failed.',
  })];
}

const SEVERE = new Set(['critical', 'serious']);

export function a11yFindings(a11y) {
  const rules = new Map();
  for (const p of a11y ?? []) {
    for (const v of p.violations ?? []) {
      const r = rules.get(v.id) ?? { help: v.help || v.id, severe: false, pages: new Set(), lines: [] };
      r.severe ||= SEVERE.has(v.impact);
      r.pages.add(p.page);
      r.lines.push(`${p.page} on ${p.project}: ${v.nodes} places, e.g. ${v.target}`);
      rules.set(v.id, r);
    }
  }
  return [...rules.values()]
    .sort((a, b) => (b.severe - a.severe) || (b.pages.size - a.pages.size))
    .slice(0, MAX_AXE)
    .map((r) => finding('axe', {
      grade: r.severe ? 'warning' : 'note',
      title: `Accessibility: ${r.help} (${r.pages.size} ${r.pages.size === 1 ? 'page' : 'pages'})`,
      detail: r.lines.slice(0, 10).join('\n'),
    }));
}

const HEX = /(['"`])[^'"`\n]*#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b[^'"`\n]*\1/;
const FONT = /fonts\.googleapis|fonts\.gstatic|@font-face|@import\s+url\(/;
const INLINE = /style=\{\{/;

export function houseStyleFindings({ dir, files }) {
  const out = [];
  const scan = (files ?? []).filter((f) => f.startsWith('apps/web/src/') && /\.(?:ts|tsx|css)$/.test(f) && f !== 'apps/web/src/theme.ts');
  for (const f of scan) {
    let text;
    try {
      const p = path.join(dir, f);
      if (statSync(p).size > MAX_FILE) continue;
      text = readFileSync(p, 'utf8');
    } catch { continue; }
    if (HEX.test(text)) {
      out.push(finding('house-style', { grade: 'warning', file: f, title: `${f} sets colours by hand instead of using the theme`,
        detail: 'A colour is typed in directly. Use the colours in apps/web/src/theme.ts so the whole app stays consistent.' }));
    }
    if (FONT.test(text)) {
      out.push(finding('house-style', { grade: 'warning', file: f, title: `${f} loads a web font, which the house style avoids (it can also need a licence and sends visitors' addresses to the font host)`,
        detail: 'Use the fonts the theme already sets instead of loading one from outside.' }));
    }
    if (INLINE.test(text)) {
      out.push(finding('house-style', { grade: 'note', file: f, title: `${f} styles elements inline instead of using the house components`,
        detail: 'Prefer the house components and theme over style={{ ... }}.' }));
    }
    if (out.length >= MAX_HOUSE) break;
  }
  return out.slice(0, MAX_HOUSE);
}

const run = (tool, status, findings = [], extra = {}) => ({ tool, label: label(tool), status, findings, note: null, ...extra });

function pageContext(browser) {
  const cases = browser.filter((c) => specOf(c) === 'responsive.spec.ts' && !c.skipped);
  const pages = new Set(cases.map((c) => pageName(c.title)));
  const projects = [...new Set(cases.map((c) => c.project))];
  return `Pages checked: ${pages.size} pages × ${projects.join(', ') || 'no projects'}. ${cases.filter((c) => !c.ok).length} failed.`;
}

export const DESIGN = {
  member: MEMBER,
  label: 'Design',
  alwaysInterpret: true,
  async collect(input) {
    if (!input.project && !input.brief && !input.evidence) {
      return [{ tool: 'page-gate', label: label('page-gate'), status: 'skipped', findings: [], note: 'Design is checked only on client apps.' }];
    }
    const ev = input.evidence ?? {};
    const gates = ev.gates ?? null;
    const browser = gates?.browser;
    const out = [];

    const counted = (spec) => (Array.isArray(browser) ? browser : []).filter((c) => specOf(c) === spec && !c.skipped).length;
    if (!gates || !Array.isArray(browser) || !browser.length || !counted('responsive.spec.ts')) {
      const why = (Array.isArray(browser) && browser.length)
        ? 'the browser report has no page check that ran'
        : ev.gatesNote || gates?.note || 'no reason was given';
      out.push(run('page-gate', 'skipped', [finding('page-gate', {
        grade: 'warning', locked: true, title: 'The pages were not checked at desktop and phone width',
        detail: `The page check did not run (${why}), so no page was looked at on desktop or phone.`,
      })], { note: `The page check did not run (${why}), so no page was looked at on desktop or phone.` }));
    } else {
      out.push(run('page-gate', 'ran', pageGateFindings(browser), {
        context: pageContext(browser),
        attach: (gates.screenshots ?? []).map((s) => s.file),
      }));
    }
    if (!gates || !Array.isArray(browser) || !browser.length) {
      out.push(run('registry', 'skipped'));
    } else if (!counted('registry.spec.ts')) {
      const note = 'The browser report has no screen list check that ran, so no one checked that every page has a screenshot check.';
      out.push(run('registry', 'skipped', [finding('registry', {
        grade: 'warning', locked: true, title: 'The screen list was not checked', detail: note,
      })], { note }));
    } else {
      out.push(run('registry', 'ran', registryFindings(browser)));
    }

    const axe = gates?.axe;
    if (!gates) {
      out.push(run('axe', 'skipped', [], { note: 'The accessibility scan did not run because the page check did not.' }));
    } else if (axe && axe.status !== 'ok') {
      const status = ['missing', 'off', 'error'].includes(axe.status) ? axe.status : 'error';
      const findings = status === 'error'
        ? [finding('axe', { grade: 'warning', title: 'axe-core could not be used', detail: axe.note || 'axe-core could not be confirmed.' })] : [];
      out.push(run('axe', status, findings, { note: axe.note ?? null }));
    } else if (gates.a11y == null) {
      // Ruling R23: not proven, whatever gates.source.a11y says.
      out.push(run('axe', 'ran', [finding('axe', {
        grade: 'warning', locked: true, title: 'Accessibility was not checked on any page',
        detail: 'The accessibility scan produced no results, so accessibility is not proven.',
      })]));
    } else {
      out.push(run('axe', 'ran', a11yFindings(gates.a11y)));
    }

    out.push(run('house-style', 'ran', houseStyleFindings({ dir: input.dir, files: input.files })));
    return out;
  },
};
