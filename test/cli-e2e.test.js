import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { writeStubCli } from './helpers/stubCli.js';
import { makeRepo, refsOf } from './helpers/gitRepo.js';
import { git, metaDirOf } from '../src/workspace.js';
import { main, STOPPED_BEFORE_START } from '../src/cli/main.js';
import { NO_TTY_LOCAL } from '../src/ui/terminal.js';
import { LOCAL_DOWN_WARNING } from '../src/team.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'conductor.js');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'e2e-'));

// claude: author → a one-step plan; reviewer → APPROVE; write → edits a file.
const CLAUDE = `
  if (args[0] === '--version') { console.log('2.1.0 (Claude Code)'); process.exit(0); }
  const sys = args[args.indexOf('--append-system-prompt') + 1] || '';
  let result;
  if (sys.includes('REVIEWER')) result = 'Fine.\\nVERDICT: APPROVE';
  else if (args.includes('acceptEdits')) { require('fs').writeFileSync('claude-step.txt', 'x\\n'); result = 'done'; }
  else result = 'Plan.\\n\`\`\`json\\n' + JSON.stringify({ summary: 's', chunks: [{ title: 'Add multiply', instructions: 'add it' }] }) + '\\n\`\`\`';
  process.stdout.write(JSON.stringify({ result, is_error: false, total_cost_usd: 0.01 }));
`;
// codex: frontier reviewer → APPROVE; local (model_provider=localai) → edits a file, or hangs.
const CODEX = `
  if (args[0] === '--version') { console.log('codex-cli 0.163.0'); process.exit(0); }
  const fs = require('fs');
  const out = args[args.indexOf('-o') + 1];
  if (args.includes('model_provider=localai')) {
    if (process.env.STUB_LOCAL_FAIL) { console.error('ERROR: stream disconnected before completion'); process.exit(1); }
    if (process.env.STUB_LOCAL_HANG) { setInterval(() => {}, 1000); }
    else { fs.writeFileSync('multiply.txt', 'local did it\\n'); fs.writeFileSync(out, 'Edited multiply.txt.'); }
  } else if ((args[1] || '').includes('REVIEWER')) fs.writeFileSync(out, 'Looks right.\\nVERDICT: APPROVE');
  else { fs.writeFileSync('codex-step.txt', 'x\\n'); fs.writeFileSync(out, 'done'); }
`;

