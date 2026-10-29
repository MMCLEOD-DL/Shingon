# Task 10: The `conductor` command

This task delivers spec §8: one command run inside the project.

```
conductor "add a CSV export button to the reports page"
conductor resume [<workspace>]
conductor runs
conductor doctor
```

**Pieces:**
- argument parsing;
- config discovery;
- a list of the unfinished runs for this repository;
- Ctrl-C handling (Ruling 5): kill the agents, log `interrupted`, exit 130, and stay resumable;
- `bin/conductor.js`, which wires config → `buildTeam` → `runTask`/`resume` → the terminal hooks, and tells the user in plain words what happened and what to do next.

**Files:**
- Create: `src/cli/args.js`, `src/cli/config.js`, `src/cli/runs.js`, `src/cli/main.js`, `bin/conductor.js`, `test/cli.test.js`, `test/cli-e2e.test.js`
- Modify: `src/exec.js` (track live children), `package.json` (`bin`)
- Test: `test/exec.test.js` (append)

**Interfaces:**
- Consumes:
  - `loadConfig(file) -> { participants, routing, options }` (Task 2);
  - `buildTeam` (Task 5);
  - `runTask`/`resume` with `warnings` and the `paused` status (Task 6);
  - the outcome `note` (Task 7);
  - `createTerminal` and `StatusModel#seed` (Tasks 8–9);
  - `RunLog` (`src/runlog.js`);
  - `metaDirOf` and `defaultBaseDir` (`src/workspace.js`);
  - `runCommand` (`src/exec.js`);
  - `REASON_TEXT` (Task 4).
- Produces:
  - `parseCli(argv)` and `USAGE` (`src/cli/args.js`).
    - Only a bare first word `resume`, `runs` or `doctor` is a subcommand. Any other positional text, joined with spaces, is the request.
    - Flags: `--config <file>`, `--test "<cmd>"`, `--approve-plan`, `--approve-each-chunk`, `--watch-diffs`, `--keep-workspace`, `--no-bell`, `-h/--help`, `--version`. No arguments at all means `help`.
    - Result: `{ command, request?, workspaceDir?, flags: { config, testCommand, approvePlan, approveEachChunk, watchDiffs, keepWorkspace, bell } }`, or `{ error }`.
  - `findConfig({ flag = null, cwd, env = process.env, home = os.homedir() })` (`src/cli/config.js`).
    - With `flag`: `path.resolve(cwd, flag)`, which must exist.
    - Otherwise the first that exists of: `<cwd>/conductor.json`, `$XDG_CONFIG_HOME/conductor/config.json` (if set), `<home>/.config/conductor/config.json`.
    - If nothing is found it throws a plain error listing every place it looked.
  - `listRuns({ baseDir = defaultBaseDir(), repoDir = null })` (`src/cli/runs.js`).
    - It reads `<baseDir>/*.conductor/state.json`.
    - It keeps statuses `running | failed | paused` whose workspace still exists and whose `state.repoDir` equals `path.resolve(repoDir)` when given.
    - It returns `[{ workspaceDir, request, status, phase, done, total, updatedAt, reason }]`, newest first.
  - `killAllChildren(signal = 'SIGKILL')` (`src/exec.js`) kills the process group of every live `runCommand` child.
  - `main(argv, { cwd, env, stdin, stdout, isTTY, onSignal, exit })` → `Promise<exit code>` (`src/cli/main.js`).
    - `env.CONDUCTOR_BASE_DIR` overrides the workspace location. Tests use this; real users get the library default.
    - `onSignal(handler)` registers the Ctrl-C handler (default: `process.once('SIGINT', handler)`), and `exit(code)` ends the process (default `process.exit`).
  - Exit codes: `EXIT = { landed: 0, rejected: 1, stopped: 1, failed: 2, paused: 3, usage: 64, interrupted: 130 }`. Config problems and "not a git repository" are `usage`.
  - `bin/conductor.js` is just `process.exit(await main(process.argv.slice(2)))`.

**User-facing text (exact):**
- landed:
  ```
  Done. The result is on a new branch in your repository: <branch>
  See what changed:  git log --stat <branch>
  Merge it when you are happy:  git merge <branch>
  ```
