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
import { execFileSync, spawn } from 'node:child_process';
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
  catch (e) { results.push(['FAIL', name, e.message]); console.log(`FAIL  ${name}\n      ${e.message.split('\n').slice(0, 4).join(' | ')}`); }
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

  // Second service with Codex's slow-landing worker (P3-1): approval starts an irreversible landing.
  const landing = await createAppServer({ dataDir: path.join(root, 'data-landing'), configFile, port: 0, uiDir,
    workerFile: path.join(conductorDir, 'test', 'fixtures', 'operator-app', 'slow-land-worker.cjs') });
  try {
    const lp = await (await browser.newContext()).newPage();
    lp.on('pageerror', (e) => consoleErrors.push(e.message));
    await lp.goto(`${landing.origin}/#bootstrap=${landing.bootstrapToken}`);
    await lp.getByLabel(/Full path/).fill(repo);
    await lp.getByRole('button', { name: 'Continue' }).click();
    await lp.getByRole('button', { name: 'Add repository' }).click();
    const begin = async (text) => {
      await lp.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New task' }).click();
      await lp.getByLabel(/Describe the change/).fill(text);
      await lp.getByRole('button', { name: 'Start' }).click();
      await lp.getByRole('heading', { name: 'Review the finished work' }).waitFor({ timeout: 15000 });
      await lp.getByRole('button', { name: 'Approve: create a branch' }).click();
    };

    await step('during an approved landing the Stop action is never offered', async () => {
      await begin('slow landing');
      await lp.getByText(/Answer saved/).waitFor();
      const until = Date.now() + 250;
      while (Date.now() < until) {
        if (await lp.getByRole('button', { name: /Stop run/ }).count()) throw new Error('Stop offered during landing: ' + (await lp.locator('main').innerText()).slice(0, 400));
        await lp.waitForTimeout(25);
      }
      await lp.getByText('Branch created').waitFor({ timeout: 15000 });
    });

    await step('worker lost after approval: the UI asks for repository inspection and offers no Resume', async () => {
      execFileSync('git', ['-C', repo, 'branch', '-D', 'conductor/landed']);
      await begin('crash-after-approval');
      await lp.getByText(/The approved result may already be in the repository/).waitFor({ timeout: 15000 });
      assert.equal(await lp.getByRole('button', { name: 'Resume' }).count(), 0);
      assert.match(execFileSync('git', ['-C', repo, 'branch', '--list', 'conductor/landed'], { encoding: 'utf8' }), /conductor\/landed/);
    });

    await step('recording an inspection for a run with no saved workspace is refused by the service and the UI says so', async () => {
      const box = lp.getByRole('checkbox', { name: /I have inspected the repository/ });
      const record = lp.getByRole('button', { name: 'Record inspection' });
      assert.equal(await record.isDisabled(), true);
      await box.check();
      await record.click();
      await lp.getByText(/no resumable workspace/).waitFor({ timeout: 5000 });
      assert.equal(await lp.getByRole('button', { name: 'Resume' }).count(), 0);
    });
    await lp.context().close();
  } finally { await landing.close(); }

  // Third service with the UI's own inspect worker: lost after approval, but with a saved workspace.
  process.env.JOURNEY_CONDUCTOR_DIR = conductorDir; // the worker uses this checkout's real Workspace
  const inspecting = await createAppServer({ dataDir: path.join(root, 'data-inspect'), configFile, port: 0, uiDir,
    workerFile: path.join(here, 'inspect-worker.cjs') });
  try {
    const ip = await (await browser.newContext()).newPage();
    ip.on('pageerror', (e) => consoleErrors.push(e.message));
    await ip.goto(`${inspecting.origin}/#bootstrap=${inspecting.bootstrapToken}`);
    await ip.getByLabel(/Full path/).fill(repo);
    await ip.getByRole('button', { name: 'Continue' }).click();
    await ip.getByRole('button', { name: 'Add repository' }).click();

    await step('inspection is recorded only after confirming, starts nothing, and then Resume reconciles without a second branch', async () => {
      await ip.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New task' }).click();
      await ip.getByLabel(/Describe the change/).fill('inspect after a lost worker');
      await ip.getByRole('button', { name: 'Start' }).click();
      await ip.getByRole('heading', { name: 'Review the finished work' }).waitFor({ timeout: 15000 });
      await ip.getByRole('button', { name: 'Approve: create a branch' }).click();
      await ip.getByRole('heading', { name: 'Check the repository before recovering' }).waitFor({ timeout: 15000 });
      const runId = new URL(ip.url()).pathname.split('/').pop();
      const readRun = () => ip.evaluate(async (id) => (await fetch(`/api/v1/runs/${id}`)).json(), runId);
      const approved = (await readRun()).workspaceCommit;
      const panel = await ip.locator('.recovery').innerText();
      assert.ok(panel.includes(repo), 'the inspection steps name the registered repository');
      assert.ok(panel.includes(approved), 'the inspection steps name the approved commit');
      assert.equal(await ip.getByRole('button', { name: 'Resume' }).count(), 0);
      // What the operator would see with the panel's own read-only command: the branch is already there.
      assert.match(execFileSync('git', ['-C', repo, 'branch', '--points-at', approved], { encoding: 'utf8' }), /conductor\/inspected/);
      await ip.setViewportSize({ width: 360, height: 800 });
      assert.ok(await ip.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no horizontal scrolling with the inspection steps at phone width');
      await ip.setViewportSize({ width: 1280, height: 800 });

      await ip.getByRole('checkbox', { name: /I have inspected the repository/ }).check();
      await ip.getByRole('button', { name: 'Record inspection' }).click();
      await ip.getByText(/Inspection recorded. Nothing has started/).waitFor({ timeout: 5000 });
      await ip.getByRole('button', { name: 'Resume' }).waitFor({ timeout: 5000 });
      const run = await readRun();
      assert.equal(run.status, 'interrupted', 'recording the inspection starts no worker');
      assert.equal(run.recoveryAcknowledged?.commit, approved);

      await ip.getByRole('button', { name: 'Resume' }).click();
      await ip.getByText('Branch created').waitFor({ timeout: 15000 });
      const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'conductor/inspected'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      assert.equal(branches.length, 1);
    });
    await ip.context().close();
  } finally { await inspecting.close(); }

  // ---- P07 adversarial checks (UI side) ----
  const runIdFrom = (p) => new URL(p.url()).pathname.split('/').pop();
  const apiGet = async (p, pathname) => p.evaluate(async (u) => { const r = await fetch(u); return { status: r.status, body: await r.json() }; }, pathname);

  await step('two tabs, one question: only the first answer counts; the stale tab is told and sends nothing that lands', async () => {
    const ctx = await browser.newContext({ storageState: await context.storageState() });
    const a = await ctx.newPage(), b = await ctx.newPage();
    await a.goto(`${app.origin}/`);
    await a.getByLabel(/Describe the change/).fill('two-tab race');
    await a.getByRole('button', { name: 'Start' }).click();
    await a.getByRole('heading', { name: 'Review the finished work' }).waitFor({ timeout: 15000 });
    const runId = runIdFrom(a);
    // Tab B's live stream is cut, so it keeps showing the question after tab A has answered it.
    await b.route('**/events?**', (route) => route.abort());
    await b.goto(`${app.origin}/runs/${runId}`);
    await b.getByRole('heading', { name: 'Review the finished work' }).waitFor();
    await b.getByText(/Connection lost — reconnecting/).waitFor();
    await a.getByRole('button', { name: 'Approve: create a branch' }).click();
    await a.getByText('Branch created').waitFor({ timeout: 15000 });
    await b.getByRole('button', { name: 'Approve: create a branch' }).click();
    await b.getByText(/This question changed or was already answered/).waitFor();
    assert.equal(await b.getByText(/Answer saved/).count(), 0);
    const { body } = await apiGet(a, `/api/v1/runs/${runId}`);
    assert.equal(body.status, 'completed');
    // Count resolutions from the replayed event stream: read it for one second, then abort (it never ends by itself).
    const resolved = await a.evaluate(async (u) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 1000);
      let text = '';
      try {
        const reader = (await fetch(u, { signal: ctl.signal })).body.getReader();
        for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
      } catch { /* aborted after the replay */ } finally { clearTimeout(timer); }
      return text.split('\n').filter((l) => l.startsWith('data:') && l.includes('"decision-resolved"')).length;
    }, `/api/v1/runs/${runId}/events?after=0`);
    assert.equal(resolved, 1, `expected one recorded answer, found ${resolved}`);
    await ctx.close();
  });

  await step('abrupt service kill during a question, then restart: the question is withdrawn, never answered, and the UI says how to sign in again', async () => {
    const dataDir = path.join(root, 'data-kill');
    const serve = (port) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(here, 'serve-fixture.mjs'), '--service', conductorDir, '--data', dataDir, '--config', configFile,
        '--ui', uiDir, '--worker', workerFile, '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (c) => { out += c; const line = out.split('\n')[0]; if (out.includes('\n')) resolve({ child, ...JSON.parse(line) }); });
      child.on('exit', (code) => reject(new Error(`fixture service exited (${code})`)));
    });
    const first = await serve(0);
    const port = new URL(first.origin).port;
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    try {
      await p.goto(`${first.origin}/#bootstrap=${first.bootstrapToken}`);
      await p.getByLabel(/Full path/).fill(repo);
      await p.getByRole('button', { name: 'Continue' }).click();
      await p.getByRole('button', { name: 'Add repository' }).click();
      await p.getByLabel(/Describe the change/).fill('killed mid-question');
      await p.getByRole('button', { name: 'Start' }).click();
      await p.getByRole('heading', { name: 'Review the finished work' }).waitFor({ timeout: 15000 });
      const runId = runIdFrom(p);
      first.child.kill('SIGKILL');
      await new Promise((r) => first.child.once('exit', r));
      await p.getByText(/Connection lost — reconnecting/).waitFor({ timeout: 15000 });
      const second = await serve(port);
      try {
        // The old session died with the process: the open tab must not answer, and must say what to do.
        await p.getByRole('button', { name: 'Approve: create a branch' }).click();
        await p.getByText(/Your sign-in has ended/).waitFor({ timeout: 15000 });
        await p.goto(`${second.origin}/#bootstrap=${second.bootstrapToken}`);
        // Wait for sign-in to finish: navigating away at once can cancel the session POST before its cookie is set.
        await p.getByRole('heading', { name: 'New coding task' }).waitFor({ timeout: 15000 });
        await p.goto(`${second.origin}/runs/${runId}`);
        await p.getByText('Interrupted', { exact: true }).waitFor({ timeout: 15000 });
        await p.getByText(/Any question it was asking has been withdrawn/).waitFor();
        assert.equal(await p.getByRole('button', { name: 'Approve: create a branch' }).count(), 0);
        const { body } = await apiGet(p, `/api/v1/runs/${runId}`);
        assert.equal(body.status, 'interrupted');
        assert.equal(body.decision, null);
        assert.equal(body.landedBranch, null);
      } finally { second.child.kill('SIGTERM'); await new Promise((r) => second.child.once('exit', r)); }
    } finally { await ctx.close(); if (first.child.exitCode === null) first.child.kill('SIGKILL'); }
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
