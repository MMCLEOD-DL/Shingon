// src/council/gates.js
// The council's own run of the foundation's gates, in the council workspace, reading machine-readable
// reports. It runs only the parts asked for (Task 6 reuses Plan 8's checks for the rest) and adds the
// axe accessibility pass. axe-core stays on Conductor's side: its licence banner is checked here and the
// file is injected from Conductor's own path, never added to the app, its package.json or its lockfile.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../exec.js';
import { redact, strictChildEnv, secretValues } from '../secrets.js';
import { clip } from '../text.js';

export const GATE_STEPS = ['npm-ci', 'lint', 'typecheck', 'licences', 'vitest', 'build', 'browser', 'a11y'];

const AXE_REL = path.join('.local', 'share', 'conductor', 'axe-core', 'axe.min.js');
const AXE_UNCONFIRMED = 'Conductor could not confirm that the file at councilTools.axe is axe-core under the Mozilla Public License, so the accessibility scan did not run.';
const AXE_INSTALL = 'Install: npm pack axe-core@4, then put package/axe.min.js at ~/.local/share/conductor/axe-core/axe.min.js (MPL-2.0; Conductor uses it as a tool and never adds it to client apps).';
const TIMED_OUT = 'It took longer than the time allowed.';

export function detectAxe({ options = {}, env = process.env } = {}) {
  const setting = options.councilTools?.axe;
  if (setting === false) {
    return { path: null, version: null, status: 'off', note: 'axe-core is turned off in the config, so the accessibility scan did not run.' };
  }
  const file = typeof setting === 'string' && setting ? setting : path.join(env.HOME || homedir(), AXE_REL);
  let head;
  try { head = readFileSync(file, 'utf8').slice(0, 4000); } catch {
    return { path: file, version: null, status: 'missing', note: `axe-core is not installed, so the accessibility scan did not run. ${AXE_INSTALL}` };
  }
  const version = /\baxe(?:-core)?\s+v(\d+\.\d+\.\d+[\w.-]*)/i.exec(head)?.[1];
  const mpl = /Mozilla Public License,?\s+(?:v\.?\s*|version\s+)2\.0/i.test(head);
  if (!version || !mpl) return { path: file, version: null, status: 'error', note: AXE_UNCONFIRMED };
  return { path: file, version, status: 'ok', note: null };
}

// ---------- parsers ----------

const ANSI = /\x1b\[[0-9;]*m/g;
const message = (m) => clip(redact(String(m ?? '').replace(ANSI, '')), 1000);
// Reports written in Plan 8's clone and in the council workspace read the same.
const appRelative = (f) => /(?:^|[\\/])((?:apps|packages)[\\/].*)$/.exec(String(f ?? ''))?.[1]?.replace(/\\/g, '/') ?? String(f ?? '');

function json(text, what) {
  try { return JSON.parse(text); } catch { throw new Error(what); }
}

export function parseVitestJson(text) {
  const WHAT = 'The test report could not be read.';
  const doc = json(text, WHAT);
  if (!doc || !Array.isArray(doc.testResults)) throw new Error(WHAT);
  const status = (s) => (s === 'passed' || s === 'failed' || s === 'todo' ? s : 'skipped');
  const out = [];
  for (const f of doc.testResults) {
    for (const a of f.assertionResults ?? []) {
      out.push({
        file: appRelative(f.name),
        title: String(a.fullName ?? a.title ?? ''),
        status: status(a.status),
        message: message(a.failureMessages?.[0]),
      });
    }
  }
  return out;
}

export function parsePlaywrightJson(text) {
  const WHAT = 'The browser test report could not be read.';
  const doc = json(text, WHAT);
  if (!doc || !Array.isArray(doc.suites)) throw new Error(WHAT);
  const out = [];
  const walk = (suite, file) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        out.push({
          file: appRelative(spec.file ?? here),
          title: String(spec.title ?? ''),
          project: t.projectName ?? '',
          ok: t.status === 'expected' || t.status === 'flaky',
          skipped: t.status === 'skipped',
          message: message(t.results?.[0]?.error?.message),
        });
      }
    }
    for (const s of suite.suites ?? []) walk(s, here);
  };
  for (const s of doc.suites) walk(s, s.file);
  return out;
}

export function parseA11yLines(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o && typeof o.page === 'string' && Array.isArray(o.violations)) out.push(o);
  }
  return out;
}

export function parseCrossingJson(text) {
  const WHAT = 'The crossing report could not be read.';
  const doc = json(text, WHAT);
  if (!doc || typeof doc !== 'object') throw new Error(WHAT);
  const failures = (Array.isArray(doc.failures) ? doc.failures : []).map((f) => String(f?.sentence ?? f));
  return { routes: Number(doc.routes) || 0, checks: Number(doc.checks) || 0, failures };
}

// ---------- the run ----------

const COMMANDS = {
  'npm-ci': 'npm ci --no-audit --no-fund --loglevel=error',
  lint: 'npm run lint',
  typecheck: 'npm run typecheck',
  licences: 'npm run licences',
  vitest: 'npx vitest run --reporter=default --reporter=json --outputFile.json=.council/out/vitest.json',
  build: 'npx tsc -b packages/shared && npm -w @hf/web run build',
  browser: 'npx playwright test -c .council/playwright.config.ts --reporter=json',
  a11y: 'npx playwright test -c .council/playwright.config.ts --reporter=json --project=council-a11y-desktop --project=council-a11y-phone',
};
const VERIFY_STEPS = ['lint', 'typecheck', 'licences', 'vitest'];
const lastLines = (s, n = 40) => s.split('\n').slice(-n).join('\n').trim();
const emptySteps = () => Object.fromEntries(GATE_STEPS.map((s) => [s, null]));

