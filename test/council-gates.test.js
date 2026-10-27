import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { detectAxe, parseVitestJson, parsePlaywrightJson, parseA11yLines, parseCrossingJson, runGates, GATE_STEPS } from '../src/council/gates.js';
import { fakeGatesRun } from './helpers/councilFull.js';

const FX = new URL('./fixtures/council-full/gates-out/', import.meta.url).pathname;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'gates-'));
const read = (f) => readFileSync(path.join(FX, f), 'utf8');
const okChecks = { browsersInstalled: () => ({ ok: true, why: '' }), testDatabaseProblem: () => null };
const opts = { ...DEFAULT_OPTIONS, councilTools: { axe: false } };

test('detectAxe: checks the licence banner, never guesses', () => {
  const d = tmp();
  const good = path.join(d, 'axe.min.js');
  writeFileSync(good, '/*! axe v4.10.3\n * Copyright (c) 2015 - 2025 Deque Systems, Inc.\n * Your use of this Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. */\nvar axe=1;');
  assert.deepEqual(detectAxe({ options: { councilTools: { axe: good } } }), { path: good, version: '4.10.3', status: 'ok', note: null });
  const odd = path.join(d, 'other.js');
  writeFileSync(odd, 'var axe = 1;');
  const e = detectAxe({ options: { councilTools: { axe: odd } } });
  assert.equal(e.status, 'error');
  assert.equal(e.note, 'Conductor could not confirm that the file at councilTools.axe is axe-core under the Mozilla Public License, so the accessibility scan did not run.');
  assert.equal(detectAxe({ options: { councilTools: { axe: false } } }).status, 'off');
  const missing = detectAxe({ options: { councilTools: {} }, env: { HOME: d } });
  assert.equal(missing.status, 'missing');
  assert.match(missing.note, /^axe-core is not installed, so the accessibility scan did not run\. Install: /);
});

test('parsers read the real reporter shapes', () => {
  assert.deepEqual(parseVitestJson(read('vitest.json')).map((c) => [c.title, c.status]), [
    ['claims > [mileage-claims#1] 120 miles at 45p comes to £54.00', 'failed'],
    ['claims > [mileage-claims#2] a manager sees their team only', 'passed'],
    ['receipts > [receipts#1] later', 'skipped'],
    ['notes > a partial update changes only the fields sent', 'passed'],
  ]);
  const b = parsePlaywrightJson(read('playwright.json'));
  assert.deepEqual(b.filter((c) => !c.ok).map((c) => [path.basename(c.file), c.title, c.project]), [
    ['responsive.spec.ts', 'notes works at this width', 'mobile-webkit'],
    ['flows.spec.ts', 'a member adds a note with a photo', 'desktop-chromium'],
  ]);
  assert.match(b[0].message, /the page scrolls sideways/);
  assert.deepEqual(parseA11yLines(read('a11y.jsonl') + '\nnot json\n').map((p) => [p.page, p.violations.length]), [['notes', 1], ['people', 0]]);
  assert.throws(() => parseVitestJson('banner'), /The test report could not be read/);
  assert.deepEqual(parseCrossingJson(read('crossing.json')), { routes: 31, checks: 7012, failures: [] });
  assert.deepEqual(parseCrossingJson('{"routes":3,"checks":9,"failures":[{"sentence":"A member could read another team\'s claim."}]}').failures, ["A member could read another team's claim."]);
});

test('runGates: every step in order, reports read, council files written into the workspace only', async () => {
  const dir = tmp();
  const { run, calls } = fakeGatesRun({ codes: { vitest: 1, browser: 1 } });
  const r = await runGates({ dir, axe: { status: 'off', path: null }, options: opts, env: {}, run, helpers: okChecks });
  assert.deepEqual(GATE_STEPS.map((s) => r.steps[s]), [0, 0, 0, 0, 1, 0, 1, null]);
  assert.equal(r.tests.length, 4);
  assert.equal(r.crossing.routes, 31);
  assert.deepEqual(r.screenshots.map((s) => s.file).sort(), ['reports/screenshots/notes-mobile-webkit.png', 'reports/screenshots/people-mobile-chromium.png']);
  assert.match(r.logs.vitest, /FAIL {2}apps\/server\/test\/claims\.test\.ts/);
  assert.ok(existsSync(path.join(dir, '.council', 'playwright.config.ts')));
  const browserCall = calls.find((c) => c.args.at(-1).includes('playwright test'));
  assert.equal(browserCall.env.HF_COUNCIL_AXE, '');
  assert.equal(browserCall.env.PLAYWRIGHT_JSON_OUTPUT_NAME, path.join(dir, '.council', 'out', 'playwright.json'));
});

