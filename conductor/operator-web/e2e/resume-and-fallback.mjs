// Browser checks for what happens after a question is interrupted or answered, against the REAL operator service and
// the REAL Conductor engine with deterministic stand-in model CLIs (no models, no subscriptions):
//   - the service is killed while a result question is pending and started again: the question is withdrawn, Resume
//     asks again on fresh evidence, and approving then creates exactly one branch at the reviewed commit;
//   - the local model is down: the fallback question highlights neither choice; Pause and Use subscriptions each
//     leave a page that says what actually happened.
// The service runs as its own process (e2e/serve-fixture.mjs without --worker, so the real engine) so it can be
// killed abruptly and restarted on the same data directory and port.
//
//   npm run build && node e2e/resume-and-fallback.mjs [--service <conductor dir with src/service>]
//
// journey.mjs runs this at its end, so CI covers it. Needs Playwright with Chromium.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { service: { type: 'string' } } });
const conductorDir = path.resolve(values.service ?? path.join(here, '..', '..'));
if (!existsSync(path.join(conductorDir, 'src', 'service', 'server.js'))) { console.error(`No operator service in ${conductorDir}. Pass --service <conductor dir>.`); process.exit(2); }
const uiDir = path.join(here, '..', 'dist');
if (!existsSync(path.join(uiDir, 'index.html'))) { console.error('Build the UI first: npm run build'); process.exit(2); }
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }
const { writeStubCli } = await import(pathToFileURL(path.join(conductorDir, 'test', 'helpers', 'stubCli.js')).href);

const root = mkdtempSync(path.join(tmpdir(), 'operator-web-resume-'));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const repo = path.join(root, 'repo'); mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.name', 'Resume journey'); git(repo, 'config', 'user.email', 'resume-journey@example.invalid');
writeFileSync(path.join(repo, 'README.md'), 'original\n');
git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial');
const originalHead = git(repo, 'rev-parse', 'HEAD').trim();
const conductorBranches = () => git(repo, 'branch', '--list', 'conductor/*').trim().split('\n').map((b) => b.replace(/^[*+ ]+/, '')).filter(Boolean);

// A local model endpoint that answers the engine's probe, and the two subscription CLIs (as in real-engine.mjs).
const local = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[]}'); }); });
await new Promise((r) => local.listen(0, '127.0.0.1', r));
const bin = path.join(root, 'bin');
const claude = writeStubCli(bin, 'claude', `
  if (args[0] === '--version') { console.log('synthetic'); process.exit(0); }
  const sys = args[args.indexOf('--append-system-prompt') + 1] || '';
  const result = sys.includes('REVIEWER') ? 'Fine.\\nVERDICT: APPROVE'
    : 'Plan.\\n\`\`\`json\\n' + JSON.stringify({ summary: 'Add multiply', chunks: [{ title: 'Add multiply', instructions: 'add it' }] }) + '\\n\`\`\`';
  console.log(JSON.stringify({ result, is_error: false }));`);
const codex = writeStubCli(bin, 'codex', `
  if (args[0] === '--version') { console.log('synthetic'); process.exit(0); }
  const fs = require('fs'); const out = args[args.indexOf('-o') + 1];
  if (args.includes('model_provider=localai')) { fs.writeFileSync('multiply.txt', 'local did it\\n'); fs.writeFileSync(out, 'Edited multiply.txt.'); }
  else fs.writeFileSync(out, 'Fine.\\nVERDICT: APPROVE');`);
const config = (name, localUrl) => {
  const file = path.join(root, `${name}.json`);
  writeFileSync(file, JSON.stringify({ participants: [
    { name: 'claude', adapter: 'claude-code', bin: claude, roles: ['author', 'reviewer'], capabilities: { can_edit_files: true } },
    { name: 'codex', adapter: 'codex', bin: codex, roles: ['author', 'reviewer'], capabilities: { can_edit_files: true } },
    { name: 'local', adapter: 'local-agent', bin: codex, model: 'synthetic', baseUrl: localUrl, roles: ['grunt'], capabilities: { can_edit_files: true } },
  ], options: { testCommand: 'node --version' }, routing: { allowApi: false } }));
  return file;
};
const serve = (dataDir, configFile, port = 0) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(here, 'serve-fixture.mjs'), '--service', conductorDir, '--data', dataDir,
    '--config', configFile, '--ui', uiDir, '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; if (out.includes('\n')) resolve({ child, ...JSON.parse(out.split('\n')[0]) }); });
  child.on('exit', (code) => reject(new Error(`service exited (${code})`)));
});
const stop = async (s, signal = 'SIGTERM') => { if (s && s.child.exitCode === null && s.child.signalCode === null) { s.child.kill(signal); await new Promise((r) => s.child.once('exit', r)); } };

