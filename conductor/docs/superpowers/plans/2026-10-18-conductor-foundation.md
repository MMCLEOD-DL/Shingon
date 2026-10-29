# Conductor — Plan 1: Foundation & Local-Agent Spike

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the substrate every later plan stands on — a uniform `Participant` wrapper that can drive the user's local coding agent, Claude Code, and Codex in a given role and return one normalized `Result` — and first prove (build-spike #1) that the local model can execute an agentic coding chunk through the Codex CLI.

**Architecture:** A small dependency-free Node.js (ESM) library. Each model is reached through an *adapter* that shells out to its CLI (`claude -p --output-format json`, `codex exec -o <file>`, and the same `codex` pointed at LocalAI). Adapter output is passed through a *Normalizer* so the rest of the system never trusts raw model formatting, and is returned as a structured `Result`. A `Participant` binds an adapter to a name, capabilities, and role-eligibility. A `conductor-probe` CLI exercises one participant end-to-end. No orchestration loop, no git workspace, and no routing yet — those are Plans 2 and 3.

**Tech Stack:** Node.js ≥ 20 (developed on v22), ES modules, **zero runtime dependencies** (only Node built-ins: `node:child_process`, `node:fs`, `node:path`, `node:test`, `node:assert`). Tests use the built-in test runner (`node --test`). External CLIs driven: `claude` (Claude Code) and `codex` (Codex CLI, also the local-agent harness).

**Spec:** `docs/superpowers/specs/2026-10-18-conductor-mvp-design.md`

## Global Constraints

