import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePlaywrightJson, parseA11yLines } from '../src/council/gates.js';
import { pageGateFindings, registryFindings, a11yFindings, houseStyleFindings, DESIGN } from '../src/council/design.js';
import { applyInterpretation } from '../src/council/interpret.js';

const fx = (f) => readFileSync(new URL(`./fixtures/council-full/gates-out/${f}`, import.meta.url), 'utf8');
const browser = parsePlaywrightJson(fx('playwright.json'));
const a11y = parseA11yLines(fx('a11y.jsonl'));

test('a page that scrolls sideways on a phone is a locked block; journeys are not Design\'s', () => {
  const f = pageGateFindings(browser);
  assert.deepEqual(f.map((x) => [x.title, x.grade, x.locked, x.tool]), [['The notes page scrolls sideways on a phone (Safari)', 'blocking', true, 'page-gate']]);
  assert.match(f[0].detail, /the page scrolls sideways/);
  assert.deepEqual(registryFindings(browser), []);
});

test('each gate message gets its own plain title', () => {
  const mk = (message, project = 'mobile-chromium') => ({ file: '/work/apps/web/e2e/responsive.spec.ts', title: 'people works at this width', project, ok: false, skipped: false, message });
  assert.equal(pageGateFindings([mk('buttons and fields too small to tap')])[0].title, 'The people page has buttons or fields too small to tap on a phone (Chrome)');
  assert.equal(pageGateFindings([mk('script errors on the page', 'desktop-chromium')])[0].title, 'The people page has script errors on desktop');
  assert.equal(pageGateFindings([mk('Timed out 10000ms waiting for getByRole(\'heading\')')])[0].title, 'The people page does not load properly on a phone (Chrome)');
  assert.deepEqual(pageGateFindings([{ ...mk('x'), skipped: true }]), []);
  const reg = registryFindings([{ file: '/work/apps/web/e2e/registry.spec.ts', title: 'every app path has at least one page in the screenshot registry', project: 'desktop-chromium', ok: false, skipped: false, message: 'Add these pages to apps/web/e2e/pages.ts: ["/claims"]' }]);
  assert.deepEqual(reg.map((x) => [x.grade, x.locked]), [['blocking', true]]);
});

test('axe: serious is a warning, never a block; minor is a note', () => {
  const f = a11yFindings(a11y);
  assert.deepEqual(f.map((x) => [x.tool, x.grade, x.maxGrade]), [['axe', 'warning', 'warning']]);
  assert.match(f[0].title, /^Accessibility: .+ \(1 page\)$/);
  assert.match(f[0].detail, /notes on council-a11y-phone: 3 places, e\.g\. \.mantine-Button-root/);
  const minor = a11yFindings([{ page: 'p', project: 'x', violations: [{ id: 'region', impact: 'minor', help: 'Content in landmarks', nodes: 1, target: 'div' }] }]);
  assert.equal(minor[0].grade, 'note');
});

test('house style: hand-typed colours and web fonts warn; inline styles are a note; the theme file is allowed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hs-'));
  const put = (f, s) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), s); };
  put('apps/web/src/pages/claims/List.tsx', 'const c = "#ff0000";\n<div style={{ margin: 3 }} />\n');
  put('apps/web/src/index.css', '@import url(https://fonts.googleapis.com/css2?family=Inter);\n');
  put('apps/web/src/theme.ts', 'const a = "#123456";\n');
  const f = houseStyleFindings({ dir, files: ['apps/web/src/pages/claims/List.tsx', 'apps/web/src/index.css', 'apps/web/src/theme.ts', 'apps/server/src/x.ts'] });
  assert.deepEqual(f.map((x) => [x.file, x.grade]), [
    ['apps/web/src/pages/claims/List.tsx', 'warning'], ['apps/web/src/pages/claims/List.tsx', 'note'], ['apps/web/src/index.css', 'warning']]);
});