- rejected: `Not approved. Your repository is unchanged.`, plus ` Your note was saved with the run log.` when there is a note.
- stopped, failed and paused: print the outcome's `reason`. When the run is resumable (`failed`/`paused` with a `workspaceDir`), add `To continue from where it stopped, run:  conductor resume`.
- Ctrl-C: `Stopped. Your repository is unchanged. To continue later, run:  conductor resume`.
- not a repo: `Run conductor inside a git repository: the folder of the project you want changed.`
- resume with no unfinished run: `There is no unfinished Conductor run for this repository.` (exit 1).
- Always, when known, the last line is: `Full log: <transcript path>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/exec.test.js`:

```js
import { killAllChildren } from '../src/exec.js';

test('killAllChildren ends every live child; their runs resolve', async () => {
  const p = runCommand({ cmd: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 60000 });
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  killAllChildren();
  const r = await p;
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - t0 < 5000);
});
```

(Use the file's existing `runCommand` import.)

Create `test/cli.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCli } from '../src/cli/args.js';
import { findConfig } from '../src/cli/config.js';
import { listRuns } from '../src/cli/runs.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'cli-'));

test('parseCli: a request, subcommands and flags', () => {
  assert.deepEqual(parseCli(['add', 'a', 'CSV', 'export']).request, 'add a CSV export');
  assert.equal(parseCli(['resume the login work']).command, 'run', 'only a bare "resume" is the subcommand');
  assert.deepEqual(parseCli(['resume']), { command: 'resume', workspaceDir: null, flags: parseCli(['resume']).flags });
  assert.equal(parseCli(['resume', '/w/x']).workspaceDir, '/w/x');
  assert.equal(parseCli(['runs']).command, 'runs');
  assert.equal(parseCli(['doctor']).command, 'doctor');
  assert.equal(parseCli([]).command, 'help');
  assert.equal(parseCli(['--version']).command, 'version');
  const f = parseCli(['fix it', '--config', 'c.json', '--test', 'npm test', '--approve-plan', '--approve-each-chunk', '--watch-diffs', '--keep-workspace', '--no-bell']).flags;
  assert.deepEqual(f, { config: 'c.json', testCommand: 'npm test', approvePlan: true, approveEachChunk: true, watchDiffs: true, keepWorkspace: true, bell: false });
  assert.deepEqual(parseCli(['x']).flags, { config: null, testCommand: null, approvePlan: false, approveEachChunk: false, watchDiffs: false, keepWorkspace: false, bell: true });
});

test('parseCli: bad usage is an error, never a run', () => {
  assert.ok(parseCli(['x', '--bogus']).error);
  assert.ok(parseCli(['runs', 'extra']).error);
  assert.ok(parseCli(['resume', 'a', 'b']).error);
  assert.ok(parseCli(['   ']).error);
});

test('findConfig: flag, then ./conductor.json, then XDG, then ~/.config', () => {
  const cwd = tmp();
  const home = tmp();
  const xdg = tmp();
  assert.throws(() => findConfig({ cwd, env: {}, home }), (e) => e.message.includes(path.join(cwd, 'conductor.json')) && e.message.includes(path.join(home, '.config', 'conductor', 'config.json')));
  mkdirSync(path.join(home, '.config', 'conductor'), { recursive: true });
  writeFileSync(path.join(home, '.config', 'conductor', 'config.json'), '{}');
  assert.equal(findConfig({ cwd, env: {}, home }), path.join(home, '.config', 'conductor', 'config.json'));
  mkdirSync(path.join(xdg, 'conductor'));
  writeFileSync(path.join(xdg, 'conductor', 'config.json'), '{}');
  assert.equal(findConfig({ cwd, env: { XDG_CONFIG_HOME: xdg }, home }), path.join(xdg, 'conductor', 'config.json'));
  writeFileSync(path.join(cwd, 'conductor.json'), '{}');
  assert.equal(findConfig({ cwd, env: { XDG_CONFIG_HOME: xdg }, home }), path.join(cwd, 'conductor.json'));
  writeFileSync(path.join(cwd, 'mine.json'), '{}');
  assert.equal(findConfig({ flag: 'mine.json', cwd, env: {}, home }), path.join(cwd, 'mine.json'));
  assert.throws(() => findConfig({ flag: 'missing.json', cwd, env: {}, home }), /No config file at .*missing\.json/);
});

test('listRuns: unfinished runs of this repo only, newest first', () => {
  const baseDir = tmp();
  const mk = (name, state, mtime) => {
    mkdirSync(path.join(baseDir, name));
    mkdirSync(path.join(baseDir, `${name}.conductor`));
    const f = path.join(baseDir, `${name}.conductor`, 'state.json');
    writeFileSync(f, JSON.stringify({ version: 1, ...state }));
    utimesSync(f, mtime, mtime);
  };
  const plan = { chunks: [{ title: 'a' }, { title: 'b' }] };
  mk('ws-old', { status: 'failed', repoDir: '/repo', request: 'old', phase: 'chunks', chunkShas: ['s1'], plan }, 1000);
  mk('ws-new', { status: 'paused', repoDir: '/repo', request: 'new', phase: 'plan', chunkShas: [], plan: null }, 2000);
  mk('ws-done', { status: 'landed', repoDir: '/repo', request: 'done', phase: 'done', chunkShas: [] }, 3000);
  mk('ws-other', { status: 'running', repoDir: '/elsewhere', request: 'other', phase: 'plan', chunkShas: [] }, 4000);
  mkdirSync(path.join(baseDir, 'ws-gone.conductor'));
  writeFileSync(path.join(baseDir, 'ws-gone.conductor', 'state.json'), JSON.stringify({ status: 'running', repoDir: '/repo' }));
  mkdirSync(path.join(baseDir, 'ws-broken.conductor'));
  mkdirSync(path.join(baseDir, 'ws-broken'));
  writeFileSync(path.join(baseDir, 'ws-broken.conductor', 'state.json'), '{not json');
  const runs = listRuns({ baseDir, repoDir: '/repo' });
  assert.deepEqual(runs.map((r) => r.request), ['new', 'old']);
  assert.deepEqual({ done: runs[1].done, total: runs[1].total, status: runs[1].status }, { done: 1, total: 2, status: 'failed' });
  assert.equal(runs[0].workspaceDir, path.join(baseDir, 'ws-new'));
  assert.equal(listRuns({ baseDir, repoDir: null }).length, 3);
  assert.deepEqual(listRuns({ baseDir: path.join(baseDir, 'nope') }), []);
});
```

Create `test/cli-e2e.test.js`. It drives the real command against stub CLIs and a stub local-model server:

```js
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
    assert.match(d.out, /✓ claude \(claude-code\)/);
    assert.match(d.out, /✓ local \(local-agent\)/);
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
    stdin.end('a\n');
    let text = '';
    const stdout = new Writable({ write(c, e, cb) { text += c; cb(); } });
    const code = await main(['add multiply', '--config', s.cfg, '--no-bell'], { cwd: s.repo, env: s.env, stdin, stdout, isTTY: true, onSignal: () => {}, exit: () => {} });
    assert.equal(code, 0, text);
    assert.match(text, /Done\. The result is on a new branch in your repository: conductor\/add-multiply/);
    assert.equal((await git(s.repo, ['show', '--name-only', '--format=', 'conductor/add-multiply'])).stdout.trim(), 'multiply.txt');
  } finally { await s.close(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, because `src/cli/*`, `bin/conductor.js` and `killAllChildren` do not exist.

- [ ] **Step 3: Implement**

`src/exec.js`:
- Add at module level: `const LIVE = new Set(); // every running child, for Ctrl-C`.
- In `runCommand`, after `child = spawn(...)` succeeds, add `LIVE.add(child);`.
- In `finish`, after `settled = true;`, add `LIVE.delete(child);`.
- Add:

```js
// Ctrl-C (bin/conductor.js): end every agent we started, with its whole process group.
export function killAllChildren(signal = 'SIGKILL') {
  for (const child of LIVE) {
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
  }
}
```

Create `src/cli/args.js`:

```js
// src/cli/args.js
import { parseArgs } from 'node:util';

export const USAGE = `Usage:
  conductor "<what you want done>"   start a new task in this repository
  conductor resume [<workspace>]     continue the latest unfinished run here (or the one given)
  conductor runs                     list unfinished runs for this repository
  conductor doctor                   check which AI models are available
Options:
  --config <file>        config file (default: ./conductor.json, then ~/.config/conductor/config.json)
  --test "<command>"     the command that runs this project's tests, e.g. "npm test"
  --approve-plan         show you the plan and ask before any step runs
  --approve-each-chunk   ask you before moving on after each step
  --watch-diffs          print each step's changes as it finishes
  --keep-workspace       keep Conductor's working copy after the run
  --no-bell              do not ring the terminal bell when Conductor needs you
  -h, --help             show this help
  --version              show the version`;

const OPTIONS = {
  config: { type: 'string' },
  test: { type: 'string' },
  'approve-plan': { type: 'boolean' },
  'approve-each-chunk': { type: 'boolean' },
  'watch-diffs': { type: 'boolean' },
  'keep-workspace': { type: 'boolean' },
  'no-bell': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};
const SUBCOMMANDS = new Set(['resume', 'runs', 'doctor']);

export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    return { error: e.message };
  }
  const { values: v, positionals } = parsed;
  const flags = {
    config: v.config ?? null,
    testCommand: v.test ?? null,
    approvePlan: v['approve-plan'] === true,
    approveEachChunk: v['approve-each-chunk'] === true,
    watchDiffs: v['watch-diffs'] === true,
    keepWorkspace: v['keep-workspace'] === true,
    bell: v['no-bell'] !== true,
  };
  if (v.help) return { command: 'help', flags };
  if (v.version) return { command: 'version', flags };
  if (!positionals.length) return { command: 'help', flags };
  const [first, ...rest] = positionals;
  if (SUBCOMMANDS.has(first)) {
    if (first === 'resume') {
      if (rest.length > 1) return { error: 'resume takes at most one workspace path' };
      return { command: 'resume', workspaceDir: rest[0] ?? null, flags };
    }
    if (rest.length) return { error: `${first} takes no arguments` };
    return { command: first, flags };
  }
  const request = positionals.join(' ').trim();
  if (!request) return { error: 'the request is empty: say what you want done' };
  return { command: 'run', request, flags };
}
```

Create `src/cli/config.js`:

```js
// src/cli/config.js
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function findConfig({ flag = null, cwd = process.cwd(), env = process.env, home = homedir() } = {}) {
  if (flag) {
    const p = path.resolve(cwd, flag);
    if (!existsSync(p)) throw new Error(`No config file at ${p}.`);
    return p;
  }
  const places = [path.join(cwd, 'conductor.json')];
  if (env.XDG_CONFIG_HOME) places.push(path.join(env.XDG_CONFIG_HOME, 'conductor', 'config.json'));
  places.push(path.join(home, '.config', 'conductor', 'config.json'));
  const found = places.find((p) => existsSync(p));
  if (found) return found;
  throw new Error(`No Conductor config found. Looked in:\n${places.map((p) => `  - ${p}`).join('\n')}\n` +
    'Copy config.example.json from the Conductor folder to one of these places and edit it.');
}
```

Create `src/cli/runs.js`:

```js
// src/cli/runs.js
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { defaultBaseDir } from '../workspace.js';

const UNFINISHED = new Set(['running', 'failed', 'paused']);
const META = '.conductor';

export function listRuns({ baseDir = defaultBaseDir(), repoDir = null } = {}) {
  let names;
  try {
    names = readdirSync(baseDir);
  } catch {
    return [];
  }
  const want = repoDir ? path.resolve(repoDir) : null;
  const runs = [];
  for (const name of names) {
    if (!name.endsWith(META)) continue;
    const statePath = path.join(baseDir, name, 'state.json');
    let s;
    let mtime;
    try {
      s = JSON.parse(readFileSync(statePath, 'utf8'));
      mtime = statSync(statePath).mtimeMs;
    } catch {
      continue;
    }
    if (!s || !UNFINISHED.has(s.status) || (want && s.repoDir !== want)) continue;
    const workspaceDir = path.join(baseDir, name.slice(0, -META.length));
    if (!existsSync(workspaceDir)) continue;
    runs.push({
      workspaceDir, request: s.request ?? '', status: s.status, phase: s.phase ?? null,
      done: Array.isArray(s.chunkShas) ? s.chunkShas.length : 0, total: s.plan?.chunks?.length ?? null,
      updatedAt: mtime, reason: s.reason ?? null,
    });
  }
  return runs.sort((a, b) => b.updatedAt - a.updatedAt);
}
```

Create `src/cli/main.js`:

```js
// src/cli/main.js
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCli, USAGE } from './args.js';
import { findConfig } from './config.js';
import { listRuns } from './runs.js';
import { loadConfig } from '../config.js';
import { buildTeam } from '../team.js';
import { runTask, resume } from '../conductor.js';
import { createTerminal } from '../ui/terminal.js';
import { RunLog } from '../runlog.js';
import { metaDirOf, defaultBaseDir } from '../workspace.js';
import { runCommand, killAllChildren } from '../exec.js';
import { REASON_TEXT } from '../router.js';

export const EXIT = Object.freeze({ landed: 0, rejected: 1, stopped: 1, failed: 2, paused: 3, usage: 64, interrupted: 130 });
const NOT_A_REPO = 'Run conductor inside a git repository: the folder of the project you want changed.';
const INTERRUPTED = 'Stopped. Your repository is unchanged. To continue later, run:  conductor resume';

async function repoRoot(cwd) {
  const r = await runCommand({ cmd: 'git', args: ['rev-parse', '--show-toplevel'], cwd, timeoutMs: 15000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

function version() {
  const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  return JSON.parse(readFileSync(pkg, 'utf8')).version;
}

function reportLines(report) {
  return report.map((x) => `  ${x.ok ? '✓' : '✗'} ${x.name} (${x.kind})${x.ok ? '' : `: ${REASON_TEXT[x.reason] ?? x.reason}${x.detail ? ` (${x.detail})` : ''}`}`);
}

function outcomeText(out) {
  const lines = [];
  if (out.status === 'landed') {
    lines.push(`Done. The result is on a new branch in your repository: ${out.branch}`,
      `See what changed:  git log --stat ${out.branch}`, `Merge it when you are happy:  git merge ${out.branch}`);
  } else if (out.status === 'rejected') {
    lines.push(`Not approved. Your repository is unchanged.${out.note ? ' Your note was saved with the run log.' : ''}`);
  } else {
    lines.push(out.reason ?? `The run ended: ${out.status}.`);
    if ((out.status === 'failed' || out.status === 'paused') && out.workspaceDir) lines.push('To continue from where it stopped, run:  conductor resume');
  }
  const log = out.transcript ?? (out.workspaceDir ? path.join(metaDirOf(out.workspaceDir), 'transcript.jsonl') : null);
  if (log) lines.push(`Full log: ${log}`);
  return lines.join('\n');
}

export async function main(argv, {
  cwd = process.cwd(), env = process.env, stdin = process.stdin, stdout = process.stdout,
  isTTY = Boolean(stdin.isTTY && stdout.isTTY),
  onSignal = (handler) => process.once('SIGINT', handler), exit = (code) => process.exit(code),
} = {}) {
  const print = (s) => stdout.write(`${s}\n`);
  const cli = parseCli(argv);
  if (cli.error) { print(`${cli.error}\n\n${USAGE}`); return EXIT.usage; }
  if (cli.command === 'help') { print(USAGE); return 0; }
  if (cli.command === 'version') { print(version()); return 0; }

  const repoDir = await repoRoot(cwd);
  if (!repoDir) { print(NOT_A_REPO); return EXIT.usage; }
  const baseDir = env.CONDUCTOR_BASE_DIR || undefined;

  if (cli.command === 'runs') {
    const runs = listRuns({ baseDir: baseDir ?? defaultBaseDir(env), repoDir });
    if (!runs.length) { print('No unfinished runs for this repository.'); return 0; }
    for (const r of runs) print(`${r.status.padEnd(7)} ${r.done}/${r.total ?? '?'} steps  ${r.request}  (${r.workspaceDir})`);
    return 0;
  }

  let config;
  try {
    config = loadConfig(findConfig({ flag: cli.flags.config, cwd, env }));
  } catch (e) {
    print(`Conductor could not read its config: ${e.message}`);
    return EXIT.usage;
  }

  let workspaceDir = null;
  let seed = null;
  if (cli.command === 'resume') {
    workspaceDir = cli.workspaceDir ? path.resolve(cwd, cli.workspaceDir) : listRuns({ baseDir: baseDir ?? defaultBaseDir(env), repoDir })[0]?.workspaceDir ?? null;
    if (!workspaceDir) { print('There is no unfinished Conductor run for this repository.'); return 1; }
    try {
      const s = JSON.parse(readFileSync(path.join(metaDirOf(workspaceDir), 'state.json'), 'utf8'));
      if (s.plan?.chunks) seed = { chunks: s.plan.chunks.map((c) => c.title), done: s.chunkShas?.length ?? 0 };
    } catch {
      // resume() itself explains an unusable state
    }
  }

  const term = createTerminal({ input: stdin, output: stdout, isTTY, bell: cli.flags.bell });
  if (seed) term.model.seed(seed);
  term.say('Checking which AI models are available…');
  const built = await buildTeam(config.participants, { routing: config.routing, env });
  if (cli.command === 'doctor' || !built.ok) {
    term.say(reportLines(built.report).join('\n'));
    if (built.ok) {
      term.say(`Author: ${built.team.author.name} · Reviewer: ${built.team.reviewer.name} · Local: ${built.team.local.name}`);
      for (const w of built.warnings) term.say(`Note: ${w}`);
    } else {
      term.say(built.error);
    }
    term.close();
    return built.ok ? 0 : EXIT.failed;
  }
  for (const w of built.warnings) term.say(`Note: ${w}`);

  // Ctrl-C (Ruling 5): stop the agents, record it, leave the run resumable, exit 130.
  onSignal(() => {
    killAllChildren();
    if (workspaceDir) {
      try { new RunLog(metaDirOf(workspaceDir)).event('interrupted', {}); } catch {}
    }
    term.say(`\n${INTERRUPTED}`);
    term.close();
    exit(EXIT.interrupted);
  });

  const f = cli.flags;
  const overrides = {
    ...(f.testCommand ? { testCommand: f.testCommand } : {}),
    ...(f.approvePlan ? { approvePlan: true } : {}),
    ...(f.approveEachChunk ? { approveEachChunk: true } : {}),
    ...(f.watchDiffs ? { watchDiffs: true } : {}),
    ...(f.keepWorkspace ? { keepWorkspace: true } : {}),
    allowSameVendor: built.allowSameVendor,
  };
  const hooks = {
    onEvent: (e) => { if (e.type === 'start' && e.workspace) workspaceDir = e.workspace; term.onEvent(e); },
    escalate: term.escalate, approveResult: term.approveResult, approveChunk: term.approveChunk, approvePlan: term.approvePlan,
  };
  let out;
  try {
    out = cli.command === 'resume'
      ? await resume({ workspaceDir, repoDir, team: built.team, hooks, options: overrides, warnings: built.warnings })
      : await runTask({ repoDir, request: cli.request, team: built.team, hooks, options: { ...config.options, ...overrides }, baseDir, warnings: built.warnings });
  } catch (e) {
    term.say(`Conductor could not start: ${e.message}`);
    term.close();
    return EXIT.usage;
  }
  term.say(`\n${outcomeText(out)}`);
  term.close();
  return EXIT[out.status] ?? EXIT.failed;
}
```

Create `bin/conductor.js`:

```js
#!/usr/bin/env node
// bin/conductor.js
import { main } from '../src/cli/main.js';

process.exit(await main(process.argv.slice(2)));
```

Run `chmod +x bin/conductor.js`. Then in `package.json`, change `"bin"` to:

```json
  "bin": { "conductor": "bin/conductor.js", "conductor-probe": "bin/conductor-probe.js" },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS. The e2e tests take a few seconds each.

The Ctrl-C test does not depend on timing. The handler runs between event-loop turns, so the hanging local child is either already in `LIVE` (and gets killed) or was never spawned (and the process exits first). **Do not** add sleeps.

- [ ] **Step 5: Commit**

```bash
git add src/cli src/exec.js bin/conductor.js package.json test
git commit -m "feat: the conductor command — run, resume, runs, doctor; Ctrl-C stays resumable"
```
