# Task 2: Wake config

Waking must be pluggable per participant, with "warn only" as the default (Ruling 3). This task defines the `wake` block, validates it at config load with plain-English errors, and gives every Participant a normalized `participant.wake`. Later tasks never need to handle a missing or half-filled block.

It also validates `routing.localDown`. That setting gains a third value in Task 5, and today a typo there (say `"frontiers"`) silently counts as `"frontier"`, which would mean surprise spend.

**Files:**
- Create: `src/wake.js` (validation part; Task 3 adds the mechanisms)
- Modify: `src/participant.js`, `src/config.js`
- Test: `test/wake.test.js` (new), `test/config.test.js` (append), `test/participant.test.js` (append)

**Interfaces:**
- Consumes: `loadConfig` (`src/config.js`), `Participant` (`src/participant.js`).
- Produces:
  - `WAKE_DEFAULTS = Object.freeze({ method: 'warn', waitMs: 180000, pollMs: 5000, broadcast: '255.255.255.255', port: 9, timeoutMs: 60000 })`.
  - `DEFAULT_WAKE_HINT = 'Start the machine that runs this model, and its model server, then try again.'`
  - `normalizeWake(raw, participantName) -> Wake`, frozen. Every error message starts `Participant <name>: wake` and never echoes the value of an env var.
    - `raw == null` → `{ method: 'warn', hint: DEFAULT_WAKE_HINT, waitMs: 180000, pollMs: 5000 }`.
    - a non-object (including an array) → throws `…: wake must be an object`.
    - `method`: one of `warn | wol | command` (default `warn`), else throws `…: wake.method must be "warn", "wol" or "command"`.
    - `hint`: a non-empty string, else `DEFAULT_WAKE_HINT`.
    - `waitMs`: an integer from 0 to 900000; `pollMs`: an integer from 500 to 60000. Defaults come from `WAKE_DEFAULTS`. Anything else throws `…: wake.waitMs must be a whole number of milliseconds from 0 to 900000` (likewise for `pollMs`).
    - `wol`:
      - `mac` must match `/^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i`, and is stored lower-case with `:` separators.
      - `broadcast` is a non-empty string, default `'255.255.255.255'`.
      - `port` is an integer from 1 to 65535, default `9`.
    - `command`:
      - `cmd` is a non-empty string.
      - `args` is an array of strings (default `[]`).
      - `env` is an array of env var **names** matching `/^[A-Za-z_][A-Za-z0-9_]*$/` (default `[]`).
      - `timeoutMs` is an integer from 1000 to 600000, default `60000`.
    - Keys that do not belong to the chosen method are dropped, not rejected, so the operator can switch `method` while keeping the other block's settings in the file.
  - `new Participant({ …, wake })`: stores `this.wake = wake ?? normalizeWake(null, name)`.
  - `loadConfig`:
    - passes `wake: normalizeWake(spec.wake, spec.name)` to every Participant;
    - throws `routing.localDown must be "ask", "frontier" or "pause", but the config has <JSON>` for any other present value.

- [ ] **Step 1: Write the failing tests**

