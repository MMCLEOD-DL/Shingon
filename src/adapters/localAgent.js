// src/adapters/localAgent.js
import { CodexAdapter } from './codex.js';
import { addScrubEnv } from '../secrets.js';

// The local model's own shell commands never see credentials: do not rely on the Codex default.
export const SHELL_ENV_EXCLUDE = 'shell_environment_policy.exclude=["*KEY*","*TOKEN*","*SECRET*","*PASSWORD*","*CREDENTIAL*"]';

export class LocalAgentAdapter {
  constructor({ bin = 'codex', provider = 'localai', model, timeoutMs = 120000, extraConfig = [], envKey = 'LOCALAI_API_KEY' } = {}) {
    if (!model) throw new Error('LocalAgentAdapter requires a model');
    this.kind = 'local-agent';
    this.bin = bin;
    this.provider = provider;
    this.model = model;
    this.envKey = envKey;
    addScrubEnv(envKey); // every other child (frontier CLIs, tests, git) loses this key
    this._codex = new CodexAdapter({
      bin,
      timeoutMs,
      // The exclude goes last so no extraConfig entry can override it.
      extraConfig: [`model_provider=${provider}`, `model=${model}`, ...extraConfig, SHELL_ENV_EXCLUDE],
      // No fixed sandbox: write:true gives workspace-write, write:false read-only (Codex's default rule).
      envAllow: [envKey], // only the Codex harness itself gets the provider key
    });
  }

  run(role, task, context = '', opts = {}) {
    return this._codex.run(role, task, context, opts);
  }
}
