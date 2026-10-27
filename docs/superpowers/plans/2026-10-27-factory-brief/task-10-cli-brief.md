# Task 10: CLI — the brief command

This task wires `conductor brief` end to end:
- refusals come first, and the command fails closed without a TTY;
- the frontier-only author seat is built **before** anything is imported, so a failure leaves nothing behind;
- the notes are imported, the loop runs on the real terminal, and Ctrl-C is handled.

The end-to-end test runs the real `ClaudeCodeAdapter` against a stub `claude`, with a recording 127.0.0.1 "local model" that must never be contacted.

**Files:**
- Create: `src/factory/briefTeam.js`
- Modify: `src/cli/factory.js` (replace the Task 9 placeholder), `test/helpers/factoryCli.js` (append)
- Test: `test/factory-brief-team.test.js` (create), `test/factory-cli.test.js` (append)

**Interfaces:**
- Consumes:
  - `runBriefSession`, `assertFrontierSeat` (Task 7);
  - `importNotes`, `newSession`, `loadSession`, `saveSession`, `discardSession`, `acquireBriefLock` (Task 6);
  - `currentBriefInfo`, `briefPaths`, `ukDate` (Task 4);
  - `readProject` (Task 1);
  - `askBriefQuestion`, `approveBrief`, `confirmDiscard` (Task 8);
  - `loadConfig`, `findConfig`, `checkHealth`, `HealthBoard`, `Seat`, `REASON_TEXT`, `API_KEY_BILLING_WARNING`, `isSubscriptionKind`, `isApiKind`, `killAllChildren`, `RunLog`, `redact`.
- Produces:
  - `briefAuthorSeat(participants, { routing, env, health, board })`;
  - `NO_TTY_BRIEF_START`;
  - `factoryDeps` keys: `buildAuthor(config, env) -> Promise<{ ok, seat, warnings } | { ok: false, error }>`, `isAlive(pid)` and `now()`. All are optional; the defaults are the real ones.

- [ ] **Step 1: Write the failing seat tests** in `test/factory-brief-team.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefAuthorSeat } from '../src/factory/briefTeam.js';
import { API_KEY_BILLING_WARNING } from '../src/team.js';
import { fakeParticipant } from './helpers/fakes.js';

const p = (name, kind, roles = ['author', 'reviewer']) => fakeParticipant({ name, kind, roles, script: () => ({ text: 'x' }) });
const TEAM = () => [p('claude', 'claude-code'), p('codex', 'codex'), p('local', 'local-agent', ['grunt']), p('oops', 'local-agent', ['author']), p('api', 'anthropic-api')];
const healthOf = (down = {}) => { const probed = []; const fn = async (adapter) => { probed.push(adapter.kind); return down[adapter.kind] ? { ok: false, reason: down[adapter.kind] } : { ok: true, reason: '' }; }; fn.probed = probed; return fn; };
const names = (seat) => seat.candidates.map((c) => c.name);

test('the author seat is frontier only: subscriptions, API only when allowed, never local', async () => {
  const health = healthOf();
  const r = await briefAuthorSeat(TEAM(), { health, env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.seat.name, 'claude');
  assert.deepEqual(names(r.seat), ['claude', 'codex']);
  assert.equal(health.probed.includes('local-agent'), false, 'the local model is not even checked');
  assert.deepEqual(names((await briefAuthorSeat(TEAM(), { health: healthOf(), env: {}, routing: { allowApi: true } })).seat), ['claude', 'codex', 'api']);
  assert.equal((await briefAuthorSeat(TEAM(), { health: healthOf(), env: {}, routing: { allowApi: 'true' } })).seat.candidates.some((c) => c.name === 'api'), false, 'only a real true allows paid API');
});

test('preference, fallback and plain failure', async () => {
  assert.equal((await briefAuthorSeat(TEAM(), { health: healthOf(), env: {}, routing: { author: 'codex' } })).seat.name, 'codex');
  assert.equal((await briefAuthorSeat(TEAM(), { health: healthOf({ 'claude-code': 'rate-limit' }), env: {} })).seat.name, 'codex');
  const none = await briefAuthorSeat(TEAM(), { health: healthOf({ 'claude-code': 'rate-limit', codex: 'unauthorized' }), env: {} });
  assert.deepEqual(none, { ok: false, error: 'No AI subscription can write the brief (claude: rate-limited; codex: not signed in, or its key was refused). Sign in to Claude Code or Codex, then run the same command again. Nothing was sent to any AI model.' });
  const warn = await briefAuthorSeat(TEAM(), { health: healthOf(), env: { ANTHROPIC_API_KEY: 'sk-test-0000000000000000' } });
  assert.deepEqual(warn.warnings, [API_KEY_BILLING_WARNING]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/factory-brief-team.test.js`
