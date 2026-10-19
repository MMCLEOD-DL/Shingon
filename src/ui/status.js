// src/ui/status.js
// Spec §8 live status: a pure fold of transcript events into plain-English lines.
// No I/O here; the terminal (src/ui/terminal.js) only redraws what lines() returns.
import { REASON_TEXT } from '../router.js';

const ICON = { done: '✓', running: '⟳', paused: '⏸', failed: '✗', queued: ' ' };
const LABEL = 10;
const TITLE = 22;
const DETAIL_COL = LABEL + 1 + TITLE; // plan/final labels pad to this so details line up
const MAX_NOTICES = 3;

const pad = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n);
};
const line = (icon, label, detail) => `  ${icon} ${label} ${detail}`.trimEnd();

export class StatusModel {
  constructor() {
    this.plan = { status: 'drafting', activity: '', author: null, reviewer: null, rounds: 0, earlier: false };
    this.chunks = [];
    this.current = null;
    this.final = null;
    this.costUsd = 0;
    this.localSteps = 0;
    this.notices = [];
    this.sawSameVendor = false;
  }

  seed({ chunks = [], done = 0 } = {}) {
    this.plan = { ...this.plan, status: 'agreed', earlier: true };
    this.chunks = chunks.map((title, i) => ({ title, status: i < done ? 'done' : 'queued', earlier: i < done }));
  }

  apply(e) {
    if (!e || typeof e.type !== 'string') return;
    const who = e.servedBy ?? e.participant;
    const c = this.current == null ? null : this.chunks[this.current];
    switch (e.type) {
      case 'phase':
        if (e.name === 'final') this.final = { status: 'reviewing', reviewer: null };
        break;
      case 'call':
        if (this.final) {
          this.final.reviewer = e.participant;
        } else if (c) {
          const reviewing = e.role === 'reviewer';
          c.activity = reviewing ? 'reviewing' : 'editing';
          c[reviewing ? 'reviewer' : 'editor'] = e.participant;
        } else if (this.plan.status !== 'agreed') {
          this.plan.activity = `${e.participant} ${e.role === 'reviewer' ? 'reviewing' : 'drafting'} the plan…`;
        }
        break;
      case 'result':
        if (typeof e.costUsd === 'number' && Number.isFinite(e.costUsd)) this.costUsd += e.costUsd;
        if (this.final) {
          if (e.role === 'reviewer') { this.final.reviewer = who; this.final.status = 'gate'; }
        } else if (c && e.ok) {
          c[e.role === 'reviewer' ? 'reviewer' : 'editor'] = who;
        }
        break;
      case 'plan-agreed':
        this.plan = { ...this.plan, status: 'agreed', author: e.author, reviewer: e.reviewer, rounds: e.rounds };
        this.chunks = (e.chunks ?? []).map((title) => ({ title, status: 'queued' }));
        break;
      case 'chunk':
        if (!this.chunks[e.index]) break;
        this.current = e.index;
        Object.assign(this.chunks[e.index], { status: 'running', activity: 'editing' });
        break;
      case 'chunk-fallback':
        if (this.chunks[e.index]) this.chunks[e.index].fallback = e.to;
        break;
      case 'chunk-done': {
        const d = this.chunks[e.index];
        if (!d) break;
        d.status = 'done';
        if (e.by) d.editor = e.by;
        if (!d.fallback) this.localSteps += 1;
        this.current = null;
        break;
      }
      case 'route-failover':
        this.#notice(`↪ ${e.from} is ${REASON_TEXT[e.reason] ?? e.reason}; switching to the next model`);
        break;
      case 'route-wait':
        this.#notice(`⏸ every model for ${e.seat} is rate-limited or unreachable; waiting ${Math.round((e.ms ?? 0) / 1000)}s`);
        break;
      case 'api-in-use':
        this.#notice(`$ using the paid API (${e.participant}); this costs money`);
        break;
      case 'same-vendor-review':
        if (!this.sawSameVendor) this.#notice('! a step was checked by the same AI company that wrote it');
        this.sawSameVendor = true;
        break;
      case 'finish':
        if (this.final) this.final.status = 'done';
        break;
      default:
        break;
    }
  }

  #notice(text) {
    this.notices.push(text);
  }

  lines() {
    const out = [];
    const p = this.plan;
    if (p.status === 'agreed') {
      const detail = p.earlier ? 'from the earlier run' : `${p.author} drafted · ${p.reviewer} reviewed (${p.rounds} round${p.rounds === 1 ? '' : 's'})`;
      out.push(line(ICON.done, pad('Plan agreed', DETAIL_COL), detail));
    } else {
      out.push(line(ICON.running, pad('Planning', DETAIL_COL), p.activity));
    }
    const n = this.chunks.length;
    this.chunks.forEach((c, i) => {
      out.push(line(ICON[c.status] ?? ' ', `${pad(`Step ${i + 1}/${n}`, LABEL)} ${pad(c.title, TITLE)}`, this.#detail(c)));
    });
    if (this.final) {
      const f = this.final;
      const detail = f.status === 'done' ? 'done' : f.status === 'gate' ? 'waiting for your approval' : `${f.reviewer ?? 'the reviewer'} checking the whole change…`;
      out.push(line(f.status === 'done' ? ICON.done : ICON.running, pad('Final check', DETAIL_COL), detail));
    }
    out.push(`  frontier cost reported so far: ~$${this.costUsd.toFixed(2)} · local steps: ${this.localSteps}`);
    for (const t of this.notices.slice(-MAX_NOTICES)) out.push(`  ${t}`);
    return out;
  }

  #detail(c) {
    if (c.status === 'queued') return 'queued';
    if (c.status === 'done') {
      if (c.earlier) return 'done earlier';
      return `${c.editor ?? '?'} ✎${c.fallback ? ' (took over)' : ''} · ${c.reviewer ?? '?'} reviewed ✓`;
    }
    if (c.activity === 'reviewing') return `${c.editor ?? '?'} ✎ · ${c.reviewer ?? '?'} reviewing…`;
    return `${c.editor ?? '?'} ✎ …`;
  }
}