function emptyResult(axe, note = null) {
  return {
    steps: emptySteps(), verify: null, tests: null, browser: null, a11y: null, crossing: null,
    screenshots: [], logs: {}, axe, note, source: { verify: null, browser: null, a11y: null },
  };
}

function readIf(file) {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

function readScreenshots(dir) {
  const raw = readIf(path.join(dir, 'reports', 'screenshots', 'manifest.json'));
  if (raw == null) return [];
  let list;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e.file === 'string' && !e.file.includes('/') && !e.file.includes('\\') && !e.file.startsWith('.'))
    .map((e) => ({ page: e.page, project: e.project, file: `reports/screenshots/${e.file}` }))
    .filter((e) => existsSync(path.join(dir, e.file)));
}

export async function runGates({ dir, axe, need = { verify: true, browser: true }, options = {}, env = process.env, run = runCommand, home, helpers } = {}) {
  const axeOk = axe?.status === 'ok';
  const needVerify = !!need.verify;
  const needBrowser = !!need.browser;
  const needA11y = !needBrowser && axeOk;
  if (!needVerify && !needBrowser && !needA11y) return emptyResult(axe);

  const h = helpers ?? await import('../factory/checks.js');
  const dbProblem = h.testDatabaseProblem({ env });
  if (dbProblem) return { problem: dbProblem };

  let note = null;
  let web = needBrowser || needA11y;
  if (web) {
    const b = h.browsersInstalled({ env, home });
    if (!b.ok) { web = false; note = `The page check did not run: ${b.why}.`; }
  }
  const result = emptyResult(axe, note);
  if (!needVerify && !web) return result;

  const secrets = [env.TEST_DATABASE_URL, ...secretValues(env), ...secretValues()].filter(Boolean);
  const out = path.join(dir, '.council', 'out');
  mkdirSync(out, { recursive: true });
  for (const f of ['vitest.json', 'playwright.json', 'a11y.jsonl']) rmSync(path.join(out, f), { force: true });

  const childEnv = strictChildEnv({ env });
  for (const k of ['TEST_DATABASE_URL', 'PLAYWRIGHT_BROWSERS_PATH', 'HF_E2E_MAIL_DIR']) if (env[k]) childEnv[k] = env[k];
  const webEnv = {
    ...childEnv,
    PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(out, 'playwright.json'),
    HF_COUNCIL_OUT: out,
    HF_COUNCIL_AXE: axeOk && (needBrowser || needA11y) ? axe.path : '',
  };

  const deadline = Date.now() + (options.councilGatesTimeoutMs ?? 2_400_000);
  let stopped = false;
  const step = async (name, stepEnv = childEnv) => {
    const left = deadline - Date.now();
    let code, text;
    if (left <= 0) { code = -1; text = TIMED_OUT; }
    else {
      const r = await run({ cmd: 'sh', args: ['-c', COMMANDS[name]], cwd: dir, env: stepEnv, timeoutMs: left });
      text = redact(`${r.stdout ?? ''}${r.stderr ?? ''}`, secrets);
      code = r.timedOut ? -1 : (r.code ?? -1);
      if (r.timedOut) text = `${text}\n${TIMED_OUT}`.trim();
    }
    result.steps[name] = code;
    writeFileSync(path.join(out, `${name}.log`), text);
    if (code !== 0) result.logs[name] = lastLines(text);
    if (code === -1) {
      stopped = true;
      result.note = [result.note, `The ${name} step took longer than the time allowed, so the later checks did not run.`].filter(Boolean).join(' ');
    }
    return code;
  };

  const install = await step('npm-ci');
  if (install === 0) {
    if (needVerify) {
      for (const s of VERIFY_STEPS) { if (stopped) break; await step(s); }
    }
    if (web && !stopped) {
      const built = await step('build');
      if (built === 0) {
        const here = path.join(dir, '.council');
        const assets = new URL('./assets/', import.meta.url);
        copyFileSync(new URL('council.playwright.config.ts', assets), path.join(here, 'playwright.config.ts'));
        copyFileSync(new URL('council-a11y.spec.ts', assets), path.join(here, 'a11y.spec.ts'));
        await step(needBrowser ? 'browser' : 'a11y', webEnv);
      }
    }
  }

  const tryParse = (file, parse) => {
    const text = readIf(file);
    if (text == null) return null;
    try { return parse(text); } catch (e) { result.note = [result.note, e.message].filter(Boolean).join(' '); return null; }
  };
  if (result.steps.vitest !== null) result.tests = tryParse(path.join(out, 'vitest.json'), parseVitestJson);
  if (needVerify && result.steps.vitest !== null) result.crossing = tryParse(path.join(dir, 'apps', 'server', 'reports', 'crossing.json'), parseCrossingJson);
  if (result.steps.browser !== null) {
    result.browser = tryParse(path.join(out, 'playwright.json'), parsePlaywrightJson);
    result.screenshots = readScreenshots(dir);
  }
  if (axeOk && (result.steps.browser !== null || result.steps.a11y !== null)) {
    result.a11y = tryParse(path.join(out, 'a11y.jsonl'), parseA11yLines);
  }
  return result;
}