const browser = await chromium.launch();
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(['pass', name]); console.log(`pass  ${name}`); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log(`FAIL  ${name}\n      ${e.message.split('\n').slice(0, 4).join(' | ')}`); }
};
const consoleErrors = [];
const newPage = async () => {
  const p = await (await browser.newContext()).newPage();
  p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  p.on('pageerror', (e) => consoleErrors.push(e.message));
  return p;
};
const signInAndRegister = async (p, s) => {
  await p.goto(`${s.origin}/#bootstrap=${s.bootstrapToken}`);
  await p.getByLabel(/Full path/).fill(repo);
  await p.getByRole('button', { name: 'Continue' }).click();
  await p.getByRole('button', { name: 'Add repository' }).click();
  await p.getByRole('combobox').waitFor();
};
const start = async (p, text, heading) => {
  await p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'New task' }).click();
  await p.getByLabel(/Describe the change/).fill(text);
  await p.getByRole('button', { name: 'Start' }).click();
  await p.getByRole('heading', { name: heading }).waitFor({ timeout: 60000 });
  return new URL(p.url()).pathname.split('/').pop();
};
const readRun = (p, runId) => p.evaluate(async (id) => (await fetch(`/api/v1/runs/${id}`)).json(), runId);
const statusLine = (p) => p.locator('p.status').innerText();
// The note shown after an answer is accepted: true only until the run has moved on.
const STILL_WAITING = /Answer saved\. Waiting for Conductor to continue/;
const SETTLED = new Set(['Branch created', 'Rejected — no branch created', 'Paused', 'Interrupted', 'Failed']);

