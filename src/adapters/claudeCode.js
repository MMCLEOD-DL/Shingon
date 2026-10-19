// src/adapters/claudeCode.js
import { runCommand } from '../exec.js';
import { normalize } from '../normalizer.js';
import { getRolePreset } from '../roles.js';
import { makeResult } from '../result.js';
import { summarizeFailure, isInfrastructureFailure } from '../health.js';
import { childEnv } from '../secrets.js';

export class ClaudeCodeAdapter {
  constructor({ bin = 'claude', model = null, timeoutMs = 120000 } = {}) {
    this.kind = 'claude-code';
    this.bin = bin;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async run(role, task, context = '', opts = {}) {
    const preset = getRolePreset(role);
    const prompt = context ? `${task}\n\n---\nContext:\n${context}` : task;
    const system = `${preset.systemPrompt}\n\n${preset.outputShape}`;
    const args = ['-p', prompt, '--output-format', 'json', '--append-system-prompt', system];
    if (this.model) args.push('--model', this.model);
    if (opts.write) args.push('--permission-mode', 'acceptEdits');

    const { stdout, stderr, code, timedOut } = await runCommand({
      cmd: this.bin, args, cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? this.timeoutMs, env: childEnv(),
    });

    if (code !== 0 || timedOut) {
      const reason = summarizeFailure(stderr);
      return makeResult({
        text: stdout, ok: false,
        error: timedOut ? 'timed out' : (reason || `exit ${code}`),
        failure: !timedOut && isInfrastructureFailure(reason) ? 'infrastructure' : null,
      });
    }

    let obj;
    try {
      obj = JSON.parse(stdout);
    } catch {
      return makeResult({ text: stdout, ok: false, error: 'could not parse claude JSON output' });
    }

    if (!obj || typeof obj !== 'object') {
      return makeResult({ text: stdout, ok: false, error: 'claude JSON output was not an object' });
    }

    const resultText = typeof obj.result === 'string' ? obj.result : '';
    const norm = normalize(resultText);
    return makeResult({
      text: norm.text,
      diff: norm.diff,
      verdict: norm.verdict,
      usage: { costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null, raw: { num_turns: obj.num_turns ?? null } },
      ok: obj.is_error !== true,
      error: obj.is_error === true ? (typeof obj.result === 'string' ? obj.result : 'claude reported is_error') : null,
    });
  }
}
