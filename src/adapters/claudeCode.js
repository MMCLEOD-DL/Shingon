// src/adapters/claudeCode.js
import { runCommand } from '../exec.js';
import { normalize } from '../normalizer.js';
import { getRolePreset } from '../roles.js';
import { makeResult } from '../result.js';

export class ClaudeCodeAdapter {
  constructor({ bin = 'claude', model = null, timeoutMs = 120000 } = {}) {
    this.kind = 'claude-code';
    this.bin = bin;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async run(role, task, context = '') {
    const preset = getRolePreset(role);
    const prompt = context ? `${task}\n\n---\nContext:\n${context}` : task;
    const system = `${preset.systemPrompt}\n\n${preset.outputShape}`;
    const args = ['-p', prompt, '--output-format', 'json', '--append-system-prompt', system];
    if (this.model) args.push('--model', this.model);

    const { stdout, stderr, code, timedOut } = await runCommand({
      cmd: this.bin, args, timeoutMs: this.timeoutMs,
    });

    if (code !== 0 || timedOut) {
      return makeResult({ text: stdout, ok: false, error: timedOut ? 'timed out' : (stderr || `exit ${code}`) });
    }

    let obj;
    try {
      obj = JSON.parse(stdout);
    } catch {
      return makeResult({ text: stdout, ok: false, error: 'could not parse claude JSON output' });
    }

    const norm = normalize(obj.result ?? '');
    return makeResult({
      text: norm.text,
      diff: norm.diff,
      verdict: norm.verdict,
      usage: { costUsd: obj.total_cost_usd ?? null, raw: { num_turns: obj.num_turns ?? null } },
      ok: obj.is_error !== true,
      error: obj.is_error === true ? (obj.result ?? 'claude reported is_error') : null,
    });
  }
}