async function setup({ local = { up: true }, wake = null, routing = null } = {}) {
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => {
    if (local.up || (local.flag && existsSync(local.flag))) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[]}'); }
    else { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"no healthy nodes available"}}'); }
  }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const bins = tmp();
  const claude = writeStubCli(bins, 'claude', CLAUDE);
  const codex = writeStubCli(bins, 'codex', CODEX);
  const cfg = path.join(tmp(), 'conductor.json');
  writeFileSync(cfg, JSON.stringify({ participants: [
    { name: 'claude', adapter: 'claude-code', bin: claude, roles: ['author', 'reviewer'], capabilities: { is_agentic: true, can_edit_files: true } },
    { name: 'codex', adapter: 'codex', bin: codex, roles: ['author', 'reviewer'], capabilities: { is_agentic: true, can_edit_files: true } },
    { name: 'local', adapter: 'local-agent', bin: codex, model: 'm', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, roles: ['grunt'], capabilities: { is_agentic: true, can_edit_files: true }, ...(wake ? { wake } : {}) },
  ], ...(routing ? { routing } : {}) }));
  const repo = await makeRepo();
  const baseDir = tmp();
  const env = { ...process.env, CONDUCTOR_BASE_DIR: baseDir, XDG_CONFIG_HOME: tmp(), XDG_CACHE_HOME: tmp() };
  delete env.ANTHROPIC_API_KEY;
  return { local, server, cfg, repo, baseDir, env, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

// Spawns the real bin (stdin is a pipe, so: no TTY). until(text) → send SIGINT once it appears.
function spawnBin(args, { cwd, env, until = null }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let sent = false;
    const onData = (d) => {
      out += d;
      if (until && !sent && out.includes(until)) { sent = true; child.kill('SIGINT'); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('no terminal: the whole run happens, the gate fails closed, the repo is untouched (Review Focus 3)', async () => {
  const s = await setup();
  try {
    const before = await refsOf(s.repo);
    const r = await spawnBin(['add multiply', '--config', s.cfg], { cwd: s.repo, env: s.env });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Plan agreed/);
    assert.match(r.out, /no terminal to ask you, so the result was not approved/);
    assert.match(r.out, /Not approved\. Your repository is unchanged\./);
    assert.match(r.out, /Full log: /);
    assert.equal(await refsOf(s.repo), before);
  } finally { await s.close(); }
});

test('Ctrl-C mid-step: exit 130, resumable, listed by runs, picked up by resume (Review Focus 1)', async () => {
  const s = await setup();
  try {
    const before = await refsOf(s.repo);
    const hang = { ...s.env, STUB_LOCAL_HANG: '1' };
    const r = await spawnBin(['add multiply', '--config', s.cfg], { cwd: s.repo, env: hang, until: 'local ✎' });
    assert.equal(r.code, 130, r.out);
    assert.match(r.out, /Stopped\. Your repository is unchanged\. To continue later, run:  conductor resume/);
    assert.equal(await refsOf(s.repo), before);

    const runs = await spawnBin(['runs'], { cwd: s.repo, env: s.env });
    assert.equal(runs.code, 0);
    assert.match(runs.out, /running .*add multiply/);

    const ws = /\((\/[^)]+)\)/.exec(runs.out)[1];
    const state = JSON.parse(readFileSync(path.join(metaDirOf(ws), 'state.json'), 'utf8'));
    assert.equal(state.status, 'running');
    assert.match(readFileSync(path.join(metaDirOf(ws), 'transcript.jsonl'), 'utf8'), /"type":"interrupted"/);
    assert.equal((await git(ws, ['status', '--porcelain'])).stdout.includes('multiply.txt'), false, 'nothing partial committed');

    const resumed = await spawnBin(['resume', '--config', s.cfg], { cwd: s.repo, env: s.env });
    assert.equal(resumed.code, 1, resumed.out); // no TTY at the gate → rejected
    assert.match(resumed.out, /Not approved/);
  } finally { await s.close(); }
});

test('doctor, help, bad usage, not a repository', async () => {
  const s = await setup();
  try {
    const d = await spawnBin(['doctor', '--config', s.cfg], { cwd: s.repo, env: s.env });
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /✓ claude \(claude-code\): installed \(sign-in is checked when it is first used\)/);
    assert.match(d.out, /✓ local \(local-agent\)\n/, 'the local model was really tested, so no "installed" caveat');
    assert.match(d.out, /Author: claude · Reviewer: codex · Local: local/);
    assert.equal((await spawnBin([], { cwd: s.repo, env: s.env })).code, 0);
    const bad = await spawnBin(['x', '--bogus'], { cwd: s.repo, env: s.env });
    assert.equal(bad.code, 64);
    assert.match(bad.out, /Usage:/);
    const notRepo = await spawnBin(['x', '--config', s.cfg], { cwd: tmp(), env: s.env });
    assert.equal(notRepo.code, 64);
    assert.match(notRepo.out, /Run conductor inside a git repository/);
    const none = await spawnBin(['resume', '--config', s.cfg], { cwd: s.repo, env: s.env });
    assert.equal(none.code, 1);
    assert.match(none.out, /There is no unfinished Conductor run for this repository\./);
  } finally { await s.close(); }
});

test('in-process with a terminal: the user approves and the result lands', async () => {
  const s = await setup();
  try {
    const stdin = new PassThrough();
    let text = '';
    // The user answers once the approval question is on screen (earlier type-ahead is discarded).
    const stdout = new Writable({ write(c, e, cb) {
      text += c;
      if (String(c).includes('[a] approve → new branch')) setImmediate(() => stdin.end('a\n'));
      cb();
    } });
    const code = await main(['add multiply', '--config', s.cfg, '--no-bell'], { cwd: s.repo, env: s.env, stdin, stdout, isTTY: true, onSignal: () => {}, exit: () => {} });
    assert.equal(code, 0, text);
    assert.match(text, /Done\. The result is on a new branch in your repository: conductor\/add-multiply/);
    assert.equal((await git(s.repo, ['show', '--name-only', '--format=', 'conductor/add-multiply'])).stdout.trim(), 'multiply.txt');
  } finally { await s.close(); }
});

test('"could not start" is redacted (cheap fix)', async () => {
  const s = await setup();
  const secret = 'sekrit-value-0123456789';
  process.env.CONDUCTOR_E2E_TOKEN = secret;
  try {
    // routing.local names a participant that cannot be the local executor: runTask throws with its name.
    const cfg = JSON.parse(readFileSync(s.cfg, 'utf8'));
    cfg.participants[1].name = secret;
    cfg.routing = { local: secret };
    writeFileSync(s.cfg, JSON.stringify(cfg));
    let text = '';
    const stdout = new Writable({ write(c, e, cb) { text += c; cb(); } });
    const code = await main(['add multiply', '--config', s.cfg], { cwd: s.repo, env: s.env, stdin: new PassThrough(), stdout, isTTY: false, onSignal: () => {}, exit: () => {} });
    assert.equal(code, 64, text);
    assert.match(text, /Conductor could not start: \[redacted\] must be able to play grunt/);
    assert.ok(!text.includes(secret));
  } finally {
    delete process.env.CONDUCTOR_E2E_TOKEN;
    await s.close();
  }
});

test('local down without consent: the run stops before anything is spent', async () => {
  const s = await setup();
  try {
    const cfg = JSON.parse(readFileSync(s.cfg, 'utf8'));
    cfg.participants[2].baseUrl = 'http://127.0.0.1:9/v1'; // nothing listens there: connection refused
    writeFileSync(s.cfg, JSON.stringify(cfg));
    const before = await refsOf(s.repo);
    const r = await spawnBin(['add multiply', '--config', s.cfg], { cwd: s.repo, env: s.env });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Start the local model, then run/);
    assert.doesNotMatch(r.out, /Plan agreed/, 'no agent was called');
    assert.deepEqual(await refsOf(s.repo), before);
  } finally { await s.close(); }
});