Expected: FAIL with `Cannot find module '…/briefTeam.js'`.

- [ ] **Step 3: Implement `src/factory/briefTeam.js`**

`briefAuthorSeat(participants, { routing = {}, env = process.env, health = checkHealth, board = new HealthBoard() } = {})`:
- `subs` are the participants with a subscription kind that can play `author`;
- `apis` are the participants with an API kind that can play `author`, but only when `routing.allowApi === true`;
- every `local-agent` is excluded, whatever its roles;
- probe `subs` and `apis` only, in parallel, with `{ timeoutMs: 15000 }`. A throw counts as `{ ok: false, reason: 'unavailable' }`. Mark the down ones on `board`;
- the author is `routing.author` if it is healthy, else the first healthy sub, else the first healthy api;
- with none healthy, return `{ ok: false, error }` with the exact text in the test, built from `REASON_TEXT`;
- otherwise `seat = new Seat({ name: author.name, candidates: [...new Set([author, ...subs, ...apis])], board, cooldownMs: routing.cooldownMs ?? 60000, maxWaitMs: routing.maxWaitMs ?? 300000 })`;
- call `assertFrontierSeat(seat)` as a belt-and-braces check;
- warnings: `API_KEY_BILLING_WARNING` when `env.ANTHROPIC_API_KEY` is set and a healthy `claude-code` sub exists.

- [ ] **Step 4: Write the failing CLI tests**

Append to `test/helpers/factoryCli.js`:

```js
import http from 'node:http';
import { writeFileSync as wf } from 'node:fs';
import { writeStubCli } from './stubCli.js';

// Answers each prompt once it is on screen (a chunk ending "> " or "(one line): "); with none left, ends input.
// out.text() is everything shown, so runMain can return it.
export function interactive(answers, { onPrompt = () => {} } = {}) {
  const stdin = new PassThrough();
  const queue = [...answers];
  let text = '';
  const out = new Writable({ write(c, e, cb) { const s = c.toString(); text += s;
    if (s.endsWith('> ') || s.endsWith('(one line): ')) { onPrompt(text); setImmediate(() => (queue.length ? stdin.write(`${queue.shift()}\n`) : stdin.end())); }
    cb(); } });
  out.text = () => text;
  return { stdin, out, text: () => text };
}

// A config whose author is a stub `claude` (first reply: a draft with a question; once answers are in: the final
// brief) and whose local model is a 127.0.0.1 server that records every request body. Codex must never be called.
export async function briefWorld({ first, second }) {
  const bodies = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { bodies.push(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[]}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const bins = tmp();
  const promptLog = path.join(bins, 'prompts.log');
  const fence = (o) => 'Draft.\n```json\n' + JSON.stringify(o) + '\n```';
  const claude = writeStubCli(bins, 'claude', `
    const fs = require('fs');
    if (args[0] === '--version') { console.log('2.1.0 (Claude Code)'); process.exit(0); }
    const prompt = args[args.indexOf('-p') + 1] || '';
    fs.appendFileSync(${JSON.stringify(promptLog)}, prompt + '\\n=====\\n');
    const result = prompt.includes('The operator has answered') ? ${JSON.stringify(fence(second))} : ${JSON.stringify(fence(first))};
    process.stdout.write(JSON.stringify({ result, is_error: false, total_cost_usd: 0.02 }));`);
  const codex = writeStubCli(bins, 'codex', `if (args[0] === '--version') { console.log('codex-cli 0.163.0'); process.exit(0); } console.error('ERROR: codex should not be called'); process.exit(1);`);
  const cfg = path.join(tmp(), 'conductor.json');
  wf(cfg, JSON.stringify({ participants: [
    { name: 'claude', adapter: 'claude-code', bin: claude, roles: ['author', 'reviewer'], capabilities: { is_agentic: true, can_edit_files: true } },
    { name: 'codex', adapter: 'codex', bin: codex, roles: ['author', 'reviewer'], capabilities: { is_agentic: true, can_edit_files: true } },
    { name: 'local', adapter: 'local-agent', bin: codex, model: 'm', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, roles: ['grunt'], capabilities: { is_agentic: true, can_edit_files: true } },
  ], routing: { author: 'claude' }, factory: { operatorName: 'Malcolm' } }));
  return { cfg, bodies, promptLog, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}
```

