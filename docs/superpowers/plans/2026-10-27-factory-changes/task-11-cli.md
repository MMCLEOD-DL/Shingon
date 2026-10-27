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
- **Dispatch (Contract 7.3).** Plan 11 adds its parser cases to `src/cli/args.js` and its handlers to Plan 7's `FACTORY_COMMANDS` table in `src/cli/factory.js`:
  - `FACTORY_COMMANDS.change = runChangeCommand`;
  - `FACTORY_COMMANDS['foundation-upgrade'] = runUpgradeCommand`.

  It does **not** touch `src/cli/main.js`. Plan 7's `main()` already runs `runFactoryCommand` before the "must be inside a git repo" check, so these commands work from any folder and find the project under `factory.projectsRoot` (`factoryConfig(config).projectsRoot`).
- **No terminal.** `change`, `foundation-upgrade --to` and `--resume` need questions answered (brief questions, the gate, retries). Without a terminal they refuse before anything starts (`NO_TTY_CHANGE`), so no subscription is spent on work that could never be approved. `--check` and `--abandon` ask nothing and work anywhere.
- **Team and brief seat.** They check and wake the workers and build the team exactly as Plan 8's `build` handler does, using the same helper (index "Still open" 2), including asking before the frontier covers for a local model that is down. The brief's author seat comes from Plan 7's `briefAuthorSeat`, and `term.briefIo` from Plan 7's terminal functions (`askBriefQuestion`, `approveBrief`), exactly as Plan 7's `brief --revise` handler builds them.
- **Gate label.** The terminal's `approveBuild` gate (Plan 8) shows Plan 11's `approveLabel` in place of `approve: mark the app ready` when the argument carries one.
- **Words.** `change`/`foundation-upgrade` are subcommands only when a change flag (`--notes`, `--resume`, `--abandon`, `--to`, `--check`) is present or exactly one positional follows. Otherwise they are part of a normal request, so `conductor change the button colour` stays an ordinary run.

**Files:**
- Modify: `src/cli/args.js`, `src/cli/factory.js` (two `FACTORY_COMMANDS` entries), `src/ui/terminal.js` (gate label only)
- Create: `src/cli/change.js`
- Test: `test/cli-change.test.js`, `test/cli.test.js` (append parse cases), `test/terminal.test.js` (append one)

**Interfaces:**
- Consumes:
  - `runChange`, `runFoundationUpgrade`, `resumeChange`, `abandonChange` (Task 9);
  - `securityBehind`, `behindText` (Task 10);
  - `realDeps`, `missingSeams` (Task 1);
  - Plan 7: `runFactoryCommand`, `FACTORY_COMMANDS`, `factoryConfig`, `readProject`, `briefAuthorSeat`;
  - Plan 8: the team helper its `build` handler uses;
  - `createTerminal`; `EXIT` (`src/cli/main.js`).
- Produces:
  - `parseCli` results:
    - `{ command: 'change', slug, notesFile, resume, abandon, flags }`
    - `{ command: 'foundation-upgrade', slug, toTag, resume, abandon, check, flags }`
  - `runChangeCommand(cli, ctx)` and `runUpgradeCommand(cli, ctx)` in `src/cli/change.js`, with Plan 7's handler signature: `ctx = { cwd, env, stdin, stdout, isTTY, onSignal, exit, deps }`. `ctx.deps.change` (tests only) replaces `realDeps()`. Each returns an exit code;
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

(`pick` keeps the listed keys; it drops `flags`.) `--notes` and `--to` may already exist in `OPTIONS` from Plans 7 and 10; reuse them, and add only the flags that are missing. If Plan 7's `brief` case stores `--notes` under the key `notes`, the `change` result still exposes it as `notesFile`.

- [ ] **Step 2: Write the failing command tests**

`test/cli-change.test.js` calls Plan 7's `runFactoryCommand(parseCli([...argv, '--config', cfg, '--no-bell']), { cwd: someNonRepoDir, env, stdin, stdout, isTTY, onSignal, exit, deps: { change: stubDeps() } })`. The config points `factory.projectsRoot` at Task 1's fixture root. One test goes through `main(argv, …)` with `--check` from a folder that is not a git repository, to prove the dispatch order (that path needs no stubs: the fixture deployments are read from disk by `realDeps().listDeployments`).

