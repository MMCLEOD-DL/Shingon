// P07 browser checks: the built UI (dist/) against the REAL operator service and the REAL Conductor engine, with
// deterministic stand-in model CLIs (no models, no subscriptions). journey.mjs proves the UI drives the service's
// HTTP/SSE contract with a fixture worker; this proves a task started in the browser is planned, edited, tested,
// reviewed and landed by the real engine, and checks the adversarial cases that need a real browser:
//   - files changed after review: approval refused, nothing landed, and the UI says so;
//   - a page on another origin, in the signed-in browser, cannot start a task;
//   - a planted secret never reaches the browser, the built UI, the service's records or Git.
//
//   npm run build && node e2e/real-engine.mjs [--service <conductor dir with src/service>]
//
// journey.mjs runs this at its end, so CI covers both. Needs Playwright with Chromium.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { service: { type: 'string' } } });
const conductorDir = path.resolve(values.service ?? path.join(here, '..', '..'));
const serverFile = path.join(conductorDir, 'src', 'service', 'server.js');
if (!existsSync(serverFile)) { console.error(`No operator service at ${serverFile}. Pass --service <conductor dir>.`); process.exit(2); }
const uiDir = path.join(here, '..', 'dist');
if (!existsSync(path.join(uiDir, 'index.html'))) { console.error('Build the UI first: npm run build'); process.exit(2); }
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }

// A secret-looking value in the service's environment that model CLIs do inherit (a GitHub token is a realistic
// one). The stand-in CLIs print it back, as a careless model or tool might; it must be redacted everywhere it could
// surface. An API key is planted too: subscription mode must not pass it to any model CLI at all.
const SECRET = `ghp_planted${randomBytes(12).toString('hex')}`;
const API_KEY = `sk-ant-planted-${randomBytes(12).toString('hex')}`;
process.env.GITHUB_TOKEN = SECRET;
process.env.ANTHROPIC_API_KEY = API_KEY;
const { createAppServer } = await import(pathToFileURL(serverFile).href);
const { writeStubCli } = await import(pathToFileURL(path.join(conductorDir, 'test', 'helpers', 'stubCli.js')).href);

