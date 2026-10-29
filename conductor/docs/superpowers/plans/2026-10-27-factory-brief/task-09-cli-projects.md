# Task 9: CLI — parsing and project commands

This task puts the Plan 7 rows of Contract 5 on the command line and makes the three `project` commands work end to end. The `brief` command is parsed here and wired in Task 10. Factory commands run **outside** a git repository, so `main` dispatches them before the repository check.

It also builds the shared dispatch of Contract 7 §7.3: `src/cli/factory.js` exports `FACTORY_COMMANDS` (`{ [command]: handler }`) and `runFactoryCommand(cli, ctx)`, and `main()` sends any command found in that table to it. This is the last time a factory plan touches `main.js`: Plans 8, 10 and 11 add their parser cases to `args.js` and their handlers to `FACTORY_COMMANDS`.

**Files:**
- Modify: `src/cli/args.js`, `src/cli/main.js`
- Create: `src/cli/factory.js`
- Test: `test/cli.test.js` (append only), `test/factory-cli.test.js` (create), `test/helpers/factoryCli.js` (create)

**Interfaces:**
- Consumes: `factoryConfig` (Task 1), `validateSlug`, `createProject`, `readProject`, `listProjects` (Task 1), `currentBriefInfo`, `briefPaths`, `ukDate` (Task 4), `loadSession` (Task 6), `findConfig` (`src/cli/config.js`), `EXIT` (`src/cli/main.js`).
- Produces:
  - the `parseCli` results listed in Shared Interfaces (Task 9). The `flags` object keeps exactly its current keys, so the existing `deepEqual`s stay untouched;
  - `FACTORY_COMMANDS` and `runFactoryCommand(cli, ctx) -> Promise<number|null>`, with the `FactoryContext` handed to every handler (Shared Interfaces, Task 9). A handler may return `null` for "not mine" (Contract 7 §7.11), and `main()` then carries on with the ordinary path; Plan 8's `resume` handler uses this.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.js`:

```js
test('parseCli: project and brief commands (values outside flags)', () => {
  assert.deepEqual(parseCli(['project', 'new', 'Acme Ltd']), { command: 'project-new', client: 'Acme Ltd', slug: null, flags: parseCli(['x']).flags });
  assert.equal(parseCli(['project', 'new', 'Acme', 'Ltd']).client, 'Acme Ltd');
  assert.equal(parseCli(['project', 'new', 'Acme Ltd', '--slug', 'acme']).slug, 'acme');
  assert.equal(parseCli(['project', 'list']).command, 'project-list');
  assert.deepEqual(parseCli(['project', 'show', 'acme']).slug, 'acme');
  assert.deepEqual(parseCli(['brief', 'acme', '--notes', 'm.md']), { command: 'brief', slug: 'acme', notes: 'm.md', revise: false, discardDraft: false, flags: parseCli(['x']).flags });
  assert.equal(parseCli(['brief', 'acme']).notes, null, 'no --notes: carry on with an unfinished brief');
  assert.equal(parseCli(['brief', 'acme', '--revise', '--notes', 'm.md']).revise, true);
  assert.equal(parseCli(['brief', 'acme', '--discard-draft']).discardDraft, true);
  assert.equal(parseCli(['project brief for acme']).command, 'run', 'only a bare "project"/"brief" is a subcommand');
  for (const [argv, re] of [
    [['project'], /project needs new, list or show/],
    [['project', 'delete', 'x'], /project needs new, list or show/],
    [['project', 'new'], /project new needs the client's name/],
    [['project', 'list', 'x'], /project list takes no arguments/],
    [['project', 'show'], /project show needs one project name/],
    [['brief'], /brief needs one project name/],
    [['brief', 'a', 'b'], /brief needs one project name/],
    [['brief', 'acme', '--revise'], /brief --revise needs --notes <file>: the notes that say what changes/],
    [['brief', 'acme', '--discard-draft', '--notes', 'm.md'], /--discard-draft cannot be combined with --notes or --revise/],
    [['fix it', '--notes', 'm.md'], /--notes, --revise and --discard-draft only go with conductor brief/],
    [['project', 'list', '--slug', 'x'], /--slug only goes with conductor project new/],
  ]) assert.match(parseCli(argv).error ?? '', re, argv.join(' '));
});

test('the usage text lists the project and brief commands', () => {
  for (const s of ['conductor project new "<client>"', 'conductor project list', 'conductor project show <slug>',
    'conductor brief <slug> --notes <file>', 'conductor brief <slug> --revise --notes <file>', 'conductor brief <slug> --discard-draft']) assert.ok(USAGE.includes(s), s);
});
```

