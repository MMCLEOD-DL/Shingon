import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAppChecks, browsersInstalled, checksLine, testDatabaseProblem, verifyWithReports, VERIFY_COMMAND } from '../src/factory/checks.js';
import { git } from '../src/workspace.js';
import { makeFoundationRepo } from './helpers/factoryFixtures.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
// A fake `run`: records commands, answers npm ci / the test command / the browser gate as told.
function fakeRun({ verify = 0, e2e = 0, writeReport = true } = {}) {
  const calls = [];
  const run = async (o) => {
    calls.push(o);
    const line = [o.cmd, ...(o.args ?? [])].join(' ');
    if (line.includes('test:e2e')) { writeFileSync(o.env.PLAYWRIGHT_JSON_OUTPUT_FILE, '{}'); return { code: e2e, stdout: e2e ? '2 failed: phone layout scrolls sideways' : '24 passed', stderr: '', timedOut: false }; }
    if (o.cmd === 'sh') {
      const m = o.args[1].match(/--outputFile\.json='([^']+)'/); if (m) writeFileSync(m[1], '{}');
      if (writeReport) { mkdirSync(path.join(o.cwd, 'apps/server/reports'), { recursive: true }); writeFileSync(path.join(o.cwd, 'apps/server/reports/crossing.md'), '# 12 routes, 0 failures\n'); }
      return { code: verify, stdout: verify ? 'FAIL apps/server/test/x.test.ts' : 'ok', stderr: '', timedOut: false };
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  };
  return { run, calls };
}
const browsersHome = () => { const h = tmp('home-'); mkdirSync(path.join(h, '.cache/ms-playwright/chromium-1248'), { recursive: true }); mkdirSync(path.join(h, '.cache/ms-playwright/webkit-2370'), { recursive: true }); return h; };
const headSha = async (appDir) => (await git(appDir, ['rev-parse', 'HEAD'])).stdout.trim();

test('green: clone at the commit, install, verify, browser gate; reports copied; the clone removed', async () => {
  const appDir = await makeFoundationRepo();
  const sha = await headSha(appDir);
  const workDir = path.join(tmp('chk-'), 'check');
  const reportsDir = tmp('rep-');
  const { run, calls } = fakeRun();
  const c = await runAppChecks({ appDir, sha, workDir, reportsDir, run, home: browsersHome(), env: {} });
  assert.deepEqual([c.verify.status, c.browser.status], ['passed', 'passed']);
  assert.deepEqual(calls.map((x) => x.cmd === 'sh' ? x.args[1] : [x.cmd, ...x.args].join(' ')),
    ['npm ci --no-audit --no-fund --loglevel=error', verifyWithReports(reportsDir), 'npm run test:e2e -- --reporter=list,json']);
  assert.equal(calls[2].env.PLAYWRIGHT_JSON_OUTPUT_FILE, path.join(reportsDir, 'playwright.json'));
  assert.equal(readFileSync(path.join(reportsDir, 'crossing.md'), 'utf8'), '# 12 routes, 0 failures\n');
  assert.deepEqual(c.reports, ['vitest.json', 'playwright.json', 'crossing.md'].map((n) => path.join(reportsDir, n)));
  assert.equal(existsSync(workDir), false);
  assert.equal(checksLine(c), 'All checks pass (lint, types, licences and every test, including the role-crossing tests), and the browser checks pass.');
});

test('verifyWithReports adds the vitest JSON reporter after the double dash', () => {
  assert.ok(VERIFY_COMMAND.endsWith('&& npm run verify'));
  assert.equal(verifyWithReports('/r/it s'), `${VERIFY_COMMAND} -- -- --reporter=default --reporter=json --outputFile.json='/r/it s/vitest.json'`);
});

