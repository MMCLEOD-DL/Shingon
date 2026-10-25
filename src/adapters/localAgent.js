// src/adapters/localAgent.js
import { CodexAdapter } from './codex.js';
import { addScrubEnv, redact } from '../secrets.js';
import { runCommand } from '../exec.js';

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

  // A real liveness check: LocalAI's /models answers even when its worker is down (F-A5),
  // so ask the model for one token. Free: it runs locally.
  async probe({ timeoutMs = 60000 } = {}) {
    const v = await runCommand({ cmd: this.bin, args: ['--version'], timeoutMs: 15000 });
    if (v.code !== 0 || v.timedOut) return { ok: false, reason: 'unavailable', detail: `${this.bin} is not installed or does not run` };
    const key = process.env[this.envKey];
    let res;
    let body = '';
    try {
      res = await fetch(`${String(this.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1 }),
        redirect: 'error', // never resend the key to wherever a redirect points
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await res.text();
    } catch (e) {
      const detail = e?.name === 'TimeoutError'
        ? 'the local model did not answer in time'
        : redact(`could not reach the local model server (${e?.cause?.code ?? e?.message ?? e})`);
      return { ok: false, reason: 'unavailable', detail };
    }
    if (res.ok) return { ok: true, reason: '' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized', detail: `the local model server refused the key (HTTP ${res.status})` };
    if (res.status === 404) return { ok: false, reason: 'model-missing', detail: `the local model server has no model named ${this.model}` };
    // LocalAI on CT110 is up but its GPU worker (the .109 desktop) is not connected (Ruling 7).
    if (res.status >= 500 && /no healthy nodes/i.test(body)) {
      return { ok: false, reason: 'worker-offline', detail: 'the local model server is running, but no GPU worker is connected to it' };
    }
    return { ok: false, reason: 'unavailable', detail: `the local model server answered HTTP ${res.status}` };
  }
}