```js
test('no terminal: change refuses before checking models or touching the project', async () => {
  const code = await runFactoryCommand(parseCli(['change', 'acme', '--notes', notes, …]), { …, isTTY: false });
  assert.equal(code, EXIT.usage);
  assert.match(out.text(), new RegExp(escape(NO_TTY_CHANGE)));
  assert.equal(readdirSync(path.join(projectDir, 'builds')).length, 0);
});
test('--check works without a terminal and outside any git repository', async () => {
  const code = await main(['foundation-upgrade', '--check', …], { …, isTTY: false });
  assert.equal(code, 0);
  assert.match(out.text(), /Newest foundation release: v0\.1\.1\./);
});
test('change and foundation-upgrade are FACTORY_COMMANDS handlers', () => {
  assert.equal(FACTORY_COMMANDS.change, runChangeCommand);
  assert.equal(FACTORY_COMMANDS['foundation-upgrade'], runUpgradeCommand);
});
test('a missing dep is reported plainly and nothing starts', ...)          // deps without releaseApp → code 2, /missing parts it needs for changes \(releaseApp\)/
test('an unknown project is a plain usage error', ...)                     // Plan 7's readProject message, code 64
test('an unreadable notes file is a plain usage error before any model is checked', ...)
test('change end to end with stubs and a scripted terminal: exit 0, the report printed', ...)
  // scripted answers: the brief stub asks nothing, the gate prompt shows 'approve → add to the app and update 2 deployments' → 'a'
test('--abandon works without a terminal and says what it left', ...)
test('the outcome maps to the exit code: rejected 1, stopped 1, paused 3', ...)
```

Append to `test/terminal.test.js`:

```js
test('the build gate shows the approveLabel when one is given', ...)   // '[a] approve → add to the app and update 2 deployments'
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/cli.test.js test/cli-change.test.js test/terminal.test.js`
Expected: the new tests FAIL.

- [ ] **Step 4: Implement**

- **`src/cli/args.js`:** add the missing flags among `notes`, `to` (string), `resume`, `abandon` and `check` (boolean) to `OPTIONS`; add the subcommand rule and the usage lines.
- **`src/ui/terminal.js`:** in Plan 8's `approveBuild`, the prompt's approve item is `` `[a] ${approveLabel ?? 'approve: mark the app ready'}` ``; the rest is unchanged.
- **`src/cli/change.js`:**
  - `factory = factoryConfig(config)` (Plan 7's config load and error text); `deps = ctx.deps?.change ?? realDeps()`; `missingSeams` → exit 2 with `MISSING_SEAMS`;
  - `readProject(factory.projectsRoot, slug)` → plain usage error;
  - `--check` → `securityBehind` + `behindText`, exit 0 (1 when any row could not be checked);
  - `--abandon` → `abandonChange` (no team);
  - otherwise: refuse without a terminal (`NO_TTY_CHANGE`); check the notes file (resolved against `cwd`) can be read; prepare the team (Plan 8's helper) and the brief seat (Plan 7's `briefAuthorSeat`); build `term`; call `runChange`/`runFoundationUpgrade`/`resumeChange`;
  - print `outcome.report` (or `outcome.reason`), and return `EXIT[outcome.status] ?? EXIT.failed`, with `done` mapped to 0;
  - Ctrl-C during a change (through `ctx.onSignal`): `killAllChildren()`, print `INTERRUPTED_CHANGE`, `exit(130)`. Plan 7's lock is taken over later, because its process is gone.
- **`src/cli/factory.js`:** the two `FACTORY_COMMANDS` entries, nothing else.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 6: Commit**

```bash
git add src/cli/args.js src/cli/factory.js src/cli/change.js src/ui/terminal.js test/cli.test.js test/cli-change.test.js test/terminal.test.js
git commit -m "feat(cli): conductor change and conductor foundation-upgrade (with --resume, --abandon, --check)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
