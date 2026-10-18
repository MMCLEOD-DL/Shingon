# Task 2: Workspace

The throwaway git clone where all agent work happens. The real repo is only touched by `land()`, which creates a new branch and refuses to overwrite.

**Files:**
- Create: `src/text.js`, `src/workspace.js`, `test/helpers/gitRepo.js`
- Test: `test/text.test.js`, `test/workspace.test.js`

**Interfaces:**
- Consumes: `runCommand({cmd,args,cwd,timeoutMs})` from `src/exec.js`.
- Produces:
  - `clip(text, max = 8000) -> string` — unchanged if short; otherwise keeps head and tail halves with a `…[N chars clipped]…` marker.
  - `git(cwd, args, { timeoutMs }) -> { stdout, stderr, code, timedOut }` — always prefixed with the safety flags.
  - `slugify(s) -> string` — lowercase `[a-z0-9-]`, max 40 chars, `'task'` if empty.
  - `class Workspace` — see the index's Shared Interfaces. Branch is `conductor/<slug>`. `diff`/`listFiles` include uncommitted and untracked changes. `resetHard` also removes untracked (non-ignored) files. `runTests` with no command returns `{ ran: false, passed: null, code: null, output: '' }`.
  - `test/helpers/gitRepo.js`: `makeRepo(files) -> dir` (repo on `main` with one commit), `refsOf(dir) -> string`.

- [ ] **Step 1: Write the failing tests**

`test/text.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clip } from '../src/text.js';

test('short text unchanged', () => {
  assert.equal(clip('abc', 10), 'abc');
});

test('long text keeps head and tail with a marker', () => {
  const s = 'A'.repeat(50) + 'B'.repeat(50);
  const c = clip(s, 20);
  assert.ok(c.startsWith('A'.repeat(10)));
  assert.ok(c.endsWith('B'.repeat(10)));
  assert.match(c, /\[80 chars clipped\]/);
});

test('non-string becomes empty string', () => {
  assert.equal(clip(undefined), '');
});
```

`test/helpers/gitRepo.js`:

```js
// test/helpers/gitRepo.js
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../../src/workspace.js';

// Creates a git repo on branch main with one commit containing `files`.
export async function makeRepo(files = { 'README.md': 'hello\n' }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'repo-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

// Every ref and the object it points at; used to prove a repo was not touched.
export async function refsOf(dir) {
  return (await git(dir, ['for-each-ref', '--format=%(refname) %(objectname)'])).stdout;
}
```