let services = [];
try {
  await step('service killed during a real result question, restarted, then Resume: asked again on fresh evidence, one branch, and no stale "waiting" note', async () => {
    const dataDir = path.join(root, 'data-restart'), configFile = config('local-up', `http://127.0.0.1:${local.address().port}/v1`);
    const first = await serve(dataDir, configFile); services.push(first);
    const port = new URL(first.origin).port;
    const p = await newPage();
    await signInAndRegister(p, first);
    const runId = await start(p, 'Add multiply', 'Review the finished work');
    const asked = (await readRun(p, runId)).decision;
    assert.match(asked.evidence.commit, /^[0-9a-f]{40}$/);

    await stop(first, 'SIGKILL');
    await p.getByText(/Connection lost — reconnecting/).waitFor({ timeout: 15000 });
    const second = await serve(dataDir, configFile, port); services.push(second);
    await p.goto(`${second.origin}/#bootstrap=${second.bootstrapToken}`);
    await p.getByRole('heading', { name: 'New coding task' }).waitFor({ timeout: 15000 }); // let the session cookie land
    await p.goto(`${second.origin}/runs/${runId}`);
    await p.getByText('Interrupted', { exact: true }).waitFor({ timeout: 15000 });
    await p.getByText(/Any question it was asking has been withdrawn\. Resume to continue from its saved work\./).waitFor();
    assert.equal(await p.getByRole('button', { name: 'Approve: create a branch' }).count(), 0, 'the withdrawn question is not offered');
    assert.deepEqual(conductorBranches(), [], 'nothing landed before Resume');

    await p.getByRole('button', { name: 'Resume' }).click();
    await p.getByRole('heading', { name: 'Review the finished work' }).waitFor({ timeout: 60000 });
    await p.getByText(/Earlier answers do not carry over/).waitFor();
    const again = (await readRun(p, runId)).decision;
    assert.notEqual(again.id, asked.id, 'a new question, not the withdrawn one');
    assert.equal(again.evidence.commit, asked.evidence.commit, 'the saved work was kept, not redone');
    await p.getByText('+local did it').waitFor(); // the exact change is on screen
    await p.getByText('Tests passed').waitFor();
    await p.getByRole('button', { name: 'Approve: create a branch' }).click();
    await p.getByText('Branch created', { exact: true }).waitFor({ timeout: 60000 });

    const done = await readRun(p, runId);
    assert.deepEqual(conductorBranches(), [done.landedBranch], 'exactly one branch');
    assert.equal(git(repo, 'rev-parse', done.landedBranch).trim(), asked.evidence.commit, 'the branch is the reviewed commit');
    assert.equal(git(repo, 'rev-parse', 'main').trim(), originalHead, 'nothing merged into main');
    assert.equal(await p.getByText(STILL_WAITING).count(), 0, 'a finished run still says the answer is waiting');
    await p.context().close();
    await stop(second);
  });

  // Port 9 (discard) refuses connections, so the engine finds the local model unavailable before any work starts.
  const down = await serve(path.join(root, 'data-fallback'), config('local-down', 'http://127.0.0.1:9/v1')); services.push(down);
  const q = await newPage();
  await signInAndRegister(q, down);

  await step('local model down, Pause: neither choice is highlighted, nothing lands, and the page says the run cannot be resumed', async () => {
    const runId = await start(q, 'fallback then pause', 'The local model is unavailable');
    await q.getByText(/never switches to paid API keys/).waitFor();
    const classes = await q.locator('.choices button').evaluateAll((bs) => bs.map((b) => [b.textContent, b.className]));
    assert.deepEqual(classes.map(([t]) => t).sort(), ['Pause', 'Use subscriptions']);
    assert.deepEqual(classes.filter(([, c]) => c.includes('primary')), [], 'a choice is highlighted');
    await q.getByRole('button', { name: 'Pause' }).click();
    await q.getByText('Paused', { exact: true }).waitFor({ timeout: 30000 });
    const run = await readRun(q, runId);
    assert.equal(run.status, 'paused');
    assert.equal(run.resumable, false, 'paused before any work was saved');
    await q.getByText(/It has no saved work to resume/).waitFor();
    assert.equal(await q.getByRole('button', { name: 'Resume' }).count(), 0);
    assert.equal(await q.getByText(STILL_WAITING).count(), 0, 'a paused run still says the answer is waiting');
    assert.deepEqual(conductorBranches().filter((b) => b !== 'conductor/add-multiply'), [], 'nothing landed');
  });

  await step('local model down, Use subscriptions: the answer is recorded, and the next screen never shows it as still waiting', async () => {
    const runId = await start(q, 'fallback then continue', 'The local model is unavailable');
    const first = (await readRun(q, runId)).decision;
    await q.getByRole('button', { name: 'Use subscriptions' }).click();
    // Wait until the page has moved past the answered question: a different question, or a settled run.
    await q.waitForFunction((firstPrompt) => {
      const status = document.querySelector('p.status strong')?.textContent ?? '';
      const question = document.querySelector('.decision h2');
      return !['Needs your decision', 'Working'].includes(status) || (question && document.querySelector('.decision .prompt')?.textContent !== firstPrompt);
    }, first.prompt, { timeout: 60000 });
    const run = await readRun(q, runId);
    await q.locator('details.activity summary').click();
    await q.locator('details.activity').getByText('You chose to use your subscriptions.').waitFor(); // the answer, in plain words
    const status = await statusLine(q);
    if (run.status === 'awaiting-decision') {
      assert.notEqual(run.decision.id, first.id);
      assert.equal(await q.locator('.decision .choices button.primary').filter({ hasText: 'Use subscriptions' }).count(), 0);
    } else assert.ok([...SETTLED].some((s) => status.includes(s)), `unexpected state: ${status}`);
    assert.equal(await q.getByText(STILL_WAITING).count(), 0, `the answered question is still shown as waiting next to: ${status}`);
    // Leave the run settled: stop it if it is still asking.
    if (run.status === 'awaiting-decision') {
      await q.getByRole('button', { name: 'Stop run…' }).click();
      await q.getByRole('button', { name: 'Yes, stop this run' }).click();
      await q.getByText('Interrupted', { exact: true }).waitFor({ timeout: 30000 });
    }
  });
  await q.context().close();

  await step('no browser errors', async () => {
    // The deliberate kill cuts the live stream and refuses its reconnection attempts; nothing else may fail.
    const unexpected = consoleErrors.filter((t) => !/status of (401|409)|net::ERR_INCOMPLETE_CHUNKED_ENCODING|net::ERR_CONNECTION_REFUSED/.test(t));
    assert.equal(unexpected.length, 0, unexpected.join(' || '));
  });
} finally {
  await browser.close();
  for (const s of services) await stop(s, 'SIGKILL').catch(() => {});
  await new Promise((r) => local.close(r));
  rmSync(root, { recursive: true, force: true });
}
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed (UI ${uiDir}; service ${conductorDir}; engine: real, with stand-in model CLIs)`);
process.exit(failed ? 1 : 0);