(Inside the stub body, the `${...}` interpolations are evaluated by the test when it writes the stub, so the stub holds literal paths and replies.)

Append to `test/factory-cli.test.js`:

```js
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { interactive, briefWorld } from './helpers/factoryCli.js';
import { loadBrief, briefPaths } from '../src/factory/brief.js';
import { loadSession } from '../src/factory/briefSession.js';
import { NO_TTY_BRIEF_START } from '../src/cli/factory.js';
import { validBrief } from './helpers/briefFixtures.js';

const MARKER = 'MARKER-NOTES-5150';
const Q = { id: 'q1', question: 'Where should backups go?', why: 'Never only on the same box' };
const FIRST = validBrief({ policy: { ...validBrief().policy, backupDestination: null }, openQuestions: [Q] });

async function briefSetup() {
  const w = await briefWorld({ first: FIRST, second: validBrief() });
  const root = path.join(tmp(), 'projects');
  const env = envFor(root);
  await runMain(['project', 'new', 'Thistle Joinery Ltd', '--slug', 'thistle', '--config', w.cfg], { env });
  const notes = path.join(tmp(), 'meeting.md');
  writeFileSync(notes, `Met Jo. ${MARKER}. 45 staff.`);
  const dir = path.join(root, 'thistle');
  // go(args, answers, { deps, main, onPrompt }) runs `conductor brief thistle …` on a scripted terminal.
  const go = (args, answers, { deps, main, onPrompt } = {}) => {
    const t = interactive(answers, { onPrompt });
    return runMain(['brief', 'thistle', ...args, '--config', w.cfg, '--no-bell'], { env, isTTY: true, stdin: t.stdin, stdout: t.out, deps, main });
  };
  return { w, env, notes, dir, go };
}

test('no terminal: nothing is read, imported or sent', async () => {
  const s = await briefSetup();
  try {
    const r = await runMain(['brief', 'thistle', '--notes', s.notes, '--config', s.w.cfg], { env: s.env, isTTY: false });
    assert.equal(r.code, 1);
    assert.ok(r.out.includes(NO_TTY_BRIEF_START));
    assert.match(NO_TTY_BRIEF_START, /Nothing was read or sent to any AI model/);
    assert.deepEqual(readdirSync(path.join(s.dir, 'notes')), []);
    assert.equal(existsSync(briefPaths(s.dir).session), false);
    assert.equal(existsSync(s.w.promptLog), false);
  } finally { await s.w.close(); }
});

test('the whole sitting: one question, approve; notes go only to the author; the local model is never contacted', async () => {
  const s = await briefSetup();
  try {
    const r = await s.go(['--notes', s.notes], ['A USB disk in their safe', 'a']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Your meeting notes go only to the frontier models \(Claude or Codex\), never to the local model\./);
    assert.match(r.out, /Question 1 of 1: Where should backups go\?/);
    assert.match(r.out, /=== The brief, ready for your approval ===\n# Brief: Thistle Joinery Ltd/);
    assert.match(r.out, /Approved\. Brief version 1 for Thistle Joinery Ltd is saved:\n {2}.*brief-v1\.md \(to read\)\n {2}.*brief-v1\.json \(what the factory builds from\)/);
    assert.match(r.out, /Frontier cost reported by the AI tools this sitting: \$0\.04/);
    assert.equal(loadBrief(s.dir).approvedBy, 'Malcolm');
    assert.ok(readFileSync(s.w.promptLog, 'utf8').includes(MARKER), 'the author got the notes');
    assert.deepEqual(s.w.bodies, [], 'the local model was never contacted');
    assert.equal(existsSync(briefPaths(s.dir).lock), false);
    const [copy] = readdirSync(path.join(s.dir, 'notes'));
    assert.equal(readFileSync(path.join(s.dir, 'notes', copy), 'utf8'), `Met Jo. ${MARKER}. 45 staff.`);
  } finally { await s.w.close(); }
});

test('stop, refusals, resume, approved-already and revise-without-brief', async () => {
  const s = await briefSetup();
  try {
    const none = await s.go([], []);
    assert.equal(none.code, 1);
    assert.match(none.out, /There is no unfinished brief for thistle\. To start one, run: conductor brief thistle --notes <file>/);
    const rev = await s.go(['--revise', '--notes', s.notes], []);
    assert.equal(rev.code, 1);
    assert.match(rev.out, /thistle has no approved brief to revise yet\. Run: conductor brief thistle --notes <file>/);

    const stop = await s.go(['--notes', s.notes], ['stop']);
    assert.equal(stop.code, 1);
    assert.match(stop.out, /Stopped\. Your answers so far are saved\. To carry on, run: conductor brief thistle/);
    assert.equal(loadSession(s.dir, 'thistle').stage, 'questions');
    const again = await s.go(['--notes', s.notes], []);
    assert.equal(again.code, 1);
    assert.match(again.out, /There is an unfinished brief for thistle \(started \d{1,2} [A-Z][a-z]+ \d{4}\)\. Run conductor brief thistle to carry on with it, or conductor brief thistle --discard-draft to start again\./);

    const resumed = await s.go([], ['USB disk', 'a']);
    assert.equal(resumed.code, 0, resumed.out);
    assert.match(resumed.out, /Carrying on with the unfinished brief for thistle\./);
    const twice = await s.go(['--notes', s.notes], []);
    assert.equal(twice.code, 1);
    assert.match(twice.out, /thistle already has an approved brief \(version 1, approved \d{1,2} [A-Z][a-z]+ \d{4}\)\. To change it, run: conductor brief thistle --revise --notes <file>/);
  } finally { await s.w.close(); }
});

test('the lock, discarding, an unavailable author leaves nothing behind, Ctrl-C', async () => {
  const s = await briefSetup();
  try {
    await s.go(['--notes', s.notes], ['stop']);
    writeFileSync(briefPaths(s.dir).lock, JSON.stringify({ pid: 424242, at: 'x' }));
    const locked = await s.go([], [], { deps: { isAlive: () => true } });
    assert.equal(locked.code, 1);
    assert.match(locked.out, /Another conductor brief is already running for this project \(process 424242\)/);
    const kept = await s.go(['--discard-draft'], ['n'], { deps: { isAlive: () => false } });
    assert.equal(kept.code, 1);
    assert.match(kept.out, /Nothing was thrown away\./);
    assert.ok(loadSession(s.dir, 'thistle'));
    const gone = await s.go(['--discard-draft'], ['y']);
    assert.equal(gone.code, 0);
    assert.match(gone.out, /The unfinished brief for thistle was thrown away\. Your notes are kept in .*notes/);
    assert.equal(loadSession(s.dir, 'thistle'), null);
    assert.equal((await s.go(['--discard-draft'], [])).code, 1);

    const down = await s.go(['--notes', s.notes], [], { deps: { buildAuthor: async () => ({ ok: false, error: 'No AI subscription can write the brief (claude: rate-limited). Sign in to Claude Code or Codex, then run the same command again. Nothing was sent to any AI model.' }) } });
    assert.equal(down.code, 2);
    assert.match(down.out, /No AI subscription can write the brief/);
    assert.equal(readdirSync(path.join(s.dir, 'notes')).length, 1, 'only the first sitting\'s copy: nothing new imported');
    assert.equal(existsSync(briefPaths(s.dir).session), false);
    assert.equal(existsSync(briefPaths(s.dir).lock), false);

    let handler = null; let exitCode = null;
    const c = await s.go(['--notes', s.notes], [], {
      onPrompt: () => { const h = handler; handler = null; h?.(); },
      main: { onSignal: (h) => { handler = h; }, exit: (code) => { exitCode = code; } },
    });
    assert.equal(exitCode, 130, c.out);
    assert.match(c.out, /Stopped\. Your answers so far are saved\. To carry on, run: conductor brief thistle/);
    assert.equal(loadSession(s.dir, 'thistle').stage, 'questions');
    assert.equal(existsSync(briefPaths(s.dir).lock), false);
  } finally { await s.w.close(); }
});
```

