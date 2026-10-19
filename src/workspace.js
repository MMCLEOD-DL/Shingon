// src/workspace.js
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { runCommand } from './exec.js';
import { clip } from './text.js';
import { childEnv, redact } from './secrets.js';

// Fixed identity, no signing, no repo hooks: Conductor's own git calls must
// never depend on (or trigger) anything in the user's git setup. Agents can write
// the workspace's .git/config, so every command-running knob is pinned off here
// (fsmonitor, pager, external diff, ssh, network transports, auto-gc).
const GIT_FLAGS = [
  '-c', 'user.name=Conductor', '-c', 'user.email=conductor@localhost',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external=',
  '-c', 'core.sshCommand=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
];
// Every diff Conductor runs: never an external diff driver or a textconv filter.
const DIFF = ['diff', '--no-ext-diff', '--no-textconv'];
const ZERO_SHA = '0'.repeat(40);

export function git(cwd, args, { timeoutMs = 60000, env = {} } = {}) {
  return runCommand({
    cmd: 'git', args: [...GIT_FLAGS, ...args], cwd, timeoutMs,
    env: { ...childEnv(), GIT_TERMINAL_PROMPT: '0', ...env },
  });
}

async function gitOk(cwd, args, opts) {
  const r = await git(cwd, args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout;
}

export function slugify(s) {
  const slug = String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'task';
}

// Conductor's own metadata (base, state.json, transcript.jsonl, the pristine git
// config) lives in a sibling directory, outside the agents' cwd.
export const metaDirOf = (dir) => `${path.resolve(dir)}.conductor`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Workspaces must survive a reboot (crash-safe & resumable), so not os.tmpdir():
// $XDG_STATE_HOME/conductor/workspaces, else ~/.conductor/workspaces.
export function defaultBaseDir(env = process.env) {
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, 'conductor', 'workspaces');
  return path.join(env.HOME || homedir(), '.conductor', 'workspaces');
}

const CLONE_TIMEOUT_MS = 15 * 60_000;

