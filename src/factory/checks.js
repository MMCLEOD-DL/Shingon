// Whole-app checks: the foundation's own gates, run on one commit of the app in a
// throwaway clone so <project>/app stays clean. The JSON reports are written straight
// into reportsDir under fixed names (Contract 7 section 7.7): vitest.json,
// playwright.json, crossing.md, crossing.json, screenshots.
import { mkdirSync, rmSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { git } from '../workspace.js';
import { runCommand } from '../exec.js';
import { strictChildEnv, redact, secretValues } from '../secrets.js';
import { clip } from '../text.js';

// Task 10's src/factory/remote.js will own this; kept local until that file exists.
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const VERIFY_COMMAND = '{ [ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-audit --no-fund --loglevel=error; } && npm run verify';

// npm appends the arguments after the first `--` to the script's last command (vitest run).
export function verifyWithReports(reportsDir) {
  return `${VERIFY_COMMAND} -- -- --reporter=default --reporter=json --outputFile.json=${shQuote(path.join(reportsDir, 'vitest.json'))}`;
}

export function browsersInstalled({ env = process.env, home = homedir() } = {}) {
  const root = env.PLAYWRIGHT_BROWSERS_PATH || path.join(home, '.cache', 'ms-playwright');
  let names = [];
  try { names = readdirSync(root); } catch { /* none */ }
  const has = (b) => names.some((n) => new RegExp(`^${b}-\\d+$`).test(n));
  const missing = ['chromium', 'webkit'].filter((b) => !has(b));
  return missing.length ? { ok: false, why: `no ${missing.join(' or ')} browser in ${root}` } : { ok: true, why: '' };
}

export function testDatabaseProblem({ testCommand = null, env = process.env } = {}) {
  if (testCommand != null || env.TEST_DATABASE_URL) return null;
  return "TEST_DATABASE_URL is not set, so the foundation's tests cannot reach a database. Set it to a PostgreSQL role that may create databases (for example postgres://hf_test@127.0.0.1/postgres) and run the command again.";
}

const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

export async function runAppChecks({ appDir, sha, workDir, reportsDir, testCommand = null, browser = true, env = process.env, home, run = runCommand, timeoutMs = 3_600_000 }) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(sha))) throw new Error(`${sha} is not a commit id`);
  const secrets = [env.TEST_DATABASE_URL, ...secretValues(env), ...secretValues()].filter(Boolean);
  const outputOf = (r) => clip(redact(`${r.stdout ?? ''}${r.stderr ?? ''}`, secrets) + (r.timedOut ? '\n[timed out]' : ''), 4000);
  for (const n of ['vitest.json', 'playwright.json', 'crossing.md', 'crossing.json', 'screenshots']) rmSync(path.join(reportsDir, n), { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(path.dirname(workDir), { recursive: true });
  const clone = await git(path.dirname(workDir), ['clone', '--quiet', '--no-hardlinks', appDir, workDir], { timeoutMs: 300_000 });
  if (clone.code !== 0) throw new Error(`could not clone the app for the checks: ${firstLine(clone.stderr)}`);
  const co = await git(workDir, ['checkout', '-q', '--detach', sha, '--']);
  if (co.code !== 0) { rmSync(workDir, { recursive: true, force: true }); throw new Error(`could not check out ${sha} for the checks: ${firstLine(co.stderr)}`); }
  try {
    const childEnv = strictChildEnv({ env });
    mkdirSync(reportsDir, { recursive: true });
    let verify, browserResult;

    const install = await run({ cmd: 'npm', args: ['ci', '--no-audit', '--no-fund', '--loglevel=error'], cwd: workDir, env: childEnv, timeoutMs });
    if (install.code !== 0 || install.timedOut) {
      verify = { status: 'failed', summary: "Conductor could not install the app's packages (npm ci failed), so the checks could not run.", output: outputOf(install) };
    } else {
      const r = await run({ cmd: 'sh', args: ['-c', testCommand ?? verifyWithReports(reportsDir)], cwd: workDir, env: childEnv, timeoutMs });
      const ok = r.code === 0 && !r.timedOut;
      verify = { status: ok ? 'passed' : 'failed', summary: ok ? 'Lint, types, licences and every test pass.' : 'The main checks failed.', output: outputOf(r) };
    }

    if (browser === false) browserResult = { status: 'skipped', summary: 'The browser checks are turned off in the settings.' };
    else if (verify.status !== 'passed') browserResult = { status: 'skipped', summary: 'The browser checks did not run, because the main checks failed.' };
    else if (!browsersInstalled({ env, home }).ok) {
      browserResult = { status: 'missing', summary: "The browser checks did not run: Playwright's browsers are not installed on this computer (run: npx playwright install chromium webkit)." };
    } else {
      const r = await run({ cmd: 'npm', args: ['run', 'test:e2e', '--', '--reporter=list,json'], cwd: workDir, env: { ...childEnv, PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(reportsDir, 'playwright.json') }, timeoutMs });
      const ok = r.code === 0 && !r.timedOut;
      browserResult = { status: ok ? 'passed' : 'failed', summary: ok ? 'The browser checks pass.' : 'The browser checks failed.', output: outputOf(r) };
    }

    for (const rel of ['apps/server/reports/crossing.md', 'apps/server/reports/crossing.json', 'reports/screenshots']) {
      const from = path.join(workDir, rel);
      if (existsSync(from)) cpSync(from, path.join(reportsDir, path.basename(rel)), { recursive: true });
    }
    const reports = ['vitest.json', 'playwright.json', 'crossing.md', 'crossing.json', 'screenshots']
      .map((n) => path.join(reportsDir, n)).filter((p) => existsSync(p));
    return { sha, verify, browser: browserResult, reports };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function checksLine(checks) {
  const { verify, browser } = checks;
  if (verify.status !== 'passed') return `The checks FAIL: ${firstLine(verify.output) || verify.summary}`;
  const base = 'All checks pass (lint, types, licences and every test, including the role-crossing tests)';
  if (browser.status === 'passed') return `${base}, and the browser checks pass.`;
  if (browser.status === 'failed') return `All checks pass, but the browser checks FAIL: ${firstLine(browser.output) || browser.summary}`;
  return `${base}. ${browser.summary}`;
}