- [ ] **Step 5: Run them to verify they fail**

Run: `node --test test/factory-cli.test.js`
Expected: FAIL with `conductor brief is not ready yet.`

- [ ] **Step 6: Implement the `brief` command in `src/cli/factory.js`**

`NO_TTY_BRIEF_START = 'conductor brief needs a terminal: it asks you questions and needs your approval. Nothing was read or sent to any AI model. Run it in a terminal.'`

Order of operations (each refusal prints its message from the tests and returns 1 unless noted):

1. Settings and slug, as in Task 9. `readProject`, with its error printed, returns 1.
2. `!isTTY` → print `NO_TTY_BRIEF_START` and return 1. This happens before any file or model work.
3. Acquire the lock with `acquireBriefLock(dir, { isAlive: deps.isAlive })`. A refusal returns 1. Release it in a `finally` on every path, including the SIGINT handler.
4. `session = loadSession(dir, slug)`. A corrupt session prints its message and returns 1.
5. `--discard-draft`:
   - no session → `There is no unfinished brief for ${slug}.`, return 1;
   - otherwise `term.confirmDiscard({ slug })`. `true` → `discardSession` and the "thrown away" message, return 0. `false` → `Nothing was thrown away.`, return 1.
6. Session state and the notes flags:
   - session and `--notes` → the "unfinished brief … (started ${ukDate})" refusal;
   - session and no notes → say `Carrying on with the unfinished brief for ${slug}.`;
   - no session and no notes → the "no unfinished brief" refusal;
   - no session and notes → `info = currentBriefInfo(dir)`:
     - `info?.broken` → print it and return 1;
     - `info` and not `--revise` → the "already has an approved brief" refusal;
     - `--revise` and no `info` → the "no approved brief to revise" refusal.