Create `test/wake.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWake, WAKE_DEFAULTS, DEFAULT_WAKE_HINT } from '../src/wake.js';

test('no wake block: warn only, with the default hint', () => {
  assert.deepEqual(normalizeWake(undefined, 'local'), { method: 'warn', hint: DEFAULT_WAKE_HINT, waitMs: 180000, pollMs: 5000 });
  assert.equal(Object.isFrozen(normalizeWake(null, 'local')), true);
  assert.equal(WAKE_DEFAULTS.method, 'warn');
});

test('wol: MAC normalized, defaults filled, foreign keys dropped', () => {
  const w = normalizeWake({ method: 'wol', mac: 'AA-BB-CC-DD-EE-0F', hint: 'Turn on the desktop.', cmd: 'ssh' }, 'local');
  assert.deepEqual(w, { method: 'wol', hint: 'Turn on the desktop.', waitMs: 180000, pollMs: 5000, mac: 'aa:bb:cc:dd:ee:0f', broadcast: '255.255.255.255', port: 9 });
});

test('command: cmd, args, env names and timeout', () => {
  const w = normalizeWake({ method: 'command', cmd: 'ssh', args: ['-i', '/k', 'wake@192.168.1.109', 'start-worker'], env: ['WAKE_TOKEN'], waitMs: 240000 }, 'local');
  assert.deepEqual(w, { method: 'command', hint: DEFAULT_WAKE_HINT, waitMs: 240000, pollMs: 5000, cmd: 'ssh', args: ['-i', '/k', 'wake@192.168.1.109', 'start-worker'], env: ['WAKE_TOKEN'], timeoutMs: 60000 });
});

test('bad wake config is a plain error naming the participant', () => {
  const bad = [
    [[], /Participant local: wake must be an object/],
    [{ method: 'magic' }, /wake\.method must be "warn", "wol" or "command"/],
    [{ method: 'wol' }, /wake\.mac/],
    [{ method: 'wol', mac: 'aa:bb:cc:dd:ee' }, /wake\.mac/],
    [{ method: 'wol', mac: 'aa:bb:cc:dd:ee:ff', port: 70000 }, /wake\.port/],
    [{ method: 'command' }, /wake\.cmd/],
    [{ method: 'command', cmd: 'x', args: 'start' }, /wake\.args/],
    [{ method: 'command', cmd: 'x', env: ['NOT OK'] }, /wake\.env/],
    [{ method: 'command', cmd: 'x', timeoutMs: 10 }, /wake\.timeoutMs/],
    [{ waitMs: -1 }, /wake\.waitMs must be a whole number of milliseconds from 0 to 900000/],
    [{ pollMs: 1.5 }, /wake\.pollMs/],
  ];
  for (const [raw, re] of bad) assert.throws(() => normalizeWake(raw, 'local'), (e) => re.test(e.message) && e.message.startsWith('Participant local: wake'), JSON.stringify(raw));
});

test('an env NAME is validated, its value is never read or echoed', () => {
  process.env.WAKE_SECRET_TEST = 'sekrit-wake-value-123';
  try {
    const w = normalizeWake({ method: 'command', cmd: 'x', env: ['WAKE_SECRET_TEST'] }, 'local');
    assert.doesNotMatch(JSON.stringify(w), /sekrit/);
  } finally { delete process.env.WAKE_SECRET_TEST; }
});
```

Append to `test/config.test.js`:

```js
test('every participant gets a normalized wake; localDown is validated', () => {
  const f = writeConfig({ participants: [
    { name: 'claude', adapter: 'claude-code', roles: ['author', 'reviewer'] },
    { name: 'local', adapter: 'local-agent', model: 'm', roles: ['grunt'], wake: { method: 'wol', mac: '00:11:22:33:44:55', hint: 'Turn on the desktop PC.' } },
  ], routing: { localDown: 'ask' } });
  const { byName } = loadConfig(f);
  assert.equal(byName.get('claude').wake.method, 'warn');
  assert.equal(byName.get('local').wake.mac, '00:11:22:33:44:55');
  for (const v of ['frontiers', true, 'ASK']) {
    const g = writeConfig({ participants: [{ name: 'c', adapter: 'claude-code', roles: ['author'] }], routing: { localDown: v } });
    assert.throws(() => loadConfig(g), /routing\.localDown must be "ask", "frontier" or "pause", but the config has/, String(v));
  }
  const h = writeConfig({ participants: [{ name: 'l', adapter: 'local-agent', model: 'm', roles: ['grunt'], wake: { method: 'nope' } }] });
  assert.throws(() => loadConfig(h), /Participant l: wake\.method/);
});
```