test('DESIGN.collect: four checks; screenshots attached; nothing proven → a locked "not checked" warning', async () => {
  const shots = [{ page: 'notes', project: 'mobile-chromium', file: 'reports/screenshots/notes-mobile-chromium.png' }];
  const runs = await DESIGN.collect({ brief: {}, dir: '/nope', files: [], evidence: { gates: { browser, a11y, screenshots: shots, axe: { status: 'ok', version: '4.10.3' } }, gatesNote: null } });
  assert.deepEqual(runs.map((r) => [r.tool, r.status]), [['page-gate', 'ran'], ['registry', 'ran'], ['axe', 'ran'], ['house-style', 'ran']]);
  assert.deepEqual(runs[0].attach, ['reports/screenshots/notes-mobile-chromium.png']);
  assert.match(runs[0].context, /^Pages checked: \d+ pages × /);
  const none = await DESIGN.collect({ brief: {}, dir: '/nope', files: [], evidence: { gates: null, gatesNote: 'TEST_DATABASE_URL is not set' } });
  assert.equal(none[0].status, 'skipped');
  assert.deepEqual(none[0].findings.map((x) => [x.title, x.grade, x.locked]), [['The pages were not checked at desktop and phone width', 'warning', true]]);
  assert.equal(none[2].status, 'skipped');
});

test('the interpreter cannot clear a page-gate block, raise axe, or block on a screenshot alone', () => {
  const findings = [...pageGateFindings(browser), ...a11yFindings(a11y)];
  const out = applyInterpretation(findings, ['D1', 'D2'], {
    findings: [{ id: 'D1', decision: 'dismiss', grade: 'note', why: 'looks fine to me' }, { id: 'D2', decision: 'keep', grade: 'blocking', why: 'contrast' }],
    extra: [{ title: 'The claims list looks cramped', grade: 'blocking', why: 'ugly' }],
  }, { member: 'design' });
  assert.deepEqual(out.map((f) => [f.grade, f.dismissed]), [['blocking', false], ['warning', false], ['warning', false]]);
});

test('R23: a missing accessibility report is a locked warning, not clean; no project is skipped', async () => {
  const gates = { browser, a11y: null, screenshots: [], axe: { status: 'ok', version: '4.10.3' }, source: { a11y: 'own' } };
  const runs = await DESIGN.collect({ brief: {}, dir: '/nope', files: [], evidence: { gates, gatesNote: null } });
  assert.deepEqual(runs[2].findings.map((x) => [x.grade, x.locked]), [['warning', true]]);
  const bad = await DESIGN.collect({ brief: {}, dir: '/nope', files: [], evidence: { gates: { ...gates, axe: { status: 'error', note: 'x' } }, gatesNote: null } });
  assert.deepEqual([bad[2].status, bad[2].findings[0].title], ['error', 'axe-core could not be used']);
  const plain = await DESIGN.collect({ dir: '/nope', files: [], project: null, brief: null, evidence: null });
  assert.equal(plain.length, 1);
  assert.equal(plain[0].status, 'skipped');
});

test('a browser report with no page-check case (or no screen-list case) is "not checked", not a clean run', async () => {
  const flowsOnly = browser.filter((c) => !/responsive|registry/.test(c.file));
  const skippedPages = browser.map((c) => (/responsive/.test(c.file) ? { ...c, skipped: true, ok: false } : c));
  for (const b of [flowsOnly, skippedPages]) {
    const runs = await DESIGN.collect({ brief: {}, dir: '/nope', files: [], evidence: { gates: { browser: b, a11y, screenshots: [], axe: { status: 'ok' } }, gatesNote: null } });
    assert.equal(runs[0].status, 'skipped');
    assert.deepEqual(runs[0].findings.map((x) => [x.title, x.grade, x.locked]), [['The pages were not checked at desktop and phone width', 'warning', true]]);
  }
  const noReg = await DESIGN.collect({ brief: {}, dir: '/nope', files: [], evidence: { gates: { browser: flowsOnly, a11y, screenshots: [], axe: { status: 'ok' } }, gatesNote: null } });
  assert.equal(noReg[1].status, 'skipped');
  assert.deepEqual(noReg[1].findings.map((x) => [x.title, x.grade, x.locked]), [['The screen list was not checked', 'warning', true]]);
  const pagesNoReg = browser.filter((c) => !/registry/.test(c.file));
  const r = await DESIGN.collect({ brief: {}, dir: '/nope', files: [], evidence: { gates: { browser: pagesNoReg, a11y, screenshots: [], axe: { status: 'ok' } }, gatesNote: null } });
  assert.equal(r[0].status, 'ran');
  assert.deepEqual(r[1].findings.map((x) => x.title), ['The screen list was not checked']);
});
