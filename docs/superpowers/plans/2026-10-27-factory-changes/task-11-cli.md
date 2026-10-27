# Task 11: CLI commands

This task puts Plan 11's rows of Contract 5 on the `conductor` command line:

```
conductor change <slug> --notes <file>          change brief → build → full council → gate → ship as an update
conductor change <slug> --resume                continue the project's unfinished change or upgrade
conductor change <slug> --abandon               drop it
conductor foundation-upgrade <slug> --to <tag>  bring a newer foundation release into the app, then the same path
conductor foundation-upgrade <slug> --resume | --abandon
conductor foundation-upgrade --check            which projects and deployments are behind on security fixes
```

Rules:
- These commands work from **any folder**: they find the project under `factory.projectsRoot` (Contract 1), not the current git repository. Dispatch them before the "run inside a git repository" check.
- `change`, `foundation-upgrade --to` and `--resume` need questions answered (brief questions, the gate, retries). **Without a terminal they refuse before anything starts** (`NO_TTY_CHANGE`), so no subscription is spent on work that could never be approved. `--check` and `--abandon` ask nothing and work anywhere.
- They check and wake the workers and build the team exactly as a normal run does (Plan 4), including asking before the frontier covers for a local model that is down.
- The terminal's gate shows Plan 11's `approveLabel` in place of `approve → new branch` when the gate argument carries one.

**Merging with Plans 7, 8 and 10:** those plans also add subcommands and the flags `--notes` and `--to` to `src/cli/args.js`, and need a team in `src/cli/main.js`. If a factory dispatcher or a team-preparing helper already exists on master, add these commands to it and reuse it; add a flag only if it is not already there. Only extract `prepareTeam` (Step 3) if nothing like it exists.

**Files:**
- Modify: `src/cli/args.js`, `src/cli/main.js`, `src/ui/terminal.js` (gate label only)
- Create: `src/cli/change.js`
- Test: `test/cli-change.test.js`, `test/cli.test.js` (append parse cases), `test/terminal.test.js` (append one)

**Interfaces:**
- Consumes: `runChange`, `runFoundationUpgrade`, `resumeChange`, `abandonChange` (Task 9); `securityBehind`, `behindText` (Task 10); `realDeps`, `missingSeams` (Task 1); `deps.projectDirFor`; `createTerminal`, `EXIT`; the worker and team code already in `main.js`.
- Produces:
  - `parseCli` results:
    - `{ command: 'change', slug, notesFile, resume, abandon, flags }`
    - `{ command: 'foundation-upgrade', slug, toTag, resume, abandon, check, flags }`
  - `runChangeCommand(cli, { cwd, env, term, config, deps, team })`, `runUpgradeCommand(…)`, `runUpgradeCheck({ config, deps, print })` in `src/cli/change.js`, each returning an exit code;
  - exit codes: `done` 0, `rejected` and `stopped` 1, `failed` 2, `paused` 3, usage 64, Ctrl-C 130 (the existing `EXIT`, plus `done: 0`);
  - texts:
    - `NO_TTY_CHANGE = 'There is no terminal to ask you, so Conductor did not start. A change needs your answers and your approval: run it in a terminal.'`
    - `INTERRUPTED_CHANGE(slug, cmd)` = `` `Stopped. Nothing was shipped beyond what the report above says. To continue, run:  conductor ${cmd} ${slug} --resume` ``
    - usage errors, e.g. `'change needs a project name and one of --notes <file>, --resume or --abandon'`, `'foundation-upgrade needs a project name and one of --to <tag>, --resume or --abandon, or --check on its own'`, `` `The notes file ${file} could not be read.` ``
  - `USAGE` gains the six lines above.

- [ ] **Step 1: Write the failing parse tests**

Append to `test/cli.test.js`:

```js
test('parseCli: change and foundation-upgrade', () => {
  assert.deepEqual(pick(parseCli(['change', 'acme', '--notes', 'n.md'])), { command: 'change', slug: 'acme', notesFile: 'n.md', resume: false, abandon: false });
  assert.deepEqual(pick(parseCli(['change', 'acme', '--resume'])), { command: 'change', slug: 'acme', notesFile: null, resume: true, abandon: false });
  assert.deepEqual(pick(parseCli(['foundation-upgrade', 'acme', '--to', 'v0.1.1'])), { command: 'foundation-upgrade', slug: 'acme', toTag: 'v0.1.1', resume: false, abandon: false, check: false });
  assert.deepEqual(pick(parseCli(['foundation-upgrade', '--check'])), { command: 'foundation-upgrade', slug: null, toTag: null, resume: false, abandon: false, check: true });
  assert.match(parseCli(['change', 'acme']).error, /change needs a project name and one of --notes/);
  assert.match(parseCli(['change', 'acme', '--notes', 'n', '--resume']).error, /one of/);
  assert.match(parseCli(['change']).error, /change needs a project name/);
  assert.match(parseCli(['foundation-upgrade', 'acme', '--check']).error, /--check on its own/);
  assert.match(parseCli(['foundation-upgrade', 'acme']).error, /one of --to <tag>/);
  assert.match(parseCli(['change', 'a', 'b', '--resume']).error, /one project name/);
});
test('a request that merely starts with the word change is still a normal run when it has more words and no change flags', ...)
  // parseCli(['change', 'the', 'button', 'colour']) → { command: 'run', request: 'change the button colour' }
```

