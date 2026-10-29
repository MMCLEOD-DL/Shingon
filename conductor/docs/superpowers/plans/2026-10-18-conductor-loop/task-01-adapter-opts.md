# Task 1: Adapter run options

Agents must run inside the workspace and only get write access when their role needs it. Plan 1 adapters take no `cwd`/write/timeout per call; this task adds them, fixes the Codex temp-dir leak, and lets config pass `timeoutMs`/`extraConfig`/`provider` through.

**Files:**
- Modify: `src/adapters/codex.js`, `src/adapters/claudeCode.js`, `src/adapters/localAgent.js`, `src/participant.js`, `src/config.js`
- Test: `test/codex.test.js`, `test/claudeCode.test.js`, `test/localAgent.test.js`, `test/participant.test.js`, `test/config.test.js` (append)

**Interfaces:**
- Consumes: Plan 1 `runCommand({cmd,args,cwd,timeoutMs})`, `writeStubCli(dir,name,bodyJs)`.
- Produces: `adapter.run(role, task, context = '', opts = {})` and `participant.run(role, task, context = '', opts = {})` where `opts = { cwd?: string, write?: boolean, timeoutMs?: number }`.
  - Codex: `--sandbox` is `workspace-write` when `opts.write`, else the constructor `sandbox`, else `read-only`. Temp output dir always removed.
  - Claude: `opts.write` adds `--permission-mode acceptEdits`.
  - `LocalAgentAdapter({ bin, provider, model, timeoutMs, extraConfig = [] })` — `extraConfig` entries are appended after the provider/model `-c` flags.
  - `buildAdapter(spec)` forwards `spec.timeoutMs`, and `spec.extraConfig` (codex, local-agent), `spec.provider` (local-agent).

- [ ] **Step 1: Write the failing tests**

Append to `test/codex.test.js`:

```js
import { readdirSync } from 'node:fs';

const ECHO_ARGS = `
  const oi = args.indexOf('-o');
  require('node:fs').writeFileSync(args[oi+1], 'cwd=' + process.cwd() + ' ' + args.join(' '));
`;

test('runs in opts.cwd and uses workspace-write when opts.write', async () => {
  const dir = tmp();
  const bin = writeStubCli(tmp(), 'codex', ECHO_ARGS);
  const r = await new CodexAdapter({ bin }).run('grunt', 't', '', { cwd: dir, write: true });
  assert.match(r.text, new RegExp('cwd=' + dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(r.text, /--sandbox workspace-write/);
});

test('defaults to read-only sandbox when not writing', async () => {
  const bin = writeStubCli(tmp(), 'codex', ECHO_ARGS);
  const r = await new CodexAdapter({ bin }).run('reviewer', 't');
  assert.match(r.text, /--sandbox read-only/);
});

test('opts.timeoutMs overrides the constructor timeout', async () => {
  const bin = writeStubCli(tmp(), 'codex', `setTimeout(() => {}, 10000);`);
  const t0 = Date.now();
  const r = await new CodexAdapter({ bin, timeoutMs: 60000 }).run('author', 't', '', { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
  assert.ok(Date.now() - t0 < 5000);
});

test('removes its temp output dir on success and failure', async () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith('codex-out-')).length;
  const ok = writeStubCli(tmp(), 'codex', ECHO_ARGS);
  const bad = writeStubCli(tmp(), 'codex', `process.exit(3);`);
  await new CodexAdapter({ bin: ok }).run('author', 't');
  await new CodexAdapter({ bin: bad }).run('author', 't');
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith('codex-out-')).length;
  assert.equal(after, before);
});
```

Append to `test/claudeCode.test.js` (it already has `tmp()`, `writeStubCli` and `ClaudeCodeAdapter`):

```js
const CLAUDE_ECHO = `
  process.stdout.write(JSON.stringify({ result: 'cwd=' + process.cwd() + ' ' + args.join(' '), is_error: false }));
