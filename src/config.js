// src/config.js
import { readFileSync } from 'node:fs';
import { ClaudeCodeAdapter } from './adapters/claudeCode.js';
import { CodexAdapter } from './adapters/codex.js';
import { LocalAgentAdapter } from './adapters/localAgent.js';
import { Participant } from './participant.js';

export function buildAdapter(spec) {
  const opts = { bin: spec.bin, model: spec.model, timeoutMs: spec.timeoutMs };
  switch (spec.adapter) {
    case 'claude-code': return new ClaudeCodeAdapter(opts);
    case 'codex': return new CodexAdapter({ ...opts, extraConfig: spec.extraConfig });
    case 'local-agent': return new LocalAgentAdapter({ // throws if model missing
      ...opts, provider: spec.provider, baseUrl: spec.baseUrl, contextWindow: spec.contextWindow,
      extraConfig: spec.extraConfig, envKey: spec.envKey,
    });
    default:
      throw new Error(`Participant ${spec.name}: unknown adapter "${spec.adapter}" (expected claude-code | codex | local-agent)`);
  }
}

export function loadConfig(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed.participants)) throw new Error('config must have a "participants" array');
  const participants = parsed.participants.map((spec) =>
    new Participant({
      name: spec.name,
      adapter: buildAdapter(spec),
      roles: spec.roles,
      capabilities: spec.capabilities ?? {},
    }));
  const byName = new Map();
  for (const p of participants) {
    if (byName.has(p.name)) throw new Error(`Duplicate participant name: ${p.name}`);
    byName.set(p.name, p);
  }
  return { participants, byName };
}