(`pick` keeps the listed keys; it drops `flags`.) The last test protects today's behaviour: `conductor "change the button colour"` passed as several words must not become a change request. Rule: `change`/`foundation-upgrade` are subcommands only when a change flag (`--notes`, `--resume`, `--abandon`, `--to`, `--check`) is present or exactly one positional follows; otherwise they are part of a normal request.

- [ ] **Step 2: Write the failing command tests**

`test/cli-change.test.js` calls `main([...argv, '--config', cfg, '--no-bell'], { cwd: someNonRepoDir, env, stdin, stdout, isTTY, onSignal, exit, changeDeps })`. `main` gains a test-only option `changeDeps` (default `realDeps()`), and the config points `factory.projectsRoot` at Task 1's fixture root.

```js
test('no terminal: change refuses before checking models or touching the project', async () => {
  const code = await main(['change', 'acme', '--notes', notes, …], { …, isTTY: false, changeDeps: stubDeps() });
  assert.equal(code, EXIT.usage);
  assert.match(out.text(), new RegExp(escape(NO_TTY_CHANGE)));
  assert.equal(existsSync(path.join(projectDir, '.conductor-lock')), false);
  assert.equal(readdirSync(path.join(projectDir, 'builds')).length, 0);
});
test('--check works without a terminal and outside any git repository', async () => {
  const code = await main(['foundation-upgrade', '--check', …], { …, isTTY: false, changeDeps: stubDeps() });
  assert.equal(code, 0);
  assert.match(out.text(), /Newest foundation release: v0\.1\.1\./);
});
test('a missing seam is reported plainly and nothing starts', ...)        // changeDeps without releaseApp → code 2, /missing parts it needs for changes \(releaseApp\)/
test('an unknown project is a plain usage error', ...)                     // /There is no project called nope/ (from deps.projectDirFor), code 64
test('an unreadable notes file is a plain usage error before any model is checked', ...)
test('change end to end with stubs and a scripted terminal: exit 0, the report printed', ...)
  // scripted answers: the brief stub asks nothing, the gate prompt shows 'approve → add to the app and update 2 deployments' → 'a'
test('--abandon works without a terminal and says what it left', ...)
test('the outcome maps to the exit code: rejected 1, stopped 1, paused 3', ...)
```

Append to `test/terminal.test.js`:

```js
test('the gate shows the approveLabel when one is given', ...)   // '[a] approve → add to the app and update 2 deployments'
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/cli.test.js test/cli-change.test.js test/terminal.test.js`
Expected: the new tests FAIL.

- [ ] **Step 4: Implement**

- `src/cli/args.js`: add `notes` and `to` (string), `resume`, `abandon`, `check` (boolean) to `OPTIONS` if absent; the subcommand rule from Step 1; the usage lines.
- `src/ui/terminal.js`: in `approveResult`, the prompt is `` `[v] view diff · [a] ${approveLabel ?? 'approve → new branch'} · [r] reject · [n] reject with a note > ` ``.
- `src/cli/main.js`:
  - dispatch `change` and `foundation-upgrade` right after `help`/`version`, before `repoRoot`;
  - load the config as today; `deps = changeDeps ?? realDeps()`; `missingSeams` → exit 2 with `MISSING_SEAMS`;
  - `--check` → `runUpgradeCheck`; `--abandon` → `abandonChange` (no team);
  - otherwise: refuse without a terminal (`NO_TTY_CHANGE`); read the notes file (resolved against `cwd`) to check it exists; then `prepareTeam` and call `runChangeCommand`/`runUpgradeCommand`;
  - Ctrl-C during a change: `killAllChildren()`, print `INTERRUPTED_CHANGE`, `exit(130)` (the lock is taken over later because its process is gone, Task 1).
- Extract `prepareTeam({ config, env, term, wakeDeps, baseDir }) -> { ok: true, team, warnings, approvedFallback } | { ok: false, code }` from the existing run/resume code (worker check and wake, `buildTeam`, the local-down question), and make the existing run/resume path call it, so both share one copy. Existing CLI tests must stay green unchanged.
- `src/cli/change.js`: build `term` hooks, call the pipeline, print `outcome.report` (or `outcome.reason`), return `EXIT[outcome.status] ?? EXIT.failed` with `done` mapped to 0.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 6: Commit**

```bash
git add src/cli/args.js src/cli/main.js src/cli/change.js src/ui/terminal.js test/cli.test.js test/cli-change.test.js test/terminal.test.js
git commit -m "feat(cli): conductor change and conductor foundation-upgrade (with --resume, --abandon, --check)"
```