`test/workspace.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace, git, slugify } from '../src/workspace.js';
import { makeRepo, refsOf } from './helpers/gitRepo.js';

const base = () => mkdtempSync(path.join(tmpdir(), 'wsbase-'));

test('slugify', () => {
  assert.equal(slugify('Add CSV Export!'), 'add-csv-export');
  assert.equal(slugify('***'), 'task');
  assert.equal(slugify('x'.repeat(100)).length, 40);
});

test('create clones HEAD onto a conductor branch with no remotes, real repo untouched', async () => {
  const repo = await makeRepo();
  const before = await refsOf(repo);
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 'Add CSV' });
  assert.equal(ws.branch, 'conductor/add-csv');
  assert.equal(readFileSync(path.join(ws.dir, 'README.md'), 'utf8'), 'hello\n');
  assert.equal((await git(ws.dir, ['remote'])).stdout.trim(), '');
  assert.equal(ws.baseSha, await ws.head());
  assert.equal(await refsOf(repo), before);
});

test('create rejects a directory that is not a git repo with a commit', async () => {
  await assert.rejects(Workspace.create({ repoDir: base(), baseDir: base(), taskId: 't' }), /not a git repository/);
});

test('open restores branch and baseSha', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a');
  await ws.commitAll('a');
  const again = await Workspace.open(ws.dir);
  assert.equal(again.branch, ws.branch);
  assert.equal(again.baseSha, ws.baseSha);
});

test('commitAll returns null when clean, a sha when dirty', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  assert.equal(await ws.commitAll('nothing'), null);
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a');
  const sha = await ws.commitAll('add a');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(sha, await ws.head());
});

test('diff and listFiles include committed, modified and untracked changes', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  const b = await ws.head();
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a\n');
  await ws.commitAll('a');
  writeFileSync(path.join(ws.dir, 'README.md'), 'changed\n');
  writeFileSync(path.join(ws.dir, 'new.txt'), 'new\n');
  const d = await ws.diff(b);
  assert.match(d, /\+a/);
  assert.match(d, /\+changed/);
  assert.match(d, /\+new/);
  assert.deepEqual((await ws.listFiles(b)).sort(), ['README.md', 'a.txt', 'new.txt']);
});

test('squashSince collapses everything since base into one commit', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  const b = await ws.head();
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a');
  await ws.commitAll('one');
  writeFileSync(path.join(ws.dir, 'b.txt'), 'b');
  await ws.commitAll('two');
  writeFileSync(path.join(ws.dir, 'c.txt'), 'c');
  const sha = await ws.squashSince(b, 'chunk 1');
  assert.equal((await git(ws.dir, ['rev-list', '--count', `${b}..HEAD`])).stdout.trim(), '1');
  assert.equal((await git(ws.dir, ['log', '-1', '--format=%s'])).stdout.trim(), 'chunk 1');
  assert.equal(sha, await ws.head());
  for (const f of ['a.txt', 'b.txt', 'c.txt']) assert.ok(existsSync(path.join(ws.dir, f)));
});

test('squashSince returns null when nothing changed', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  assert.equal(await ws.squashSince(await ws.head(), 'empty'), null);
});

test('resetHard drops commits, edits and untracked files', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  const b = await ws.head();
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a');
  await ws.commitAll('a');
  writeFileSync(path.join(ws.dir, 'README.md'), 'junk');
  writeFileSync(path.join(ws.dir, 'stray.txt'), 'x');
  await ws.resetHard(b);
  assert.equal(await ws.head(), b);
  assert.equal(readFileSync(path.join(ws.dir, 'README.md'), 'utf8'), 'hello\n');
  assert.ok(!existsSync(path.join(ws.dir, 'a.txt')));
  assert.ok(!existsSync(path.join(ws.dir, 'stray.txt')));
});

test('runTests reports pass, fail, and not-configured', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  assert.deepEqual(await ws.runTests(null), { ran: false, passed: null, code: null, output: '' });
  const ok = await ws.runTests('echo fine');
  assert.equal(ok.passed, true);
  assert.match(ok.output, /fine/);
  const bad = await ws.runTests('echo broken >&2; exit 4');
  assert.equal(bad.passed, false);
  assert.equal(bad.code, 4);
  assert.match(bad.output, /broken/);
});

test('runTests timeout counts as failure', async () => {
  const ws = await Workspace.create({ repoDir: await makeRepo(), baseDir: base(), taskId: 't' });
  const r = await ws.runTests('sleep 10', { timeoutMs: 300 });
  assert.equal(r.passed, false);
});

test('land creates a new branch in the real repo without touching its checkout', async () => {
  const repo = await makeRepo();
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't' });
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a');
  const sha = await ws.commitAll('a');
  const r = await ws.land({ repoDir: repo, branch: 'conductor/result' });
  assert.deepEqual(r, { ok: true, branch: 'conductor/result', error: null });
  assert.equal((await git(repo, ['rev-parse', 'conductor/result'])).stdout.trim(), sha);
  assert.equal((await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'main');
  assert.ok(!existsSync(path.join(repo, 'a.txt')));
});

test('land refuses an existing branch and leaves it unchanged', async () => {
  const repo = await makeRepo();
  await git(repo, ['branch', 'taken']);
  const before = await refsOf(repo);
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't' });
  writeFileSync(path.join(ws.dir, 'a.txt'), 'a');
  await ws.commitAll('a');
  const r = await ws.land({ repoDir: repo, branch: 'taken' });
  assert.equal(r.ok, false);
  assert.match(r.error, /already exists/);
  assert.equal(await refsOf(repo), before);
});

test('land rejects an invalid branch name', async () => {
  const repo = await makeRepo();
  const ws = await Workspace.create({ repoDir: repo, baseDir: base(), taskId: 't' });
  const r = await ws.land({ repoDir: repo, branch: 'bad..name' });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid branch name/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/text.js'` / `'../src/workspace.js'`.

- [ ] **Step 3: Implement**

`src/text.js`:

```js
// src/text.js
// Keep prompts and logs bounded: head + tail survive, the middle is elided.
export function clip(text, max = 8000) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n…[${s.length - half * 2} chars clipped]…\n${s.slice(-half)}`;
}
```

`src/workspace.js`:

```js
// src/workspace.js
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from './exec.js';
import { clip } from './text.js';

// Fixed identity, no signing, no repo hooks: Conductor's own git calls must
// never depend on (or trigger) anything in the user's git setup.
const GIT_FLAGS = [
  '-c', 'user.name=Conductor', '-c', 'user.email=conductor@localhost',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
];