`;

test('runs in opts.cwd and adds acceptEdits when opts.write', async () => {
  const dir = tmp();
  const bin = writeStubCli(tmp(), 'claude', CLAUDE_ECHO);
  const r = await new ClaudeCodeAdapter({ bin }).run('author', 't', '', { cwd: dir, write: true });
  assert.ok(r.text.includes('cwd=' + dir));
  assert.match(r.text, /--permission-mode acceptEdits/);
});

test('no permission-mode flag when not writing', async () => {
  const bin = writeStubCli(tmp(), 'claude', CLAUDE_ECHO);
  const r = await new ClaudeCodeAdapter({ bin }).run('reviewer', 't');
  assert.doesNotMatch(r.text, /--permission-mode/);
});
```

Append to `test/localAgent.test.js` (it already imports `writeStubCli`, `mkdtempSync`, `tmpdir`, `path`):

```js
test('forwards opts and appends extraConfig after provider/model', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'la-'));
  const bin = writeStubCli(d, 'codex', `
    const oi = args.indexOf('-o');
    require('node:fs').writeFileSync(args[oi+1], 'cwd=' + process.cwd() + ' ' + args.join(' '));
  `);
  const a = new LocalAgentAdapter({ bin, model: 'm1', extraConfig: ['model_providers.localai.base_url=http://127.0.0.1:8091/v1'] });
  const r = await a.run('grunt', 't', '', { cwd: d, write: true });
  assert.ok(r.text.includes('cwd=' + d));
  assert.match(r.text, /-c model_provider=localai -c model=m1 -c model_providers\.localai\.base_url=http:\/\/127\.0\.0\.1:8091\/v1/);
  assert.match(r.text, /--sandbox workspace-write/);
});
```

Append to `test/participant.test.js`:

```js
test('forwards opts to the adapter', async () => {
  let seen = null;
  const adapter = { kind: 'fake', run: async (role, task, context, opts) => { seen = opts; return makeResult({ text: 'x' }); } };
  const p = new Participant({ name: 'p', adapter, roles: ['grunt'] });
  await p.run('grunt', 't', 'c', { cwd: '/w', write: true });
  assert.deepEqual(seen, { cwd: '/w', write: true });
});
```

Append to `test/config.test.js`:

```js
test('buildAdapter forwards timeoutMs, extraConfig and provider', () => {
  const c = buildAdapter({ name: 'c', adapter: 'codex', timeoutMs: 999, extraConfig: ['a=1'] });
  assert.equal(c.timeoutMs, 999);
  assert.deepEqual(c.extraConfig, ['a=1']);
  const l = buildAdapter({ name: 'l', adapter: 'local-agent', model: 'm', provider: 'ollama', extraConfig: ['b=2'], timeoutMs: 5 });
  assert.equal(l.provider, 'ollama');
  assert.deepEqual(l._codex.extraConfig, ['model_provider=ollama', 'model=m', 'b=2']);
  assert.equal(l._codex.timeoutMs, 5);
  const k = buildAdapter({ name: 'k', adapter: 'claude-code' });
  assert.equal(k.timeoutMs, 120000);
});
```

