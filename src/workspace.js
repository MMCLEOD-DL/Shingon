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
