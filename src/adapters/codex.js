// src/adapters/codex.js
import { runCommand } from '../exec.js';
import { normalize } from '../normalizer.js';
import { getRolePreset } from '../roles.js';
import { makeResult } from '../result.js';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export class CodexAdapter {
  constructor({ bin = 'codex', model = null, timeoutMs = 120000, extraConfig = [], sandbox = null } = {}) {
    this.kind = 'codex';
    this.bin = bin;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.extraConfig = extraConfig;
    this.sandbox = sandbox;
  }

  async run(role, task, context = '') {
    const preset = getRolePreset(role);
    // Codex has no system-prompt flag, so the role is prefixed into the prompt.
    const prompt =
      `${preset.systemPrompt}\n\n${preset.outputShape}\n\n---\nTask:\n${task}` +
      (context ? `\n\n---\nContext:\n${context}` : '');

    const outDir = mkdtempSync(path.join(tmpdir(), 'codex-out-'));
    const outFile = path.join(outDir, 'last-message.txt');

    const args = ['exec', prompt, '-o', outFile];
    if (this.model) args.push('-c', `model=${this.model}`);
    for (const kv of this.extraConfig) args.push('-c', kv);
    if (this.sandbox) args.push('--sandbox', this.sandbox);

    const { stdout, stderr, code, timedOut } = await runCommand({
      cmd: this.bin, args, timeoutMs: this.timeoutMs,
    });

    if (code !== 0 || timedOut) {
      return makeResult({ text: stdout, ok: false, error: timedOut ? 'timed out' : (stderr || `exit ${code}`) });
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
  }
}
