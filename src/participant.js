// src/participant.js
import { isResult } from './result.js';

export class Participant {
  constructor({ name, adapter, roles, capabilities = {} }) {
    if (!name) throw new Error('Participant requires a name');
    if (!adapter || typeof adapter.run !== 'function') throw new Error(`Participant ${name} needs an adapter with run()`);
    if (!Array.isArray(roles) || roles.length === 0) throw new Error(`Participant ${name} needs at least one role`);
    this.name = name;
    this.adapter = adapter;
    this.roles = roles;
    this.capabilities = { is_agentic: false, can_edit_files: false, ...capabilities };
  }

  canPlay(role) {
    return this.roles.includes(role);
  }

  async run(role, task, context = '') {
    if (!this.canPlay(role)) {
      throw new Error(`Participant ${this.name} is not eligible for role "${role}" (eligible: ${this.roles.join(', ')})`);
    }
    const result = await this.adapter.run(role, task, context);
    if (!isResult(result)) {
      throw new Error(`Adapter ${this.adapter.kind} for ${this.name} did not return a Result`);
    }
    return result;
  }
}
