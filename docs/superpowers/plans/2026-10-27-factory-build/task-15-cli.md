# Task 15: Commands: build, preview, machines

The operator-facing commands. Contract 5 names `build` and `preview`; Contract 7 §7.8 adds `machines`:

```
conductor build <project> [--new] [--approve-plan] [--watch-diffs] [--no-bell] [--config <file>]
conductor preview <project> [--stop]
conductor machines [list|sweep]
conductor resume            (inside <projectsRoot>/<project>/ or its app/: carries on that project's unfinished build)
```

- **Dispatch (Contract 7 §7.3).** The handlers are entries in Plan 7's `FACTORY_COMMANDS` table (`src/cli/factory.js`). Plan 7's `main()` calls `runFactoryCommand` before the "must be inside a git repository" check, so these commands work from any folder.
- `preview` and `machines` need no AI models.
- `build` goes through the same worker checks, waking and local-fallback consent as a normal run (Plan 4). It then calls `runBuild` with the terminal's hooks plus `approveBuild` and `onProgress`.
- Exit codes:
  - `build`: `ready` 0, `rejected`/`stopped` 1, `failed` 2, `paused` 3, usage 64, Ctrl-C 130;
  - `preview` and `machines`: 0 on success, 2 on a machine or setup problem.
- **`main.js`, once more (Contract 7 §7.11).** `build` needs the team preparation that lives inline in `main()`: worker checks, waking, `buildTeam`, the local-down question, usage memory, the Ctrl-C handler, and the hooks and overrides. Copying it would fork Plan 4's behaviour. So this task touches `main.js` **once**, and changes no behaviour: it moves that block, unchanged, into `prepareTeam` in `src/cli/prepareRun.js`, and `main()` calls it. Plan 11's change commands call the same `prepareTeam`.
  - A handler that returns `null` means "not mine here", and `main()` carries on as before: Plan 7's dispatch already does this (§7.11). Only `resume` uses it, to pick up a build when run inside a project folder (Contract 5: "`conductor resume` works for builds").
  - The proof is that `test/cli.test.js` and every other existing CLI test pass unchanged.
- **The lock (Contract 7 §7.11).** `buildCommand` (and so `resume` inside a project) takes `lockProject(projectDir, 'build')` before any team preparation and holds it around `runBuild`, which never takes it. `preview` uses Plan 7's separate `'preview'` lock inside `startPreview`/`stopPreview` (Task 14), so it runs beside a build.
- **Merging with Plan 7:** Plan 7 also adds subcommands to `src/cli/args.js`. Rebase on master and merge by hand; both plans only add entries and branches.

