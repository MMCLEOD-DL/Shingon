// src/adapters/localAgent.js
import { CodexAdapter } from './codex.js';

export class LocalAgentAdapter {
  constructor({ bin = 'codex', provider = 'localai', model, timeoutMs = 120000 } = {}) {
    if (!model) throw new Error('LocalAgentAdapter requires a model');
    this.kind = 'local-agent';
    this.bin = bin;
    this.provider = provider;
    this.model = model;
    this._codex = new CodexAdapter({
      bin,
      timeoutMs,
      extraConfig: [`model_provider=${provider}`, `model=${model}`],
      sandbox: 'workspace-write',
    });
  }

  run(role, task, context = '') {
    return this._codex.run(role, task, context);
  }
}
