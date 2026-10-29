// Browser journey: the built UI (dist/) against the REAL operator service (P03) in Chromium.
// The engine is Codex's deterministic IPC fixture worker (no models, no Git landing), so this
// proves the UI drives the real HTTP/SSE contract, not that coding works (that is P07/P08).
//
//   npm run build && node e2e/journey.mjs [--service <conductor dir with src/service>] [--shots <dir>]
//
// Needs Playwright with Chromium (preinstalled in the cloud environment: require('playwright')).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { service: { type: 'string' }, shots: { type: 'string' } } });
const conductorDir = path.resolve(values.service ?? path.join(here, '..', '..'));
const serverFile = path.join(conductorDir, 'src', 'service', 'server.js');
if (!existsSync(serverFile)) { console.error(`No operator service at ${serverFile}. Pass --service <conductor dir>.`); process.exit(2); }
const uiDir = path.join(here, '..', 'dist');
if (!existsSync(path.join(uiDir, 'index.html'))) { console.error('Build the UI first: npm run build'); process.exit(2); }
const { createAppServer } = await import(pathToFileURL(serverFile).href);
const workerFile = path.join(conductorDir, 'test', 'fixtures', 'operator-app', 'fake-worker.cjs');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }

const root = mkdtempSync(path.join(tmpdir(), 'operator-web-journey-'));
const shots = values.shots ? path.resolve(values.shots) : null;
if (shots) mkdirSync(shots, { recursive: true });
const repo = path.join(root, 'repo'); mkdirSync(repo);
for (const args of [['init', '-q'], ['config', 'user.name', 'Journey'], ['config', 'user.email', 'journey@example.invalid']]) execFileSync('git', ['-C', repo, ...args]);
writeFileSync(path.join(repo, 'README.md'), 'synthetic\n');
execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'initial']);
const configFile = path.join(root, 'config.json');
writeFileSync(configFile, JSON.stringify({ participants: [
  { name: 'claude', adapter: 'claude-code', roles: ['author', 'reviewer'], capabilities: { can_edit_files: true } },
  { name: 'codex', adapter: 'codex', roles: ['author', 'reviewer'], capabilities: { can_edit_files: true } },
  { name: 'local', adapter: 'local-agent', model: 'synthetic', baseUrl: 'http://127.0.0.1:9/v1', roles: ['grunt'], capabilities: { can_edit_files: true } },
], routing: { allowApi: false }, options: { testCommand: 'node --test' } }));

const app = await createAppServer({ dataDir: path.join(root, 'data'), configFile, port: 0, uiDir, workerFile });
const browser = await chromium.launch();
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(['pass', name]); console.log(`pass  ${name}`); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`); }
};
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.addInitScript(() => { window.__pwned = false; window.evil = () => { window.__pwned = true; }; });

  await step('the bootstrap link signs in and the token leaves the address bar', async () => {
    await page.goto(`${app.origin}/#bootstrap=${app.bootstrapToken}`);
    await page.getByRole('heading', { name: 'New coding task' }).waitFor();
    assert.equal(new URL(page.url()).hash, '');
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    assert.ok(!stored.includes(app.bootstrapToken));
  });

  await step('the bootstrap link cannot be used a second time (new context)', async () => {
    const other = await (await browser.newContext()).newPage();
    await other.goto(`${app.origin}/#bootstrap=${app.bootstrapToken}`);
    await other.getByText(/Bootstrap token expired or invalid/).waitFor();
    await other.context().close();
  });

  await step('a repository is registered only after confirming the access granted', async () => {
    await page.getByLabel(/Full path/).fill(repo);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText(/It never merges or pushes/).waitFor();
    await page.getByRole('button', { name: 'Add repository' }).click();
    await page.getByRole('combobox').waitFor();
  });

  const startRun = async (text) => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New task' }).click();
    await page.getByLabel(/Describe the change/).fill(text);
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByRole('heading', { name: 'Review the finished work' }).waitFor({ timeout: 15000 });
  };

  await step('start → live progress → decision with the actual evidence', async () => {
    await startRun('Add a doubled() helper');
    await page.getByText('+synthetic change').waitFor();
    await page.getByText('Tests passed').waitFor();
    assert.ok(await page.getByRole('button', { name: 'Approve: create a branch' }).isEnabled());
  });

  await step('untrusted model text is shown literally and runs nothing', async () => {
    await page.getByText('<script>untrusted</script>').first().waitFor();
    assert.equal(await page.evaluate(() => window.__pwned), false);
    assert.equal(await page.locator('main script').count(), 0);
  });

  await step('focus lands on the pending question (keyboard users)', async () => {
    const focused = await page.evaluate(() => document.activeElement?.textContent);
    assert.equal(focused, 'Review the finished work');
  });

  await step('reloading while a question is pending neither answers it nor loses it', async () => {
    await page.reload();
    await page.getByRole('heading', { name: 'Review the finished work' }).waitFor();
    assert.match(await page.getByRole('status').first().textContent(), /Needs your decision/);
  });

  if (shots) await page.screenshot({ path: path.join(shots, 'decision-desktop.png'), fullPage: true });

  await step('approve → answer saved (not "done") → branch created', async () => {
    await page.getByRole('button', { name: 'Approve: create a branch' }).click();
    await page.getByText('Branch created').waitFor({ timeout: 15000 });
    await page.getByText(/was created in the repository\. Nothing was merged, pushed or deployed\./).waitFor();
  });

  await step('a second run: reject → no branch', async () => {
    await startRun('Second synthetic task');
    await page.getByLabel(/If you reject/).fill('Use a clearer name.');
    await page.getByRole('button', { name: 'Reject' }).click();
    await page.getByText('Rejected — no branch created').waitFor({ timeout: 15000 });
  });

  await step('history lists both runs with their outcomes', async () => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'History' }).click();
    await page.getByRole('cell', { name: /Branch created/ }).waitFor();
    await page.getByRole('cell', { name: /Rejected — no branch created/ }).waitFor();
  });

  await step('connections page: nothing claims "verified" without a check, and no secret fields', async () => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Connections' }).click();
    await page.getByRole('heading', { name: 'Participants' }).waitFor();
    assert.equal(await page.getByText('verified', { exact: true }).count(), 0);
    assert.equal(await page.locator('input[type=password]').count(), 0);
  });

  await step('phone width: no horizontal scrolling on the run page', async () => {
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState() })).newPage();
    await phone.goto(`${app.origin}/history`);
    await phone.getByRole('heading', { name: 'History' }).waitFor();
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (shots) await phone.screenshot({ path: path.join(shots, 'history-phone.png'), fullPage: true });
    assert.ok(overflow <= 1, `page is ${overflow}px wider than the screen`);
    await phone.context().close();
  });

  await step('no browser errors and no CSP violations during the journey', async () => {
    assert.deepEqual(consoleErrors.filter((t) => !/Failed to load resource: the server responded with a status of 401/.test(t)), []);
  });
} finally {
  await browser.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed (UI ${uiDir}; service ${serverFile}; engine: deterministic fixture worker, no models)`);
process.exit(failed ? 1 : 0);
