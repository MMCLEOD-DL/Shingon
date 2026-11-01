// src/adapters/codex.js
import { runCommand } from '../exec.js';
import { normalize } from '../normalizer.js';
import { getRolePreset } from '../roles.js';
import { makeResult } from '../result.js';
import { summarizeFailure, isInfrastructureFailure, isContextOverflow } from '../health.js';
import { childEnv } from '../secrets.js';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { openPrivateCodexHome } from './privateCodexHome.js';
import { codexSearchEnv } from './codexSearchEnv.js';

// Private homes live outside the temp dir: Codex refuses to install its helper shims under /tmp,
// and the workspace-write sandbox lets the model write anywhere in /tmp.
export function codexHomeBase(env = process.env) {
  return path.join(env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'conductor', 'codex-homes');
}

export function frontierCodexConfig(platform = process.platform) {
  // A subscription participant must sign in separately in this generated home.
  // Personal MCP/plugins/trust/auth are neither read nor copied by Conductor.
  return 'forced_login_method = "chatgpt"\n' +
    (platform === 'win32' ? '\n[windows]\nsandbox = "elevated"\n' : '');
}

export class CodexAdapter {
  constructor({ bin = 'codex', model = null, timeoutMs = 120000, extraConfig = [], sandbox = null, envAllow = [], homeConfig, reuseHome } = {}) {
    if (homeConfig !== undefined && typeof homeConfig !== 'string') throw new Error('Codex requires a generated private config');
    this.kind = 'codex';
    this.bin = bin;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.extraConfig = extraConfig;
    this.sandbox = sandbox;
    this.envAllow = envAllow; // SCRUB_ENV keys this CLI itself needs (the local provider key)
    this.homeConfig = homeConfig ?? frontierCodexConfig();
    this.reuseHome = reuseHome ?? (homeConfig === undefined);
    // Keep the existing local-agent identity. Frontier auth survives model/role/
    // CLI override changes; a different executable gets a separate account home.
    this.homeIdentity = homeConfig === undefined ? ['frontier', this.bin] : [this.bin, this.extraConfig];
  }

  openHome({ cwd } = {}) {
    return openPrivateCodexHome({
      base: codexHomeBase(), config: this.homeConfig,
      identity: this.homeIdentity, reuse: this.reuseHome, cwd,
    });
  }

  // Offline preparation only: never launch Codex or inspect authentication state.
  async prepareHome(opts = {}) {
    if (!this.reuseHome) throw new Error('Sign-in preparation requires a retained private Codex home');
    const lease = await this.openHome(opts);
    try { return lease.home; }
    finally { await lease.close(); }
  }

  async run(role, task, context = '', opts = {}) {
    const preset = getRolePreset(role);
    // Codex has no system-prompt flag, so the role is prefixed into the prompt.
    const prompt =
      `${preset.systemPrompt}\n\n${preset.outputShape}\n\n---\nTask:\n${task}` +
      (context ? `\n\n---\nContext:\n${context}` : '');

    const outDir = mkdtempSync(path.join(tmpdir(), 'codex-out-'));
    let privateHome = null;
    try {
      const outFile = path.join(outDir, 'last-message.txt');
      const sandbox = opts.write ? 'workspace-write' : (this.sandbox ?? 'read-only');

      const args = ['exec', prompt, '-o', outFile];
      if (this.model) args.push('-c', `model=${this.model}`);
      for (const kv of this.extraConfig) args.push('-c', kv);
      args.push('--sandbox', sandbox);

      const env = codexSearchEnv(this.bin, childEnv({ allow: this.envAllow }));
      privateHome = await this.openHome({ cwd: opts.cwd });
      if (process.platform === 'win32') {
        for (const key of Object.keys(env)) if (key.toUpperCase() === 'CODEX_HOME') delete env[key];
      }
      env.CODEX_HOME = privateHome.home;

      const { stdout, stderr, code, timedOut } = await runCommand({
        cmd: this.bin, args, cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? this.timeoutMs, env,
      });

      if (code !== 0 || timedOut) {
        // Classify only Codex's own ERROR: lines, never raw stderr: it echoes the prompt there
        // (a task may mention "401"), and its last line may be the model's command output.
        const reason = summarizeFailure(stderr);
        const own = /^error:/i.test(reason);
        let failure = null;
        if (timedOut) failure = 'timeout';
        else if (own && isContextOverflow(reason)) failure = 'context-overflow';
        else if (own && isInfrastructureFailure(reason)) failure = 'infrastructure';
        return makeResult({ text: stdout, ok: false, error: timedOut ? 'timed out' : (reason || `exit ${code}`), failure });
      }
      if (!existsSync(outFile)) {
        return makeResult({ text: stdout, ok: false, error: 'codex produced no output file' });
      }

      const norm = normalize(readFileSync(outFile, 'utf8'));
      return makeResult({
        text: norm.text,
        diff: norm.diff,
        verdict: norm.verdict,
        usage: { costUsd: null, raw: null },
        ok: true,
      });
    } finally {
      try { rmSync(outDir, { recursive: true, force: true }); }
      finally { if (privateHome) await privateHome.close(); }
    }
  }
}