Create `test/helpers/factoryCli.js` (shared with Task 10; helpers live here so no test file imports another test file):

```js
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { main } from '../../src/cli/main.js';

export const tmp = () => mkdtempSync(path.join(tmpdir(), 'fcli-'));
export function capture() { let text = ''; const out = new Writable({ write(c, e, cb) { text += c; cb(); } }); out.text = () => text; return { out, text: () => text }; }
// stdout: a Writable with a text() method (Task 10's interactive()); main: overrides for onSignal / exit.
export async function runMain(argv, { env, cwd = tmp(), isTTY = false, stdin = new PassThrough(), stdout = null, deps, main: over = {} } = {}) {
  const o = stdout ?? capture().out;
  if (!o.text) { let t = ''; const w = o.write.bind(o); o.write = (c, ...rest) => { t += c; return w(c, ...rest); }; o.text = () => t; }
  const code = await main(argv, { cwd, env, stdin, stdout: o, isTTY, onSignal: () => {}, exit: () => {}, ...over, ...(deps ? { factoryDeps: deps } : {}) });
  return { code, out: o.text() };
}
export const envFor = (root) => ({ ...process.env, CONDUCTOR_PROJECTS_ROOT: root, XDG_CONFIG_HOME: tmp(), HOME: tmp() });
```

