# Task 8: CLI wiring

This task puts the pieces together in `src/cli/main.js`, for `doctor`, a new run and `resume` alike. It **replaces** Task 5's interim stop.

1. Read the worker memory, choose the workers to check (`workersToCheck(…, { local: config.routing.local })`), and run `ensureWorkers`, printing its progress lines.
2. Call `buildTeam` with `cachedHealth(...)`, so the local model is not probed twice.
3. **`doctor`:** print worker lines (`workerLine`, with "last used" from memory) in place of the plain report line for each checked worker, plus a line for any checked worker `buildTeam` did not report. For each down worker, print its `downMessage`. Never ask the consent question (Ruling 5).
4. **Run/resume, `built.localDown` set:** ask `confirmLocalFallback` (passing the worker's wake `method`, so `[w]` is worded truthfully) in a loop.
   - `wait` runs `ensureWorkers` again for that worker (a fresh wake and wait, or just a re-check for `warn`), merges the fresh status in by name, rebuilds the team, and asks again if it is still down.
   - `frontier` adds `LOCAL_DOWN_WARNING` and continues.
   - `stop` prints `STOPPED_BEFORE_START` and exits 1. Nothing was spent.
5. Turn on the mid-run question (Task 7):
   - `options.confirmLocalFallback` is `true` unless `routing.localDown` is `"frontier"`, or the operator already said "go ahead" before the run;
   - `hooks.confirmLocalFallback` is always set (so a resumed run whose saved options have it on never trips the hook-required check);
   - with `localDown: "pause"`, the hook answers `{ reason: LOCAL_PAUSE_SETTING_REASON }` without asking, so the pause message does not claim the operator chose;
   - otherwise the hook asks the terminal with `midRun: true` and returns `true` **only** when the terminal answers `'frontier'`. The terminal returns a string, but the hook contract is "exactly `true` continues", so passing `term.confirmLocalFallback` straight through would pause on every "carry on".
6. Track which participants served successful calls, and remember them **once** however the run ends: after `runTask`/`resume` return, when they throw, and in the Ctrl-C handler before `exit()`. `rememberWorkers` is sync and never throws.

**Files:**
- Modify: `src/cli/main.js`
- Test: `test/cli-e2e.test.js` (extend `setup`, append tests)

**Interfaces:**
- Consumes:
  - Task 1: `memoryFileFor`, `readWorkerMemory`, `recallWorkers`, `rememberWorkers`, `createUsageTracker`;
  - Task 4: `workersToCheck`, `ensureWorkers`, `cachedHealth`, `progressText`, `downMessage`, `workerLine`;
  - Task 5: `buildTeam(...).localDown`, `LOCAL_DOWN_WARNING`;
  - Task 6: `term.confirmLocalFallback`;
  - Task 7: `options.confirmLocalFallback`, `hooks.confirmLocalFallback`, `LOCAL_PAUSE_SETTING_REASON`.
- Produces:
  - `STOPPED_BEFORE_START = 'Conductor did not start, so none of your subscription was used. Start the local model, then run the same command again (or run "conductor doctor" to check it).'` (exported from `src/cli/main.js`).
  - `main(argv, { …existing, wakeDeps = {} })`. `wakeDeps` is spread into every `ensureWorkers` call, so tests can inject `sleep`, `now` or `wake`.
  - The mid-run prompt message is `` `The local model stopped answering during step ${index + 1} (${title}): ${reason}` ``.
  - User-visible lines:
    - `Checking the local workers…`, printed before readiness, only when there are workers to check;
    - `progressText` lines;
    - `downMessage` before each consent question.

- [ ] **Step 1: Extend the e2e `setup` and write the failing tests**

In `test/cli-e2e.test.js`, change `setup()` to `setup({ local = { up: true }, wake = null, routing = null } = {})`:
- the server answers 200 `{"choices":[]}` when `local.up || (local.flag && existsSync(local.flag))`, else 500 `{"error":{"message":"no healthy nodes available"}}`;
- the `local` participant gets `...(wake ? { wake } : {})`;
- the config gets `...(routing ? { routing } : {})`;
- `setup` also returns `local`, the mutable object.

Existing callers pass nothing, so their behaviour is unchanged. Add `existsSync` and `readdirSync` to the `node:fs` import.

Add this helper:

```js
// Answers each prompt in order once its text is on screen: [[promptSubstring, reply, before?], ...]
function scripted(answers) {
  const stdin = new PassThrough();
  let text = '';
  const queue = [...answers];
  const stdout = new Writable({ write(c, e, cb) {
    text += c;
    const next = queue[0];
    if (next && String(c).includes(next[0])) { queue.shift(); next[2]?.(); setImmediate(() => stdin.write(`${next[1]}\n`)); }
    cb();
  } });
  return { stdin, stdout, text: () => text };
}
// The pre-run question; its [w] label depends on the wake method (Task 6), so match the [f] part.
const CONSENT = '[f] go ahead without it';
const GATE = '[a] approve → new branch';
const inProcess = (s, argv, io, extra = {}) => main([...argv, '--config', s.cfg, '--no-bell'], { cwd: s.repo, env: s.env, stdin: io.stdin, stdout: io.stdout, isTTY: true, onSignal: () => {}, exit: () => {}, ...extra });
```

Append the tests:

```js
import { STOPPED_BEFORE_START } from '../src/cli/main.js';
import { NO_TTY_LOCAL } from '../src/ui/terminal.js';
import { LOCAL_DOWN_WARNING } from '../src/team.js';

test('local down, no terminal: told plainly, nothing started, nothing spent (run-2 smoke finding)', async () => {
  const s = await setup({ local: { up: false }, wake: { hint: 'Turn on the desktop PC and start the LocalAI worker.' } });
  try {
    const before = await refsOf(s.repo);
    const r = await spawnBin(['add multiply', '--config', s.cfg], { cwd: s.repo, env: s.env });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /The local model "local" is not answering: its GPU worker is not connected\. Conductor has no way to wake it set up\. To fix it by hand: Turn on the desktop PC and start the LocalAI worker\./);
    assert.ok(r.out.includes(NO_TTY_LOCAL));
    assert.ok(r.out.includes(STOPPED_BEFORE_START));
    assert.deepEqual(await refsOf(s.repo), before);
    assert.deepEqual(readdirSync(s.baseDir).filter((n) => !n.startsWith('.')), [], 'no workspace: no agent was called');
  } finally { await s.close(); }
});

test('doctor wakes a worker with its start command and says so', async () => {
  const flag = path.join(tmp(), 'worker-up');
  const starter = writeStubCli(tmp(), 'start-worker', `require('fs').writeFileSync(${JSON.stringify(flag)}, 'up');`);
  const s = await setup({ local: { up: false, flag }, wake: { method: 'command', cmd: starter, waitMs: 10000, pollMs: 500 } });
  try {
    const d = await spawnBin(['doctor', '--config', s.cfg], { cwd: s.repo, env: s.env });
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /Waking local \(its start command\)…/);
    assert.match(d.out, /local is awake \(after \d+ s\)\./);
    assert.match(d.out, /✓ local \(local-agent\) — woke it with its start command/);
    assert.doesNotMatch(d.out, /\[w\]/, 'doctor never asks');
  } finally { await s.close(); }
});

test('local down, operator says go ahead: frontier does the step, the summary says so, memory records who served', async () => {
  const s = await setup({ local: { up: false } });
  try {
    const io = scripted([[CONSENT, 'f'], [GATE, 'a']]);
    const code = await inProcess(s, ['add multiply'], io);
    assert.equal(code, 0, io.text());
    assert.ok(io.text().includes(LOCAL_DOWN_WARNING));
    assert.equal((await git(s.repo, ['show', '--name-only', '--format=', 'conductor/add-multiply'])).stdout.trim(), 'claude-step.txt');
    const mem = JSON.parse(readFileSync(path.join(s.baseDir, '.workers.json'), 'utf8'));
    assert.deepEqual(Object.keys(mem.workers).sort(), ['claude', 'codex']);
  } finally { await s.close(); }
});

test('local down, operator wakes it again after starting it: the local model does the step', async () => {
  const s = await setup({ local: { up: false } });
  try {
    const io = scripted([[CONSENT, 'w', () => { s.local.up = true; }], [GATE, 'a']]);
    const code = await inProcess(s, ['add multiply'], io);
    assert.equal(code, 0, io.text());
    assert.doesNotMatch(io.text(), new RegExp(LOCAL_DOWN_WARNING.slice(0, 30)));
    assert.equal((await git(s.repo, ['show', '--name-only', '--format=', 'conductor/add-multiply'])).stdout.trim(), 'multiply.txt');
    const mem = JSON.parse(readFileSync(path.join(s.baseDir, '.workers.json'), 'utf8'));
    assert.equal(mem.workers.local.runs, 1);
  } finally { await s.close(); }
});

test('local dies mid-run, operator pauses, then resumes once it is back (Review Focus 5)', async () => {
  // The local agent's stream fails (infrastructure); a 1 ms cooldown and no wait make the Seat give up at once.
  const s = await setup({ routing: { cooldownMs: 1, maxWaitMs: 0 } });
  process.env.STUB_LOCAL_FAIL = '1';
  try {
    const io = scripted([['[p] pause', 'p']]);
    const code = await inProcess(s, ['add multiply'], io);
    assert.equal(code, 3, io.text());
    assert.match(io.text(), /The local model stopped answering during step 1 \(Add multiply\)/);
    assert.match(io.text(), /Conductor paused: the local model stopped answering, and you chose not to use your subscription for its steps/);
    delete process.env.STUB_LOCAL_FAIL;
    const io2 = scripted([[GATE, 'a']]);
    const code2 = await inProcess(s, ['resume'], io2);
    assert.equal(code2, 0, io2.text());
    assert.match(io2.text(), /Checking the local workers…/, 'resume checks the workers again');
    assert.equal((await git(s.repo, ['show', '--name-only', '--format=', 'conductor/add-multiply'])).stdout.trim(), 'multiply.txt');
  } finally { delete process.env.STUB_LOCAL_FAIL; await s.close(); }
});

test('local dies mid-run, operator says carry on: the frontier does the step and the summary says so', async () => {
  const s = await setup({ routing: { cooldownMs: 1, maxWaitMs: 0 } });
  process.env.STUB_LOCAL_FAIL = '1';
  try {
    const io = scripted([['[p] pause', 'f'], [GATE, 'a']]);
    const code = await inProcess(s, ['add multiply'], io);
    assert.equal(code, 0, io.text());
    assert.match(io.text(), /The local model stopped answering during step 1 \(Add multiply\)/);
    assert.ok(io.text().includes(LOCAL_DOWN_WARNING), 'the gate summary carries the warning');
    assert.equal((await git(s.repo, ['show', '--name-only', '--format=', 'conductor/add-multiply'])).stdout.trim(), 'claude-step.txt');
  } finally { delete process.env.STUB_LOCAL_FAIL; await s.close(); }
});

test('local dies mid-run with localDown "pause": paused without a question, and the reason says it was the setting', async () => {
  const s = await setup({ routing: { cooldownMs: 1, maxWaitMs: 0, localDown: 'pause' } });
  process.env.STUB_LOCAL_FAIL = '1';
  try {
    const io = scripted([]);
    const code = await inProcess(s, ['add multiply'], io);
    assert.equal(code, 3, io.text());
    assert.doesNotMatch(io.text(), /\[p\] pause/);
    assert.match(io.text(), /Conductor paused: the local model stopped answering, and your settings say to pause instead of using your subscription/);
  } finally { delete process.env.STUB_LOCAL_FAIL; await s.close(); }
});
```

In the `CODEX` stub, add a failing local mode as the first line of its `model_provider=localai` branch:

```js
    if (process.env.STUB_LOCAL_FAIL) { console.error('ERROR: stream disconnected before completion'); process.exit(1); }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/cli-e2e.test.js`
Expected: FAIL. `STOPPED_BEFORE_START` is not exported, `doctor` prints no wake lines, Task 5's interim stop prints no `downMessage`, and the mid-run hook is not wired.

- [ ] **Step 3: Implement in `src/cli/main.js`**

Change the imports at the top of `src/cli/main.js`:

```js
import { buildTeam, LOCAL_DOWN_WARNING } from '../team.js';
import { LOCAL_PAUSE_SETTING_REASON } from '../chunkPhase.js';
import { memoryFileFor, readWorkerMemory, recallWorkers, rememberWorkers, createUsageTracker } from '../workerMemory.js';
import { workersToCheck, ensureWorkers, cachedHealth, progressText, downMessage, workerLine } from '../readiness.js';
```

(the `buildTeam` line replaces the existing `import { buildTeam } from '../team.js';`; the others are new).

Under `INTERRUPTED`, add:

```js
export const STOPPED_BEFORE_START = 'Conductor did not start, so none of your subscription was used. Start the local model, then run the same command again (or run "conductor doctor" to check it).';
```

Replace `reportLines` with a version that prints a checked worker's readiness line instead of its plain report line:

```js
function reportLines(report, statuses = [], lastUsed = new Map()) {
  const statusOf = (name) => statuses.find((s) => s.name === name);
  const lines = report.map((x) => {
    const s = statusOf(x.name);
    if (s) return workerLine(s, lastUsed.get(x.name) ?? null);
    return `  ${x.ok ? '✓' : '✗'} ${x.name} (${x.kind})${x.ok ? (isSubscriptionKind(x.kind) ? SUBSCRIPTION_OK : '') : `: ${REASON_TEXT[x.reason] ?? x.reason}${x.detail ? ` (${x.detail})` : ''}`}`;
  });
  // A remembered worker buildTeam does not probe (for example a self-hosted reviewer) is still shown.
  for (const s of statuses) if (!report.some((x) => x.name === s.name)) lines.push(workerLine(s, lastUsed.get(s.name) ?? null));
  return lines;
}
```

Add `wakeDeps = {}` to `main`'s options:

```js
export async function main(argv, {
  cwd = process.cwd(), env = process.env, stdin = process.stdin, stdout = process.stdout,
  isTTY = Boolean(stdin.isTTY && stdout.isTTY),
  onSignal = (handler) => process.once('SIGINT', handler), exit = (code) => process.exit(code),
  wakeDeps = {},
} = {}) {
```

Then replace everything from `term.say('Checking which AI models are available…');` to the end of `main` (this removes Task 5's interim stop) with:

```js
  term.say('Checking which AI models are available…');
  // Factory spec §4.2: check (and wake) the workers before buildTeam, earlier runs' workers first.
  const memoryFile = memoryFileFor(baseDir);
  const recalled = recallWorkers(readWorkerMemory(memoryFile), config.participants);
  const lastUsed = new Map(recalled.map((x) => [x.participant.name, x.lastUsedAt]));
  const workers = workersToCheck(config.participants, recalled, { local: config.routing?.local ?? null });
  const check = (list) => ensureWorkers(list, {
    onProgress: (e) => { const t = progressText(e); if (t) term.say(t); },
    ...wakeDeps,
  });
  let statuses = [];
  // Checked workers answer from their readiness result; matched by name, so a re-checked one counts too.
  const build = () => buildTeam(config.participants, { routing: config.routing, env, health: cachedHealth(statuses, config.participants) });
  const couldNotCheck = (e) => {
    term.say(`Conductor could not check the AI models: ${redact(String(e?.message ?? e))}`);
    term.close();
    return EXIT.failed;
  };
  let built;
  try {
    if (workers.length) {
      term.say('Checking the local workers…');
      statuses = await check(workers);
    }
    built = await build();
  } catch (e) {
    return couldNotCheck(e);
  }
  const downNotes = () => { for (const s of statuses) if (!s.ok) term.say(`Note: ${downMessage(s)}`); };
  const notBuilt = () => {
    term.say(reportLines(built.report, statuses, lastUsed).join('\n'));
    downNotes();
    term.say(built.error);
    term.close();
    return EXIT.failed;
  };
  if (!built.ok) return notBuilt();
  if (cli.command === 'doctor') {
    // Ruling 5: doctor checks and wakes like a run, but never asks: it spends nothing.
    term.say(reportLines(built.report, statuses, lastUsed).join('\n'));
    term.say(`Author: ${built.team.author.name} · Reviewer: ${built.team.reviewer.name} · Local: ${built.team.local.name}`);
    for (const w of built.warnings) term.say(`Note: ${w}`);
    downNotes();
    term.close();
    return 0;
  }

  // The local model is down and routing.localDown is "ask": nothing is spent until the operator says so.
  let approvedFallback = false;
  while (built.localDown) {
    const { name } = built.localDown;
    const participant = config.byName.get(name);
    const status = statuses.find((s) => s.name === name) ?? {
      name, kind: participant?.adapter.kind ?? 'local-agent', local: true, ok: false,
      reason: built.localDown.reason, detail: built.localDown.detail, woke: 'not-configured', wakeDetail: '', waitedMs: 0,
      hint: participant?.wake?.hint, method: participant?.wake?.method ?? 'warn',
    };
    const choice = await term.confirmLocalFallback({ message: downMessage(status), method: status.method });
    if (choice === 'frontier') {
      approvedFallback = true;
      built.warnings.push(LOCAL_DOWN_WARNING);
      break;
    }
    if (choice !== 'wait' || !participant) {
      term.say(STOPPED_BEFORE_START);
      term.close();
      return EXIT.stopped;
    }
    try {
      term.say('Checking the local workers…');
      const [fresh] = await check([participant]);
      statuses = [...statuses.filter((s) => s.name !== name), fresh];
      built = await build();
    } catch (e) {
      return couldNotCheck(e);
    }
    if (!built.ok) return notBuilt();
  }
  for (const w of built.warnings) term.say(`Note: ${w}`);

  // Who served calls this run, remembered exactly once however the run ends (sync, never throws).
  const tracker = createUsageTracker(config.byName);
  let remembered = false;
  const remember = () => {
    if (remembered) return;
    remembered = true;
    rememberWorkers(memoryFile, tracker.used());
  };

  // Ctrl-C (Ruling 5): stop the agents, record it, leave the run resumable, exit 130.
  onSignal(() => {
    killAllChildren();
    remember();
    if (workspaceDir) {
      try { new RunLog(metaDirOf(workspaceDir)).event('interrupted', {}); } catch {}
    }
    term.say(`\n${INTERRUPTED}`);
    term.close();
    exit(EXIT.interrupted);
  });

  const localDownSetting = config.routing?.localDown ?? 'ask';
  const f = cli.flags;
  const overrides = {
    ...(f.testCommand ? { testCommand: f.testCommand } : {}),
    ...(f.approvePlan ? { approvePlan: true } : {}),
    ...(f.approveEachChunk ? { approveEachChunk: true } : {}),
    ...(f.watchDiffs ? { watchDiffs: true } : {}),
    ...(f.keepWorkspace ? { keepWorkspace: true } : {}),
    allowSameVendor: built.allowSameVendor,
    // Task 7: ask mid-run, unless covering is the operator's standing choice or he already agreed for this run.
    confirmLocalFallback: localDownSetting !== 'frontier' && !approvedFallback,
  };
  const hooks = {
    onEvent: (e) => { tracker.onEvent(e); if (e.type === 'start' && e.workspace) workspaceDir = e.workspace; term.onEvent(e); },
    escalate: term.escalate, approveResult: term.approveResult, approveChunk: term.approveChunk, approvePlan: term.approvePlan,
    // The hook contract is "exactly true continues"; the terminal answers 'frontier' | 'stop'.
    confirmLocalFallback: localDownSetting === 'pause'
      ? async () => ({ reason: LOCAL_PAUSE_SETTING_REASON })
      : async ({ index, title, reason }) => (await term.confirmLocalFallback({
        message: `The local model stopped answering during step ${index + 1} (${title}): ${reason}`,
        midRun: true,
      })) === 'frontier',
  };
  let out;
  try {
    out = cli.command === 'resume'
      ? await resume({ workspaceDir, repoDir, team: built.team, hooks, options: overrides, warnings: built.warnings })
      : await runTask({ repoDir, request: cli.request, team: built.team, hooks, options: { ...config.options, ...overrides }, baseDir, warnings: built.warnings });
  } catch (e) {
    remember();
    term.say(`Conductor could not start: ${redact(String(e?.message ?? e))}`);
    term.close();
    return EXIT.usage;
  }
  remember();
  term.say(`\n${outcomeText(out)}`);
  term.close();
  return EXIT[out.status] ?? EXIT.failed;
}
```

Notes on this code:
- Doctor with an unbuildable team (`!built.ok`) still prints the report, the down notes and the error, and exits 2, as `doctor` did before.
- `built.warnings` is printed after the consent loop, so an operator who says "go ahead" sees `LOCAL_DOWN_WARNING` once before the run and again in the gate summary.
- The memory file sits under `baseDir`, so the e2e tests (which set `CONDUCTOR_BASE_DIR`) never touch the operator's real memory.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS, including the existing `doctor` assertion `/✓ local \(local-agent\)\n/`, since a healthy worker with no memory prints exactly that.

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.js test/cli-e2e.test.js
git commit -m "feat: wake workers before a run and ask before the subscription covers for them"
```