// Answers each prompt in order once its text is on screen: [[promptSubstring, reply, before?], ...]
function scripted(answers) {
  const stdin = new PassThrough();
  let text = '';
  const queue = [...answers];
  const stdout = new Writable({ write(c, e, cb) {
    text += c;
    const next = queue[0];
    if (next && String(c).includes(next[0])) { queue.shift(); next[2]?.(); setImmediate(() => stdin.write(`${next[1]}\n`)); }
    cb();
  } });
  return { stdin, stdout, text: () => text };
}
// The pre-run question; its [w] label depends on the wake method (Task 6), so match the [f] part.
const CONSENT = '[f] go ahead without it';
const GATE = '[a] approve → new branch';
const inProcess = (s, argv, io, extra = {}) => main([...argv, '--config', s.cfg, '--no-bell'], { cwd: s.repo, env: s.env, stdin: io.stdin, stdout: io.stdout, isTTY: true, onSignal: () => {}, exit: () => {}, ...extra });

test('local down, no terminal: told plainly, nothing started, nothing spent (run-2 smoke finding)', async () => {
  const s = await setup({ local: { up: false }, wake: { hint: 'Turn on the desktop PC and start the LocalAI worker.' } });
  try {
    const before = await refsOf(s.repo);
    const r = await spawnBin(['add multiply', '--config', s.cfg], { cwd: s.repo, env: s.env });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /The local model "local" is not answering: its GPU worker is not connected\. Conductor has no way to wake it set up\. To fix it by hand: Turn on the desktop PC and start the LocalAI worker\./);
    assert.ok(r.out.includes(NO_TTY_LOCAL));
    assert.ok(r.out.includes(STOPPED_BEFORE_START));
    assert.deepEqual(await refsOf(s.repo), before);
    assert.deepEqual(readdirSync(s.baseDir).filter((n) => !n.startsWith('.')), [], 'no workspace: no agent was called');
  } finally { await s.close(); }
});

test('doctor wakes a worker with its start command and says so', async () => {
  const flag = path.join(tmp(), 'worker-up');
  const starter = writeStubCli(tmp(), 'start-worker', `require('fs').writeFileSync(${JSON.stringify(flag)}, 'up');`);
  const s = await setup({ local: { up: false, flag }, wake: { method: 'command', cmd: starter, waitMs: 10000, pollMs: 500 } });
  try {
    const d = await spawnBin(['doctor', '--config', s.cfg], { cwd: s.repo, env: s.env });
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /Waking local \(its start command\)…/);
    assert.match(d.out, /local is awake \(after \d+ s\)\./);
    assert.match(d.out, /✓ local \(local-agent\) — woke it with its start command/);
    assert.doesNotMatch(d.out, /\[w\]/, 'doctor never asks');
  } finally { await s.close(); }
});

test('local down, operator says go ahead: frontier does the step, the summary says so, memory records who served', async () => {
  const s = await setup({ local: { up: false } });
  try {
    const io = scripted([[CONSENT, 'f'], [GATE, 'a']]);
    const code = await inProcess(s, ['add multiply'], io);
    assert.equal(code, 0, io.text());
    assert.ok(io.text().includes(LOCAL_DOWN_WARNING));
    assert.equal((await git(s.repo, ['show', '--name-only', '--format=', 'conductor/add-multiply'])).stdout.trim(), 'claude-step.txt');
    const mem = JSON.parse(readFileSync(path.join(s.baseDir, '.workers.json'), 'utf8'));
    assert.deepEqual(Object.keys(mem.workers).sort(), ['claude', 'codex']);
  } finally { await s.close(); }
});