Create `test/factory-cli.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { saveApprovedBrief } from '../src/factory/brief.js';
import { FACTORY_COMMANDS } from '../src/cli/factory.js';
import { newSession, saveSession } from '../src/factory/briefSession.js';
import { approvedBrief } from './helpers/briefFixtures.js';

import { tmp, runMain, envFor } from './helpers/factoryCli.js';

// Plans 8, 10 and 11 add entries, so this checks Plan 7's four by name, never the whole table.
test('FACTORY_COMMANDS holds the Plan 7 handlers', () => {
  for (const k of ['project-new', 'project-list', 'project-show', 'brief']) assert.equal(typeof FACTORY_COMMANDS[k], 'function', k);
  assert.equal(Object.hasOwn(FACTORY_COMMANDS, 'run'), false, 'ordinary runs still go through the git-repo path');
});

test('a handler that returns null falls through to the ordinary path (Contract 7 §7.11)', async () => {
  FACTORY_COMMANDS.runs = async () => null;            // stand-in for Plan 8's resume handler
  try {
    const r = await runMain(['runs'], { env: envFor(tmp()) });
    assert.equal(r.code, 64);
    assert.match(r.out, /git repository/, 'main carried on to its usual "inside a git repository" check');
  } finally { delete FACTORY_COMMANDS.runs; }
});

test('ctx.config is the loaded config when it has participants, else null (Contract 7 §7.11)', async () => {
  const seen = [];
  const orig = FACTORY_COMMANDS['project-list'];
  FACTORY_COMMANDS['project-list'] = async (cli, ctx) => { seen.push(ctx); return orig(cli, ctx); };
  try {
    const cfg = path.join(tmp(), 'c.json');
    writeFileSync(cfg, JSON.stringify({ factory: { operatorName: 'Malcolm' } }));
    await runMain(['project', 'list', '--config', cfg], { env: envFor(tmp()) });
    writeFileSync(cfg, JSON.stringify({ participants: [], factory: { operatorName: 'Malcolm' } }));
    await runMain(['project', 'list', '--config', cfg], { env: envFor(tmp()) });
  } finally { FACTORY_COMMANDS['project-list'] = orig; }
  assert.equal(seen[0].config, null);
  assert.deepEqual(seen[1].config.participants, []);
  assert.equal(seen[1].factory.operatorName, 'Malcolm');
  for (const k of ['cwd', 'env', 'stdin', 'stdout', 'isTTY', 'onSignal', 'exit', 'factory', 'config', 'deps']) assert.ok(k in seen[1], k);
});

test('project new / list / show work outside a git repository, without a config', async () => {
  const root = path.join(tmp(), 'projects');
  const env = envFor(root);
  const none = await runMain(['project', 'list'], { env });
  assert.equal(none.code, 0);
  assert.match(none.out, /No projects yet\. Make one with: conductor project new "<client name>"/);

  const made = await runMain(['project', 'new', 'Thistle Joinery Ltd', '--slug', 'thistle'], { env });
  assert.equal(made.code, 0, made.out);
  assert.match(made.out, /Made project thistle for "Thistle Joinery Ltd" in .*projects\/thistle\nNext: conductor brief thistle --notes <your meeting notes>/);
  const dup = await runMain(['project', 'new', 'Thistle', '--slug', 'thistle'], { env });
  assert.equal(dup.code, 1);
  assert.match(dup.out, /A project called thistle already exists/);

  await runMain(['project', 'new', 'Acme'], { env });
  const dir = path.join(root, 'thistle');
  saveSession(dir, newSession({ slug: 'thistle', mode: 'new', notes: [], now: new Date('2026-10-27T10:00:00Z') }));
  let list = await runMain(['project', 'list'], { env });
  assert.match(list.out, /acme +Acme +briefing +no brief yet/);
  assert.match(list.out, /thistle +Thistle Joinery Ltd +briefing +brief unfinished \(run: conductor brief thistle\)/);

  saveApprovedBrief(dir, approvedBrief());
  list = await runMain(['project', 'list'], { env });
  assert.match(list.out, /thistle +Thistle Joinery Ltd +briefing +brief v1 approved 27 October 2026; a new version is unfinished/);

  const show = await runMain(['project', 'show', 'thistle'], { env });
  assert.equal(show.code, 0);
  for (const re of [/^Thistle Joinery Ltd \(thistle\)$/m, /^Folder: .*projects\/thistle$/m, /^Status: briefing$/m, /^Created: \d{1,2} [A-Z][a-z]+ \d{4}$/m,
    /^Foundation: not chosen yet \(set when the app is first built\)$/m, /^Approved build: none yet$/m, /^Brief: version 1, approved by Malcolm on 27 October 2026$/m,
    /^ {2}Read it: .*brief-v1\.md$/m, /^Unfinished brief: waiting at the first draft\. Carry on with: conductor brief thistle$/m]) assert.match(show.out, re);
  const missing = await runMain(['project', 'show', 'nope'], { env });
  assert.equal(missing.code, 1);
  assert.match(missing.out, /There is no project called "nope"/);
  const bad = await runMain(['project', 'show', '../etc'], { env });
  assert.equal(bad.code, 64);
  assert.match(bad.out, /is not a usable folder name/);
});

test('a bad factory section in the config is a plain usage error', async () => {
  const cfg = path.join(tmp(), 'c.json');
  writeFileSync(cfg, JSON.stringify({ participants: [], factory: { projectsRoot: 'relative' } }));
  const env = { ...process.env, XDG_CONFIG_HOME: tmp(), HOME: tmp() };
  delete env.CONDUCTOR_PROJECTS_ROOT;
  const r = await runMain(['project', 'list', '--config', cfg], { env });
  assert.equal(r.code, 64);
  assert.match(r.out, /Conductor could not read its config: factory\.projectsRoot must be a full path/);
  const gone = await runMain(['project', 'list', '--config', '/nope/c.json'], { env });
  assert.equal(gone.code, 64);
  assert.match(gone.out, /No config file at \/nope\/c\.json/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/cli.test.js test/factory-cli.test.js`