test('runGates: npm ci fails → nothing else runs; build fails → no browser step', async () => {
  const a = await runGates({ dir: tmp(), axe: { status: 'off' }, options: opts, env: {}, run: fakeGatesRun({ codes: { 'npm-ci': 1 } }).run, helpers: okChecks });
  assert.deepEqual(GATE_STEPS.map((s) => a.steps[s]), [1, null, null, null, null, null, null, null]);
  const b = await runGates({ dir: tmp(), axe: { status: 'off' }, options: opts, env: {}, run: fakeGatesRun({ codes: { build: 2 } }).run, helpers: okChecks });
  assert.equal(b.steps.browser, null);
  assert.equal(b.browser, null);
});

test('runGates: no test database → a plain problem, nothing run; no browsers → verify only, with a note', async () => {
  const { run, calls } = fakeGatesRun();
  const p = await runGates({ dir: tmp(), axe: { status: 'off' }, options: opts, env: {}, run,
    helpers: { ...okChecks, testDatabaseProblem: () => 'TEST_DATABASE_URL is not set, so the foundation\'s tests cannot reach a database.' } });
  assert.deepEqual(p, { problem: 'TEST_DATABASE_URL is not set, so the foundation\'s tests cannot reach a database.' });
  assert.equal(calls.length, 0);
  const n = await runGates({ dir: tmp(), axe: { status: 'off' }, options: opts, env: {}, run: fakeGatesRun().run,
    helpers: { ...okChecks, browsersInstalled: () => ({ ok: false, why: 'the Playwright browsers are not installed' }) } });
  assert.equal(n.steps.browser, null);
  assert.equal(n.note, 'The page check did not run: the Playwright browsers are not installed.');
});

test('runGates: only what is needed — the axe pass alone when Plan 8\'s reports cover the rest', async () => {
  const axePath = path.join(tmp(), 'axe.min.js');
  const { run, calls } = fakeGatesRun();
  const r = await runGates({ dir: tmp(), axe: { status: 'ok', path: axePath, version: '4.10.3' }, need: { verify: false, browser: false }, options: opts, env: {}, run, helpers: okChecks });
  assert.deepEqual(GATE_STEPS.map((s) => r.steps[s]), [0, null, null, null, null, 0, null, 0]);
  const a11yCall = calls.find((c) => c.args.at(-1).includes('playwright test'));
  assert.match(a11yCall.args.at(-1), /--project=council-a11y-desktop --project=council-a11y-phone/);
  assert.equal(a11yCall.env.HF_COUNCIL_AXE, axePath);
  assert.equal(r.a11y.length, 2);
  assert.equal(r.tests, null);
  const none = await runGates({ dir: tmp(), axe: { status: 'off' }, need: { verify: false, browser: false }, options: opts, env: {}, run: fakeGatesRun().run, helpers: okChecks });
  assert.deepEqual(GATE_STEPS.map((s) => none.steps[s]), [null, null, null, null, null, null, null, null]);
});

test('runGates: a step that runs out of time stops the rest', async () => {
  const r = await runGates({ dir: tmp(), axe: { status: 'off' }, options: { ...opts, councilGatesTimeoutMs: 1000 }, env: {}, run: fakeGatesRun({ timeout: 'vitest' }).run, helpers: okChecks });
  assert.equal(r.steps.vitest, -1);
  assert.equal(r.steps.build, null);
  assert.match(r.note, /took longer than the time allowed/);
});
