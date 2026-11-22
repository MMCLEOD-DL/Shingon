import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import { createAppServer } from '../../src/service/server.js';
import { localWorkerConfig } from '../../src/localWorkerConfig.js';
import { loadConfig } from '../../src/config.js';
import { git } from '../../src/workspace.js';
import { killAllChildren } from '../../src/exec.js';
import { launchWorkerCommand, workerReady, workerOutput } from '../../src/service/localWorker.js';
import { strictChildEnv, addScrubEnv } from '../../src/secrets.js';

const fakeWorker = fileURLToPath(new URL('../fixtures/operator-app/fake-worker.cjs', import.meta.url));
const delay = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, { commandSource = '', configured = true, timeout = 5000, tools, ready = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'worker-start-test-'));
  const repo = path.join(root, 'repo'); mkdirSync(repo);
  await git(repo, ['init', '-q', '-b', 'main']); writeFileSync(path.join(repo, 'README.md'), 'synthetic\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'initial']);
  const count = path.join(root, 'count.txt'), script = path.join(root, 'start.cjs');
  writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(count)}, 'start\\n');\n${typeof commandSource === 'function' ? commandSource(root) : commandSource}`);
  let readyNow = ready, requests = [];
  const server = http.createServer((req, res) => { requests.push({ url: req.url, headers: req.headers }); res.writeHead(readyNow ? 200 : 503); res.end(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const readyUrl = `http://127.0.0.1:${server.address().port}/readyz`;
  const worker = { startCommand: [process.execPath, script], readyUrl, startTimeoutMs: timeout };
  const configFile = path.join(root, 'config.json'), dataDir = path.join(root, 'data');
  const config = { participants: [
    { name: 'claude', adapter: 'claude-code', roles: ['author', 'reviewer'], capabilities: { can_edit_files: true } },
    { name: 'codex', adapter: 'codex', roles: ['author', 'reviewer'], capabilities: { can_edit_files: true } },
    { name: 'local', adapter: 'local-agent', model: 'synthetic', roles: ['grunt'], capabilities: { can_edit_files: true } },
  ], ...(configured ? { local: { worker } } : {}), options: { testCommand: 'node --test' } };
  writeFileSync(configFile, JSON.stringify(config));
  let app = await createAppServer({ dataDir, configFile, port: 0, workerFile: fakeWorker, localWorkerTools: tools });
  let cookie;
  const api = async (p, method = 'GET', body) => {
    const res = await fetch(app.origin + '/api/v1' + p, { method, headers: { origin: app.origin, ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (p === '/session') cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  const login = () => api('/session', 'POST', { bootstrapToken: app.bootstrapToken });
  await login(); const repoId = (await api('/repositories', 'POST', { path: repo })).body.id;
  const start = async (request = 'synthetic worker offline') => (await api('/runs', 'POST', { repositoryId: repoId, request, presetId: 'default', clientRequestId: 'run-' + request.replaceAll(' ', '-') })).body.id;
  const wait = async (id, predicate) => {
    for (let i = 0; i < 400; i++) { const run = (await api('/runs/' + id)).body; if (predicate(run)) return run; await delay(10); }
    throw new Error('synthetic worker state timed out');
  };
  const answer = (run, choiceId = 'start-worker', clientRequestId = 'answer-1') => api(`/runs/${run.id}/decisions/${run.decision.id}`, 'POST', {
    choiceId, expectedRevision: run.decision.revision, reviewedCommit: run.decision.evidence.commit, clientRequestId,
  });
  t.after(async () => { await app.close(); await new Promise(r => server.close(r)); rmSync(root, { recursive: true, force: true }); });
  return { root, repo, configFile, config, worker, count, script, requests, api, start, wait, answer, get app() { return app; }, setReady: value => { readyNow = value; },
    restart: async () => { await app.close(); app = await createAppServer({ dataDir, configFile, port: 0, workerFile: fakeWorker, localWorkerTools: tools }); cookie = null; await login(); } };
}

test('disk worker config validates argv/policy/URL/timeout without changing normal setup URL policy', async t => {
  const valid = { startCommand: ['powershell.exe', '-NoProfile', '-File', 'synthetic start.ps1'], readyUrl: 'http://192.168.1.109:50050/readyz' };
  assert.equal(localWorkerConfig({ worker: valid }).startTimeoutMs, 180000);
  for (const startCommand of [[], 'shell text', ['x', '-ExecutionPolicy', 'Bypass'], ['x', '-eXeCuTiOnPoLiCy:Bypass'], ['x', 'a\0b']]) {
    assert.throws(() => localWorkerConfig({ worker: { ...valid, startCommand } }));
  }
  for (const value of [0, -1, true, 1.5, '180000']) assert.throws(() => localWorkerConfig({ worker: { ...valid, startTimeoutMs: value } }));
  for (const readyUrl of ['file:///private', 'http://user:password@host/readyz', 'http://host/readyz?token=x', 'http://host/#x']) assert.throws(() => localWorkerConfig({ worker: { ...valid, readyUrl } }));
  const s = await fixture(t);
  assert.deepEqual(loadConfig(s.configFile).local.worker, s.worker);
  const setup = (await s.api('/setup')).body;
  assert.deepEqual(setup.local.worker, { startConfigured: true });
  assert.equal(JSON.stringify(setup).includes(s.script), false);
  assert.equal(JSON.stringify(setup).includes('readyUrl'), false);
  const before = readFileSync(s.configFile, 'utf8');
  for (const endpoint of ['/setup/validate', '/setup']) {
    assert.equal((await s.api(endpoint, endpoint === '/setup' ? 'PUT' : 'POST', { local: { worker: s.worker } })).status, 400);
    assert.equal(readFileSync(s.configFile, 'utf8'), before);
  }
  assert.equal((await s.api('/setup/validate', 'POST', { local: { model: 'synthetic', baseUrl: valid.readyUrl } })).status, 400);
  assert.equal((await s.api('/setup', 'PUT', { local: { model: 'changed', baseUrl: 'http://127.0.0.1:9999/v1' } })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(s.configFile, 'utf8')).local.worker, s.worker);
});

for (const [request, configured, offered] of [
  ['synthetic worker offline', true, true], ['synthetic worker offline', false, false],
  ['synthetic worker unauthorized', true, false], ['synthetic worker mid-run', true, false],
  ['synthetic worker model missing', true, false], ['synthetic worker unavailable', true, false],
]) test(`start eligibility: ${request}, configured=${configured}`, async t => {
  const s = await fixture(t, { configured }); const id = await s.start(request);
  const run = await s.wait(id, r => r.status === 'awaiting-decision');
  assert.equal(run.decision.choices.some(c => c.id === 'start-worker'), offered);
  if (!offered) assert.equal((await s.answer(run)).status, 400);
  assert.equal(existsSync(s.count), false);
});

test('already ready skips the command, says busy, and delivers the distinct re-probe answer', async t => {
  const s = await fixture(t, { ready: true }); const id = await s.start();
  const run = await s.wait(id, r => r.status === 'awaiting-decision');
  assert.equal((await s.answer(run)).status, 200);
  const done = await s.wait(id, r => r.status === 'paused');
  assert.equal(existsSync(s.count), false);
  assert.equal(done.coverage.local, 'used');
  assert.deepEqual(done.coverage.vendors, []);
  assert.match(s.app.runs.get(id).events.find(e => e.data.engineType === 'local-worker-ready').message, /up but busy/);
  assert.ok(s.requests.every(r => r.headers.authorization === undefined));
});

test('successful command runs once, is scrubbed, waits for ready, and survives engine cleanup', async t => {
  const s = await fixture(t, { commandSource: `if (Object.keys(process.env).some(k => /KEY|TOKEN|PASSWORD/i.test(k))) process.exit(9);` });
  const id = await s.start(); const run = await s.wait(id, r => r.status === 'awaiting-decision');
  assert.equal((await s.answer(run)).status, 200);
  await s.wait(id, r => r.decision?.workerStart?.state === 'waiting');
  killAllChildren(); s.setReady(true);
  await s.wait(id, r => r.status === 'paused');
  assert.equal(readFileSync(s.count, 'utf8'), 'start\n');
  assert.deepEqual(s.app.runs.get(id).events.filter(e => e.type === 'progress' && e.data.engineType.startsWith('local-worker-')).map(e => e.data.engineType), ['local-worker-start', 'local-worker-wait', 'local-worker-ready']);
  assert.equal((await s.answer(run)).status, 200, 'completed receipt replays, not another command');
  assert.equal(readFileSync(s.count, 'utf8'), 'start\n');
});

test('70-second fake readiness wait uses the clock, and all concurrent answers receive 409', async t => {
  let clock = 0, launches = 0, polls = 0, release;
  const held = new Promise(r => { release = r; });
  const s = await fixture(t, { timeout: 180000, tools: {
    now: () => clock, sleep: async ms => { clock += ms; },
    ready: async () => { polls++; return clock >= 70000; },
    launch: async () => { launches++; await held; return { code: 0 }; },
  } });
  const id = await s.start(); const run = await s.wait(id, r => r.status === 'awaiting-decision');
  assert.equal((await s.answer(run)).status, 200);
  for (const [choice, key] of [['start-worker', 'answer-1'], ['start-worker', 'answer-2'], ['continue', 'answer-3']]) {
    const result = await s.answer(run, choice, key); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'worker-start-in-progress');
  }
  release(); const done = await s.wait(id, r => r.status === 'paused');
  assert.equal(clock, 70000); assert.equal(launches, 1); assert.ok(polls > 1); assert.deepEqual(done.coverage.vendors, []);
});

test('nonzero start shows scrubbed WSL refusal, advances revision, and offers no retry', async t => {
  const old = process.env.SYNTHETIC_START_TOKEN; process.env.SYNTHETIC_START_TOKEN = 'synthetic-start-secret-value';
  t.after(() => { if (old === undefined) delete process.env.SYNTHETIC_START_TOKEN; else process.env.SYNTHETIC_START_TOKEN = old; });
  const s = await fixture(t, { commandSource: `console.error('\\x1b[31mWSL forwarding configuration needs to be updated before starting the worker. synthetic-start-secret-value'); process.exit(7);` });
  const id = await s.start(); const run = await s.wait(id, r => r.status === 'awaiting-decision'); await s.answer(run);
  const failed = await s.wait(id, r => r.decision?.workerStart?.state === 'failed');
  assert.notEqual(failed.decision.revision, run.decision.revision);
  assert.equal(failed.decision.prompt, 'The start command failed. Nothing else was tried.');
  assert.match(failed.decision.workerStart.output, /WSL forwarding configuration needs to be updated/);
  assert.doesNotMatch(JSON.stringify(s.app.store.data), /synthetic-start-secret-value|\u001b/);
  assert.deepEqual(failed.decision.choices.map(c => c.id), ['pause', 'continue']);
  assert.deepEqual(failed.coverage.vendors, []); assert.equal(readFileSync(s.count, 'utf8'), 'start\n');
  assert.equal((await s.answer(failed, 'start-worker', 'answer-2')).status, 400);
});

test('timeout offers explicit retry and never chooses subscriptions', async t => {
  let clock = 0, launches = 0;
  const s = await fixture(t, { timeout: 3000, tools: { now: () => clock, sleep: async ms => { clock += ms; }, ready: async () => false, launch: async () => { launches++; return { code: 0 }; } } });
  const id = await s.start(); const run = await s.wait(id, r => r.status === 'awaiting-decision'); await s.answer(run);
  const timed = await s.wait(id, r => r.decision?.workerStart?.state === 'timeout');
  assert.deepEqual(timed.decision.choices.map(c => c.id), ['pause', 'continue', 'start-worker']);
  assert.equal(timed.decision.choices.at(-1).label, 'Try again'); assert.notEqual(timed.decision.revision, run.decision.revision);
  assert.deepEqual(timed.coverage.vendors, []);
  const stale = await s.answer(run, 'start-worker', 'new-stale'); assert.equal(stale.status, 409);
  await s.answer(timed, 'start-worker', 'answer-2');
  await s.wait(id, r => r.decision?.workerStart?.state === 'timeout' && r.decision.revision !== timed.decision.revision);
  assert.equal(launches, 2);
});

test('a failed re-probe asks again with its new reason and no start choice', async t => {
  const s = await fixture(t, { ready: true }); const id = await s.start('synthetic worker reprobe unauthorized');
  const run = await s.wait(id, r => r.status === 'awaiting-decision'); await s.answer(run);
  const fresh = await s.wait(id, r => r.decision?.id === 'test-decision-reprobe');
  assert.equal(fresh.decision.localDown.reason, 'unauthorized');
  assert.deepEqual(fresh.decision.choices.map(c => c.id), ['pause', 'continue']);
});

test('cancel and service restart abandon the wait and never resume the start', async t => {
  let launches = 0;
  const s = await fixture(t, { tools: { ready: async () => false, launch: async () => { launches++; return { code: 0 }; } } });
  const id = await s.start(); const run = await s.wait(id, r => r.status === 'awaiting-decision'); await s.answer(run);
  await s.wait(id, r => r.decision?.workerStart?.state === 'waiting');
  assert.equal((await s.api('/runs/' + id + '/cancel', 'POST', {})).status, 202);
  await s.wait(id, r => r.status === 'interrupted'); await s.restart();
  const interrupted = (await s.api('/runs/' + id)).body;
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.decision, null); assert.equal(launches, 1);
});

test('readiness rejects redirects and sends no Authorization; output is clipped and terminal-safe', async t => {
  let forwarded = 0;
  const server = http.createServer((req, res) => { assert.equal(req.headers.authorization, undefined); forwarded++; res.writeHead(302, { location: '/again' }); res.end(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  assert.equal(await workerReady(`http://127.0.0.1:${server.address().port}/readyz`), false); assert.equal(forwarded, 1);
  const output = workerOutput('x'.repeat(1000) + '\n\x1b]0;title\x07\x1b[31mfinal\x00');
  assert.ok(output.length <= 600); assert.ok(output.endsWith('final')); assert.doesNotMatch(output, /\x1b|\x00|title/);
});

for (const ending of ['cancel', 'finish']) test(`detached synthetic keeper survives ${ending}, service close, and killAllChildren`, async t => {
  let keeper;
  t.after(() => { if (keeper) { try { process.kill(keeper); } catch {} } });
  const s = await fixture(t, { commandSource: root => {
    const file = path.join(root, 'keeper.pid');
    const code = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(file)}, String(process.pid));setInterval(()=>fs.writeFileSync(${JSON.stringify(path.join(root, 'keeper-beat'))},String(Date.now())),25);`;
    // Model a long-lived keeper: Node on Windows otherwise kills its own child job on command exit.
    return `const p = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(code)}], {stdio:'ignore', detached:true, windowsHide:true}); p.unref();`
      + (ending === 'cancel' ? `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'command-finished'))},'done'),800);` : '');
  } });
  const id = await s.start(); const run = await s.wait(id, r => r.status === 'awaiting-decision'); await s.answer(run);
  if (ending === 'finish') await s.wait(id, r => r.decision?.workerStart?.state === 'waiting');
  for (let n = 0; n < 200 && !existsSync(path.join(s.root, 'keeper.pid')); n++) await delay(10);
  keeper = Number(readFileSync(path.join(s.root, 'keeper.pid'), 'utf8'));
  killAllChildren(); process.kill(keeper, 0);
  if (ending === 'cancel') {
    await s.api('/runs/' + id + '/cancel', 'POST', {}); await s.wait(id, r => r.status === 'interrupted');
  } else { s.setReady(true); await s.wait(id, r => r.status === 'paused'); }
  process.kill(keeper, 0); await s.app.close(); process.kill(keeper, 0);
  if (ending === 'cancel') {
    const finished = path.join(s.root, 'command-finished');
    for (let n = 0; n < 200 && !existsSync(finished); n++) await delay(10);
    assert.equal(readFileSync(finished, 'utf8'), 'done', 'cancellation did not kill the active start command');
  }
  const beatFile = path.join(s.root, 'keeper-beat');
  for (let n = 0; n < 100 && !existsSync(beatFile); n++) await delay(10);
  const beat = readFileSync(beatFile, 'utf8');
  for (let n = 0; n < 100 && readFileSync(beatFile, 'utf8') === beat; n++) await delay(10);
  assert.notEqual(readFileSync(beatFile, 'utf8'), beat, 'keeper is executing, not merely an unreaped PID');
  assert.equal(readFileSync(s.count, 'utf8'), 'start\n');
});

test('setup does not create a worker section and fixture copies expose no private start fields', async t => {
  const s = await fixture(t, { configured: false });
  assert.deepEqual((await s.api('/setup')).body.local.worker, { startConfigured: false });
  assert.equal((await s.api('/setup', 'PUT', { local: { model: 'changed', baseUrl: 'http://127.0.0.1:8080/v1' } })).status, 200);
  assert.equal(JSON.parse(readFileSync(s.configFile, 'utf8')).local, undefined);
  const canonical = readFileSync(new URL('../fixtures/operator-app/contract-v1.json', import.meta.url));
  assert.deepEqual(canonical, readFileSync(new URL('../../operator-web/tests/fixtures/contract-v1.json', import.meta.url)));
  const examples = JSON.parse(canonical);
  for (const key of ['workerOfflineConfiguredDecision', 'workerOfflineUnconfiguredDecision', 'workerUnauthorizedDecision', 'workerStartInProgressDecision', 'workerStartFailedDecision', 'workerStartTimeoutDecision']) assert.ok(examples[key]);
  assert.equal(examples.workerOfflineConfiguredDecision.choices.at(-1).id, 'start-worker');
  assert.equal(examples.workerOfflineUnconfiguredDecision.choices.length, 2);
  assert.equal(examples.workerUnauthorizedDecision.choices.length, 2);
  assert.doesNotMatch(JSON.stringify(Object.fromEntries(Object.entries(examples).filter(([k]) => k.startsWith('worker')))), /startCommand|readyUrl|startTimeoutMs/);
});

test('configured argv is literal, including shell metacharacters and empty arguments', async () => {
  const args = ['literal & echo NEVER_RUN', '$(not-a-command)', ''];
  const config = localWorkerConfig({ worker: { startCommand: [process.execPath, '-e', 'console.error(JSON.stringify(process.argv.slice(1)));process.exit(4)', ...args], readyUrl: 'http://127.0.0.1/readyz' } });
  const result = await launchWorkerCommand(config);
  assert.equal(result.code, 4); assert.equal(result.output.trim(), JSON.stringify(args));
  const missing = await launchWorkerCommand({ startCommand: ['synthetic-private-missing-executable-9261'] });
  assert.equal(missing.code, -1); assert.doesNotMatch(missing.output, /synthetic-private/);
});

test('restart during a readiness wait invalidates the question without another start', async t => {
  let launches = 0;
  const s = await fixture(t, { tools: { ready: async () => false, launch: async () => { launches++; return { code: 0 }; } } });
  const id = await s.start(); const run = await s.wait(id, r => r.status === 'awaiting-decision'); await s.answer(run);
  await s.wait(id, r => r.decision?.workerStart?.state === 'waiting'); await s.restart();
  const recovered = (await s.api('/runs/' + id)).body;
  assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.decision, null); assert.equal(launches, 1);
  assert.equal((await s.answer(run)).status, 200, 'a saved receipt replays, it does not resume a start');
  assert.equal((await s.answer(run, 'start-worker', 'different-request')).status, 409);
  assert.equal(launches, 1);
});

test('launcher command deadline is bounded and split secret output is scrubbed before clipping', async t => {
  const run = (code, timeoutMs, redactions = []) => new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('../../src/service/localWorkerLauncher.js', import.meta.url)), ['--local-worker-launcher'], {
      detached: true, windowsHide: true, env: strictChildEnv(), execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const deadline = setTimeout(() => { child.kill(); reject(new Error('synthetic launcher deadline failed')); }, 4000);
    child.once('error', reject); child.on('message', msg => {
      if (msg.type === 'ready') child.send({ type: 'launch', command: [process.execPath, '-e', code], timeoutMs, redactions });
      else if (msg.type === 'finished') { clearTimeout(deadline); if (child.connected) child.disconnect(); resolve(msg); }
    });
  });
  const timeout = await run('setTimeout(()=>{},1500)', 200);
  assert.equal(timeout.timedOut, true); assert.notEqual(timeout.code, 0);
  const secret = 'synthetic-fragmented-start-secret';
  const complete = await run(`process.stdout.write('x'.repeat(20000)+'\\n'+${JSON.stringify(secret.slice(0, 12))});setTimeout(()=>{process.stderr.write(${JSON.stringify(secret.slice(12))}+'\\nlast line');process.exit(3)},50)`, 2000, [secret]);
  assert.equal(complete.code, 3); assert.doesNotMatch(complete.output, /synthetic-fragmented|start-secret/);
  assert.ok(complete.output.endsWith('last line')); assert.match(complete.output, /\[redacted\]/);
});

test('launcher drops case variants of configured provider variables and database URLs', async t => {
  const names = ['synthetic_provider_value', 'TEST_DATABASE_URL'];
  const previous = names.map(name => process.env[name]);
  process.env[names[0]] = 'synthetic-private-provider-value'; process.env[names[1]] = 'postgres://synthetic:private@localhost/test';
  addScrubEnv('SYNTHETIC_PROVIDER_VALUE');
  t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
  const result = await launchWorkerCommand({ startCommand: [process.execPath, '-e', `if(Object.keys(process.env).some(k=>['SYNTHETIC_PROVIDER_VALUE','TEST_DATABASE_URL'].includes(k.toUpperCase())))process.exit(9);console.log('clean');`] });
  assert.equal(result.code, 0); assert.equal(result.output.trim(), 'clean');
});

test('a late 200 cannot overrun the original readiness deadline', async t => {
  let clock = 0, calls = 0;
  const s = await fixture(t, { timeout: 5000, tools: { now: () => clock, sleep: async ms => { clock += ms; },
    ready: async () => { if (++calls === 1) return false; clock = 5001; return true; }, launch: async () => ({ code: 0 }) } });
  const id = await s.start(); const run = await s.wait(id, r => r.status === 'awaiting-decision'); await s.answer(run);
  const timed = await s.wait(id, r => r.decision?.workerStart?.state === 'timeout');
  assert.deepEqual(timed.coverage.vendors, []);
  assert.equal(s.app.runs.get(id).events.some(e => e.data.engineType === 'local-worker-ready'), false);
});

test('abrupt service termination leaves its synthetic readyz worker and detached launcher alive', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'abrupt-start-test-'));
  let service, keeper;
  t.after(async () => {
    for (const pid of [service?.pid, keeper]) if (pid) { try { process.kill(pid); } catch {} }
    await delay(150); rmSync(root, { recursive: true, force: true });
  });
  const repo = path.join(root, 'repo'); mkdirSync(repo); await git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(repo, 'README.md'), 'synthetic\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'initial']);
  const reserve = http.createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const readyUrl = `http://127.0.0.1:${port}/readyz`, keeperFile = path.join(root, 'keeper.json');
  const keeperCode = `const http=require('node:http'); const s=http.createServer((q,r)=>{r.writeHead(200);r.end('ready')}); s.listen(${port},'127.0.0.1',()=>require('node:fs').writeFileSync(${JSON.stringify(keeperFile)},JSON.stringify({pid:process.pid})));`;
  const command = path.join(root, 'start.cjs');
  writeFileSync(command, `const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(keeperCode)}],{stdio:'ignore',detached:true,windowsHide:true});p.unref();setTimeout(()=>process.exit(0),1500);`);
  const configFile = path.join(root, 'config.json');
  writeFileSync(configFile, JSON.stringify({ participants: [
    { name: 'local', adapter: 'local-agent', model: 'synthetic', roles: ['grunt'], capabilities: { can_edit_files: true } },
  ], local: { worker: { startCommand: [process.execPath, command], readyUrl } } }));
  service = fork(fileURLToPath(new URL('../fixtures/operator-app/start-worker-service.cjs', import.meta.url)), ['--synthetic-start-worker-service'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const info = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('synthetic service startup timed out')), 5000);
    service.once('message', msg => { clearTimeout(timeout); resolve(msg); }); service.once('error', reject);
    service.send({ configFile, dataDir: path.join(root, 'data'), workerFile: fakeWorker });
  });
  let cookie;
  const api = async (p, body) => {
    const response = await fetch(info.origin + '/api/v1' + p, { method: 'POST', headers: { origin: info.origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    if (p === '/session') cookie = response.headers.get('set-cookie').split(';')[0];
    assert.ok(response.ok); return response.json();
  };
  await api('/session', { bootstrapToken: info.bootstrapToken });
  const repository = await api('/repositories', { path: repo });
  const run = await api('/runs', { repositoryId: repository.id, request: 'synthetic worker offline', presetId: 'default', clientRequestId: 'start-1' });
  let decision;
  for (let n = 0; n < 200; n++) {
    decision = (await (await fetch(info.origin + '/api/v1/runs/' + run.id, { headers: { cookie } })).json()).decision;
    if (decision) break; await delay(10);
  }
  assert.ok(decision);
  await api(`/runs/${run.id}/decisions/${decision.id}`, { choiceId: 'start-worker', expectedRevision: decision.revision, reviewedCommit: null, clientRequestId: 'answer-1' });
  for (let n = 0; n < 300 && !existsSync(keeperFile); n++) await delay(10);
  keeper = JSON.parse(readFileSync(keeperFile, 'utf8')).pid;
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill.exe', ['/PID', String(service.pid), '/F'], { windowsHide: true, stdio: 'ignore' });
    assert.equal(killed.status, 0);
  } else service.kill('SIGKILL');
  await delay(1800); process.kill(keeper, 0);
  assert.equal((await fetch(readyUrl)).status, 200, 'the synthetic worker still owns readyz after service death');
});