- **Runtime:** Node.js ≥ 20. `package.json` sets `"type": "module"` and `"engines": { "node": ">=20" }`.
- **Dependencies:** zero runtime npm dependencies. Only Node built-ins. No test framework beyond `node --test`. (Matches the operator's "no test framework / minimal tooling" preference and keeps a downloadable program from breaking on transitive deps.)
- **Subscription-first:** this plan drives only the subscription CLIs (`claude`, `codex`). No direct Anthropic/OpenAI API calls are made here; the `ApiAdapter` fallback is deferred to Plan 3 (routing), where the fallback ladder lives.
- **Secrets:** never print, log, or write to disk any API key, OAuth token, or credential value. Adapters pass the CLIs' own ambient auth through `env`; they never read or echo token files. Transcripts/log output must not include `env`.
- **Local-agent sandbox:** the local agent always runs Codex in `workspace-write` sandbox mode. It is never given a wider sandbox in this plan.
- **Normalizer is authoritative:** no component downstream of an adapter may parse raw model stdout itself; it consumes only the `Result` the Normalizer produced.
- **Roles are a closed set:** `"author"`, `"reviewer"`, `"grunt"`. Any other role string is an error.

## Review Focus

Spec-implied inputs/failures that no single task's happy-path test would otherwise exercise — each is pinned to a test in the owning task:

- **Malformed / fenced model output** (prose around a ```` ```diff ````, missing or lower-case verdict, markdown fences wrapping the whole reply): the Normalizer must still return clean `text`, the right `diff`, and a correct `verdict` — never crash. → Task 5.
- **Subprocess hangs** (a CLI that never exits): the shared exec runner must kill it and return `timedOut: true`, never hang the process. → Task 4.
- **CLI exits non-zero / version-skew** (e.g. stderr `unknown variant 'max'`, or a `401`): the adapter must return `ok: false` with the stderr captured as `error`, not throw. → Tasks 7, 8.
- **Malformed JSON from `claude -p`** (truncated or non-JSON stdout): `ClaudeCodeAdapter` must return `ok: false` with the raw stdout preserved in `text`, not throw on `JSON.parse`. → Task 7.
- **Config asks for an impossible role** (participant not eligible for the requested role, or config names an unknown adapter kind): a clear thrown error naming the participant/role, not silent undefined behavior. → Tasks 10, 12.

---

## File Structure

```
conductor/
├── package.json                      # Task 2 — ESM, engines, test script
├── config.example.json               # Task 12 — example participants config
├── spikes/localai-codex/
│   ├── run-spike.sh                  # Task 1 — kept smoke test for the local agent
│   └── RESULT.md                     # Task 1 — recorded PASS/FAIL + notes
├── src/
│   ├── result.js                     # Task 3 — Result shape + makeResult/isResult
│   ├── exec.js                       # Task 4 — runCommand() subprocess runner
│   ├── normalizer.js                 # Task 5 — normalize() fences/diff/verdict
│   ├── roles.js                      # Task 6 — getRolePreset()
│   ├── adapters/
│   │   ├── claudeCode.js             # Task 7 — ClaudeCodeAdapter
│   │   ├── codex.js                  # Task 8 — CodexAdapter
│   │   └── localAgent.js             # Task 9 — LocalAgentAdapter
│   ├── participant.js                # Task 10 — Participant
│   ├── health.js                     # Task 11 — checkHealth()
│   └── config.js                     # Task 12 — loadConfig()
├── bin/
│   └── conductor-probe.js            # Task 13 — probe CLI
└── test/
    ├── helpers/stubCli.js            # Task 7 — writes fake-CLI stub scripts
    ├── result.test.js                # Task 3
    ├── exec.test.js                  # Task 4
    ├── normalizer.test.js            # Task 5
    ├── roles.test.js                 # Task 6
    ├── claudeCode.test.js            # Task 7
    ├── codex.test.js                 # Task 8
    ├── localAgent.test.js            # Task 9
    ├── participant.test.js           # Task 10
    ├── health.test.js                # Task 11
    ├── config.test.js                # Task 12
    └── probe.test.js                 # Task 13
```

Each `src/*` file has one responsibility and a small, named interface; adapters share `exec.js` and `normalizer.js` so formatting/subprocess logic lives in exactly one place.

---

### Task 1: Build-spike #1 — Codex-on-LocalAI agentic execution

**This task gates the rest of the plan.** The spec names it "do first": the whole local-grunt thesis depends on the local model following Codex's tool-call / `apply_patch` protocol well enough to edit a file and produce a diff. If it fails, the fallback (serve the model via ollama/lmstudio) is tried before anything else is built. This is a spike: its deliverable is a recorded answer plus a kept smoke script, not production code.

**Precondition:** the desktop GPU worker (.109) must be up and node-approved so LocalAI can actually generate (per the Shingon notes). Confirm with the operator before running. The local model name below is the one proven in the MVP inference test: `shingon-qwen3.8-27b-q4` (adjust if the operator's config differs).

**Files:**
- Create: `spikes/localai-codex/run-spike.sh`
- Create: `spikes/localai-codex/RESULT.md`
- Modify (on the host, not in-repo): `~/.codex/config.toml` — add a `localai` model provider.

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a validated `~/.codex/config.toml` `[model_providers.localai]` block and the confirmed invocation `codex exec -c model_provider=localai -c model=<model> --sandbox workspace-write "<prompt>"` that later adapters (Task 9) rely on.

- [ ] **Step 1: Add the LocalAI provider to `~/.codex/config.toml`**

Append (do not overwrite existing providers). `base_url` points at the operator's LocalAI `/v1`; `wire_api = "chat"` because LocalAI speaks the OpenAI chat API:

```toml
[model_providers.localai]
name = "LocalAI (Shingon)"
base_url = "http://192.168.1.110:8081/v1"
wire_api = "chat"
# LocalAI auth: Codex sends the key from this env var as a Bearer token.
env_key = "LOCALAI_API_KEY"
```

The key is supplied via the `LOCALAI_API_KEY` environment variable at run time — it is **not** written into the file. (Do not print the key.)

- [ ] **Step 2: Write the kept smoke script**

`spikes/localai-codex/run-spike.sh` — creates a throwaway git repo in the scratchpad, asks the local agent to create one file, and checks that a file and a non-empty diff resulted:

```bash
#!/usr/bin/env bash
# Build-spike #1: can the local model execute an agentic chunk through Codex?
# Requires: desktop worker up; LOCALAI_API_KEY set in the environment.
set -u
MODEL="${LOCALAI_MODEL:-shingon-qwen3.8-27b-q4}"
WORK="$(mktemp -d)"
cd "$WORK" || exit 2
git init -q && git config user.email spike@local && git config user.name spike
git commit -q --allow-empty -m init

echo "== running codex against localai (model=$MODEL) in $WORK =="
codex exec \
  -c model_provider=localai \
  -c "model=$MODEL" \
  --sandbox workspace-write \
  --skip-git-repo-check \
  "Create a file named hello.txt whose only contents are the word: online. Then stop." \
  2>codex.err
rc=$?

echo "== result =="
echo "codex exit: $rc"
if [ -f hello.txt ]; then echo "FILE_CREATED: yes"; echo "contents: $(cat hello.txt)"; else echo "FILE_CREATED: no"; fi
echo "diff lines: $(git status --porcelain | wc -l)"
echo "stderr tail:"; tail -5 codex.err
echo "workdir kept at: $WORK"
```

- [ ] **Step 3: Run the spike (operator confirms worker is up first)**

Run: `LOCALAI_API_KEY=... bash spikes/localai-codex/run-spike.sh` (the operator runs this so the key stays off the command log).
Expected (PASS): `FILE_CREATED: yes`, `contents: online`, `diff lines: 1`, codex exit 0.
Possible (FAIL): the model ignores the tool protocol, loops, or errors — `FILE_CREATED: no`.

- [ ] **Step 4: If FAIL, try the ollama/lmstudio fallback once**

Per spec risk #1, re-serve the same model via ollama or LM Studio and re-run with Codex's native OSS path (`codex exec --oss --local-provider lmstudio -c model=<model> ...`). Record which serving path works.

- [ ] **Step 5: Record the result**

Write `spikes/localai-codex/RESULT.md`: date, model, serving path (LocalAI vs ollama/lmstudio), PASS/FAIL, the exact working invocation, and any protocol quirks observed. **If both paths FAIL, stop and surface to the operator** — the local-grunt design assumption is broken and the plan must be revisited before continuing. If PASS, note the working `-c` flags; Task 9 copies them verbatim.

- [ ] **Step 6: Commit**

```bash
git add spikes/localai-codex/run-spike.sh spikes/localai-codex/RESULT.md
git commit -m "spike: validate Codex-on-LocalAI agentic execution (build-spike #1)"
```

---

### Task 2: Project scaffold

**Files:**
- Create: `package.json`
- Create: `test/.gitkeep` (so the empty test dir exists until Task 3)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` → runs `node --test` over `test/`; `npm start` → runs the probe (wired in Task 13).

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "conductor",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "description": "Coordinate local and frontier models with adversarial cross-review.",
  "engines": { "node": ">=20" },
  "bin": { "conductor-probe": "bin/conductor-probe.js" },
  "scripts": {
    "test": "node --test",
    "start": "node bin/conductor-probe.js"
  }
}
```

- [ ] **Step 2: Create the empty test dir marker**

```bash
mkdir -p test && touch test/.gitkeep
```

- [ ] **Step 3: Verify the test runner starts with no tests**

Run: `npm test`
Expected: exit 0, reporting `tests 0` (no test files yet — a clean baseline).

- [ ] **Step 4: Commit**

```bash
git add package.json test/.gitkeep
git commit -m "chore: node ESM scaffold with built-in test runner"
```

---

### Task 3: Result type

**Files:**
- Create: `src/result.js`
- Test: `test/result.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `makeResult(partial) -> Result` where `Result = { text: string, diff: string|null, verdict: Verdict|null, usage: { costUsd: number|null, raw: object|null }, ok: boolean, error: string|null }` and `Verdict = { decision: "APPROVE"|"BLOCK", reason: string }`.
  - `isResult(x) -> boolean`.
  Every adapter returns a value built by `makeResult`.

- [ ] **Step 1: Write the failing test**

```js
// test/result.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeResult, isResult } from '../src/result.js';

test('makeResult fills defaults', () => {
  const r = makeResult({ text: 'hi' });
  assert.equal(r.text, 'hi');
  assert.equal(r.diff, null);
  assert.equal(r.verdict, null);
  assert.deepEqual(r.usage, { costUsd: null, raw: null });
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.ok(isResult(r));
});

test('makeResult passes through supplied fields', () => {
  const r = makeResult({ text: 't', ok: false, error: 'boom', usage: { costUsd: 0.5, raw: { a: 1 } } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'boom');
  assert.equal(r.usage.costUsd, 0.5);
});

test('isResult rejects non-results', () => {
  assert.equal(isResult({ text: 'x' }), false);
  assert.equal(isResult(null), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/result.test.js`
Expected: FAIL — cannot find module `../src/result.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/result.js
const BRAND = Symbol.for('conductor.Result');

export function makeResult(partial = {}) {
  const usage = partial.usage ?? {};
  return {
    [BRAND]: true,
    text: partial.text ?? '',
    diff: partial.diff ?? null,
    verdict: partial.verdict ?? null,
    usage: { costUsd: usage.costUsd ?? null, raw: usage.raw ?? null },
    ok: partial.ok ?? true,
    error: partial.error ?? null,
  };
}

export function isResult(x) {
  return !!x && typeof x === 'object' && x[BRAND] === true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/result.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/result.js test/result.test.js
git commit -m "feat: Result type with makeResult/isResult"
```

---

### Task 4: Shared subprocess runner

**Files:**
- Create: `src/exec.js`
- Test: `test/exec.test.js`

**Interfaces:**
- Consumes: nothing (Node built-ins only).
- Produces: `runCommand({ cmd, args=[], cwd, input=null, timeoutMs=120000, env=process.env }) -> Promise<{ stdout: string, stderr: string, code: number, timedOut: boolean }>`. Never rejects; a spawn error is reported as `code: -1` with the message in `stderr`. All adapters call this; nothing else spawns processes.

- [ ] **Step 1: Write the failing test** (covers success, non-zero exit, stdin, and the Review-Focus timeout case)

```js
// test/exec.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../src/exec.js';

const node = process.execPath;

test('captures stdout and zero exit', async () => {
  const r = await runCommand({ cmd: node, args: ['-e', 'process.stdout.write("hello")'] });
  assert.equal(r.stdout, 'hello');
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
});

test('captures stderr and non-zero exit', async () => {
  const r = await runCommand({ cmd: node, args: ['-e', 'process.stderr.write("bad");process.exit(3)'] });
  assert.match(r.stderr, /bad/);
  assert.equal(r.code, 3);
});

test('feeds stdin', async () => {
  const r = await runCommand({
    cmd: node,
    args: ['-e', 'process.stdin.on("data",d=>process.stdout.write(d))'],
    input: 'piped',
  });
  assert.equal(r.stdout, 'piped');
});

test('kills a hanging process and reports timedOut', async () => {
  const r = await runCommand({
    cmd: node,
    args: ['-e', 'setInterval(()=>{},1000)'],
    timeoutMs: 150,
  });
  assert.equal(r.timedOut, true);
});

test('does not reject on a missing binary', async () => {
  const r = await runCommand({ cmd: '/nonexistent/binary/xyz', args: [] });
  assert.equal(r.code, -1);
  assert.match(r.stderr, /ENOENT|spawn/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/exec.test.js`
Expected: FAIL — cannot find module `../src/exec.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/exec.js
import { spawn } from 'node:child_process';

export function runCommand({ cmd, args = [], cwd, input = null, timeoutMs = 120000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env });
    } catch (err) {
      resolve({ stdout, stderr: String(err?.message ?? err), code: -1, timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err?.message ?? err), code: -1, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1, timedOut });
    });

    if (input != null) {
      child.stdin.on('error', () => {});
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/exec.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exec.js test/exec.test.js
git commit -m "feat: runCommand subprocess runner with timeout and error safety"
```

---

### Task 5: Normalizer

**Files:**
- Create: `src/normalizer.js`
- Test: `test/normalizer.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalize(rawText) -> { text: string, diff: string|null, verdict: Verdict|null }`.
  - `text`: the reply with any single outer ```` ``` ```` fence that wraps the *entire* reply removed; otherwise unchanged (trimmed).
  - `diff`: the contents of the first ```` ```diff ```` fenced block, else `null`.
  - `verdict`: parsed from the first line matching `VERDICT: APPROVE` / `VERDICT: BLOCK - <reason>` (case-insensitive, `-`/`—`/`:` separators), else `null`.

- [ ] **Step 1: Write the failing test** (includes the Review-Focus messy-format cases)

```js
// test/normalizer.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalizer.js';

test('plain text passes through trimmed', () => {
  const r = normalize('  looks good  ');
  assert.equal(r.text, 'looks good');
  assert.equal(r.diff, null);
  assert.equal(r.verdict, null);
});

test('strips a single outer code fence wrapping the whole reply', () => {
  const r = normalize('```\nhello world\n```');
  assert.equal(r.text, 'hello world');
});

test('extracts a fenced diff block', () => {
  const raw = 'Here is the change:\n```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n```\nDone.';
  const r = normalize(raw);
  assert.match(r.diff, /\+new/);
  assert.match(r.diff, /^--- a\/x/);
});

test('parses APPROVE verdict', () => {
  const r = normalize('All tests pass.\nVERDICT: APPROVE');
  assert.deepEqual(r.verdict, { decision: 'APPROVE', reason: '' });
});

test('parses BLOCK verdict with reason and various separators/case', () => {
  const r = normalize('verdict: block — the migration drops a column');
  assert.equal(r.verdict.decision, 'BLOCK');
  assert.match(r.verdict.reason, /drops a column/);
});

test('messy reply: prose + fenced diff + verdict all recovered', () => {
  const raw = '```\nI made the change.\n```diff\n--- a/f\n+++ b/f\n@@\n+x\n```\nVERDICT: BLOCK: needs a test\n```';
  const r = normalize(raw);
  assert.match(r.diff, /\+x/);
  assert.equal(r.verdict.decision, 'BLOCK');
  assert.match(r.verdict.reason, /needs a test/);
});

test('never throws on empty or null-ish input', () => {
  assert.doesNotThrow(() => normalize(''));
  assert.doesNotThrow(() => normalize(undefined));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/normalizer.test.js`
Expected: FAIL — cannot find module `../src/normalizer.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/normalizer.js

// First ```diff ... ``` fenced block.
const DIFF_FENCE = /```diff\s*\n([\s\S]*?)```/i;
// VERDICT: APPROVE | BLOCK  (optional separator + reason), case-insensitive, one line.
const VERDICT_LINE = /^\s*VERDICT\s*:\s*(APPROVE|BLOCK)\s*(?:[-—:]\s*)?(.*)$/im;

function stripOuterFence(s) {
  // Remove a fence that opens at the very start and closes at the very end.
  const m = s.match(/^```[^\n]*\n([\s\S]*)\n```$/);
  return m ? m[1] : s;
}

export function normalize(rawText) {
  const raw = typeof rawText === 'string' ? rawText : '';

  const diffMatch = raw.match(DIFF_FENCE);
  const diff = diffMatch ? diffMatch[1].replace(/\s+$/, '') : null;

  const vMatch = raw.match(VERDICT_LINE);
  const verdict = vMatch
    ? { decision: vMatch[1].toUpperCase(), reason: vMatch[2].trim() }
    : null;

  // text is prose only: the extracted diff block and verdict line are control
  // data, so remove them from the human-readable text.
  let body = raw;
  if (diffMatch) body = body.replace(diffMatch[0], '');
  if (vMatch) body = body.replace(vMatch[0], '');
  const text = stripOuterFence(body.trim()).trim();
  return { text, diff, verdict };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/normalizer.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/normalizer.js test/normalizer.test.js
git commit -m "feat: Normalizer extracts text/diff/verdict from untrusted model output"
```

---

### Task 6: Role presets

**Files:**
- Create: `src/roles.js`
- Test: `test/roles.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `ROLES = ['author','reviewer','grunt']` and `getRolePreset(role) -> { systemPrompt: string, outputShape: string }`. Throws `Error` on an unknown role. Adapters append `systemPrompt`/`outputShape` to the CLI's system prompt.

- [ ] **Step 1: Write the failing test**

```js
// test/roles.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRolePreset, ROLES } from '../src/roles.js';

test('exposes the closed role set', () => {
  assert.deepEqual(ROLES, ['author', 'reviewer', 'grunt']);
});

test('reviewer preset asks for a VERDICT line', () => {
  const p = getRolePreset('reviewer');
  assert.match(p.outputShape, /VERDICT:/);
  assert.ok(p.systemPrompt.length > 0);
});

test('author and grunt presets exist and differ', () => {
  assert.notEqual(getRolePreset('author').systemPrompt, getRolePreset('grunt').systemPrompt);
});

test('unknown role throws naming the role', () => {
  assert.throws(() => getRolePreset('boss'), /boss/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/roles.test.js`
Expected: FAIL — cannot find module `../src/roles.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/roles.js
export const ROLES = ['author', 'reviewer', 'grunt'];

const PRESETS = {
  author: {
    systemPrompt:
      'You are the AUTHOR. Produce a clear plan or implementation for the task. ' +
      'Be decisive; state assumptions explicitly. You own the decision.',
    outputShape:
      'Respond in plain prose. If you include code changes, put them in a single ```diff fenced block.',
  },
  reviewer: {
    systemPrompt:
      'You are an adversarial REVIEWER from a rival vendor. Find real, substantive problems ' +
      'in the work: correctness, missing tests, security, and unmet requirements. ' +
      'Raise blocking concerns only, each with a concrete reason. Do not nitpick style or preference.',
    outputShape:
      'End your reply with exactly one line: "VERDICT: APPROVE" or "VERDICT: BLOCK - <one-sentence reason>".',
  },
  grunt: {
    systemPrompt:
      'You are the EXECUTOR. Implement exactly the bounded chunk described, no more. ' +
      'Edit files, run the tests, and stop when the chunk is done. Do not redesign.',
    outputShape:
      'Make the edits directly. Summarize what you changed in one short paragraph.',
  },
};

export function getRolePreset(role) {
  const preset = PRESETS[role];
  if (!preset) throw new Error(`Unknown role: ${role}. Valid roles: ${ROLES.join(', ')}`);
  return preset;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/roles.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/roles.js test/roles.test.js
git commit -m "feat: role presets for author/reviewer/grunt"
```

---

### Task 7: ClaudeCodeAdapter

**Files:**
- Create: `test/helpers/stubCli.js`
- Create: `src/adapters/claudeCode.js`
- Test: `test/claudeCode.test.js`

**Interfaces:**
- Consumes: `runCommand` (Task 4), `normalize` (Task 5), `getRolePreset` (Task 6), `makeResult` (Task 3).
- Produces:
  - Helper `writeStubCli(dir, name, bodyJs) -> string` (returns the absolute path to an executable Node stub) — reused by Tasks 8, 9, 13.
  - `class ClaudeCodeAdapter { kind = 'claude-code'; constructor({ bin='claude', model=null, timeoutMs=120000 }); async run(role, task, context='') -> Result }`. It invokes `claude -p <task+context> --output-format json --append-system-prompt <preset>` (adding `--model` when set), parses the JSON (`result`, `total_cost_usd`, `is_error`), and normalizes the `result` text. Malformed JSON → `ok:false`, raw stdout kept in `text`.

- [ ] **Step 1: Write the stub-CLI helper**

```js
// test/helpers/stubCli.js
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Writes an executable Node script that acts as a fake CLI. bodyJs runs with
// `args` (process.argv.slice(2)) in scope. Returns the stub's absolute path.
export function writeStubCli(dir, name, bodyJs) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\n${bodyJs}\n`);
  chmodSync(file, 0o755);
  return file;
}
```

- [ ] **Step 2: Write the failing test**

```js
// test/claudeCode.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { ClaudeCodeAdapter } from '../src/adapters/claudeCode.js';

function tmp() { return mkdtempSync(path.join(tmpdir(), 'cc-')); }

test('parses claude -p JSON into a Result with cost', async () => {
  const dir = tmp();
  // Fake claude: emit the Claude Code JSON envelope.
  const bin = writeStubCli(dir, 'claude', `
    const out = { result: "VERDICT: APPROVE", total_cost_usd: 0.25, is_error: false };
    process.stdout.write(JSON.stringify(out));
  `);
  const r = await new ClaudeCodeAdapter({ bin }).run('reviewer', 'check this');
  assert.equal(r.ok, true);
  assert.equal(r.verdict.decision, 'APPROVE');
  assert.equal(r.usage.costUsd, 0.25);
});

test('passes role preset via --append-system-prompt and task as prompt', async () => {
  const dir = tmp();
  const bin = writeStubCli(dir, 'claude', `
    const i = args.indexOf('--append-system-prompt');
    const sys = args[i+1] || '';
    const prompt = args[args.indexOf('-p')+1] || '';
    process.stdout.write(JSON.stringify({ result: sys.includes('REVIEWER') && prompt.includes('my task') ? 'ok' : 'bad', is_error:false }));
  `);
  const r = await new ClaudeCodeAdapter({ bin }).run('reviewer', 'my task');
  assert.equal(r.text, 'ok');
});

test('non-zero exit or is_error yields ok:false with stderr captured', async () => {
  const dir = tmp();
  const bin = writeStubCli(dir, 'claude', `
    process.stderr.write("unknown variant 'max'");
    process.exit(1);
  `);
  const r = await new ClaudeCodeAdapter({ bin }).run('author', 't');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown variant/);
});

test('malformed JSON stdout does not throw; raw kept in text', async () => {
  const dir = tmp();
  const bin = writeStubCli(dir, 'claude', `process.stdout.write("not json at all");`);
  const r = await new ClaudeCodeAdapter({ bin }).run('author', 't');
  assert.equal(r.ok, false);
  assert.match(r.text, /not json/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/claudeCode.test.js`
Expected: FAIL — cannot find module `../src/adapters/claudeCode.js`.

- [ ] **Step 4: Write the implementation**

```js
// src/adapters/claudeCode.js
import { runCommand } from '../exec.js';
import { normalize } from '../normalizer.js';
import { getRolePreset } from '../roles.js';
import { makeResult } from '../result.js';

export class ClaudeCodeAdapter {
  constructor({ bin = 'claude', model = null, timeoutMs = 120000 } = {}) {
    this.kind = 'claude-code';
    this.bin = bin;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async run(role, task, context = '') {
    const preset = getRolePreset(role);
    const prompt = context ? `${task}\n\n---\nContext:\n${context}` : task;
    const system = `${preset.systemPrompt}\n\n${preset.outputShape}`;
    const args = ['-p', prompt, '--output-format', 'json', '--append-system-prompt', system];
    if (this.model) args.push('--model', this.model);

    const { stdout, stderr, code, timedOut } = await runCommand({
      cmd: this.bin, args, timeoutMs: this.timeoutMs,
    });

    if (code !== 0 || timedOut) {
      return makeResult({ text: stdout, ok: false, error: timedOut ? 'timed out' : (stderr || `exit ${code}`) });
    }

    let obj;
    try {
      obj = JSON.parse(stdout);
    } catch {
      return makeResult({ text: stdout, ok: false, error: 'could not parse claude JSON output' });
    }

    const norm = normalize(obj.result ?? '');
    return makeResult({
      text: norm.text,
      diff: norm.diff,
      verdict: norm.verdict,
      usage: { costUsd: obj.total_cost_usd ?? null, raw: { num_turns: obj.num_turns ?? null } },
      ok: obj.is_error !== true,
      error: obj.is_error === true ? (obj.result ?? 'claude reported is_error') : null,
    });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/claudeCode.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add test/helpers/stubCli.js src/adapters/claudeCode.js test/claudeCode.test.js
git commit -m "feat: ClaudeCodeAdapter driving claude -p with JSON output"
```

---

### Task 8: CodexAdapter

**Files:**
- Create: `src/adapters/codex.js`
- Test: `test/codex.test.js`

**Interfaces:**
- Consumes: `runCommand`, `normalize`, `getRolePreset`, `makeResult`, and `writeStubCli` (test helper).
- Produces: `class CodexAdapter { kind='codex'; constructor({ bin='codex', model=null, timeoutMs=120000, extraConfig=[], sandbox=null }); async run(role, task, context='') -> Result }`. It invokes `codex exec <prompt> -o <tmpfile>` plus one `-c <k=v>` per `extraConfig` entry, plus `--sandbox <sandbox>` when set, appends the role preset via `-c` experimental instructions **and** by prefixing the prompt (Codex has no `--append-system-prompt`), then reads the `-o` file as the agent's final message and normalizes it. `extraConfig` is the hook Task 9 uses to point the same driver at LocalAI.

- [ ] **Step 1: Write the failing test**

```js
// test/codex.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { CodexAdapter } from '../src/adapters/codex.js';

function tmp() { return mkdtempSync(path.join(tmpdir(), 'cx-')); }

// Fake codex: writes the final message to the path after -o, echoes it too.
const FAKE = `
  const oi = args.indexOf('-o');
  const outFile = oi >= 0 ? args[oi+1] : null;
  const msg = "done\\nVERDICT: APPROVE";
  if (outFile) require('node:fs').writeFileSync(outFile, msg);
  process.stdout.write("codex log line");
`;

test('reads the -o output file and normalizes it', async () => {
  const bin = writeStubCli(tmp(), 'codex', FAKE);
  const r = await new CodexAdapter({ bin }).run('reviewer', 'review x');
  assert.equal(r.ok, true);
  assert.equal(r.verdict.decision, 'APPROVE');
  assert.equal(r.text, 'done');
});

test('passes extraConfig as -c flags and sandbox', async () => {
  const bin = writeStubCli(tmp(), 'codex', `
    const oi = args.indexOf('-o');
    require('node:fs').writeFileSync(args[oi+1], args.join(' '));
  `);
  const r = await new CodexAdapter({ bin, extraConfig: ['model_provider=localai'], sandbox: 'workspace-write' }).run('grunt', 't');
  assert.match(r.text, /-c model_provider=localai/);
  assert.match(r.text, /--sandbox workspace-write/);
});

test('non-zero exit yields ok:false', async () => {
  const bin = writeStubCli(tmp(), 'codex', `process.stderr.write("boom");process.exit(2);`);
  const r = await new CodexAdapter({ bin }).run('author', 't');
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test('missing output file yields ok:false', async () => {
  const bin = writeStubCli(tmp(), 'codex', `process.stdout.write("no file written");`);
  const r = await new CodexAdapter({ bin }).run('author', 't');
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/codex.test.js`
Expected: FAIL — cannot find module `../src/adapters/codex.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/adapters/codex.js
import { runCommand } from '../exec.js';
import { normalize } from '../normalizer.js';
import { getRolePreset } from '../roles.js';
import { makeResult } from '../result.js';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export class CodexAdapter {
  constructor({ bin = 'codex', model = null, timeoutMs = 120000, extraConfig = [], sandbox = null } = {}) {
    this.kind = 'codex';
    this.bin = bin;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.extraConfig = extraConfig;
    this.sandbox = sandbox;
  }

  async run(role, task, context = '') {
    const preset = getRolePreset(role);
    // Codex has no system-prompt flag, so the role is prefixed into the prompt.
    const prompt =
      `${preset.systemPrompt}\n\n${preset.outputShape}\n\n---\nTask:\n${task}` +
      (context ? `\n\n---\nContext:\n${context}` : '');

    const outDir = mkdtempSync(path.join(tmpdir(), 'codex-out-'));
    const outFile = path.join(outDir, 'last-message.txt');

    const args = ['exec', prompt, '-o', outFile];
    if (this.model) args.push('-c', `model=${this.model}`);
    for (const kv of this.extraConfig) args.push('-c', kv);
    if (this.sandbox) args.push('--sandbox', this.sandbox);

    const { stdout, stderr, code, timedOut } = await runCommand({
      cmd: this.bin, args, timeoutMs: this.timeoutMs,
    });

    if (code !== 0 || timedOut) {
      return makeResult({ text: stdout, ok: false, error: timedOut ? 'timed out' : (stderr || `exit ${code}`) });
    }
    if (!existsSync(outFile)) {
      return makeResult({ text: stdout, ok: false, error: 'codex produced no output file' });
    }

    const norm = normalize(readFileSync(outFile, 'utf8'));
    return makeResult({
      text: norm.text,
      diff: norm.diff,
      verdict: norm.verdict,
      usage: { costUsd: null, raw: null },
      ok: true,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/codex.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/codex.js test/codex.test.js
git commit -m "feat: CodexAdapter driving codex exec -o with configurable -c flags"
```

---

### Task 9: LocalAgentAdapter

**Files:**
- Create: `src/adapters/localAgent.js`
- Test: `test/localAgent.test.js`

**Interfaces:**
- Consumes: `CodexAdapter` (Task 8).
- Produces: `class LocalAgentAdapter { kind='local-agent'; constructor({ bin='codex', provider='localai', model, timeoutMs=120000 }); async run(role, task, context='') -> Result }`. It composes a `CodexAdapter` with `extraConfig=['model_provider=<provider>', 'model=<model>']` and `sandbox='workspace-write'` (the flags Task 1 validated), and delegates `run`. `model` is required (throws if missing).

- [ ] **Step 1: Write the failing test**

```js
// test/localAgent.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { LocalAgentAdapter } from '../src/adapters/localAgent.js';

test('drives codex with the localai provider, model, and workspace-write sandbox', async () => {
  const bin = writeStubCli(mkdtempSync(path.join(tmpdir(), 'la-')), 'codex', `
    const oi = args.indexOf('-o');
    require('node:fs').writeFileSync(args[oi+1], args.join(' '));
  `);
  const r = await new LocalAgentAdapter({ bin, model: 'shingon-qwen3.8-27b-q4' }).run('grunt', 'do the chunk');
  assert.match(r.text, /-c model_provider=localai/);
  assert.match(r.text, /-c model=shingon-qwen3\.8-27b-q4/);
  assert.match(r.text, /--sandbox workspace-write/);
});

test('requires a model', () => {
  assert.throws(() => new LocalAgentAdapter({ bin: 'codex' }), /model/);
});

test('kind is local-agent', () => {
  assert.equal(new LocalAgentAdapter({ model: 'm' }).kind, 'local-agent');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/localAgent.test.js`
Expected: FAIL — cannot find module `../src/adapters/localAgent.js`.

- [ ] **Step 3: Write the implementation**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/localAgent.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/localAgent.js test/localAgent.test.js
git commit -m "feat: LocalAgentAdapter — Codex harness pointed at LocalAI (workspace-write)"
```

---

### Task 10: Participant

**Files:**
- Create: `src/participant.js`
- Test: `test/participant.test.js`

**Interfaces:**
- Consumes: `isResult` (Task 3); any adapter from Tasks 7–9 (duck-typed: has `kind` and `async run(role, task, context)`).
- Produces: `class Participant { constructor({ name, adapter, roles, capabilities={} }); canPlay(role) -> boolean; async run(role, task, context) -> Result }`. `run` throws if the participant is not eligible for `role`; it asserts the adapter returned a `Result`. `capabilities` defaults: `{ is_agentic:false, can_edit_files:false }` merged over the supplied object.

- [ ] **Step 1: Write the failing test**

```js
// test/participant.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Participant } from '../src/participant.js';
import { makeResult } from '../src/result.js';

const fakeAdapter = { kind: 'fake', async run(role) { return makeResult({ text: `ran ${role}` }); } };

test('runs an eligible role through the adapter', async () => {
  const p = new Participant({ name: 'claude', adapter: fakeAdapter, roles: ['author', 'reviewer'] });
  assert.equal(p.canPlay('reviewer'), true);
  const r = await p.run('reviewer', 'task');
  assert.equal(r.text, 'ran reviewer');
});

test('rejects an ineligible role naming participant and role', async () => {
  const p = new Participant({ name: 'local', adapter: fakeAdapter, roles: ['grunt'] });
  assert.equal(p.canPlay('author'), false);
  await assert.rejects(() => p.run('author', 't'), /local.*author|author.*local/);
});

test('capabilities default to false and merge', () => {
  const p = new Participant({ name: 'x', adapter: fakeAdapter, roles: ['grunt'], capabilities: { is_agentic: true } });
  assert.equal(p.capabilities.is_agentic, true);
  assert.equal(p.capabilities.can_edit_files, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/participant.test.js`
Expected: FAIL — cannot find module `../src/participant.js`.

- [ ] **Step 3: Write the implementation**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/participant.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/participant.js test/participant.test.js
git commit -m "feat: Participant binds an adapter to name, roles, capabilities"
```

---

### Task 11: Health-check

**Files:**
- Create: `src/health.js`
- Test: `test/health.test.js`

**Interfaces:**
- Consumes: `runCommand` (Task 4); an adapter (`kind`, `bin`).
- Produces: `async checkHealth(adapter, { timeoutMs=15000 } = {}) -> { ok: boolean, reason: string }`. Runs the CLI's `--version` (`claude --version` / `codex --version`), returns `{ ok:true, reason:'' }` on exit 0, else classifies stderr into a reason code: `unauthorized` (401/unauthorized/token), `version-skew` (`unknown variant`), `rate-limit` (429/rate limit), or `unavailable` (anything else, incl. timeout / ENOENT). The classifier is a pure helper `classifyFailure(stderr) -> string` exported for testing.

- [ ] **Step 1: Write the failing test**

```js
// test/health.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { checkHealth, classifyFailure } from '../src/health.js';

function tmp() { return mkdtempSync(path.join(tmpdir(), 'hc-')); }

test('healthy CLI returns ok', async () => {
  const bin = writeStubCli(tmp(), 'claude', `process.stdout.write("2.1.302");`);
  const r = await checkHealth({ kind: 'claude-code', bin });
  assert.equal(r.ok, true);
});

test('classifies known failure signatures', () => {
  assert.equal(classifyFailure("Could not parse your authentication token"), 'unauthorized');
  assert.equal(classifyFailure("unknown variant `max`"), 'version-skew');
  assert.equal(classifyFailure("429 rate limit reached"), 'rate-limit');
  assert.equal(classifyFailure("some other explosion"), 'unavailable');
});

test('non-zero version check returns ok:false with a reason', async () => {
  const bin = writeStubCli(tmp(), 'codex', `process.stderr.write("401 unauthorized");process.exit(1);`);
  const r = await checkHealth({ kind: 'codex', bin });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unauthorized');
});

test('missing binary is unavailable, not a throw', async () => {
  const r = await checkHealth({ kind: 'codex', bin: '/no/such/codex' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unavailable');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/health.test.js`
Expected: FAIL — cannot find module `../src/health.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/health.js
import { runCommand } from './exec.js';

export function classifyFailure(stderr = '') {
  const s = stderr.toLowerCase();
  if (/401|unauthorized|authentication token|sign in/.test(s)) return 'unauthorized';
  if (/unknown variant|unknown field|invalid value/.test(s)) return 'version-skew';
  if (/429|rate limit|limit reached/.test(s)) return 'rate-limit';
  return 'unavailable';
}

export async function checkHealth(adapter, { timeoutMs = 15000 } = {}) {
  const bin = adapter.bin ?? adapter.kind;
  const { stderr, code, timedOut } = await runCommand({ cmd: bin, args: ['--version'], timeoutMs });
  if (code === 0 && !timedOut) return { ok: true, reason: '' };
  if (timedOut) return { ok: false, reason: 'unavailable' };
  return { ok: false, reason: classifyFailure(stderr) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/health.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/health.js test/health.test.js
git commit -m "feat: per-adapter health-check with failure classification"
```

---

### Task 12: Config loader

**Files:**
- Create: `src/config.js`
- Create: `config.example.json`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: all three adapters (Tasks 7–9) and `Participant` (Task 10).
- Produces: `loadConfig(filePath) -> { participants: Participant[], byName: Map<string, Participant> }`. The config JSON is `{ "participants": [ { name, adapter, bin?, model?, roles, capabilities? } ] }` where `adapter ∈ {"claude-code","codex","local-agent"}`. Unknown adapter kind → throws naming the participant. A `local-agent` without `model` → throws. The factory `buildAdapter(spec)` is exported for testing.

- [ ] **Step 1: Write `config.example.json`**

```json
{
  "participants": [
    { "name": "claude", "adapter": "claude-code", "bin": "claude",
      "roles": ["author", "reviewer"], "capabilities": { "is_agentic": true, "can_edit_files": true } },
    { "name": "codex", "adapter": "codex", "bin": "codex",
      "roles": ["author", "reviewer"], "capabilities": { "is_agentic": true, "can_edit_files": true } },
    { "name": "local", "adapter": "local-agent", "bin": "codex", "model": "shingon-qwen3.8-27b-q4",
      "roles": ["grunt"], "capabilities": { "is_agentic": true, "can_edit_files": true } }
  ]
}
```

- [ ] **Step 2: Write the failing test**

```js
// test/config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, buildAdapter } from '../src/config.js';

function writeConfig(obj) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const f = path.join(dir, 'config.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('loads the example-shaped config into Participants', () => {
  const f = writeConfig({ participants: [
    { name: 'claude', adapter: 'claude-code', roles: ['author', 'reviewer'] },
    { name: 'local', adapter: 'local-agent', model: 'm', roles: ['grunt'] },
  ]});
  const { participants, byName } = loadConfig(f);
  assert.equal(participants.length, 2);
  assert.equal(byName.get('claude').adapter.kind, 'claude-code');
  assert.equal(byName.get('local').adapter.kind, 'local-agent');
});

test('unknown adapter kind throws naming the participant', () => {
  assert.throws(() => buildAdapter({ name: 'bad', adapter: 'telepathy' }), /bad.*telepathy|telepathy.*bad/);
});

test('local-agent without model throws', () => {
  assert.throws(() => buildAdapter({ name: 'local', adapter: 'local-agent' }), /model/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — cannot find module `../src/config.js`.

- [ ] **Step 4: Write the implementation**

```js
// src/config.js
import { readFileSync } from 'node:fs';
import { ClaudeCodeAdapter } from './adapters/claudeCode.js';
import { CodexAdapter } from './adapters/codex.js';
import { LocalAgentAdapter } from './adapters/localAgent.js';
import { Participant } from './participant.js';

export function buildAdapter(spec) {
  const opts = { bin: spec.bin, model: spec.model };
  switch (spec.adapter) {
    case 'claude-code': return new ClaudeCodeAdapter(opts);
    case 'codex': return new CodexAdapter(opts);
    case 'local-agent': return new LocalAgentAdapter(opts); // throws if model missing
    default:
      throw new Error(`Participant ${spec.name}: unknown adapter "${spec.adapter}" (expected claude-code | codex | local-agent)`);
  }
}

export function loadConfig(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed.participants)) throw new Error('config must have a "participants" array');
  const participants = parsed.participants.map((spec) =>
    new Participant({
      name: spec.name,
      adapter: buildAdapter(spec),
      roles: spec.roles,
      capabilities: spec.capabilities ?? {},
    }));
  const byName = new Map(participants.map((p) => [p.name, p]));
  return { participants, byName };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config.js config.example.json test/config.test.js
git commit -m "feat: config loader building Participants from one JSON file"
```

---

### Task 13: conductor-probe CLI

**Files:**
- Create: `bin/conductor-probe.js`
- Test: `test/probe.test.js`

**Interfaces:**
- Consumes: `loadConfig` (Task 12).
- Produces: an executable CLI: `conductor-probe --config <path> --participant <name> --role <role> --task "<text>" [--task-file <path>] [--json]`. It loads the config, runs the named participant in the role on the task, and prints a plain-English summary of the `Result` (ok, verdict, cost, whether a diff was returned, text) or, with `--json`, the raw `Result`. Exit code is 0 on `ok:true`, 1 on `ok:false`. This is the end-to-end tie of the whole plan.

- [ ] **Step 1: Write the failing test** (drives the real CLI with a fake `claude` from config)

```js
// test/probe.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { runCommand } from '../src/exec.js';

test('probe runs a participant end-to-end and prints the verdict', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'probe-'));
  const claude = writeStubCli(dir, 'claude', `
    process.stdout.write(JSON.stringify({ result: "looks fine\\nVERDICT: APPROVE", total_cost_usd: 0.1, is_error: false }));
  `);
  const cfg = path.join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ participants: [
    { name: 'claude', adapter: 'claude-code', bin: claude, roles: ['reviewer'] },
  ]}));

  const probe = path.resolve('bin/conductor-probe.js');
  const r = await runCommand({
    cmd: process.execPath,
    args: [probe, '--config', cfg, '--participant', 'claude', '--role', 'reviewer', '--task', 'review this'],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /APPROVE/);
  assert.match(r.stdout, /0\.1/);
});

test('probe exits 1 when the participant is not ok', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'probe2-'));
  const claude = writeStubCli(dir, 'claude', `process.exit(1);`);
  const cfg = path.join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ participants: [
    { name: 'claude', adapter: 'claude-code', bin: claude, roles: ['author'] },
  ]}));
  const probe = path.resolve('bin/conductor-probe.js');
  const r = await runCommand({ cmd: process.execPath, args: [probe, '--config', cfg, '--participant', 'claude', '--role', 'author', '--task', 't'] });
  assert.equal(r.code, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/probe.test.js`
Expected: FAIL — cannot find module `../bin/conductor-probe.js`.

- [ ] **Step 3: Write the implementation**

```js
#!/usr/bin/env node
// bin/conductor-probe.js
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';

function parse() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'config.json' },
      participant: { type: 'string' },
      role: { type: 'string' },
      task: { type: 'string' },
      'task-file': { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  return values;
}

async function main() {
  const v = parse();
  if (!v.participant || !v.role || (!v.task && !v['task-file'])) {
    console.error('usage: conductor-probe --config <p> --participant <name> --role <role> --task "<text>" | --task-file <path> [--json]');
    process.exit(2);
  }
  const task = v['task-file'] ? readFileSync(v['task-file'], 'utf8') : v.task;

  const { byName } = loadConfig(v.config);
  const p = byName.get(v.participant);
  if (!p) {
    console.error(`no participant named "${v.participant}" in ${v.config}`);
    process.exit(2);
  }

  const result = await p.run(v.role, task);

  if (v.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`participant : ${p.name} (${p.adapter.kind})`);
    console.log(`role        : ${v.role}`);
    console.log(`ok          : ${result.ok}`);
    if (result.verdict) console.log(`verdict     : ${result.verdict.decision}${result.verdict.reason ? ' — ' + result.verdict.reason : ''}`);
    console.log(`cost (usd)  : ${result.usage.costUsd ?? 'n/a'}`);
    console.log(`diff        : ${result.diff ? 'yes' : 'no'}`);
    if (result.error) console.log(`error       : ${result.error}`);
    console.log('--- text ---');
    console.log(result.text);
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => { console.error(err.message); process.exit(2); });
```

- [ ] **Step 4: Make it executable and run the tests**

```bash
chmod +x bin/conductor-probe.js
```
Run: `node --test test/probe.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all tests across all files PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add bin/conductor-probe.js test/probe.test.js
git commit -m "feat: conductor-probe CLI ties adapters/config into an end-to-end run"
```

---

## Done when

- `npm test` is green across every file.
- `spikes/localai-codex/RESULT.md` records a PASS (or a working ollama/lmstudio fallback) for build-spike #1 — or the operator has been told the local-grunt assumption failed.
- `conductor-probe` can drive a real `claude`/`codex` participant (with the operator's live subscriptions) and print a normalized Result.

This is the substrate. Plan 2 adds the git workspace and the adversarial plan→chunk→checkpoint loop on top of these Participants; Plan 3 adds the routing/fallback ladder, the `conductor` command, and the final approval gate.