test('red verify: the browser gate is skipped and the output is kept, clipped and redacted', async () => {
  const appDir = await makeFoundationRepo();
  const sha = await headSha(appDir);
  const { run } = fakeRun({ verify: 1 });
  const c = await runAppChecks({ appDir, sha, workDir: path.join(tmp('chk-'), 'c'), reportsDir: tmp('rep-'), run, home: browsersHome(), env: {} });
  assert.equal(c.verify.status, 'failed');
  assert.match(c.verify.output, /FAIL apps\/server\/test\/x\.test\.ts/);
  assert.equal(c.browser.status, 'skipped');
  assert.match(checksLine(c), /^The checks FAIL/);
});

test('browser gate red: the checks line names it', async () => {
  const appDir = await makeFoundationRepo();
  const sha = await headSha(appDir);
  const c = await runAppChecks({ appDir, sha, workDir: path.join(tmp('chk-'), 'c'), reportsDir: tmp('rep-'), run: fakeRun({ e2e: 1 }).run, home: browsersHome(), env: {} });
  assert.equal(c.browser.status, 'failed');
  assert.match(checksLine(c), /^All checks pass, but the browser checks FAIL: 2 failed/);
});

test('no browsers: the browser gate shows as not run, with the install hint', async () => {
  const appDir = await makeFoundationRepo();
  const sha = await headSha(appDir);
  const c = await runAppChecks({ appDir, sha, workDir: path.join(tmp('chk-'), 'c'), reportsDir: tmp('rep-'), run: fakeRun().run, home: tmp('nohome-'), env: {} });
  assert.equal(c.browser.status, 'missing');
  assert.match(c.browser.summary, /npx playwright install chromium webkit/);
  assert.equal(browsersInstalled({ home: browsersHome(), env: {} }).ok, true);
  assert.equal(browsersInstalled({ home: tmp('nohome-'), env: {} }).ok, false);
  assert.equal(browsersInstalled({ home: tmp('nohome-'), env: { PLAYWRIGHT_BROWSERS_PATH: path.join(browsersHome(), '.cache/ms-playwright') } }).ok, true);
});

test('browser: false skips the gate without looking for browsers', async () => {
  const appDir = await makeFoundationRepo();
  const sha = await headSha(appDir);
  const c = await runAppChecks({ appDir, sha, workDir: path.join(tmp('chk-'), 'c'), reportsDir: tmp('rep-'), run: fakeRun().run, browser: false, env: {} });
  assert.equal(c.browser.status, 'skipped');
});

test('npm ci failing is a failed verify in plain words', async () => {
  const appDir = await makeFoundationRepo();
  const sha = await headSha(appDir);
  const run = async (o) => (o.cmd === 'npm' ? { code: 1, stdout: '', stderr: 'ERR! network', timedOut: false } : { code: 0, stdout: '', stderr: '' });
  const c = await runAppChecks({ appDir, sha, workDir: path.join(tmp('chk-'), 'c'), reportsDir: tmp('rep-'), run, browser: false, env: {} });
  assert.equal(c.verify.status, 'failed');
  assert.match(c.verify.summary, /could not install the app's packages/);
});

test('a custom test command runs as given, with no vitest report', async () => {
  const appDir = await makeFoundationRepo();
  const sha = await headSha(appDir);
  const { run, calls } = fakeRun({ writeReport: false });
  const c = await runAppChecks({ appDir, sha, workDir: path.join(tmp('chk-'), 'c'), reportsDir: tmp('rep-'), run, browser: false, testCommand: 'node -e 0', env: {} });
  assert.equal(calls.find((x) => x.cmd === 'sh').args[1], 'node -e 0');
  assert.deepEqual(c.reports, []);
});

test('TEST_DATABASE_URL is required only for the real verify', () => {
  assert.match(testDatabaseProblem({ testCommand: null, env: {} }), /TEST_DATABASE_URL is not set/);
  assert.equal(testDatabaseProblem({ testCommand: null, env: { TEST_DATABASE_URL: 'postgres://x@127.0.0.1/postgres' } }), null);
  assert.equal(testDatabaseProblem({ testCommand: 'node -e 0', env: {} }), null);
});
