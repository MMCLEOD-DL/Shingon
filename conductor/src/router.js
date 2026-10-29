// src/router.js
// Spec §7 fallback ladder. A Seat is one team slot (author / reviewer / local) backed by an
// ordered list of candidates; it looks like a single Participant to the rest of Conductor.
import { makeResult } from './result.js';
import { classifyFailure } from './health.js';
import { isApiKind } from './vendors.js';

// Plain words for why a model is out (classifyFailure + health-probe reasons).
export const REASON_TEXT = Object.freeze({
  'rate-limit': 'rate-limited',
  unauthorized: 'not signed in, or its key was refused',
  'version-skew': 'its program is out of date',
  unavailable: 'not reachable',
  'model-missing': 'the model is not installed',
  'worker-offline': 'its GPU worker is not connected',
});
const plain = (reason) => REASON_TEXT[reason] ?? reason ?? 'not available';

// Shared by every Seat of a run: who is down (for the run) or cooling (until a time).
export class HealthBoard {
  #states = new Map();

  constructor({ now = Date.now } = {}) {
    this.now = now;
  }

  markDown(name, reason) {
    this.#states.set(name, { status: 'down', reason, until: null });
  }

  cool(name, reason, ms) {
    this.#states.set(name, { status: 'cooling', reason, until: this.now() + ms });
  }

  state(name) {
    const s = this.#states.get(name);
    if (!s) return { status: 'ok', reason: '', until: null };
    if (s.status === 'cooling' && s.until <= this.now()) {
      this.#states.delete(name);
      return { status: 'ok', reason: '', until: null };
    }
    return { ...s };
  }
}

const STAYS_DOWN = new Set(['unauthorized', 'version-skew']);

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Seat {
  constructor({ name, candidates, board = new HealthBoard(), cooldownMs = 60000, maxWaitMs = 300000, sleep = sleepMs }) {
    if (!name) throw new Error('Seat requires a name');
    if (!Array.isArray(candidates) || candidates.length === 0) throw new Error(`Seat ${name} needs at least one candidate`);
    this.name = name;
    this.candidates = candidates;
    this.board = board;
    // At least 1 ms: a zero cooldown would leave the candidate neither cooling nor retried.
    this.cooldownMs = Math.max(1, Number(cooldownMs) || 0);
    this.maxWaitMs = maxWaitMs;
    this.sleep = sleep;
    this.roles = [...new Set(candidates.flatMap((c) => c.roles))];
    this.capabilities = {
      is_agentic: candidates.some((c) => c.capabilities.is_agentic),
      can_edit_files: candidates.some((c) => c.capabilities.can_edit_files),
    };
    // The preferred candidate's kind: validateTeam's two-vendor check reads it.
    this.adapter = { kind: candidates[0].adapter.kind };
    this.emit = () => {};
    this.announced = new Set();
  }

  bind(emit) {
    this.emit = typeof emit === 'function' ? emit : () => {};
  }

  canPlay(role) {
    return this.candidates.some((c) => c.canPlay(role));
  }

  #eligible(c, role, opts) {
    return c.canPlay(role) && (!opts.write || c.capabilities.can_edit_files);
  }

  async run(role, task, context = '', opts = {}) {
    let waited = false;
    for (;;) {
      for (const c of this.candidates) {
        if (!this.#eligible(c, role, opts) || this.board.state(c.name).status !== 'ok') continue;
        if (isApiKind(c.adapter.kind) && !this.announced.has(c.name)) {
          this.announced.add(c.name); // before the call: it may cost money
          this.emit('api-in-use', { seat: this.name, participant: c.name });
        }
        let r;
        try {
          r = await c.run(role, task, context, opts);
        } catch (e) {
          r = makeResult({ ok: false, error: String(e?.message ?? e) });
        }
        r.servedBy = c.name;
        r.servedKind = c.adapter.kind;
        if (r.ok || r.failure !== 'infrastructure') return r;
        const reason = classifyFailure(r.error ?? '');
        // A refused sign-in or an out-of-date program will not fix itself during the run;
        // anything else (a rate limit, a dropped connection) may, so it only cools.
        if (STAYS_DOWN.has(reason)) this.board.markDown(c.name, reason);
        else this.board.cool(c.name, reason, this.cooldownMs);
        this.emit('route-failover', { seat: this.name, from: c.name, reason, error: r.error });
      }
      const eligible = this.candidates.filter((c) => this.#eligible(c, role, opts));
      const waits = eligible.map((c) => this.board.state(c.name)).filter((s) => s.status === 'cooling').map((s) => s.until - this.board.now());
      const ms = waits.length ? Math.max(0, Math.min(...waits)) : null;
      if (!waited && ms !== null && ms <= this.maxWaitMs) {
        waited = true;
        this.emit('route-wait', { seat: this.name, ms });
        await this.sleep(ms);
        continue;
      }
      return makeResult({ ok: false, failure: 'no-participant', error: this.#nothingLeft(eligible, role, opts) });
    }
  }

  #nothingLeft(eligible, role, opts) {
    if (!eligible.length) {
      return `no AI model is available for ${this.name} (none of its models can ${opts.write ? 'edit files' : `act as ${role}`})`;
    }
    const why = eligible.map((c) => `${c.name}: ${plain(this.board.state(c.name).reason)}`).join('; ');
    return `no AI model is available for ${this.name} (${why})`;
  }
}