Expected: FAIL. `project` is parsed as a run request, and `main` answers "Run conductor inside a git repository".

- [ ] **Step 3: Implement `src/cli/args.js`**

- Add to `OPTIONS`: `notes: { type: 'string' }`, `revise: { type: 'boolean' }`, `slug: { type: 'string' }`, `'discard-draft': { type: 'boolean' }`.
- Leave `flags` exactly as it is.
- After the help/version handling, check the subcommands below in order, with the error texts in the tests.
- A bare `project`:
  - `new <client…>`: the client is the rest joined with spaces and trimmed; empty → error;
  - `list`;
  - `show <slug>`: exactly one positional.
- A bare `brief`: exactly one positional slug.
  - `--revise` without `--notes` → error;
  - `--discard-draft` with `--notes` or `--revise` → error.
- Cross-command checks:
  - `--notes`, `--revise` or `--discard-draft` given with any command other than `brief` → error;
  - `--slug` with anything but `project new` → error.
- Slug validity is **not** checked here. The factory command does it, so the message can name the folder rules.
- USAGE: insert these lines after the `doctor` line, aligned with the existing column:

```
  conductor project new "<client>"   make a folder for a new client app (--slug <name> picks its folder name)
  conductor project list             list your client projects
  conductor project show <slug>      show one project and its brief
  conductor brief <slug> --notes <file>            draft a brief from your meeting notes: questions, then your approval
  conductor brief <slug>                           carry on with an unfinished brief
  conductor brief <slug> --revise --notes <file>   make a new version of an approved brief
  conductor brief <slug> --discard-draft           throw away an unfinished brief (your notes are kept)
```

- [ ] **Step 4: Implement `src/cli/main.js` dispatch**

- Add `factoryDeps = {}` to `main`'s options (beside the existing `wakeDeps`).
- Right after the `if (cli.command === 'version') …` line and **before** `const repoDir = await repoRoot(cwd);`, add:
  ```js
  if (Object.hasOwn(FACTORY_COMMANDS, cli.command)) {
    const code = await runFactoryCommand(cli, { cwd, env, stdin, stdout, isTTY, onSignal, exit, deps: factoryDeps });
    if (code !== null) return code;           // null = "not mine": carry on with the ordinary path (Contract 7 §7.11)
  }
  ```
- Import both from `./factory.js`. Nothing else in `main.js` changes here. The only later edit to `main.js` is Plan 8 Task 15, which moves the inline team set-up into `src/cli/prepareRun.js` (`prepareTeam`, Contract 7 §7.11).

- [ ] **Step 5: Implement `src/cli/factory.js` (dispatch and project commands)**

