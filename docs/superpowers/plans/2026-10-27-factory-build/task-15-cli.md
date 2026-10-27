# Task 15: Commands: build, preview, machines

The operator-facing commands (Contract 5, plus `machines` from index Ruling 13):

```
conductor build <project> [--new] [--approve-plan] [--watch-diffs] [--no-bell] [--config <file>]
conductor preview <project> [--stop]
conductor machines [list|sweep]
conductor resume            (inside <projectsRoot>/<project>/ or its app/: carries on that project's unfinished build)
```

- `build`, `preview` and `machines` work from any folder (they find the project under `factory.projectsRoot`), so they skip the "run inside a git repository" check.
- `preview` and `machines` need no AI models: they are handled straight after the config is read.
- `build` goes through the same worker checks, waking and local-fallback consent as a normal run (Plan 4), then calls `runBuild` with the terminal's hooks plus `approveBuild` and `onProgress`.
- Exit codes: `ready` 0 (new), `rejected`/`stopped` 1, `failed` 2, `paused` 3, usage 64, Ctrl-C 130. `preview` and `machines`: 0 on success, 2 on a machine or setup problem.
- **Merging with Plan 7:** Plan 7 also adds subcommands to `src/cli/args.js` and `src/cli/main.js` (`project`, `brief`). Rebase on master and merge by hand; both plans only add entries and branches.

**Files:**
- Create: `src/cli/factory.js`
- Modify: `src/cli/args.js`, `src/cli/main.js`, `src/ui/terminal.js` (`approveBuild`, `NO_TTY_BUILD`), `src/ui/status.js` (`reset()`; a `build-feature` event resets the step list)
- Test: `test/cli-factory.test.js` (new), `test/cli.test.js` (two flag `deepEqual`s gain `stop: false, newBuild: false`), `test/terminal.test.js` (append), `test/status.test.js` (append)

**Interfaces:**
- Consumes: `runBuild` (Task 8), `startPreview`, `stopPreview`, `previewRuns` (Task 14), `getMachineProvider`, `MachineError`, `whenText` (Task 11), `createSsh` (Task 10), `factoryConfig` (Task 1), `latestBuild` (Task 7), `readProject`, `projectDir` (Plan 7 seam), `writeStubCli`, `stubDockerPath`, `stubCurl`, `makeFoundationRepo`, `makeProject`.
- Produces:
  - `parseCli` results `{ command: 'build', slug, flags }`, `{ command: 'preview', slug, flags }`, `{ command: 'machines', action: 'list'|'sweep', flags }`; `flags.stop`, `flags.newBuild`.
  - `src/cli/factory.js`: `projectSlugFor(cwd, projectsRoot) -> slug | null`; `runPreviewCommand({ factory, slug, stop, print, deps }) -> exit code`; `runMachinesCommand({ factory, action, print, deps }) -> exit code`; `buildOutcomeText(out, { slug, client, appDir }) -> string`; `previewText(result, { slug, client }) -> string`.
  - `term.approveBuild({ summary }) -> true | false | { approved: false, note }`; `NO_TTY_BUILD`.
  - `EXIT.ready = 0`.

- [ ] **Step 1: Write the failing tests**

Create `test/cli-factory.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { parseCli } from '../src/cli/args.js';
import { main } from '../src/cli/main.js';
import { projectSlugFor, buildOutcomeText } from '../src/cli/factory.js';
import { git } from '../src/workspace.js';
import { writeStubCli } from './helpers/stubCli.js';
import { stubDockerPath, stubCurl } from './helpers/stubDocker.js';
import { makeFoundationRepo, makeProject } from './helpers/factoryFixtures.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));

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

test('resume inside a project folder finds the project', () => {
  const root = tmp('pr-');
  mkdirSync(path.join(root, 'acme-ltd', 'app', 'apps'), { recursive: true });
  assert.equal(projectSlugFor(path.join(root, 'acme-ltd', 'app', 'apps'), root), 'acme-ltd');
  assert.equal(projectSlugFor(root, root), null);
  assert.equal(projectSlugFor(tmp('else-'), root), null);
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
```

Append to `test/terminal.test.js`:

```js
test('approveBuild: approve, feedback, and no terminal', async () => {
  const a = term({ answers: ['a'] });
  assert.equal(await a.t.approveBuild({ summary: 'Build r1' }), true);
  assert.match(a.text(), /=== The finished app is ready for your approval ===\nBuild r1/);
  const f = term({ answers: ['f', 'Make the totals bold.'] });
  assert.deepEqual(await f.t.approveBuild({ summary: 's' }), { approved: false, note: 'Make the totals bold.' });
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

Run: `node --test test/cli-factory.test.js test/terminal.test.js test/status.test.js test/cli.test.js`
Expected: FAIL.

- [ ] **Step 3: Parse the commands in `src/cli/args.js`**

- `OPTIONS` gains `stop: { type: 'boolean' }` and `new: { type: 'boolean' }`; `flags` gains `stop: v.stop === true, newBuild: v.new === true`; `SUBCOMMANDS` gains `build`, `preview`, `machines`.
- `build`/`preview`: exactly one argument matching `SLUG_RE`; none → `build needs the project's short name, for example: conductor build acme-ltd (see "conductor project list")` (or `preview needs …`); a bad one → `"<arg>" is not a project's short name (see "conductor project list")`.
- `machines`: no argument → `list`; `list` or `sweep`; anything else → `machines takes "list" or "sweep"`.
- `--stop` with any command but `preview` → `--stop only goes with conductor preview`; `--new` with any command but `build` → `--new only goes with conductor build`.
- `USAGE` gains, after `conductor doctor`:
  ```
    conductor build <project>          build a client's app from its approved brief (carries on an unfinished build)
    conductor preview <project>        run the app with demo data on a factory machine and show its address
    conductor preview <project> --stop stop that preview
    conductor machines [list|sweep]    show the factory's machines, or clear ones left over from crashes
  ```
  and under Options: `--new                  with build: start a fresh build instead of carrying on an unfinished one` and `--stop                 with preview: stop the running preview`.
- Update the two flag `deepEqual`s in `test/cli.test.js` (`stop: false, newBuild: false`).

- [ ] **Step 4: Implement `src/cli/factory.js`**

- `projectSlugFor`: `path.relative(projectsRoot, realpath(cwd))`; the first segment when it matches `SLUG_RE`, the path does not start with `..`, and `<projectsRoot>/<slug>/project.json` exists; else `null`.
- `runPreviewCommand`: `stop` → `stopPreview`, print `Stopped the preview of <slug>.` | `There is no preview running for <slug>.` | `The preview's machine was already gone; Conductor cleared its record.`; otherwise `startPreview` and print `previewText`: `The preview of <client>'s app is running (<the build in progress|the approved app>): <url>` / `Open it on a computer or phone on your own network.` / the seeder text / `Stop it with: conductor preview <slug> --stop` (and `The preview is already running` in place of the first line's start for `already`). Errors: a `MachineError` or any error with a plain message → print it, exit 2. Messages are `redact`ed.
- `runMachinesCommand`: `list` → `Factory machines (<kind>):` then `  <id> <name> <host>: <purpose> for <project> since <whenText(createdAt)>` per machine, or `No factory machines are in use.`; `sweep` → `provider.sweep({ olderThanMs: factory.machines.sweepAfterMs, keep: previewRuns(factory.projectsRoot) })` → `Cleared <n> leftover machine<s>.` (`Nothing was left over.` for 0). Then `Note: …` for each `provider.notes` line. For `list`, the machine's `name` is the static host's `name` (or `CT <vmid>` for Proxmox).
- `buildOutcomeText`: as in the test; `rejected` → the reason; `failed`/`stopped`/`paused` → the reason, then `To carry on: conductor build <slug>` unless the reason already names that command, then `Build log: <buildDir>/build-log.jsonl` when `buildDir` is set.

- [ ] **Step 5: Wire it into `src/cli/main.js`**

1. `EXIT` gains `ready: 0`.
2. Straight after `help`/`version`: for `build`, `preview`, `machines` and `resume`, read the config (same message on failure) and `factory = factoryConfig(config)` (a throw prints `Conductor could not read its config: <message>` and returns `EXIT.usage`).
3. `resume` without a workspace argument: `slug = projectSlugFor(cwd, factory.projectsRoot)`; when that project's `latestBuild` is unfinished, treat the command as `{ command: 'build', slug, flags }`.
4. `preview` → `return runPreviewCommand({ factory, slug, stop: cli.flags.stop, print })`; `machines` → `return runMachinesCommand({ factory, action: cli.action, print })`.
5. The git-repository check runs only for the other commands. `build` uses `baseDir` exactly as today.
6. After the team is ready and `hooks`/`overrides` are built: for `build`,
   ```js
   out = await runBuild({ factory, slug: cli.slug, team: built.team, env,
     hooks: { ...hooks, approveBuild: term.approveBuild, onProgress: (t) => term.say(t) },
     options: { ...config.options, ...overrides, ...(cli.flags.newBuild ? { newBuild: true } : {}) }, baseDir, warnings: built.warnings });
   ```
   then `remember()`, print `buildOutcomeText(out, { slug, client: project.client, appDir })` and return `EXIT[out.status] ?? EXIT.failed`. A throw prints `Conductor could not start the build: <redacted message>` and returns `EXIT.usage`. The `INTERRUPTED` text for a build is `Stopped. The build so far is kept. To carry on later, run:  conductor build <slug>`.

- [ ] **Step 6: Terminal and status view**

- `src/ui/terminal.js`: `NO_TTY_BUILD = "There is no terminal to ask you, so the build was not approved and the app's main branch is unchanged. Run Conductor in a terminal to approve it."`; `approveBuild = prompt(async ({ summary }) => …)` prints `\n=== The finished app is ready for your approval ===\n<summary>\n`, then asks `[a] approve: mark the app ready · [f] send feedback to fix · [r] reject > ` (`a` → `true`; `f` → `Your feedback (one line): ` → `{ approved: false, note }`; `r` or end of input → `false`); export it from `createTerminal`'s return value.
- `src/ui/status.js`: move the constructor's field set-up into `reset()` (called by the constructor), and add `case 'build-feature': this.reset(); break;` to `apply`.

- [ ] **Step 7: Run the tests**

Run: `node --test test/cli-factory.test.js test/terminal.test.js test/status.test.js test/cli.test.js && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli/factory.js src/cli/args.js src/cli/main.js src/ui/terminal.js src/ui/status.js test/cli-factory.test.js test/cli.test.js test/terminal.test.js test/status.test.js
git commit -m "feat(cli): conductor build, preview and machines; resume carries on a build"
```