test('local down, operator wakes it again after starting it: the local model does the step', async () => {
  const s = await setup({ local: { up: false } });
  try {
    const io = scripted([[CONSENT, 'w', () => { s.local.up = true; }], [GATE, 'a']]);
    const code = await inProcess(s, ['add multiply'], io);
    assert.equal(code, 0, io.text());
    assert.doesNotMatch(io.text(), new RegExp(LOCAL_DOWN_WARNING.slice(0, 30)));
    assert.equal((await git(s.repo, ['show', '--name-only', '--format=', 'conductor/add-multiply'])).stdout.trim(), 'multiply.txt');
    const mem = JSON.parse(readFileSync(path.join(s.baseDir, '.workers.json'), 'utf8'));
    assert.equal(mem.workers.local.runs, 1);
  } finally { await s.close(); }
});

test('local dies mid-run, operator pauses, then resumes once it is back (Review Focus 5)', async () => {
  // The local agent's stream fails (infrastructure); a 1 ms cooldown and no wait make the Seat give up at once.
  const s = await setup({ routing: { cooldownMs: 1, maxWaitMs: 0 } });
  process.env.STUB_LOCAL_FAIL = '1';
  try {
    const io = scripted([['[p] pause', 'p']]);
    const code = await inProcess(s, ['add multiply'], io);
    assert.equal(code, 3, io.text());
    assert.match(io.text(), /The local model stopped answering during step 1 \(Add multiply\)/);
    assert.match(io.text(), /Conductor paused: the local model stopped answering, and you chose not to use your subscription for its steps/);
    delete process.env.STUB_LOCAL_FAIL;
    const io2 = scripted([[GATE, 'a']]);
    const code2 = await inProcess(s, ['resume'], io2);
    assert.equal(code2, 0, io2.text());
    assert.match(io2.text(), /Checking the local workers…/, 'resume checks the workers again');
    assert.equal((await git(s.repo, ['show', '--name-only', '--format=', 'conductor/add-multiply'])).stdout.trim(), 'multiply.txt');
  } finally { delete process.env.STUB_LOCAL_FAIL; await s.close(); }
});

test('local dies mid-run, operator says carry on: the frontier does the step and the summary says so', async () => {
  const s = await setup({ routing: { cooldownMs: 1, maxWaitMs: 0 } });
  process.env.STUB_LOCAL_FAIL = '1';
  try {
    const io = scripted([['[p] pause', 'f'], [GATE, 'a']]);
    const code = await inProcess(s, ['add multiply'], io);
    assert.equal(code, 0, io.text());
    assert.match(io.text(), /The local model stopped answering during step 1 \(Add multiply\)/);
    assert.ok(io.text().includes(LOCAL_DOWN_WARNING), 'the gate summary carries the warning');
    assert.equal((await git(s.repo, ['show', '--name-only', '--format=', 'conductor/add-multiply'])).stdout.trim(), 'claude-step.txt');
  } finally { delete process.env.STUB_LOCAL_FAIL; await s.close(); }
});

test('local dies mid-run with localDown "pause": paused without a question, and the reason says it was the setting', async () => {
  const s = await setup({ routing: { cooldownMs: 1, maxWaitMs: 0, localDown: 'pause' } });
  process.env.STUB_LOCAL_FAIL = '1';
  try {
    const io = scripted([]);
    const code = await inProcess(s, ['add multiply'], io);
    assert.equal(code, 3, io.text());
    assert.doesNotMatch(io.text(), /\[p\] pause/);
    assert.match(io.text(), /Conductor paused: the local model stopped answering, and your settings say to pause instead of using your subscription/);
  } finally { delete process.env.STUB_LOCAL_FAIL; await s.close(); }
});

test('doctor with the local worker staying down: exit 0, reported down, never asks (final review 6)', async () => {
  const s = await setup({ local: { up: false } });
  try {
    // Answers "stop" if it were ever asked, so a regression fails on the assertion instead of hanging.
    const io = scripted([[CONSENT, 's']]);
    const code = await inProcess(s, ['doctor'], io);
    assert.equal(code, 0, io.text());
    assert.match(io.text(), /✗ local \(local-agent\): its GPU worker is not connected/);
    assert.ok(!io.text().includes(CONSENT), 'doctor never asks');
  } finally { await s.close(); }
});