7. Load the participants config:
   - `loadConfig(configPath)`. With no config, print the `findConfig` message;
   - errors print `Conductor could not read its config: …` and return `EXIT.usage`;
   - `built = await (deps.buildAuthor ?? ((c, e) => briefAuthorSeat(c.participants, { routing: c.routing, env: e })))(config, env)`;
   - `!built.ok` → print `built.error` and return `EXIT.failed` (2). Nothing has been imported yet;
   - print each warning as `Note: …`;
   - say `Your meeting notes go only to the frontier models (Claude or Codex), never to the local model.`
8. When there was no session:
   - `importNotes(dir, path.resolve(cwd, notes))`. A plain error prints and returns 1;
   - `session = newSession({ slug, mode: revise ? 'revise' : 'new', baseVersion: revise ? info.version : null, notes: [imported.name] })`;
   - `saveSession`.
9. Run the loop:
   - `cwdDir = mkdtempSync(path.join(tmpdir(), 'conductor-brief-'))`, removed in `finally`;
   - `log = new RunLog(briefPaths(dir).logs)`;
   - `term = createTerminal({ input: stdin, output: stdout, isTTY, bell: cli.flags.bell })`. Create it once at the top, after the TTY check, so step 5 can use it;
   - `out = await runBriefSession({ projectDir: dir, session, author: built.seat, io: { say: term.say, ask: term.askBriefQuestion, approve: term.approveBrief }, log, operatorName: settings.operatorName, cwd: cwdDir, now: deps.now })`;
   - a thrown error (for example `assertFrontierSeat`) prints `Conductor could not write the brief: ${redact(message)}` and returns `EXIT.failed`.
10. Outcome:
    - `approved` → `Approved. Brief version ${v} for ${client} is saved:` with the two indented path lines, return 0;
    - `stopped` → the reason, return 1;
    - `failed` → the reason, return 2;
    - `paused` → the reason, return 3.

    Then, when `out.costUsd > 0`, print `Frontier cost reported by the AI tools this sitting: $${out.costUsd.toFixed(2)}`. Always `term.close()`.

Ctrl-C: register `onSignal` once, after the TTY check. The handler:
1. `killAllChildren()`;
2. releases the lock;
3. says `\nStopped. Your answers so far are saved. To carry on, run: conductor brief ${slug}` once a session exists, else `\nStopped before anything started. Nothing was sent to any AI model.`;
4. `term.close()`, then `exit(EXIT.interrupted)`.

Every save already happened before the prompt that was interrupted, so nothing more needs writing.

- [ ] **Step 7: Run all tests**

Run: `node --test test/factory-brief-team.test.js test/factory-cli.test.js && npm test`
Expected: all PASS. The suite never reaches the network beyond 127.0.0.1, and the local stub's `bodies` stays empty.

- [ ] **Step 8: Commit**

```bash
git add src/factory/briefTeam.js src/cli/factory.js test/factory-brief-team.test.js test/factory-cli.test.js test/helpers/factoryCli.js
git commit -m "feat(cli): conductor brief: frontier-only author, fails closed, resumable, Ctrl-C safe"
```