- `FACTORY_COMMANDS = { 'project-new': projectNew, 'project-list': projectList, 'project-show': projectShow, brief: briefCommand }`. Each handler is `async (cli, ctx) -> number | null` (Contract 7 §7.11); `null` means "not mine" and `runFactoryCommand` passes it back to `main()` unchanged. `briefCommand` is the Task 10 placeholder for now.
- `runFactoryCommand(cli, { cwd, env, stdin, stdout, isTTY, onSignal, exit, deps = {} }) -> Promise<number|null>` does the work every factory command shares, then returns `await FACTORY_COMMANDS[cli.command](cli, ctx)`:
  - `print = (s) => stdout.write(\`${s}\n\`)`; `home = env.HOME || homedir()`. The injected `env`'s HOME is used everywhere, never the process's;
  - config path:
    - `--config` given → `findConfig({ flag: cli.flags.config, cwd, env, home })`. If it throws, print the message and return `EXIT.usage`;
    - not given → `try findConfig({ cwd, env, home })`, catching to `null` (project commands need no config);
  - the factory section: with a config path, `JSON.parse(readFileSync(configPath, 'utf8'))` and keep `{ factory: parsed.factory }`; with none, `{}`. `factoryConfig` takes any object with a `factory` key (Task 1), so project commands work with a config that has no `participants`;
  - `factory = factoryConfig(section, { env, home })`. A parse error or a throw prints `Conductor could not read its config: ${e.message}` and returns `EXIT.usage`;
  - `config` (Contract 7 §7.11): when the parsed file has a `participants` array, `try { config = loadConfig(configPath) } catch { config = null }`; otherwise `null`. Project and brief-session commands never need it to be set. A handler that needs participants (Plan 7's `brief`, Plan 8's `build`/`resume`, Plan 11's `change`) calls `loadConfig(ctx.configPath)` itself when `ctx.config` is null, so the operator sees `loadConfig`'s own plain message (`Conductor could not read its config: …`, exit 64);
  - when the command carries a slug (`cli.slug`) and `validateSlug(cli.slug)` fails, print the problem and return `EXIT.usage`;
  - `ctx = { cwd, env, stdin, stdout, isTTY, onSignal, exit, factory, config, deps }` (the Contract 7 §7.11 fields) plus the extras `home`, `print` and `configPath`.
- `factory.js` imports `EXIT` from `./main.js` while `main.js` imports `factory.js`. The cycle is safe because `EXIT` is read only inside functions, never at module load.
- `project-new`:
  - `createProject(ctx.factory.projectsRoot, { client, slug: cli.slug ?? undefined })`;
  - success prints the two lines in the test and returns 0;
  - a plain error prints its message and returns `EXIT.stopped` (1).
- `project-list`:
  - columns padded with `padEnd`: slug, client, status, brief;
  - the brief column comes from a helper `briefLine(dir, slug)`:
    - `currentBriefInfo` null and no session → `no brief yet`;
    - a session only → `brief unfinished (run: conductor brief ${slug})`;
    - approved → `brief v${v} approved ${ukDate}`, plus `; a new version is unfinished` when a session exists;
    - broken → `brief damaged: ${first sentence}`;
  - when `skipped > 0`, print `(${n} folder(s) in ${root} are not projects and were left out.)`.
- `project-show` prints:
  - the name line;
  - `Folder:`, `Status:`, `Created:`;
  - `Foundation:`, which is `${repo} at ${tag}` once set;
  - `Approved build:`, which is `none yet` while `project.approved` is null (Plan 7 never sets it), else `${approved.sha.slice(0, 12)} on ${ukDate(approved.at)}, built from brief v${approved.briefVersion}` (Contract 7 §7.5; written by Plan 8's or Plan 11's gate);
  - `Brief:`, which is `none yet. Make one with: conductor brief ${slug} --notes <file>`, or the version line plus `  Read it:` with the md path, or `damaged: …`;
  - when a session exists, `Unfinished brief: ${stageText}. Carry on with: conductor brief ${slug}`, where `stageText` is:
    - stage draft with no draft yet → `waiting at the first draft`;
    - draft → `waiting for the AI to update the draft`;
    - questions → `${pending.length} question(s) waiting for your answer`;
    - approve → `ready for your approval`.
  - A session that cannot be read → `Unfinished brief: could not be read (run conductor brief ${slug} --discard-draft)`.
- The `brief` command returns `EXIT.usage` with `conductor brief is not ready yet.` until Task 10 replaces it. No test pins that placeholder.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/cli.test.js test/factory-cli.test.js && npm test`
Expected: all PASS, with the existing `cli.test.js` and `cli-e2e.test.js` assertions unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/cli/args.js src/cli/main.js src/cli/factory.js test/cli.test.js test/factory-cli.test.js test/helpers/factoryCli.js
git commit -m "feat(cli): factory command dispatch, conductor project new/list/show and brief argument parsing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
