// src/workspace.js
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
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

  static async create({ repoDir, baseDir, taskId }) {
    const probe = await git(repoDir, ['rev-parse', '--verify', 'HEAD']);
    if (probe.code !== 0) throw new Error(`${repoDir} is not a git repository with at least one commit`);
    const dir = mkdtempSync(path.join(baseDir ?? tmpdir(), 'conductor-ws-'));
    await gitOk(dir, ['clone', '--quiet', '--no-hardlinks', path.resolve(repoDir), '.']);
    await gitOk(dir, ['remote', 'remove', 'origin']);
    const branch = `conductor/${slugify(taskId)}`;
    await gitOk(dir, ['checkout', '-q', '-b', branch]);
    const baseSha = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim();
    const ws = new Workspace(dir, branch, baseSha);
    mkdirSync(ws.metaDir, { recursive: true });
    writeFileSync(path.join(ws.metaDir, 'base'), `${baseSha}\n`);
    writeFileSync(path.join(ws.metaDir, 'repo.json'), JSON.stringify({
      repoDir: path.resolve(repoDir), gitCommonDir: await gitCommonDir(repoDir),
    }, null, 2));
    ws.sealConfig();
    return ws;
  }

  static async open(dir) {
    const branch = (await gitOk(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const baseSha = readFileSync(path.join(metaDirOf(dir), 'base'), 'utf8').trim();
    return new Workspace(dir, branch, baseSha);
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

  async diff(fromSha) {
    await gitOk(this.dir, ['add', '-A']);
    return gitOk(this.dir, [...DIFF, '--cached', fromSha]);
  }

  async listFiles(fromSha) {
    await gitOk(this.dir, ['add', '-A']);
    const out = await gitOk(this.dir, [...DIFF, '--cached', '--name-only', fromSha]);
    return out.split('\n').filter(Boolean);
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

  async resetHard(sha) {
    await gitOk(this.dir, ['reset', '-q', '--hard', sha]);
    // -ff: also remove nested git repos an agent created (plain -fd skips them). No -x: ignored files stay.
    await gitOk(this.dir, ['clean', '-ffdq']);
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
