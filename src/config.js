// src/config.js
import { readFileSync } from 'node:fs';
import { ClaudeCodeAdapter } from './adapters/claudeCode.js';
import { CodexAdapter } from './adapters/codex.js';
import { LocalAgentAdapter } from './adapters/localAgent.js';
import { Participant } from './participant.js';
import { AnthropicApiAdapter, OpenAiApiAdapter } from './adapters/api.js';
import { DEFAULT_OPTIONS } from './options.js';
import { isApiKind } from './vendors.js';
import { normalizeWake } from './wake.js';

export function buildAdapter(spec) {
  const opts = { bin: spec.bin, model: spec.model, timeoutMs: spec.timeoutMs };
  switch (spec.adapter) {
    case 'claude-code': return new ClaudeCodeAdapter(opts);
    case 'codex': return new CodexAdapter({ ...opts, extraConfig: spec.extraConfig });
    case 'local-agent': return new LocalAgentAdapter({ // throws if model missing
      ...opts, provider: spec.provider, baseUrl: spec.baseUrl, contextWindow: spec.contextWindow,
      extraConfig: spec.extraConfig, envKey: spec.envKey,
    });
    case 'anthropic-api':
    case 'openai-api': {
      const Api = spec.adapter === 'anthropic-api' ? AnthropicApiAdapter : OpenAiApiAdapter;
      return new Api({ model: spec.model, timeoutMs: spec.timeoutMs, envKey: spec.envKey, baseUrl: spec.baseUrl, maxTokens: spec.maxTokens, prices: spec.prices });
    }
    default:
      throw new Error(`Participant ${spec.name}: unknown adapter "${spec.adapter}" (expected claude-code | codex | local-agent | anthropic-api | openai-api)`);
  }
}

export function loadConfig(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed.participants)) throw new Error('config must have a "participants" array');
  const options = parsed.options ?? {};
  for (const k of Object.keys(options)) {
    if (!Object.hasOwn(DEFAULT_OPTIONS, k)) throw new Error(`Unknown option "${k}" in config (known: ${Object.keys(DEFAULT_OPTIONS).join(', ')})`);
  }
  const routing = parsed.routing ?? {};
  for (const k of ['allowApi', 'preferTwoVendors']) {
    if (Object.hasOwn(routing, k) && typeof routing[k] !== 'boolean') {
      throw new Error(`routing.${k} must be true or false (without quotes), but the config has ${JSON.stringify(routing[k])}`);
    }
  }
  if (Object.hasOwn(routing, 'localDown') && !['ask', 'frontier', 'pause'].includes(routing.localDown)) {
    throw new Error(`routing.localDown must be "ask", "frontier" or "pause", but the config has ${JSON.stringify(routing.localDown)}`);
  }
  const participants = parsed.participants.map((spec) => {
    if (isApiKind(spec.adapter)) {
      if (spec.capabilities?.can_edit_files) throw new Error(`Participant ${spec.name}: API participants cannot edit files`);
      if (spec.roles?.includes('grunt')) throw new Error(`Participant ${spec.name}: API participants cannot be the local executor (grunt)`);
    }
    return new Participant({
      name: spec.name,
      adapter: buildAdapter(spec),
      roles: spec.roles,
      capabilities: spec.capabilities ?? {},
      wake: normalizeWake(spec.wake, spec.name),
    });
  });
  const byName = new Map();
  for (const p of participants) {
    if (byName.has(p.name)) throw new Error(`Duplicate participant name: ${p.name}`);
    byName.set(p.name, p);
  }
  return { participants, byName, routing, options };
}