test('Ctrl-C while waking: the wake command is stopped and Conductor exits 130 (final review 4)', async () => {
  const pidFile = path.join(tmp(), 'wake.pid');
  const starter = writeStubCli(tmp(), 'start-worker', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const s = await setup({ local: { up: false }, wake: { method: 'command', cmd: starter, waitMs: 10000, pollMs: 500 } });
  try {
    const before = await refsOf(s.repo);
    // Ctrl-C only once the wake program is really running (it has written its pid).
    const child = spawn(process.execPath, [BIN, 'add multiply', '--config', s.cfg], { cwd: s.repo, env: s.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const closed = new Promise((res) => child.on('close', (code) => res(code)));
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((res) => setTimeout(res, 50));
    assert.ok(existsSync(pidFile), `the wake program never started: ${out}`);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    child.kill('SIGINT');
    const code = await closed;
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 50)); } catch { alive = false; }
    }
    if (alive) try { process.kill(pid, 'SIGKILL'); } catch {}
    assert.equal(alive, false, 'the detached wake command was left running');
    assert.equal(code, 130, out);
    assert.match(out, /Stopped before anything started\. Your repository is unchanged\./);
    assert.doesNotMatch(out, /conductor resume/, 'a new run has nothing to resume');
    assert.deepEqual(await refsOf(s.repo), before);
  } finally { await s.close(); }
});

function councilConfig(cfgPath, councilTools) {
  const c = JSON.parse(readFileSync(cfgPath, 'utf8'));
  c.options = { councilTools };
  const out = path.join(tmp(), 'conductor.json');
  writeFileSync(out, JSON.stringify(c));
  return out;
}

test('doctor lists the council checks; --council runs them and the report reaches the gate', async () => {
  const s = await setup();
  try {
    const gl = writeStubCli(tmp(), 'gitleaks', 'console.log("8.21.0")');
    const cfg = councilConfig(s.cfg, { semgrep: false, gitleaks: gl, 'npm-audit': false, scancode: false });
    const d = await spawnBin(['doctor', '--config', cfg], { cwd: s.repo, env: s.env });
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /Council checks \(used with --council\):\n {2}✗ Semgrep \(code scanner\): turned off in the config\n {2}✓ Gitleaks \(secret scanner\)\n {2}✗ npm audit \(dependency security check\): turned off in the config\n {2}✗ ScanCode \(licence scanner\): turned off in the config\n/);

    // a tool that is neither off nor on PATH is "not installed"
    const noPath = councilConfig(s.cfg, {});
    const onlyGit = tmp();
    symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(onlyGit, 'git'));
    const n = await spawnBin(['doctor', '--config', noPath], { cwd: s.repo, env: { ...s.env, PATH: onlyGit } });
    assert.match(n.out, /✗ Semgrep \(code scanner\): not installed/);

    const off = councilConfig(s.cfg, { semgrep: false, gitleaks: false, 'npm-audit': false, scancode: false });
    const r = await spawnBin(['add multiply', '--config', off, '--council'], { cwd: s.repo, env: s.env });
    assert.equal(r.code, 1, r.out); // no TTY at the gate → rejected
    assert.match(r.out, /✓ Council \(round 1\) +approved/);
    assert.match(r.out, /Council report: approved, nothing to fix/);
    assert.match(r.out, /Semgrep \(code scanner\) is turned off in the config\./);
  } finally { await s.close(); }
});

test('doctor lists the council checks even when the team cannot be built; a normal run does not', async () => {
  const s = await setup();
  try {
    const c = JSON.parse(readFileSync(s.cfg, 'utf8'));
    for (const p of c.participants) if (p.name !== 'local') p.bin = '/nonexistent/' + p.name;
    c.options = { councilTools: { semgrep: false, gitleaks: false, 'npm-audit': false, scancode: false } };
    const bad = path.join(tmp(), 'conductor.json');
    writeFileSync(bad, JSON.stringify(c));
    const d = await spawnBin(['doctor', '--config', bad], { cwd: s.repo, env: s.env });
    assert.equal(d.code, 2, d.out);
    assert.match(d.out, /Council checks \(used with --council\):\n {2}✗ Semgrep/);
    const r = await spawnBin(['add multiply', '--config', bad], { cwd: s.repo, env: s.env });
    assert.equal(r.code, 2, r.out);
    assert.doesNotMatch(r.out, /Council checks/);
  } finally { await s.close(); }
});