async function gitCommonDir(repoDir) {
  const r = await git(repoDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return r.code === 0 ? r.stdout.trim() : null;
}

export class Workspace {
  constructor(dir, branch, baseSha) {
    this.dir = path.resolve(dir);
    this.branch = branch;
    this.baseSha = baseSha;
    this.metaDir = metaDirOf(this.dir);
  }

  // Input validation, done before anything is created.
  static async assertRepo(repoDir) {
    const probe = await git(repoDir, ['rev-parse', '--verify', 'HEAD']);
    if (probe.code !== 0) throw new Error(`${repoDir} is not a git repository with at least one commit`);
  }

  static async create({ repoDir, baseDir, taskId }) {
    await Workspace.assertRepo(repoDir);
    const root = baseDir ?? defaultBaseDir();
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, 'conductor-ws-'));
    try {
      await gitOk(dir, ['clone', '--quiet', '--no-hardlinks', path.resolve(repoDir), '.'], { timeoutMs: CLONE_TIMEOUT_MS });
      await gitOk(dir, ['remote', 'remove', 'origin']);
      const branch = `conductor/${slugify(taskId)}`;
      await gitOk(dir, ['checkout', '-q', '-b', branch]);
      const baseSha = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim();
      const ws = new Workspace(dir, branch, baseSha);
      // The clone is of committed HEAD: record what was left behind (m5).
      const st = await git(repoDir, ['status', '--porcelain']);
      const src = await git(repoDir, ['symbolic-ref', '-q', '--short', 'HEAD']);
      ws.source = { sha: baseSha, branch: src.code === 0 ? src.stdout.trim() : null, dirty: st.code === 0 && st.stdout.trim() !== '' };
      mkdirSync(ws.metaDir, { recursive: true });
      writeFileSync(path.join(ws.metaDir, 'base'), `${baseSha}\n`);
      writeFileSync(path.join(ws.metaDir, 'repo.json'), JSON.stringify({
        repoDir: path.resolve(repoDir), gitCommonDir: await gitCommonDir(repoDir), source: ws.source,
      }, null, 2));
      ws.sealConfig();
      return ws;
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      rmSync(metaDirOf(dir), { recursive: true, force: true });
      throw e;
    }
  }

  static async open(dir) {
    const meta = metaDirOf(dir);
    if (!existsSync(path.join(meta, 'base'))) throw new Error(`${dir} is not a Conductor workspace`);
    const baseSha = readFileSync(path.join(meta, 'base'), 'utf8').trim();
    const r = await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
    const ws = new Workspace(dir, r.code === 0 ? r.stdout.trim() : null, baseSha); // null: detached HEAD
    try { ws.source = JSON.parse(readFileSync(path.join(meta, 'repo.json'), 'utf8')).source ?? null; } catch { ws.source = null; }
    return ws;
  }

  // Deletes the workspace and its metadata (after archiving what should be kept).
  remove() {
    rmSync(this.dir, { recursive: true, force: true });
    rmSync(this.metaDir, { recursive: true, force: true });
  }

  async currentBranch() {
    const r = await git(this.dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async onOwnBranch() {
    return (await this.currentBranch()) === this.branch;
  }

  // An agent can run git in the workspace. Never record, squash onto or land a
  // branch other than the run's own: a switched or detached HEAD is an error.
  async assertOnBranch() {
    const cur = await this.currentBranch();
    if (cur !== this.branch) {
      throw new Error(`the workspace is no longer on its branch ${this.branch} (found ${cur ?? 'a detached HEAD'}); nothing was landed`);
    }
  }

  // Put the run's branch back at `sha` and check it out (after an agent switched away).
  async returnToBranch(sha) {
    await gitOk(this.dir, ['checkout', '-q', '-f', '-B', this.branch, sha]);
  }

  get #configPath() { return path.join(this.dir, '.git', 'config'); }
  get #sealedConfigPath() { return path.join(this.metaDir, 'git-config'); }

  // Record the workspace's git config as Conductor left it.
  sealConfig() {
    writeFileSync(this.#sealedConfigPath, readFileSync(this.#configPath));
  }

  // After every agent call: an agent-written .git/config (fsmonitor, filters,
  // textconv, includes...) would run commands inside Conductor's own git calls.
  // Restore the sealed copy; returns null if untouched, else the hashes.
  restoreConfigIfTampered() {
    const sealed = readFileSync(this.#sealedConfigPath);
    let current = null;
    try { current = readFileSync(this.#configPath); } catch {}
    if (current && sha256(current) === sha256(sealed)) return null;
    rmSync(this.#configPath, { force: true }); // never write through a planted symlink
    writeFileSync(this.#configPath, sealed);
    return { expected: sha256(sealed), found: current ? sha256(current) : 'missing' };
  }

  // Resume must land into the repo the run was created from, and nowhere else.
  async checkRepo(repoDir) {
    let rec;
    try { rec = JSON.parse(readFileSync(path.join(this.metaDir, 'repo.json'), 'utf8')); } catch { rec = null; }
    if (!rec?.repoDir) return 'the workspace has no record of its repository';
    if (path.resolve(repoDir) !== rec.repoDir) return `this run belongs to ${rec.repoDir}, not ${path.resolve(repoDir)}`;
    const now = await gitCommonDir(rec.repoDir);
    if (!now || now !== rec.gitCommonDir) return `${rec.repoDir} is no longer the repository this run started from`;
    return null;
  }

  async head() {
    return (await gitOk(this.dir, ['rev-parse', 'HEAD'])).trim();
  }

  async isAncestor(a, b) {
    return (await git(this.dir, ['merge-base', '--is-ancestor', a, b])).code === 0;
  }

  async isClean() {
    return (await gitOk(this.dir, ['status', '--porcelain'])).trim() === '';
  }

  async #stagedChanges() {
    await gitOk(this.dir, ['add', '-A']);
    const r = await git(this.dir, [...DIFF, '--cached', '--quiet']);
    return r.code !== 0;
  }

  async commitAll(message) {
    if (!(await this.#stagedChanges())) return null;
    await gitOk(this.dir, ['commit', '-q', '--no-verify', '-m', message]);
    return this.head();
  }

  // Stage the whole worktree into a throwaway index, so diff/listFiles/snapshot
  // never touch the real index (no hidden `git add -A` side effect).
  async #withScratchIndex(fn) {
    const idx = path.join(this.metaDir, `scratch-index-${randomBytes(6).toString('hex')}`);
    const opts = { env: { GIT_INDEX_FILE: idx } };
    try {
      const real = path.join(this.dir, '.git', 'index');
      if (existsSync(real)) copyFileSync(real, idx);
      else await gitOk(this.dir, ['read-tree', 'HEAD'], opts);
      await gitOk(this.dir, ['add', '-A'], opts);
      return await fn(opts);
    } finally {
      rmSync(idx, { force: true });
    }
  }

  // fromSha..worktree, including uncommitted and untracked (not ignored) files.
  async diff(fromSha) {
    return this.#withScratchIndex((o) => gitOk(this.dir, [...DIFF, '--cached', fromSha], o));
  }

  async listFiles(fromSha) {
    const out = await this.#withScratchIndex((o) => gitOk(this.dir, [...DIFF, '--cached', '--name-only', fromSha], o));
    return out.split('\n').filter(Boolean);
  }

  // A commit of the current worktree on top of HEAD, without moving HEAD or the index.
  async snapshot() {
    return this.#withScratchIndex(async (o) => {
      const tree = (await gitOk(this.dir, ['write-tree'], o)).trim();
      return (await gitOk(this.dir, ['commit-tree', tree, '-p', 'HEAD', '-m', 'conductor: round snapshot'])).trim();
    });
  }

  // Ignored, untracked paths (wholly ignored directories collapsed to `dir/`).
  async ignoredPaths() {
    const out = await gitOk(this.dir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
    return new Set(out.split('\0').filter(Boolean));
  }

  // Commit-to-commit: exactly what landing `toSha` would ship; never reads the worktree or index.
  async diffRange(fromSha, toSha) {
    return gitOk(this.dir, [...DIFF, fromSha, toSha]);
  }

  async filesRange(fromSha, toSha) {
    const out = await gitOk(this.dir, [...DIFF, '--name-only', fromSha, toSha]);
    return out.split('\n').filter(Boolean);
  }

  async squashSince(baseSha, message) {
    await gitOk(this.dir, ['add', '-A']);
    await gitOk(this.dir, ['reset', '-q', '--soft', baseSha]);
    return this.commitAll(message);
  }

  // keepIgnored: the ignoredPaths() recorded at the chunk base. Ignored paths that
  // were not there are removed too (an agent's dist/ or build junk); the ones that
  // were (node_modules, caches) stay, keeping Ruling 7's "do not wipe deps".
  async resetHard(sha, { keepIgnored = null } = {}) {
    await gitOk(this.dir, ['reset', '-q', '--hard', sha]);
    // -ff: also remove nested git repos an agent created (plain -fd skips them). No -x: ignored files stay.
    await gitOk(this.dir, ['clean', '-ffdq']);
    if (!keepIgnored) return;
    for (const p of await this.ignoredPaths()) {
      if (keepIgnored.has(p)) continue;
      const rel = p.replace(/\/+$/, '');
      const abs = path.resolve(this.dir, rel);
      if (!rel || !abs.startsWith(this.dir + path.sep) || rel === '.git' || rel.startsWith('.git/')) continue;
      rmSync(abs, { recursive: true, force: true }); // rm never follows a symlink: it removes the link
    }
  }

  async runTests(command, { timeoutMs = 600000 } = {}) {
    if (!command) return { ran: false, passed: null, code: null, output: '' };
    const r = await runCommand({ cmd: 'sh', args: ['-c', command], cwd: this.dir, timeoutMs, env: childEnv() });
    return {
      ran: true,
      passed: r.code === 0 && !r.timedOut,
      code: r.code,
      // Redact before clipping, so a key straddling the clip point cannot survive as a fragment.
      output: clip(redact(`${r.stdout}${r.stderr}${r.timedOut ? '\n[test command timed out]' : ''}`), 4000),
    };
  }

  // Which of `names` (branch names) already point at `sha` in repoDir.
  static async findBranchAt(repoDir, names, sha) {
    for (const name of names) {
      const r = await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`]);
      if (r.code === 0 && r.stdout.trim() === sha) return name;
    }
    return null;
  }

  // The ONLY operation that writes to the real repo: adds objects plus one new
  // branch ref at exactly `sha`. Never overwrites an existing branch (create-only
  // update-ref, atomic); never touches the checkout.
  async land({ repoDir, branch, sha }) {
    if (!/^[0-9a-f]{40}$/.test(String(sha))) return { ok: false, branch, error: `invalid commit to land: ${sha}` };
    const ref = `refs/heads/${branch}`;
    // No --branch: that form expands @{-1} and friends.
    const fmt = await git(repoDir, ['check-ref-format', ref]);
    if (fmt.code !== 0 || branch.startsWith('-')) return { ok: false, branch, error: `invalid branch name: ${branch}` };
    const exists = await git(repoDir, ['rev-parse', '--verify', '--quiet', ref]);
    if (exists.code === 0) return { ok: false, branch, error: `branch ${branch} already exists in the repository` };
    const incoming = `refs/conductor/incoming/${randomBytes(8).toString('hex')}`;
    try {
      const f = await git(repoDir, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head',
        this.dir, `+refs/heads/${this.branch}:${incoming}`], { timeoutMs: 15 * 60_000 });
      if (f.code !== 0) return { ok: false, branch, error: `fetch failed: ${f.stderr.trim()}` };
      const got = await git(repoDir, ['rev-parse', '--verify', '--quiet', `${incoming}^{commit}`]);
      if (got.code !== 0 || got.stdout.trim() !== sha) {
        return { ok: false, branch, error: 'the workspace no longer holds the approved result; nothing was landed' };
      }
      const u = await git(repoDir, ['update-ref', ref, sha, ZERO_SHA]);
      if (u.code !== 0) {
        if (/exists/.test(u.stderr)) return { ok: false, branch, error: `branch ${branch} already exists in the repository` };
        return { ok: false, branch, error: `could not create the branch: ${u.stderr.trim()}` };
      }
      return { ok: true, branch, error: null };
    } finally {
      await git(repoDir, ['update-ref', '-d', incoming]);
    }
  }
}
