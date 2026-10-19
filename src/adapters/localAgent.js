// src/adapters/localAgent.js
import { CodexAdapter } from './codex.js';
import { addScrubEnv } from '../secrets.js';

// The local model's own shell commands never see credentials: do not rely on the Codex default.
export const SHELL_ENV_EXCLUDE = 'shell_environment_policy.exclude=["*KEY*","*TOKEN*","*SECRET*","*PASSWORD*","*CREDENTIAL*"]';

// LocalAI's default listen address; always written so the provider can never fall back to OpenAI.
export const DEFAULT_BASE_URL = 'http://localhost:8080/v1';

const PROVIDER_NAME = /^[A-Za-z0-9_-]+$/;
const tomlString = (s) => JSON.stringify(String(s)); // JSON escapes are valid TOML basic-string escapes

// The whole config.toml of the local agent's private CODEX_HOME: the operator's own ~/.codex
// (MCP servers, plugins, project trust, ChatGPT auth) never reaches the local model.
export function localCodexConfig({ provider, baseUrl, envKey, contextWindow = null }) {
  const lines = [];
  if (contextWindow != null) lines.push(`model_context_window = ${Number(contextWindow)}`);
  lines.push(
    '',
    `[model_providers.${provider}]`,
    `name = ${tomlString(provider)}`,
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"', // codex 0.163 dropped "chat" (spikes/localai-codex/RESULT.md)
    `env_key = ${tomlString(envKey)}`,
  );
  return lines.join('\n').trimStart() + '\n';
}

export class LocalAgentAdapter {
  constructor({ bin = 'codex', provider = 'localai', model, baseUrl = DEFAULT_BASE_URL, contextWindow = null, timeoutMs = 120000, extraConfig = [], envKey = 'LOCALAI_API_KEY' } = {}) {
    if (!model) throw new Error('LocalAgentAdapter requires a model');
    if (!PROVIDER_NAME.test(provider)) throw new Error(`LocalAgentAdapter: invalid provider name "${provider}"`);
    if (contextWindow != null && !(Number.isInteger(contextWindow) && contextWindow > 0)) {
      throw new Error('LocalAgentAdapter: contextWindow must be a positive integer');
    }
    this.kind = 'local-agent';
    this.bin = bin;
    this.provider = provider;
    this.model = model;
    this.baseUrl = baseUrl;
    this.contextWindow = contextWindow;
    this.envKey = envKey;
    addScrubEnv(envKey); // every other child (frontier CLIs, tests, git) loses this key
    this._codex = new CodexAdapter({
      bin,
      timeoutMs,
      // The exclude goes last so no extraConfig entry can override it.
      extraConfig: [`model_provider=${provider}`, `model=${model}`, ...extraConfig, SHELL_ENV_EXCLUDE],
      // No fixed sandbox: write:true gives workspace-write, write:false read-only (Codex's default rule).
      envAllow: [envKey], // only the Codex harness itself gets the provider key
      homeConfig: localCodexConfig({ provider, baseUrl, envKey, contextWindow }),
    });
  }

  run(role, task, context = '', opts = {}) {
    return this._codex.run(role, task, context, opts);
  }
}
