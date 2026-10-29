# Task 8: Status view model

Spec §8 calls for a live, plain-English status block that shows which model did what, whether each checkpoint passed, and the usage so far. It must never show raw model chatter.

This task builds that block as a **pure** model with no I/O:
- `apply(event)` folds the existing transcript events into state;
- `lines()` renders it.

The terminal in Task 9 only redraws what `lines()` returns, so all the wording is tested here.

**Files:**
- Create: `src/ui/status.js`, `test/status.test.js`

**Interfaces:**
- Consumes these event shapes, all of which already exist after Tasks 4–7:
  - `phase { name: 'plan' | 'final' }`;
  - `call { participant, role, write }`;
  - `result { participant, servedBy, role, ok, verdict, costUsd }`;
  - `plan-agreed { chunks, rounds, author, reviewer }`;
  - `chunk { index, title }`, `chunk-fallback { index, to }`, `chunk-done { index, by }`;
  - `route-failover { seat, from, reason }`, `route-wait { seat, ms }`, `api-in-use { participant }`;
  - `same-vendor-review`;
  - `finish { status }`.
- Also consumes `REASON_TEXT` (Task 4).
- Produces:
  - `new StatusModel()`, with `.apply(event)` (unknown types are ignored, and it never throws) and `.lines() -> string[]`.
  - `.seed({ chunks, done })`, which marks the plan agreed and the first `done` steps finished. It is used on `resume`, where no `plan-agreed` event is replayed.

**Rendering rules (exact):**
- **Line layout.** Every line starts with two spaces, then an icon (`✓` done, `⟳` running, `⏸` paused, `✗` failed, a space for queued), then a space.
  - Step lines: `Step i/n` padded to 10, a space, the title padded or truncated to 22 (truncation ends in `…`), a space, the detail.
  - Plan and final lines: the label padded to 33, so their detail lines up with the step details.
  - Trailing spaces are trimmed.
- **Plan line:**
  - while planning: `⟳ Planning … <participant> drafting the plan…` or `<participant> reviewing the plan…`;
  - once agreed: `✓ Plan agreed … <author> drafted · <reviewer> reviewed (<r> round[s])`;
  - after `seed`: `✓ Plan agreed … from the earlier run`.
- **Step detail:**
  - queued: `queued`;
  - running, while editing: `<editor> ✎ …`;
  - running, while reviewing: `<editor> ✎ · <reviewer> reviewing…`;
  - done: `<editor> ✎ · <reviewer> reviewed ✓`, with ` (took over)` after `✎` when a fallback did it;
  - done from `seed`: `done earlier`.
  - The editor and reviewer names are `servedBy` when known, else the participant name.
- **Final line** (only once `phase final` has been seen):
  - `⟳ Final check … <reviewer> checking the whole change…`;
  - after its result: `⟳ Final check … waiting for your approval`;
  - after `finish`: `✓ Final check … done`.
- **Usage line** (always last before the notices): `  frontier cost reported so far: ~$<x.xx> · local steps: <n>`. Here `<n>` counts the steps finished with no fallback.
- **Notices:** at most the last 3, each `  ` plus the text:
  - `route-failover`: `↪ <from> is <REASON_TEXT[reason]>; switching to the next model`;
  - `route-wait`: `⏸ every model for <seat> is rate-limited; waiting <s>s`;
  - `api-in-use`: `$ using the paid API (<participant>); this costs money`;
  - `same-vendor-review`: `! a step was checked by the same AI company that wrote it`, once only.

- [ ] **Step 1: Write the failing tests**