export function git(cwd, args, { timeoutMs = 60000 } = {}) {
  return runCommand({
    cmd: 'git', args: [...GIT_FLAGS, ...args], cwd, timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

async function gitOk(cwd, args) {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout;
}

export function slugify(s) {
  const slug = String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'task';
}

const META_DIR = (dir) => path.join(dir, '.git', 'conductor');

export class Workspace {
  constructor(dir, branch, baseSha) {
    this.dir = dir;
    this.branch = branch;
    this.baseSha = baseSha;
  }

  static async create({ repoDir, baseDir, taskId }) {
    const probe = await git(repoDir, ['rev-parse', '--verify', 'HEAD']);
    if (probe.code !== 0) throw new Error(`${repoDir} is not a git repository with at least one commit`);
    const dir = mkdtempSync(path.join(baseDir ?? tmpdir(), 'conductor-ws-'));
    await gitOk(dir, ['clone', '--quiet', '--no-hardlinks', path.resolve(repoDir), '.']);
    await gitOk(dir, ['remote', 'remove', 'origin']);
    const branch = `conductor/${slugify(taskId)}`;
    await gitOk(dir, ['checkout', '-q', '-b', branch]);
    const baseSha = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim();
    mkdirSync(META_DIR(dir), { recursive: true });
    writeFileSync(path.join(META_DIR(dir), 'base'), `${baseSha}\n`);
    return new Workspace(dir, branch, baseSha);
  }

  static async open(dir) {
    const branch = (await gitOk(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const baseSha = readFileSync(path.join(META_DIR(dir), 'base'), 'utf8').trim();
    return new Workspace(dir, branch, baseSha);
  }

  async head() {
    return (await gitOk(this.dir, ['rev-parse', 'HEAD'])).trim();
  }

  async #stagedChanges() {
    await gitOk(this.dir, ['add', '-A']);
    const r = await git(this.dir, ['diff', '--cached', '--quiet']);
    return r.code !== 0;
  }

  async commitAll(message) {
    if (!(await this.#stagedChanges())) return null;
    await gitOk(this.dir, ['commit', '-q', '--no-verify', '-m', message]);
    return this.head();
  }

  async diff(fromSha) {
    await gitOk(this.dir, ['add', '-A']);
    return gitOk(this.dir, ['diff', '--cached', fromSha]);
  }

  async listFiles(fromSha) {
    await gitOk(this.dir, ['add', '-A']);
    const out = await gitOk(this.dir, ['diff', '--cached', '--name-only', fromSha]);
    return out.split('\n').filter(Boolean);
  }

  async squashSince(baseSha, message) {
    await gitOk(this.dir, ['add', '-A']);
    await gitOk(this.dir, ['reset', '-q', '--soft', baseSha]);
    return this.commitAll(message);
  }

  async resetHard(sha) {
    await gitOk(this.dir, ['reset', '-q', '--hard', sha]);
    await gitOk(this.dir, ['clean', '-fdq']);
  }

  async runTests(command, { timeoutMs = 600000 } = {}) {
    if (!command) return { ran: false, passed: null, code: null, output: '' };
    const r = await runCommand({ cmd: 'sh', args: ['-c', command], cwd: this.dir, timeoutMs });
    return {
      ran: true,
      passed: r.code === 0 && !r.timedOut,
      code: r.code,
      output: clip(`${r.stdout}${r.stderr}${r.timedOut ? '\n[test command timed out]' : ''}`, 4000),
    };
  }

  // The ONLY operation that writes to the real repo: adds objects plus one new
  // branch ref. Never overwrites an existing branch; never touches the checkout.
  async land({ repoDir, branch }) {
    const fmt = await git(repoDir, ['check-ref-format', '--branch', branch]);
    if (fmt.code !== 0) return { ok: false, branch, error: `invalid branch name: ${branch}` };
    const exists = await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (exists.code === 0) return { ok: false, branch, error: `branch ${branch} already exists in the repository` };
    const r = await git(repoDir, ['fetch', '--quiet', '--no-tags', path.resolve(this.dir), `${this.branch}:refs/heads/${branch}`]);
    if (r.code !== 0) return { ok: false, branch, error: `fetch failed: ${r.stderr.trim()}` };
    return { ok: true, branch, error: null };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/text.js src/workspace.js test/helpers/gitRepo.js test/text.test.js test/workspace.test.js
git commit -m "feat: git workspace — isolated clone, per-chunk squash, safe land"
```
