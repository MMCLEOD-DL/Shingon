import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { writeStubCli } from './helpers/stubCli.js';
import { makeRepo, refsOf } from './helpers/gitRepo.js';
import { git, metaDirOf } from '../src/workspace.js';
import { main } from '../src/cli/main.js';

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
    if (process.env.STUB_LOCAL_HANG) { setInterval(() => {}, 1000); }
    else { fs.writeFileSync('multiply.txt', 'local did it\\n'); fs.writeFileSync(out, 'Edited multiply.txt.'); }
  } else if ((args[1] || '').includes('REVIEWER')) fs.writeFileSync(out, 'Looks right.\\nVERDICT: APPROVE');
  else { fs.writeFileSync('codex-step.txt', 'x\\n'); fs.writeFileSync(out, 'done'); }
`;

async function setup() {
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[]}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const bins = tmp();
  const claude = writeStubCli(bins, 'claude', CLAUDE);
  const codex = writeStubCli(bins, 'codex', CODEX);
  const cfg = path.join(tmp(), 'conductor.json');
  writeFileSync(cfg, JSON.stringify({ participants: [
    { name: 'claude', adapter: 'claude-code', bin: claude, roles: ['author', 'reviewer'], capabilities: { is_agentic: true, can_edit_files: true } },
    { name: 'codex', adapter: 'codex', bin: codex, roles: ['author', 'reviewer'], capabilities: { is_agentic: true, can_edit_files: true } },
    { name: 'local', adapter: 'local-agent', bin: codex, model: 'm', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, roles: ['grunt'], capabilities: { is_agentic: true, can_edit_files: true } },
  ] }));
  const repo = await makeRepo();
  const baseDir = tmp();
  const env = { ...process.env, CONDUCTOR_BASE_DIR: baseDir, XDG_CONFIG_HOME: tmp(), XDG_CACHE_HOME: tmp() };
  delete env.ANTHROPIC_API_KEY;
  return { server, cfg, repo, baseDir, env, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
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