const root = mkdtempSync(path.join(tmpdir(), 'operator-web-engine-'));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const repo = path.join(root, 'repo'); mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.name', 'Engine journey'); git(repo, 'config', 'user.email', 'engine-journey@example.invalid');
writeFileSync(path.join(repo, 'README.md'), 'original\n');
writeFileSync(path.join(repo, 'checks.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('multiply.txt', 'utf8'), 'local did it\\n');\n");
git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial');
const originalHead = git(repo, 'rev-parse', 'HEAD').trim();

// The local model endpoint the engine probes, and the two subscription CLIs (as in test/service/engine.test.js).
const local = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[]}'); }); });
await new Promise((r) => local.listen(0, '127.0.0.1', r));
const seen = path.join(root, 'stub-saw-the-secret'), sawApiKey = path.join(root, 'stub-saw-an-api-key');
const bin = path.join(root, 'bin');
const claude = writeStubCli(bin, 'claude', `
  if (args[0] === '--version') { console.log('synthetic'); process.exit(0); }
  const key = process.env.GITHUB_TOKEN || '';
  if (key) require('fs').writeFileSync(${JSON.stringify(seen)}, 'yes');
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) require('fs').writeFileSync(${JSON.stringify(sawApiKey)}, 'yes');
  const sys = args[args.indexOf('--append-system-prompt') + 1] || '';
  const result = sys.includes('REVIEWER') ? 'Fine. Debug: my key is ' + key + '\\nVERDICT: APPROVE'
    : 'Plan using ' + key + '.\\n\`\`\`json\\n' + JSON.stringify({ summary: 'Add multiply (key ' + key + ')', chunks: [{ title: 'Add multiply', instructions: 'add it' }] }) + '\\n\`\`\`';
  console.log(JSON.stringify({ result, is_error: false }));`);
const codex = writeStubCli(bin, 'codex', `
  if (args[0] === '--version') { console.log('synthetic'); process.exit(0); }
  const fs = require('fs'); const out = args[args.indexOf('-o') + 1];
  if (args.includes('model_provider=localai')) { fs.writeFileSync('multiply.txt', 'local did it\\n'); fs.writeFileSync(out, 'Edited multiply.txt. Key: ' + (process.env.GITHUB_TOKEN || '')); }
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) fs.writeFileSync(${JSON.stringify(sawApiKey)}, 'yes');
  else fs.writeFileSync(out, 'Fine.\\nVERDICT: APPROVE');`);
const configFile = path.join(root, 'config.json'), dataDir = path.join(root, 'data');
writeFileSync(configFile, JSON.stringify({ participants: [
  { name: 'claude', adapter: 'claude-code', bin: claude, roles: ['author', 'reviewer'], capabilities: { can_edit_files: true } },
  { name: 'codex', adapter: 'codex', bin: codex, roles: ['author', 'reviewer'], capabilities: { can_edit_files: true } },
  { name: 'local', adapter: 'local-agent', bin: codex, model: 'synthetic', baseUrl: `http://127.0.0.1:${local.address().port}/v1`, roles: ['grunt'], capabilities: { can_edit_files: true } },
], options: { testCommand: 'node checks.cjs' }, routing: { allowApi: false } }));

const app = await createAppServer({ dataDir, configFile, port: 0, uiDir }); // no workerFile: the real engine
const browser = await chromium.launch();
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(['pass', name]); console.log(`pass  ${name}`); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log(`FAIL  ${name}\n      ${e.message.split('\n').slice(0, 4).join(' | ')}`); }
};
const conductorBranches = () => git(repo, 'branch', '--list', 'conductor/*').trim().split('\n').map((b) => b.replace(/^[*+ ]+/, '')).filter(Boolean);
let foreign;
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  const received = []; // every non-streaming response body the browser was given
  page.on('response', async (r) => { if (!r.url().includes('/events')) { try { received.push(await r.text()); } catch { /* navigations */ } } });
  const apiGet = async (pathname) => page.evaluate(async (u) => { const r = await fetch(u); return { status: r.status, body: await r.json() }; }, pathname);
  const runIdFrom = () => new URL(page.url()).pathname.split('/').pop();
  const startRun = async (text) => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New task' }).click();
    await page.getByLabel(/Describe the change/).fill(text);
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByRole('heading', { name: 'Review the finished work' }).waitFor({ timeout: 60000 });
    return runIdFrom();
  };

  await page.goto(`${app.origin}/#bootstrap=${app.bootstrapToken}`);
  await page.getByLabel(/Full path/).fill(repo);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Add repository' }).click();
  await page.getByRole('combobox').waitFor();

  let firstRun;
  await step('a task started in the browser is planned, edited and tested by the real engine', async () => {
    firstRun = await startRun('Add a multiply helper');
    await page.getByText(/local did it/).first().waitFor();
    await page.getByText('Tests passed').waitFor();
    const { body } = await apiGet(`/api/v1/runs/${firstRun}`);
    assert.equal(body.decision.kind, 'result');
    assert.equal(body.coverage.local, 'used', 'the local model did the edit');
    assert.deepEqual([...body.coverage.vendors].sort(), ['anthropic', 'openai']);
    assert.match(body.decision.evidence.commit, /^[0-9a-f]{40}$/);
  });

  await step('approving lands a real branch with exactly the reviewed change, and main is untouched', async () => {
    const { body } = await apiGet(`/api/v1/runs/${firstRun}`);
    const reviewed = body.decision.evidence.commit;
    await page.getByRole('button', { name: 'Approve: create a branch' }).click();
    await page.getByText('Branch created').waitFor({ timeout: 60000 });
    const done = (await apiGet(`/api/v1/runs/${firstRun}`)).body;
    assert.equal(done.status, 'completed');
    assert.deepEqual(conductorBranches(), [done.landedBranch]);
    assert.equal(git(repo, 'rev-parse', done.landedBranch).trim(), reviewed, 'the branch is the commit that was reviewed');
    assert.equal(git(repo, 'show', `${done.landedBranch}:multiply.txt`), 'local did it\n');
    assert.equal(git(repo, 'rev-parse', 'main').trim(), originalHead, 'nothing merged into main');
    assert.equal(git(repo, 'status', '--porcelain'), '', "the operator's checkout is untouched");
  });

  await step('files changed after review: approval is refused, the UI says so, and nothing lands', async () => {
    const runId = await startRun('Add multiply again');
    const workspace = app.runs.get(runId).workspaceDir;
    writeFileSync(path.join(workspace, 'multiply.txt'), 'changed after review\n');
    const before = conductorBranches();
    await page.getByRole('button', { name: 'Approve: create a branch' }).click();
    await page.getByText(/This question changed or was already answered/).waitFor({ timeout: 30000 });
    const { body } = await apiGet(`/api/v1/runs/${runId}`);
    assert.equal(body.landedBranch ?? null, null);
    assert.deepEqual(conductorBranches(), before, 'no new branch');
    assert.equal(git(repo, 'rev-parse', 'main').trim(), originalHead);
  });

  await step('a page on another origin, in the signed-in browser, cannot start a task', async () => {
    const runIds = async () => (await apiGet('/api/v1/runs')).body.runs.map((r) => r.id).sort();
    const runsBefore = await runIds();
    const repositoryId = (await apiGet('/api/v1/repositories')).body.repositories[0]?.id;
    assert.ok(repositoryId, 'the attacker is given the real repository id, the worst case');
    const start = JSON.stringify({ repositoryId, request: 'foreign task', presetId: 'default', clientRequestId: 'foreign-1' });
    // Same site as the service (127.0.0.1, another port), so a SameSite cookie alone would not stop it.
    foreign = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><body>
        <form id="f" method="POST" action="${app.origin}/api/v1/runs" enctype="text/plain" target="sink">
          <input name='${start.slice(0, -1)}, "x": "' value='"}'></form>
        <iframe name="sink"></iframe>
        <script>
          window.outcome = (async () => {
            const tries = {};
            for (const [name, init] of Object.entries({
              simple: { method: 'POST', credentials: 'include', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: ${JSON.stringify(start)} },
              json: { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(start)} },
            })) { try { const r = await fetch('${app.origin}/api/v1/runs', init); tries[name] = r.type === 'opaque' ? 'opaque' : r.status; } catch (e) { tries[name] = 'blocked'; } }
            document.getElementById('f').submit();
            return tries;
          })();
        </script></body>`);
    });
    await new Promise((r) => foreign.listen(0, '127.0.0.1', r));
    const evil = await context.newPage();
    const reached = []; // what the service answered each request that got through to it from the foreign page
    evil.on('response', (r) => { if (r.url().startsWith(app.origin)) reached.push(`${r.request().method()} ${r.status()}`); });
    await evil.goto(`http://127.0.0.1:${foreign.address().port}/`);
    const tries = await evil.evaluate(() => window.outcome);
    await evil.waitForTimeout(1500); // let the form post arrive
    await evil.close();
    assert.ok(tries.json !== 202 && tries.json !== 200, `a cross-origin JSON POST was accepted (${tries.json})`);
    // Several layers stop this (the JSON-only body rule and the browser's preflight too); the origin rule must be the
    // one that answers, so that it is tested on its own rather than hidden behind the others.
    assert.ok(reached.length >= 2, `too few requests reached the service to judge: ${reached.join(', ')}`);
    assert.deepEqual(reached.filter((r) => !r.endsWith(' 403')), [], 'refused by the origin rule (403) every time');
    assert.deepEqual(await runIds(), runsBefore, 'no run was created by the foreign page');
  });

  await step('a planted secret is redacted: never in the browser, the built UI, the records or Git', async () => {
    assert.ok(existsSync(seen), 'the stand-in model really had the secret, so its absence below means redaction');
    assert.ok(!existsSync(sawApiKey), 'subscription mode passed an API key to a model CLI');
    for (const p of [`/api/v1/runs/${firstRun}`, `/api/v1/runs/${firstRun}/review`, '/api/v1/runs', '/api/v1/setup']) {
      const { body } = await apiGet(p);
      received.push(JSON.stringify(body));
    }
    received.push(await page.content());
    const leaks = received.filter((t) => t.includes(SECRET) || t.includes(API_KEY)).map((t) => t.slice(Math.max(0, t.indexOf(SECRET) - 60), t.indexOf(SECRET)));
    assert.deepEqual(leaks, [], 'secret reached the browser after: ' + leaks.join(' | '));
    const files = (dir) => readdirSync(dir).flatMap((n) => { const f = path.join(dir, n); return statSync(f).isDirectory() ? files(f) : [f]; });
    // The model's words are kept in the run's transcript, not shown in the browser: there they must read [redacted].
    assert.ok(files(dataDir).some((f) => readFileSync(f, 'utf8').includes('Plan using [redacted]')), "the planner's text was recorded, redacted");
    const holding = [...files(uiDir), ...files(dataDir)].filter((f) => readFileSync(f).includes(SECRET) || readFileSync(f).includes(API_KEY));
    assert.deepEqual(holding.map((f) => path.relative(root, f)), [], 'secret written to disk by the service or in the UI bundle');
    assert.ok(!git(repo, 'log', '--all', '-p').includes(SECRET), 'secret in Git history');
    assert.ok(!git(repo, 'log', '--all', '--format=%B').includes(SECRET), 'secret in a commit message');
  });

  await step('no browser errors during the journey', async () => {
    assert.deepEqual(consoleErrors.filter((t) => !/status of (401|403|409)/.test(t)), []);
  });
} finally {
  await browser.close();
  await app.close();
  await new Promise((r) => local.close(r));
  if (foreign) await new Promise((r) => foreign.close(r));
  rmSync(root, { recursive: true, force: true });
}
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed (UI ${uiDir}; service ${serverFile}; engine: real, with stand-in model CLIs)`);
process.exit(failed ? 1 : 0);