Create `test/status.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusModel } from '../src/ui/status.js';

const run = (events) => { const m = new StatusModel(); for (const e of events) m.apply(e); return m.lines(); };
const PLAN = [
  { type: 'phase', name: 'plan' },
  { type: 'call', participant: 'claude', role: 'author', write: false },
  { type: 'result', participant: 'claude', servedBy: 'claude', role: 'author', ok: true, costUsd: 0.1 },
  { type: 'call', participant: 'codex', role: 'reviewer', write: false },
  { type: 'result', participant: 'codex', servedBy: 'codex', role: 'reviewer', ok: true, verdict: { decision: 'APPROVE' }, costUsd: null },
  { type: 'plan-agreed', chunks: ['export util', 'UI button for the reports page'], rounds: 1, author: 'claude', reviewer: 'codex' },
];

test('planning, then the agreed plan with queued steps', () => {
  assert.deepEqual(run(PLAN.slice(0, 2)), [
    '  ⟳ Planning                          claude drafting the plan…',
    '  frontier cost reported so far: ~$0.00 · local steps: 0',
  ]);
  assert.deepEqual(run(PLAN), [
    '  ✓ Plan agreed                       claude drafted · codex reviewed (1 round)',
    '    Step 1/2   export util            queued',
    '    Step 2/2   UI button for the rep… queued',
    '  frontier cost reported so far: ~$0.10 · local steps: 0',
  ]);
});

test('a step: editing, reviewing, done by local', () => {
  const step = [
    ...PLAN,
    { type: 'chunk', index: 0, title: 'export util' },
    { type: 'call', participant: 'local', role: 'grunt', write: true },
  ];
  assert.equal(run(step)[1], '  ⟳ Step 1/2   export util            local ✎ …');
  step.push({ type: 'result', participant: 'local', servedBy: 'local', role: 'grunt', ok: true });
  step.push({ type: 'call', participant: 'codex', role: 'reviewer', write: false });
  assert.equal(run(step)[1], '  ⟳ Step 1/2   export util            local ✎ · codex reviewing…');
  step.push({ type: 'result', participant: 'codex', servedBy: 'codex', role: 'reviewer', ok: true, verdict: { decision: 'APPROVE' } });
  step.push({ type: 'chunk-done', index: 0, by: 'local' });
  const lines = run(step);
  assert.equal(lines[1], '  ✓ Step 1/2   export util            local ✎ · codex reviewed ✓');
  assert.equal(lines.at(-1), '  frontier cost reported so far: ~$0.10 · local steps: 1');
});

test('a fallback step says who took over and does not count as local', () => {
  const lines = run([
    ...PLAN,
    { type: 'chunk', index: 0, title: 'export util' },
    { type: 'call', participant: 'local', role: 'grunt', write: true },
    { type: 'result', participant: 'local', role: 'grunt', ok: false },
    { type: 'chunk-fallback', index: 0, to: 'claude' },
    { type: 'call', participant: 'claude', role: 'author', write: true },
    { type: 'result', participant: 'claude', servedBy: 'codex', role: 'author', ok: true, costUsd: 0.05 },
    { type: 'call', participant: 'codex', role: 'reviewer', write: false },
    { type: 'result', participant: 'codex', servedBy: 'codex', role: 'reviewer', ok: true, verdict: { decision: 'APPROVE' } },
    { type: 'chunk-done', index: 0, by: 'codex' },
  ]);
  assert.equal(lines[1], '  ✓ Step 1/2   export util            codex ✎ (took over) · codex reviewed ✓');
  assert.equal(lines.at(-1), '  frontier cost reported so far: ~$0.15 · local steps: 0');
});

test('the final check, waiting for approval, then done', () => {
  const ev = [...PLAN, { type: 'phase', name: 'final' }, { type: 'call', participant: 'codex', role: 'reviewer', write: false }];
  assert.equal(run(ev).at(-2), '  ⟳ Final check                       codex checking the whole change…');
  ev.push({ type: 'result', participant: 'codex', servedBy: 'codex', role: 'reviewer', ok: true, verdict: { decision: 'APPROVE' } });
  assert.equal(run(ev).at(-2), '  ⟳ Final check                       waiting for your approval');
  ev.push({ type: 'finish', status: 'landed' });
  assert.equal(run(ev).at(-2), '  ✓ Final check                       done');
});

test('routing notices: plain words, last three only, same-vendor once', () => {
  const lines = run([
    ...PLAN,
    { type: 'route-failover', seat: 'claude', from: 'claude', reason: 'unauthorized' },
    { type: 'same-vendor-review', phase: 'chunk', index: 0, vendor: 'openai' },
    { type: 'same-vendor-review', phase: 'chunk', index: 1, vendor: 'openai' },
    { type: 'route-wait', seat: 'codex', ms: 30400 },
    { type: 'api-in-use', seat: 'codex', participant: 'gpt-api' },
  ]);
  assert.deepEqual(lines.slice(-3), [
    '  ! a step was checked by the same AI company that wrote it',
    '  ⏸ every model for codex is rate-limited; waiting 30s',
    '  $ using the paid API (gpt-api); this costs money',
  ]);
  assert.ok(!lines.some((l) => l.includes('↪')), 'only the last three notices are shown');
  assert.equal(run([{ type: 'route-failover', seat: 's', from: 'claude', reason: 'unauthorized' }]).at(-1),
    '  ↪ claude is not signed in, or its key was refused; switching to the next model');
});

test('seed shows a resumed run; unknown or malformed events are ignored', () => {
  const m = new StatusModel();
  m.seed({ chunks: ['One', 'Two'], done: 1 });
  m.apply({ type: 'something-new' });
  m.apply(null);
  m.apply({ type: 'chunk', index: 99, title: 'ghost' });
  assert.deepEqual(m.lines().slice(0, 3), [
    '  ✓ Plan agreed                       from the earlier run',
    '  ✓ Step 1/2   One                    done earlier',
    '    Step 2/2   Two                    queued',
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, because `src/ui/status.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/ui/status.js`:

```js
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
        this.#notice(`⏸ every model for ${e.seat} is rate-limited; waiting ${Math.round((e.ms ?? 0) / 1000)}s`);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS. If a padding assertion is off by one, fix the **implementation** to match the exact rules above; do not change the expected strings.

- [ ] **Step 5: Commit**

```bash
git add src/ui/status.js test/status.test.js
git commit -m "feat: StatusModel — plain-English live status from run events"
```