(`buildAdapter` is already imported in that file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the new tests FAIL (no `--sandbox read-only`, wrong cwd, temp dirs leak, opts not forwarded, `extraConfig` undefined).

- [ ] **Step 3: Implement**

`src/adapters/codex.js` — change the imports and `run`:

```js
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
```

```js
  async run(role, task, context = '', opts = {}) {
    const preset = getRolePreset(role);
    // Codex has no system-prompt flag, so the role is prefixed into the prompt.
    const prompt =
      `${preset.systemPrompt}\n\n${preset.outputShape}\n\n---\nTask:\n${task}` +
      (context ? `\n\n---\nContext:\n${context}` : '');

    const outDir = mkdtempSync(path.join(tmpdir(), 'codex-out-'));
    const outFile = path.join(outDir, 'last-message.txt');
    try {
      const args = ['exec', prompt, '-o', outFile];
      if (this.model) args.push('-c', `model=${this.model}`);
      for (const kv of this.extraConfig) args.push('-c', kv);
      const sandbox = opts.write ? 'workspace-write' : (this.sandbox ?? 'read-only');
      args.push('--sandbox', sandbox);

      const { stdout, stderr, code, timedOut } = await runCommand({
        cmd: this.bin, args, cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      });

      if (code !== 0 || timedOut) {
        return makeResult({ text: stdout, ok: false, error: timedOut ? 'timed out' : (stderr || `exit ${code}`) });
      }
      let raw;
      try {
        raw = readFileSync(outFile, 'utf8');
      } catch {
        return makeResult({ text: stdout, ok: false, error: 'codex produced no output file' });
      }

      const norm = normalize(raw);
      return makeResult({
        text: norm.text,
        diff: norm.diff,
        verdict: norm.verdict,
        usage: { costUsd: null, raw: null },
        ok: true,
      });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
```

`src/adapters/claudeCode.js` — `run` signature and the command call:

```js
  async run(role, task, context = '', opts = {}) {
    const preset = getRolePreset(role);
    const prompt = context ? `${task}\n\n---\nContext:\n${context}` : task;
    const system = `${preset.systemPrompt}\n\n${preset.outputShape}`;
    const args = ['-p', prompt, '--output-format', 'json', '--append-system-prompt', system];
    if (this.model) args.push('--model', this.model);
    if (opts.write) args.push('--permission-mode', 'acceptEdits');

    const { stdout, stderr, code, timedOut } = await runCommand({
      cmd: this.bin, args, cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? this.timeoutMs,
    });
```

(the rest of the method is unchanged).

`src/adapters/localAgent.js`:

```js
export class LocalAgentAdapter {
  constructor({ bin = 'codex', provider = 'localai', model, timeoutMs = 120000, extraConfig = [] } = {}) {
    if (!model) throw new Error('LocalAgentAdapter requires a model');
    this.kind = 'local-agent';
    this.bin = bin;
    this.provider = provider;
    this.model = model;
    this._codex = new CodexAdapter({
      bin,
      timeoutMs,
      extraConfig: [`model_provider=${provider}`, `model=${model}`, ...extraConfig],
      sandbox: 'workspace-write',
    });
  }

  run(role, task, context = '', opts = {}) {
    return this._codex.run(role, task, context, opts);
  }
}
```

`src/participant.js` — `run`:

```js
  async run(role, task, context = '', opts = {}) {
    if (!this.canPlay(role)) {
      throw new Error(`Participant ${this.name} is not eligible for role "${role}" (eligible: ${this.roles.join(', ')})`);
    }
    const result = await this.adapter.run(role, task, context, opts);
```

`src/config.js` — `buildAdapter`:

```js
export function buildAdapter(spec) {
  const opts = { bin: spec.bin, model: spec.model, timeoutMs: spec.timeoutMs };
  switch (spec.adapter) {
    case 'claude-code': return new ClaudeCodeAdapter(opts);
    case 'codex': return new CodexAdapter({ ...opts, extraConfig: spec.extraConfig });
    case 'local-agent': return new LocalAgentAdapter({ ...opts, provider: spec.provider, extraConfig: spec.extraConfig }); // throws if model missing
    default:
      throw new Error(`Participant ${spec.name}: unknown adapter "${spec.adapter}" (expected claude-code | codex | local-agent)`);
  }
}
```

(`undefined` values fall through to the constructors' defaults.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (65 existing + 9 new).

- [ ] **Step 5: Commit**

```bash
git add src/adapters src/participant.js src/config.js test
git commit -m "feat: adapters take per-call cwd/write/timeout; codex cleans temp dir"
```