**Files:**
- Create: `src/cli/factoryBuild.js`, `src/cli/prepareRun.js`
- Modify:
  - `src/cli/factory.js` (Plan 7's: register `build`, `preview`, `machines` and `resume` in `FACTORY_COMMANDS`);
  - `src/cli/args.js`;
  - `src/cli/main.js` (the `prepareTeam` move above only);
  - `src/ui/terminal.js` (`approveBuild`, `NO_TTY_BUILD`);
  - `src/ui/status.js` (`reset()`; a `build-feature` event resets the step list).
- Test:
  - `test/cli-factory-build.test.js` (new);
  - `test/cli.test.js`: two flag `deepEqual`s gain `stop: false, newBuild: false`, plus any flag Plan 7 added;
  - `test/terminal.test.js` and `test/status.test.js` (append).

**Interfaces:**
- Consumes:
  - from this plan: `runBuild` (Task 8); `startPreview`, `stopPreview`, `previewRuns` (Task 14); `getMachineProvider`, `MachineError`, `whenText` (Task 11); `createSsh` (Task 10); `SLUG_RE` (Task 1); `latestBuild` (Task 7);
  - from Plan 7: `factoryConfig`, `readProject`, `lockProject`, `FACTORY_COMMANDS`, `runFactoryCommand` (and its `ctx`, Contract 7 §7.11);
  - from the existing code: `loadConfig` (`src/config.js`), `findConfig` (`src/cli/config.js`), `defaultBaseDir` (`src/workspace.js`), `createTerminal` (`src/ui/terminal.js`);
  - test helpers: `writeStubCli`, `stubDockerPath`, `stubCurl`, `makeFoundationRepo`, `makeProject`.
- Produces:
  - `parseCli` results `{ command: 'build', slug, flags }`, `{ command: 'preview', slug, flags }`, `{ command: 'machines', action: 'list'|'sweep', flags }`; `flags.stop`, `flags.newBuild`.
  - `src/cli/factoryBuild.js`:
    - `buildCommand(cli, ctx)`, `previewCommand(cli, ctx)`, `machinesCommand(cli, ctx)`, `resumeBuildCommand(cli, ctx)`: the four `FACTORY_COMMANDS` handlers. `ctx` is Plan 7's `FactoryContext` (Contract 7 §7.11): `{ cwd, env, stdin, stdout, isTTY, onSignal, exit, factory, config, deps }` plus `home`, `print`, `configPath`. Each returns an exit code, or `null` (only `resumeBuildCommand`) for "not a build here".
    - `projectSlugFor(cwd, projectsRoot) -> slug | null`;
    - `runPreviewCommand({ factory, slug, stop, print, deps }) -> exit code`;
    - `runMachinesCommand({ factory, action, print, deps }) -> exit code`;
    - `buildOutcomeText(out, { slug, client, appDir }) -> string`; `previewText(result, { slug, client }) -> string`;
    - `BUILD_EXIT = { ready: 0, rejected: 1, stopped: 1, failed: 2, paused: 3 }`.
  - `src/cli/prepareRun.js`: `prepareTeam({ cli, config, term, env, baseDir, workspaceDir = null, wakeDeps = {}, onSignal, exit, interruptedText }) -> Promise<{ code: number } | { built, hooks, overrides, remember }>` (Contract 7 §7.11's name). This is `main()`'s existing block, moved.
  - `term.approveBuild({ summary }) -> true | false | { note }` (Contract 7 §7.11); `NO_TTY_BUILD`.

The handler shape is fixed by Contract 7 §7.11 (Plan 7 Task 9).

- [ ] **Step 1: Write the failing tests**

Create `test/cli-factory-build.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable, Readable } from 'node:stream';
import { parseCli } from '../src/cli/args.js';
import { main } from '../src/cli/main.js';
import { FACTORY_COMMANDS } from '../src/cli/factory.js';
import { projectSlugFor, buildOutcomeText, resumeBuildCommand } from '../src/cli/factoryBuild.js';
import { git } from '../src/workspace.js';
import { writeStubCli } from './helpers/stubCli.js';
import { stubDockerPath, stubCurl } from './helpers/stubDocker.js';
import { makeFoundationRepo, makeProject } from './helpers/factoryFixtures.js';
import { factoryConfig } from '../src/factory/config.js';
import { lockProject } from '../src/factory/projectLock.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));

test('the handlers are registered in Plan 7\'s factory command table', () => {
  for (const c of ['build', 'preview', 'machines', 'resume']) assert.equal(typeof FACTORY_COMMANDS[c], 'function', c);
});

test('parsing the factory commands', () => {
  assert.deepEqual(parseCli(['build', 'acme-ltd']).command, 'build');
  assert.equal(parseCli(['build', 'acme-ltd', '--new']).flags.newBuild, true);
  assert.equal(parseCli(['preview', 'acme-ltd', '--stop']).flags.stop, true);
  assert.deepEqual([parseCli(['machines']).action, parseCli(['machines', 'sweep']).action], ['list', 'sweep']);
  assert.match(parseCli(['build']).error, /build needs the project's short name, for example: conductor build acme-ltd/);
  assert.match(parseCli(['build', 'Acme Ltd']).error, /"Acme Ltd" is not a project's short name/);
  assert.match(parseCli(['machines', 'nuke']).error, /machines takes "list" or "sweep"/);
  assert.match(parseCli(['x', '--stop']).error, /--stop only goes with conductor preview/);
});

test('resume inside a project folder finds the project; elsewhere it is not a build', async () => {
  const root = tmp('pr-');
  mkdirSync(path.join(root, 'acme-ltd', 'app', 'apps'), { recursive: true });
  writeFileSync(path.join(root, 'acme-ltd', 'project.json'), '{}');
  assert.equal(projectSlugFor(path.join(root, 'acme-ltd', 'app', 'apps'), root), 'acme-ltd');
  assert.equal(projectSlugFor(root, root), null);
  assert.equal(projectSlugFor(tmp('else-'), root), null);
  const config = path.join(tmp('cfg-'), 'conductor.json');
  writeFileSync(config, JSON.stringify({ participants: [], factory: { projectsRoot: root } }));
  const ctx = { cwd: tmp('else-'), env: {}, stdout: new Writable({ write(c, e, cb) { cb(); } }), isTTY: false,
    factory: factoryConfig({ factory: { projectsRoot: root } }, { env: {} }), config: null, configPath: config, deps: {} };
  assert.equal(await resumeBuildCommand(parseCli(['resume', '--config', config]), ctx), null, 'main carries on with an ordinary resume');
  assert.equal(await resumeBuildCommand(parseCli(['resume', '/w/x', '--config', config]), ctx), null, 'a workspace path is never a build');
});

test('build outcome text', () => {
  assert.match(buildOutcomeText({ status: 'ready', buildDir: '/p/builds/r' }, { slug: 'acme-ltd', client: 'Acme Ltd', appDir: '/p/app' }),
    /Done\. Acme Ltd's app is approved and ready\. Its code is on the main branch of \/p\/app\.\nSee it running: conductor preview acme-ltd/);
  assert.match(buildOutcomeText({ status: 'paused', reason: 'Conductor paused: x.', buildDir: '/p/builds/r' }, { slug: 'acme-ltd' }),
    /Conductor paused: x\.\nTo carry on: conductor build acme-ltd\nBuild log: \/p\/builds\/r\/build-log\.jsonl/);
});

// A fully local preview: "ssh" runs the script under bash with stub docker and curl; "scp" copies the file.
async function localFactory() {
  const bin = tmp('bin-');
  stubDockerPath(bin, { seed: 'Demo data added: 2 teams.\nSign in with any of these (password: demo-password-1):\n  admin@demo.test (admin)' });
  stubCurl(bin);
  const ssh = writeStubCli(tmp('ssh-'), 'ssh', `
    const { spawnSync } = require('child_process');
    const r = spawnSync('bash', ['-s'], { input: require('fs').readFileSync(0), env: { ...process.env, PATH: ${JSON.stringify(bin)} + ':' + process.env.PATH } });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status ?? 1);`);
  const scp = writeStubCli(tmp('scp-'), 'scp', `require('fs').copyFileSync(args.at(-2), args.at(-1).split(':').slice(1).join(':'));`);
  const repo = await makeFoundationRepo({ extra: { 'deploy/compose.yaml': 'name: x\n', 'deploy/Caddyfile': ':80\n', 'deploy/Dockerfile': 'FROM x\n', 'deploy/ops.Dockerfile': 'FROM x\n' } });
  const { projectsRoot, projectDir, slug } = makeProject();
  await git(projectDir, ['clone', '-q', repo, 'app']);
  const workRoot = tmp('work-');
  const config = path.join(tmp('cfg-'), 'conductor.json');
  writeFileSync(config, JSON.stringify({ participants: [], factory: { projectsRoot, machines: { sshBin: ssh, scpBin: scp,
    static: { hosts: [{ id: 'ct111', name: 'hf-build', host: '127.0.0.1', workRoot }] } } } }));
  return { config, projectDir, slug, workRoot };
}
function out() { let text = ''; return { stream: new Writable({ write(c, e, cb) { text += c; cb(); } }), text: () => text }; }

test('conductor preview, then machines list, then preview --stop, all against stubbed machines', async () => {
  const f = await localFactory();
  const cwd = tmp('cwd-');   // not a git repository: these commands do not need one
  const o = out();
  assert.equal(await main(['preview', f.slug, '--config', f.config], { cwd, stdout: o.stream, isTTY: false }), 0);
  assert.match(o.text(), /The preview of Acme Ltd's app is running \(the approved app\): http:\/\/127\.0\.0\.1:8080\//);
  assert.match(o.text(), /admin@demo\.test/);
  assert.match(o.text(), /Stop it with: conductor preview acme-ltd --stop/);
  assert.ok(existsSync(path.join(f.projectDir, 'preview.json')));
  const l = out();
  assert.equal(await main(['machines', '--config', f.config], { cwd, stdout: l.stream, isTTY: false }), 0);
  assert.match(l.text(), /ct111 hf-build 127\.0\.0\.1: preview for acme-ltd since \d\d:\d\d \d+ \w{3}/);
  const s = out();
  assert.equal(await main(['preview', f.slug, '--stop', '--config', f.config], { cwd, stdout: s.stream, isTTY: false }), 0);
  assert.match(s.text(), /Stopped the preview of acme-ltd\./);
  assert.equal(existsSync(path.join(f.projectDir, 'preview.json')), false);
  assert.equal(existsSync(path.join(f.workRoot, 'lock')), false);
});

test('a machine problem is a plain message and exit 2', async () => {
  const f = await localFactory();
  const busy = path.join(f.workRoot, 'lock');
  mkdirSync(busy, { recursive: true });
  writeFileSync(path.join(busy, 'owner.json'), JSON.stringify({ factory: 'hf', project: 'bobs-bikes', run: '20261027-100000-aaaa', purpose: 'council', createdAt: new Date().toISOString() }));
  const o = out();
  assert.equal(await main(['preview', f.slug, '--config', f.config], { cwd: tmp('cwd-'), stdout: o.stream, isTTY: false }), 2);
  assert.match(o.text(), /Every factory machine is in use: hf-build is running a council for bobs-bikes/);
  assert.doesNotMatch(o.text(), /at .*\.js:\d+/, 'no stack trace');
});

test('build hands the prepared team, hooks and options to runBuild and maps the outcome to an exit code', async () => {
  const { projectsRoot, projectDir, slug } = makeProject();
  const config = path.join(tmp('cfg-'), 'conductor.json');
  writeFileSync(config, JSON.stringify({ participants: [], factory: { projectsRoot } }));
  const seen = [];
  const deps = {
    prepareTeam: async () => ({ built: { team: { author: {}, reviewer: {}, local: {} }, warnings: [] }, hooks: { escalate: async () => 'reject' }, overrides: { approvePlan: true }, remember: () => {} }),
    runBuild: async (a) => { seen.push(a); return { status: 'paused', runId: 'r', buildDir: '/b', reason: 'Conductor paused: the local model stopped.' }; },
  };
  const o = out();
  const ctx = { cwd: tmp('cwd-'), env: {}, stdin: Readable.from([]), stdout: o.stream, isTTY: false, onSignal: () => {}, exit: () => {}, deps,
    factory: factoryConfig({ factory: { projectsRoot } }, { env: {} }), config: { participants: [], byName: new Map(), routing: {}, options: {}, factory: {} }, configPath: config };
  const code = await FACTORY_COMMANDS.build(parseCli(['build', slug, '--new', '--config', config]), ctx);
  assert.equal(code, 3);
  assert.equal(seen[0].slug, slug);
  assert.deepEqual([seen[0].options.approvePlan, seen[0].options.newBuild], [true, true]);
  assert.equal(typeof seen[0].hooks.approveBuild, 'function');
  assert.match(o.text(), /To carry on: conductor build acme-ltd/);
  // the handler takes the project lock (Contract 7 §7.11): busy → plain message, nothing prepared, nothing built
  const release = lockProject(projectDir, 'change');
  try {
    const b = out();
    assert.equal(await FACTORY_COMMANDS.build(parseCli(['build', slug, '--config', config]), { ...ctx, stdout: b.stream }), 1);
    assert.match(b.text(), /This project is busy: a change is running/);
    assert.equal(seen.length, 1, 'runBuild was not called again');
  } finally { release(); }
});
```

Append to `test/terminal.test.js`:

```js
test('approveBuild: approve, feedback, and no terminal', async () => {
  const a = term({ answers: ['a'] });
  assert.equal(await a.t.approveBuild({ summary: 'Build r1' }), true);
  assert.match(a.text(), /=== The finished app is ready for your approval ===\nBuild r1/);
  const f = term({ answers: ['f', 'Make the totals bold.'] });
  assert.deepEqual(await f.t.approveBuild({ summary: 's' }), { note: 'Make the totals bold.' });
  const n = term({ isTTY: false });
  assert.equal(await n.t.approveBuild({ summary: 's' }), false);
  assert.match(n.text(), /There is no terminal to ask you, so the build was not approved and the app's main branch is unchanged/);
  for (const x of [a, f, n]) x.t.close();
});
```

Append to `test/status.test.js`:

```js
test('a new build feature starts a fresh step list', () => {
  const m = new StatusModel();
  m.apply({ type: 'plan-agreed', chunks: ['Acceptance tests', 'Build it'] });
  m.apply({ type: 'build-feature', index: 1, total: 2, id: 'report', title: 'Monthly report', attempt: 1 });
  assert.deepEqual(m.chunks, []);
  assert.equal(m.plan.status, 'waiting');
});
```

(Use the import name and the initial `plan.status` value that `test/status.test.js` and `src/ui/status.js` already use; `reset()` restores exactly the constructor's state.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/cli-factory-build.test.js test/terminal.test.js test/status.test.js test/cli.test.js`
Expected: FAIL.

- [ ] **Step 3: Parse the commands in `src/cli/args.js`**

- `OPTIONS` gains `stop: { type: 'boolean' }` and `new: { type: 'boolean' }`; `flags` gains `stop: v.stop === true, newBuild: v.new === true`; `SUBCOMMANDS` gains `build`, `preview`, `machines`.
- `build`/`preview`: exactly one argument matching `SLUG_RE` (Task 1). None → `build needs the project's short name, for example: conductor build acme-ltd (see "conductor project list")` (or `preview needs …`). A bad one → `"<arg>" is not a project's short name (see "conductor project list")`.
- `machines`: no argument → `list`; `list` or `sweep`; anything else → `machines takes "list" or "sweep"`.
- `--stop` with any command but `preview` → `--stop only goes with conductor preview`; `--new` with any command but `build` → `--new only goes with conductor build`.
- `USAGE` gains, after Plan 7's lines:
  ```
    conductor build <project>          build a client's app from its approved brief (carries on an unfinished build)
    conductor preview <project>        run the app with demo data on a factory machine and show its address
    conductor preview <project> --stop stop that preview
    conductor machines [list|sweep]    show the factory's machines, or clear ones left over from crashes
  ```
  and under Options: `--new                  with build: start a fresh build instead of carrying on an unfinished one` and `--stop                 with preview: stop the running preview`.
- Update the two flag `deepEqual`s in `test/cli.test.js` (`stop: false, newBuild: false`).

- [ ] **Step 4: Extract `prepareTeam` from `src/cli/main.js` (Contract 7 §7.11; no behaviour change)**

1. Create `src/cli/prepareRun.js`, exporting `prepareTeam`. Move, **unchanged**, the part of `main()` that runs from `let onInterrupt = …` through the building of `overrides` and `hooks`:
   - the Ctrl-C handler for "before the run starts";
   - `Checking which AI models are available…`, the worker memory, `workersToCheck`, `ensureWorkers`, `buildTeam`, `couldNotCheck` and `notBuilt`;
   - the `doctor` branch;
   - the local-down loop and the warnings;
   - the usage tracker and `remember`;
   - the Ctrl-C handler for "after the run starts", with the workspace taken from the `start` event;
   - `overrides` and `hooks`.
2. Every early `return <code>` becomes `return { code: <code> }`. The normal end returns `{ built, hooks, overrides, remember }`.
3. The Ctrl-C messages come from `interruptedText` when given; otherwise they are today's `INTERRUPTED` / `INTERRUPTED_BEFORE_START`, exactly as now.
4. `main()` keeps everything else. It calls `const p = await prepareTeam({ cli, config, term, env, baseDir, workspaceDir, wakeDeps, onSignal, exit }); if ('code' in p) return p.code;`, then runs `runTask`/`resume` exactly as now.
5. Plan 7's dispatch already lets `null` fall through (Contract 7 §7.11); do not touch it.
6. Run `node --test test/cli.test.js test/cli-*.test.js test/terminal.test.js` → PASS **with no existing test edited** apart from the two flag `deepEqual`s in Step 3.

- [ ] **Step 5: Implement `src/cli/factoryBuild.js` and register it**

- **Shared start of every handler:**
  - `print = (s) => ctx.stdout.write(\`${s}\n\`)`.
  - `factory = ctx.factory` (Plan 7 has already read and checked it). `preview` and `machines` need nothing else.
  - `build` needs participants: `config = ctx.config ?? loadConfig(ctx.configPath)` (Contract 7 §7.11). On a failure (or no config path), print `Conductor could not read its config: <message>` and return 64. `resumeBuildCommand` instead returns `null`, so `main()` reports the problem its usual way.
- `projectSlugFor`: `path.relative(projectsRoot, realpath(cwd))`. Returns the first segment when it matches `SLUG_RE`, the path does not start with `..`, and `<projectsRoot>/<slug>/project.json` exists; otherwise `null`.
- `previewCommand` → `runPreviewCommand({ factory, slug: cli.slug, stop: cli.flags.stop, print, deps: ctx.deps })`.
- `runPreviewCommand`:
  - `stop` → `stopPreview`, then print one of `Stopped the preview of <slug>.` | `There is no preview running for <slug>.` | `The preview's machine was already gone; Conductor cleared its record.`
  - Otherwise `startPreview` and print `previewText`:
    - `The preview of <client>'s app is running (<the build in progress|the approved app>): <url>`; for `already`, the line starts `The preview is already running` instead;
    - `Open it on a computer or phone on your own network.`;
    - the seeder text;
    - `Stop it with: conductor preview <slug> --stop`.
  - Errors: a `MachineError`, or any error with a plain message → print it and return 2.
  - Every message is `redact`ed.
- `machinesCommand` → `runMachinesCommand({ factory, action: cli.action, print, deps: ctx.deps })`.
- `runMachinesCommand`:
  - `list` → `Factory machines (<kind>):`, then `  <id> <name> <host>: <purpose> for <project> since <whenText(createdAt)>` for each machine, or `No factory machines are in use.`. `name` is the static host's `name`, or `CT <vmid>` for Proxmox.
  - `sweep` → `provider.sweep({ olderThanMs: factory.machines.sweepAfterMs, keep: previewRuns(factory.projectsRoot) })`, then `Cleared <n> leftover machine<s>.` (`Nothing was left over.` for 0).
  - Then one `Note: …` line for each `provider.notes` entry.
- `buildCommand(cli, ctx)`:
  1. `readProject(factory.projectsRoot, cli.slug)`. Its plain error → print `Conductor could not start the build: <message>`, return 64.
  1a. `release = lockProject(projectDir, 'build')` (Contract 7 §7.11). Its busy message → print it, return 1. Everything after this runs in `try { … } finally { release() }`, before any model is checked or woken. (On Ctrl-C the process exits from `prepareTeam`'s handler; Plan 7's stale-pid recovery clears the left lock.)
  2. `term = createTerminal({ input: ctx.stdin, output: ctx.stdout, isTTY: ctx.isTTY, bell: cli.flags.bell })`; `baseDir = env.CONDUCTOR_BASE_DIR || defaultBaseDir(env)`.
  3. `p = await (ctx.deps?.prepareTeam ?? prepareTeam)({ cli, config, term, env, baseDir, onSignal: ctx.onSignal, exit: ctx.exit, interruptedText: \`Stopped. The build so far is kept. To carry on later, run:  conductor build ${cli.slug}\` })`. If `'code' in p`, return `p.code`.
  4. Call `runBuild` (or `ctx.deps.runBuild` in tests):
     ```js
     out = await runBuild({ factory, slug: cli.slug, team: p.built.team, env,
       hooks: { ...p.hooks, approveBuild: term.approveBuild, onProgress: (t) => term.say(t) },
       options: { ...config.options, ...p.overrides, ...(cli.flags.newBuild ? { newBuild: true } : {}) }, baseDir, warnings: p.built.warnings });
     ```
  5. A throw → `p.remember()`, print `Conductor could not start the build: <redacted message>`, return 64.
  6. Otherwise `p.remember()`, print `buildOutcomeText(out, { slug, client: project.client, appDir: <dir>/app })`, `term.close()`, and return `BUILD_EXIT[out.status] ?? 2`.
- `resumeBuildCommand(cli, ctx)`:
  - Returns `null` when `cli.workspaceDir` is set, the config cannot be read, `projectSlugFor(cwd, factory.projectsRoot)` is `null`, or that project's `latestBuild` is missing or finished (`ready`/`rejected`).
  - Otherwise it returns `buildCommand({ ...cli, command: 'build', slug }, ctx)`.
- `buildOutcomeText`:
  - `ready` → as in the test;
  - `rejected` → the reason;
  - `failed`/`stopped`/`paused` → the reason, then `To carry on: conductor build <slug>` (unless the reason already names that command), then `Build log: <buildDir>/build-log.jsonl` when `buildDir` is set.
- In `src/cli/factory.js` (Plan 7's file), add `build: buildCommand, preview: previewCommand, machines: machinesCommand, resume: resumeBuildCommand` to `FACTORY_COMMANDS`. Change nothing else there.

- [ ] **Step 6: Terminal and status view**

- `src/ui/terminal.js`:
  - `NO_TTY_BUILD = "There is no terminal to ask you, so the build was not approved and the app's main branch is unchanged. Run Conductor in a terminal to approve it."`.
  - `approveBuild = prompt(async ({ summary }) => …)` prints `\n=== The finished app is ready for your approval ===\n<summary>\n`, then asks `[a] approve: mark the app ready · [f] send feedback to fix · [r] reject > `:
    - `a` → `true`;
    - `f` → asks `Your feedback (one line): ` and returns `{ note }` (Contract 7 §7.11);
    - `r` or end of input → `false`.
  - Export it from `createTerminal`'s return value.
- `src/ui/status.js`: move the constructor's field set-up into `reset()` (called by the constructor), and add `case 'build-feature': this.reset(); break;` to `apply`.

- [ ] **Step 7: Run the tests**

Run: `node --test test/cli-factory-build.test.js test/terminal.test.js test/status.test.js test/cli.test.js && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli/factoryBuild.js src/cli/prepareRun.js src/cli/factory.js src/cli/args.js src/cli/main.js src/ui/terminal.js src/ui/status.js test/cli-factory-build.test.js test/cli.test.js test/terminal.test.js test/status.test.js
git commit -m "feat(cli): conductor build, preview and machines as factory commands; resume carries on a build

Moves main()'s team preparation into prepareTeam (src/cli/prepareRun.js)
unchanged, so build reuses it (Contract 7 §7.11).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
