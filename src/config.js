// src/config.js
import { readFileSync } from 'node:fs';
import { ClaudeCodeAdapter } from './adapters/claudeCode.js';
import { CodexAdapter } from './adapters/codex.js';
import { LocalAgentAdapter } from './adapters/localAgent.js';
import { Participant } from './participant.js';

export function buildAdapter(spec) {
  const opts = { bin: spec.bin, model: spec.model };
  switch (spec.adapter) {
    case 'claude-code': return new ClaudeCodeAdapter(opts);
    case 'codex': return new CodexAdapter(opts);
    case 'local-agent': return new LocalAgentAdapter(opts); // throws if model missing
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
  const byName = new Map(participants.map((p) => [p.name, p]));
  return { participants, byName };
}