Append to `test/participant.test.js` (reuse that file's existing fake adapter; if it has none, use `{ kind: 'x', run: async () => makeResult({ text: '' }) }`):

```js
import { normalizeWake } from '../src/wake.js';

test('a Participant built without wake gets the warn-only default', () => {
  const p = new Participant({ name: 'p', roles: ['grunt'], adapter: { kind: 'x', run: async () => null } });
  assert.deepEqual(p.wake, normalizeWake(null, 'p'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL. `src/wake.js` does not exist, Participants have no `wake`, and `localDown: 'frontiers'` loads without error.

- [ ] **Step 3: Implement `normalizeWake`, `WAKE_DEFAULTS` and `DEFAULT_WAKE_HINT` in `src/wake.js`**

Create `src/wake.js` (Task 3 appends the mechanisms to this file):

```js
// src/wake.js
// Waking a worker before a run (factory spec §4.2). Warn-only unless the config asks.

export const WAKE_DEFAULTS = Object.freeze({ method: 'warn', waitMs: 180000, pollMs: 5000, broadcast: '255.255.255.255', port: 9, timeoutMs: 60000 });
export const DEFAULT_WAKE_HINT = 'Start the machine that runs this model, and its model server, then try again.';

const METHODS = ['warn', 'wol', 'command'];
const MAC = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Every message names the participant and the setting, never a value read from the environment.
function fail(name, text) {
  throw new Error(`Participant ${name}: ${text}`);
}

function wholeMs(raw, key, min, max, name) {
  const v = raw[key] ?? WAKE_DEFAULTS[key];
  if (!Number.isInteger(v) || v < min || v > max) fail(name, `wake.${key} must be a whole number of milliseconds from ${min} to ${max}`);
  return v;
}

export function normalizeWake(raw, participantName) {
  const name = participantName;
  if (raw == null) return Object.freeze({ method: 'warn', hint: DEFAULT_WAKE_HINT, waitMs: WAKE_DEFAULTS.waitMs, pollMs: WAKE_DEFAULTS.pollMs });
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(name, 'wake must be an object');
  const method = raw.method ?? WAKE_DEFAULTS.method;
  if (!METHODS.includes(method)) fail(name, 'wake.method must be "warn", "wol" or "command"');
  // Built from scratch, not spread from raw: keys that belong to another method drop out.
  const out = {
    method,
    hint: typeof raw.hint === 'string' && raw.hint.trim() ? raw.hint.trim() : DEFAULT_WAKE_HINT,
    waitMs: wholeMs(raw, 'waitMs', 0, 900000, name),
    pollMs: wholeMs(raw, 'pollMs', 500, 60000, name),
  };
  if (method === 'wol') {
    if (typeof raw.mac !== 'string' || !MAC.test(raw.mac)) fail(name, 'wake.mac must be a network card address such as "aa:bb:cc:dd:ee:ff"');
    out.mac = raw.mac.toLowerCase().replaceAll('-', ':');
    const broadcast = raw.broadcast ?? WAKE_DEFAULTS.broadcast;
    if (typeof broadcast !== 'string' || !broadcast.trim()) fail(name, 'wake.broadcast must be an address such as "192.168.1.255"');
    out.broadcast = broadcast.trim();
    const port = raw.port ?? WAKE_DEFAULTS.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(name, 'wake.port must be a whole number from 1 to 65535');
    out.port = port;
  } else if (method === 'command') {
    if (typeof raw.cmd !== 'string' || !raw.cmd.trim()) fail(name, 'wake.cmd must name the program to run');
    out.cmd = raw.cmd;
    const args = raw.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) fail(name, 'wake.args must be a list of words, such as ["-i", "/path/to/key", "wake@192.168.1.109"]');
    out.args = Object.freeze([...args]);
    const env = raw.env ?? [];
    if (!Array.isArray(env) || !env.every((n) => typeof n === 'string' && ENV_NAME.test(n))) fail(name, 'wake.env must be a list of environment variable names, such as ["WAKE_TOKEN"]');
    out.env = Object.freeze([...env]);
    out.timeoutMs = wholeMs(raw, 'timeoutMs', 1000, 600000, name);
  }
  return Object.freeze(out);
}
```

- [ ] **Step 4: Wire it into `src/participant.js` and `src/config.js`**

In `src/participant.js`, add the import and the constructor parameter:

```js
import { isResult } from './result.js';
import { normalizeWake } from './wake.js';

export class Participant {
  constructor({ name, adapter, roles, capabilities = {}, wake = null }) {
```

and, after `this.capabilities = …`:

```js
    // How to wake this participant's machine before a run (factory spec §4.2); warn-only by default.
    this.wake = wake ?? normalizeWake(null, name);
```

In `src/config.js`, add `import { normalizeWake } from './wake.js';`. After the existing `for (const k of ['allowApi', 'preferTwoVendors'])` loop, add:

```js
  if (Object.hasOwn(routing, 'localDown') && !['ask', 'frontier', 'pause'].includes(routing.localDown)) {
    throw new Error(`routing.localDown must be "ask", "frontier" or "pause", but the config has ${JSON.stringify(routing.localDown)}`);
  }
```

and change the `new Participant({ … })` call in the `participants` map to:

```js
    return new Participant({
      name: spec.name,
      adapter: buildAdapter(spec),
      roles: spec.roles,
      capabilities: spec.capabilities ?? {},
      wake: normalizeWake(spec.wake, spec.name),
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/wake.js src/participant.js src/config.js test/wake.test.js test/config.test.js test/participant.test.js
git commit -m "feat: per-participant wake config (warn | wol | command), localDown validated"
```
