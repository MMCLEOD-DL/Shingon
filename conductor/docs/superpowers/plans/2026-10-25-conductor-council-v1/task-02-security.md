# Task 2: Security member

The Security member's deterministic half. It runs:

- **Semgrep** (SAST);
- **Gitleaks** (secrets);
- **`npm audit`** (known vulnerable dependencies);
- **a scanner-settings check** that Conductor does itself. If the run changed a file that tells a scanner what to ignore, the operator should look at it.

Each result becomes a graded `Finding`. A Semgrep or Gitleaks result none of whose lines this run added (judged per **line** from `git diff -U0`, so an old problem in a file the run merely touched still counts), or an audit result in a dependency whose version it did not change, is `preExisting`. That means "already there before this change", and it can at most warn (index Ruling 5).

The task also adds the npm lockfile reader that Legal reuses, and a test helper with stub council CLIs.

**Files:**
- Create: `src/council/lockfile.js`, `src/council/security.js`, `test/helpers/councilStubs.js`
- Test: `test/council-security.test.js` (new)

**Interfaces:**
- Consumes:
  - `makeFinding` and `MEMBER_LABEL` (Task 1);
  - `runTool`, `skipped` and `TOOL_LABEL` (Task 1);
  - `git(cwd, args)` (`src/workspace.js`).
- Produces:
  - `lockPackages(lock) -> [{ name, version, license, dev }]`. It reads lockfile v2/v3 `packages`, where the name is the text after the last `node_modules/` in the key. It skips the root `''` key, every key without `node_modules/` (workspace packages: the project's own code) and every `link: true` entry (a link to one of those). It also reads v1 `dependencies`, recursively, when there is no `packages` object. `license` is a string or null. `dev` is `true` only when the entry says `dev: true`; `devOptional: true` stays `false`, because npm sets it on a package that is also an optional dependency of a production dependency, so it can ship. Anything that is not a lockfile gives `[]`.
  - `hasLicenceData(lock) -> boolean`: `true` when `lock.packages` is a plain object (v2/v3). A v1 lockfile never records licences.
  - `readLock(dir, sha = null) -> Promise<object|null>`. With `sha` null it reads `<dir>/package-lock.json`. Otherwise it runs `git show <sha>:package-lock.json` in `dir`. A missing or invalid file gives `null`.
  - `lockDelta(basePkgs, headPkgs) -> Set<string>`: the names that have a `name@version` in head that base does not have.
  - `unquoteGitPath(s) -> string`: git writes a path with unusual characters (quotes, backslashes, control or non-ASCII bytes) as a C-style quoted string, `"a/caf\303\251.js"`. This undoes that (octal bytes decoded as UTF-8). Anything not starting with `"` is returned unchanged.
  - `addedLines(text) -> Map<string, Set<number>>`: from a `git diff -U0` text, the line numbers each file gained. It reads the path from each `+++ b/<path>` line (quoted form unquoted, a trailing tab removed; `+++ /dev/null` means no current file until the next `+++` line, so a deleted file's hunks are ignored) and adds `c … c+d-1` for each `@@ -a,b +c,d @@` hunk (`d` defaults to 1; `d = 0` adds nothing).
  - `isIntroduced({ changed, added }, file, start, end = start) -> boolean`: `false` when `file` is not in `changed`. When `added` is null (line information unknown), `true`. Otherwise `true` only when some line from `start` to `end` is in `added.get(file)`.
  - `parseSemgrep(text, { changed, added }) -> Finding[]`, `parseGitleaks(text, { changed, added }) -> Finding[]`, `parseNpmAudit(text, { introduced }) -> Finding[]`, `settingsTouched(files) -> Finding[]`.
  - `SECURITY = { member: 'security', label: 'Security', alwaysInterpret: false, collect(input) }`. `collect` returns 4 `ToolRun`s in the order `semgrep`, `gitleaks`, `npm-audit`, `settings`.
  - Test helpers: `councilStubs(dir, bodies) -> councilTools`, `SEMGREP_EVAL`, `GITLEAKS_AKIA`, `printJson(value)`, `reportJson(flag, value)`.

- [ ] **Step 1: Write the test helper `test/helpers/councilStubs.js`**

```js
// test/helpers/councilStubs.js
// Stub council CLIs. Tests never run the real semgrep / gitleaks / npm audit / scancode.
import { writeStubCli } from './stubCli.js';

const TOOLS = ['semgrep', 'gitleaks', 'npm-audit', 'scancode'];

// bodies: { semgrep?, gitleaks?, 'npm-audit'?, scancode? } (JS run with `args` in scope).
// Returns options.councilTools: a stub path per given body, false (off) for the rest.
export function councilStubs(dir, bodies = {}) {
  const out = {};
  for (const t of TOOLS) out[t] = bodies[t] ? writeStubCli(dir, `stub-${t}`, bodies[t]) : false;
  return out;
}

export const printJson = (value) => `console.log(${JSON.stringify(JSON.stringify(value))});`;
export const reportJson = (flag, value) =>
  `require('fs').writeFileSync(args[args.indexOf(${JSON.stringify(flag)}) + 1], ${JSON.stringify(JSON.stringify(value))});`;

const WALK = `
  const fs = require('fs'), path = require('path');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(path.relative('.', p));
  } };
  walk('.');
`;

// Semgrep: one ERROR per .js file that contains "eval(".
export const SEMGREP_EVAL = `${WALK}
  const results = files.filter((f) => f.endsWith('.js') && fs.readFileSync(f, 'utf8').includes('eval('))
    .map((f) => ({ check_id: 'javascript.lang.security.eval', path: f, start: { line: 1 },
      extra: { message: 'Untrusted input reaches eval()', severity: 'ERROR' } }));
  console.log(JSON.stringify({ results, errors: [] }));
`;

// Gitleaks: one hit per file holding an AWS-style key, written to --report-path. It includes
// Secret/Match exactly as the real tool does without --redact: Conductor must never read them.
export const GITLEAKS_AKIA = `${WALK}
  const hits = [];
  for (const f of files) {
    const m = fs.readFileSync(f, 'utf8').match(/AKIA[0-9A-Z]{16}/);
    if (m) hits.push({ RuleID: 'aws-access-token', Description: 'AWS Access Key', File: f, StartLine: 1, Secret: m[0], Match: 'key = ' + m[0] });
  }
  fs.writeFileSync(args[args.indexOf('--report-path') + 1], JSON.stringify(hits));
`;
```

- [ ] **Step 2: Write the failing tests**

Create `test/council-security.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lockPackages, hasLicenceData, readLock, lockDelta } from '../src/council/lockfile.js';
import { parseSemgrep, parseGitleaks, parseNpmAudit, settingsTouched, unquoteGitPath, addedLines, isIntroduced, SECURITY } from '../src/council/security.js';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { git } from '../src/workspace.js';
import { makeRepo } from './helpers/gitRepo.js';
import { councilStubs, printJson, SEMGREP_EVAL, GITLEAKS_AKIA } from './helpers/councilStubs.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'csec-'));
const LOCK_V3 = { lockfileVersion: 3, packages: {
  '': { name: 'app' },
  'node_modules/left-pad': { version: '1.3.0', license: 'MIT' },
  'node_modules/a/node_modules/left-pad': { version: '1.1.0', license: 'MIT' },
  'node_modules/gpl-thing': { version: '2.0.0', license: 'GPL-3.0-only', dev: true },
  'node_modules/@scope/pkg': { version: '0.1.0' },
  'node_modules/my-lib': { resolved: 'packages/my-lib', link: true },
  'packages/my-lib': { name: 'my-lib', version: '1.0.0' },
  'node_modules/opt-dev': { version: '1.0.0', license: 'MIT', devOptional: true },
} };

test('lockPackages reads v3 (nested, scoped, dev; links and workspace packages skipped; devOptional ships) and v1; anything else is empty', () => {
  assert.deepEqual(lockPackages(LOCK_V3), [
    { name: 'left-pad', version: '1.3.0', license: 'MIT', dev: false },
    { name: 'left-pad', version: '1.1.0', license: 'MIT', dev: false },
    { name: 'gpl-thing', version: '2.0.0', license: 'GPL-3.0-only', dev: true },
    { name: '@scope/pkg', version: '0.1.0', license: null, dev: false },
    { name: 'opt-dev', version: '1.0.0', license: 'MIT', dev: false },
  ]);
  assert.equal(hasLicenceData(LOCK_V3), true);
  const v1 = { lockfileVersion: 1, dependencies: { x: { version: '1.0.0', dependencies: { y: { version: '2.0.0', dev: true } } } } };
  assert.deepEqual(lockPackages(v1), [
    { name: 'x', version: '1.0.0', license: null, dev: false },
    { name: 'y', version: '2.0.0', license: null, dev: true },
  ]);
  assert.equal(hasLicenceData(v1), false, 'a v1 lockfile records no licences');
  assert.deepEqual(lockPackages(null), []);
  assert.deepEqual(lockPackages({ packages: 'nope' }), []);
  assert.equal(hasLicenceData(null), false);
});

test('addedLines reads git diff -U0, including quoted and spaced paths; isIntroduced works per line', () => {
  const u0 = [
    'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js',
    '@@ -3,0 +4,2 @@ fn', '+x', '+y', '@@ -10 +12 @@', '-old', '+new', '@@ -20,2 +21,0 @@', '-gone', '-gone',
    'diff --git a/my file.js b/my file.js', 'new file mode 100644', '--- /dev/null', '+++ b/my file.js\t', '@@ -0,0 +1 @@', '+z',
    'diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"', '--- "a/caf\\303\\251.js"', '+++ "b/caf\\303\\251.js"', '@@ -1 +1 @@', '-a', '+b',
    'diff --git a/del.js b/del.js', 'deleted file mode 100644', '--- a/del.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-q',
  ].join('\n');
  const added = addedLines(u0);
  assert.deepEqual([...added.keys()], ['src/a.js', 'my file.js', 'café.js']);
  assert.deepEqual([...added.get('src/a.js')], [4, 5, 12]);
  assert.deepEqual([...added.get('my file.js')], [1]);
  assert.equal(unquoteGitPath('"b/x\\"y\\\\z"'), 'b/x"y\\z');
  assert.equal(unquoteGitPath('plain'), 'plain');
  const ctx = { changed: new Set(['src/a.js']), added };
  assert.equal(isIntroduced(ctx, 'src/a.js', 5), true);
  assert.equal(isIntroduced(ctx, 'src/a.js', 1, 3), false, 'an old line in a touched file');
  assert.equal(isIntroduced(ctx, 'src/a.js', 1, 4), true, 'a multi-line result that reaches an added line');
  assert.equal(isIntroduced(ctx, 'old.js', 1), false);
  assert.equal(isIntroduced({ changed: new Set(['old.js']), added: null }, 'old.js', 1), true, 'no line information: the whole changed file counts');
});

test('lockDelta: new names and changed versions only', () => {
  const basePkgs = [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '1.0.0' }];
  const headPkgs = [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '1.1.0' }, { name: 'c', version: '0.1.0' }];
  assert.deepEqual([...lockDelta(basePkgs, headPkgs)].sort(), ['b', 'c']);
});

test('readLock: from the working tree or from a commit; missing is null', async () => {
  const repo = await makeRepo({ 'package-lock.json': JSON.stringify(LOCK_V3) });
  const sha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  writeFileSync(path.join(repo, 'package-lock.json'), '{ broken');
  assert.equal((await readLock(repo, sha)).lockfileVersion, 3);
  assert.equal(await readLock(repo), null);
  assert.equal(await readLock(await makeRepo(), sha), null);
});

const SEMGREP_OUT = { results: [
  { check_id: 'r.eval', path: 'src/a.js', start: { line: 4 }, extra: { message: 'eval of input\nmore', severity: 'ERROR' } },
  { check_id: 'r.weak', path: 'src/a.js', start: { line: 9 }, extra: { message: 'weak hash', severity: 'WARNING' } },
  { check_id: 'r.info', path: 'src/a.js', start: { line: 1 }, extra: { message: 'fyi', severity: 'INFO' } },
  { check_id: 'r.eval', path: 'old.js', start: { line: 2 }, extra: { message: 'eval of input', severity: 'ERROR' } },
] };

test('parseSemgrep: severity → grade; an untouched file is "already there" (Review Focus 2)', () => {
  const f = parseSemgrep(JSON.stringify(SEMGREP_OUT), { changed: new Set(['src/a.js']) });
  assert.deepEqual(f.map((x) => [x.grade, x.title, x.file, x.line, x.preExisting]), [
    ['blocking', 'eval of input', 'src/a.js', 4, false],
    ['warning', 'weak hash', 'src/a.js', 9, false],
    ['note', 'fyi', 'src/a.js', 1, false],
    ['warning', 'eval of input', 'old.js', 2, true],
  ]);
  assert.equal(f[0].tool, 'semgrep');
  assert.match(f[0].detail, /rule r\.eval/);
  assert.throws(() => parseSemgrep('Login required', { changed: new Set() }));
  assert.throws(() => parseSemgrep('{"errors":[]}', { changed: new Set() }), /no results/);
});

test('parseSemgrep and parseGitleaks: an old line in a file this run touched is still "already there" (Ruling 5)', () => {
  const ctx = { changed: new Set(['src/a.js', 'cfg.js']), added: new Map([['src/a.js', new Set([9])], ['cfg.js', new Set([7])]]) };
  const sem = parseSemgrep(JSON.stringify(SEMGREP_OUT), ctx);
  assert.deepEqual(sem.map((x) => [x.line, x.grade, x.preExisting]), [[4, 'warning', true], [9, 'warning', false], [1, 'note', true], [2, 'warning', true]]);
  const multi = parseSemgrep(JSON.stringify({ results: [{ check_id: 'r', path: 'src/a.js', start: { line: 7 }, end: { line: 10 }, extra: { message: 'm', severity: 'ERROR' } }] }), ctx);
  assert.equal(multi[0].grade, 'blocking', 'its lines 7-10 include the added line 9');
  const leaks = parseGitleaks(JSON.stringify([
    { RuleID: 'aws-access-token', Description: 'AWS Access Key', File: 'cfg.js', StartLine: 3, EndLine: 3 },
    { RuleID: 'aws-access-token', Description: 'AWS Access Key', File: 'cfg.js', StartLine: 7, EndLine: 7 },
  ]), ctx);
  assert.deepEqual(leaks.map((x) => [x.line, x.grade, x.preExisting]), [[3, 'warning', true], [7, 'blocking', false]]);
});

test('parseGitleaks: blocking, and the secret value is never read (Review Focus 5)', () => {
  const text = JSON.stringify([
    { RuleID: 'aws-access-token', Description: 'AWS Access Key', File: './cfg.js', StartLine: 3, Secret: 'AKIAABCDEFGHIJKLMNOP', Match: 'k=AKIAABCDEFGHIJKLMNOP' },
    { RuleID: 'generic-api-key', Description: '', File: 'old/x.env', StartLine: 1, Secret: 'zzzzzzzzzzzz', Match: 'zzzzzzzzzzzz' },
  ]);
  const f = parseGitleaks(text, { changed: new Set(['cfg.js']) });
  assert.doesNotMatch(JSON.stringify(f), /AKIAABCDEFGHIJKLMNOP|zzzzzzzzzzzz/);
  assert.deepEqual(f.map((x) => [x.grade, x.title, x.file, x.line, x.preExisting]), [
    ['blocking', 'Possible secret (AWS Access Key)', 'cfg.js', 3, false],
    ['warning', 'Possible secret (generic-api-key)', 'old/x.env', 1, true],
  ]);
  assert.deepEqual(parseGitleaks('', { changed: new Set() }), []);
});

test('parseNpmAudit: high/critical block when introduced; via-only entries are skipped; errors throw', () => {
  const text = JSON.stringify({ vulnerabilities: {
    lodash: { name: 'lodash', severity: 'high', via: [{ title: 'Prototype Pollution', url: 'u' }], fixAvailable: true },
    minimist: { name: 'minimist', severity: 'critical', via: [{ title: 'Prototype Pollution in minimist' }], fixAvailable: false },
    debug: { name: 'debug', severity: 'moderate', via: [{ title: 'ReDoS' }] },
    ms: { name: 'ms', severity: 'low', via: [{ title: 'tiny' }] },
    express: { name: 'express', severity: 'high', via: ['lodash'] },
  } });
  const f = parseNpmAudit(text, { introduced: new Set(['lodash', 'debug', 'ms']) });
  assert.deepEqual(f.map((x) => [x.title, x.grade, x.preExisting]), [
    ['lodash: Prototype Pollution (high)', 'blocking', false],
    ['minimist: Prototype Pollution in minimist (critical)', 'warning', true],
    ['debug: ReDoS (moderate)', 'warning', false],
    ['ms: tiny (low)', 'note', false],
  ]);
  assert.throws(() => parseNpmAudit(JSON.stringify({ error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } }), { introduced: new Set() }), /requires an existing lockfile/);
});

test('settingsTouched: a changed scanner-settings file is a locked warning', () => {
  const f = settingsTouched(['src/a.js', '.gitleaks.toml', 'sub/.semgrepignore']);
  assert.deepEqual(f.map((x) => [x.file, x.grade, x.locked, x.tool]), [
    ['.gitleaks.toml', 'warning', true, 'settings'],
    ['sub/.semgrepignore', 'warning', true, 'settings'],
  ]);
  assert.deepEqual(settingsTouched(['src/a.js', '.npmrc.bak']), []);
});

async function input(repo, over = {}) {
  const baseSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const files = over.files ?? [];
  // added: null = no line information, so a whole changed file counts as introduced (the files here are not committed).
  return { dir: repo, files, changed: new Set(files), added: over.added ?? null, baseSha, tests: null, baseTests: null, request: 'r', plan: null, diff: '', env: process.env, options: { ...DEFAULT_OPTIONS, ...over.options } };
}

test('SECURITY.collect: four checks in order, with exact tool arguments', async () => {
  const repo = await makeRepo({ 'old.js': 'eval(x)\n', 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.20' } } }) });
  writeFileSync(path.join(repo, 'new.js'), 'eval(y)\nconst k = "AKIAABCDEFGHIJKLMNOP";\n');
  writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/minimist': { version: '0.0.8' } } }));
  const echoArgs = `console.log(JSON.stringify({ results: [{ check_id: 'x', path: 'zz.js', start: { line: 1 }, extra: { message: args.join(' '), severity: 'INFO' } }] }));`;
  const tools = councilStubs(tmp(), {
    semgrep: SEMGREP_EVAL, gitleaks: GITLEAKS_AKIA,
    'npm-audit': printJson({ vulnerabilities: { minimist: { severity: 'critical', via: [{ title: 'Prototype Pollution' }] }, lodash: { severity: 'high', via: [{ title: 'Prototype Pollution' }] } } }),
  });
  const runs = await SECURITY.collect(await input(repo, { files: ['new.js', 'package-lock.json'], options: { councilTools: tools } }));
  assert.deepEqual(runs.map((r) => [r.tool, r.status]), [['semgrep', 'ran'], ['gitleaks', 'ran'], ['npm-audit', 'ran'], ['settings', 'ran']]);
  const blocking = runs.flatMap((r) => r.findings).filter((f) => f.grade === 'blocking').map((f) => f.title).sort();
  assert.deepEqual(blocking, ['Possible secret (AWS Access Key)', 'Untrusted input reaches eval()', 'minimist: Prototype Pollution (critical)']);
  assert.ok(runs[0].findings.some((f) => f.file === 'old.js' && f.preExisting && f.grade === 'warning'));
  assert.ok(runs[2].findings.some((f) => f.title.startsWith('lodash') && f.preExisting));

  const args = await SECURITY.collect(await input(repo, { options: { councilTools: councilStubs(tmp(), { semgrep: echoArgs }) } }));
  assert.equal(args[0].findings[0].title, 'scan --config p/default --json --quiet --metrics=off --disable-version-check .');
});

test('SECURITY.collect: no lockfile → the dependency check is skipped with a reason', async () => {
  const runs = await SECURITY.collect(await input(await makeRepo(), { options: { councilTools: councilStubs(tmp(), { 'npm-audit': printJson({}) }) } }));
  assert.equal(runs[2].status, 'skipped');
  assert.equal(runs[2].note, 'There is no package-lock.json, so dependencies were not checked for known security holes (only Node projects are checked in this version).');
  assert.equal(runs[0].status, 'off');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/council-security.test.js`
Expected: FAIL with `Cannot find module '../src/council/lockfile.js'`.

- [ ] **Step 4: Implement `src/council/lockfile.js`**

Follow the Interfaces block. `readLock` with a sha uses `git(dir, ['show', `${sha}:package-lock.json`])` and returns `null` on a non-zero exit or a JSON error.

```js
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const hasLicenceData = (lock) => isObj(lock) && isObj(lock.packages);

export function lockPackages(lock) {
  if (!isObj(lock)) return [];
  const out = [];
  const add = (name, e) => out.push({ name, version: String(e.version ?? ''), license: typeof e.license === 'string' ? e.license : null, dev: e.dev === true });
  if (isObj(lock.packages)) {
    for (const [key, e] of Object.entries(lock.packages)) {
      const at = key.lastIndexOf('node_modules/');
      if (!key || at < 0 || !isObj(e) || e.link === true) continue; // root, workspace packages and links are the project's own code
      add(key.slice(at + 'node_modules/'.length), e);
    }
    return out;
  }
  const walk = (deps) => { for (const [name, e] of Object.entries(isObj(deps) ? deps : {})) if (isObj(e)) { add(name, e); walk(e.dependencies); } };
  walk(lock.dependencies);
  return out;
}
```

- [ ] **Step 5: Implement `src/council/security.js`**

- `unquoteGitPath`, `addedLines` and `isIntroduced` follow the Interfaces block. `unquoteGitPath`:

  ```js
  const ESC = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  export function unquoteGitPath(s) {
    if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
    const body = s.slice(1, -1);
    const bytes = [];
    for (let i = 0; i < body.length; i++) {
      if (body[i] !== '\\') { bytes.push(...Buffer.from(body[i])); continue; }
      const n = body[++i];
      if (/[0-7]/.test(n)) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; } else bytes.push(ESC[n] ?? n.charCodeAt(0));
    }
    return Buffer.from(bytes).toString('utf8');
  }
  ```

- `parseSemgrep(text, { changed, added })`:
  - Run `JSON.parse(text)`; a parse error throws.
  - When `results` is not an array, `throw new Error('Semgrep gave no results list')`.
  - For each result, call `makeFinding` with:
    - `member: 'security'`, `tool: 'semgrep'`;
    - `grade`: `{ ERROR: 'blocking', WARNING: 'warning' }[extra.severity] ?? 'note'`;
    - `title`: the first line of `extra.message` (falling back to `check_id`);
    - `detail`: `` `rule ${check_id}` ``;
    - `file`: `path`, with any leading `./` stripped;
    - `line`: `start.line`;
    - `preExisting`: `!isIntroduced({ changed, added }, file, start.line, end?.line ?? start.line)`.
- `parseGitleaks(text, { changed, added })`:
  - Empty or blank text gives `[]`. Otherwise `JSON.parse`; a non-array throws.
  - Read **only** `RuleID`, `Description`, `File`, `StartLine` and `EndLine`.
  - Each entry becomes a blocking finding titled `` `Possible secret (${Description || RuleID})` ``, with `detail` `` `rule ${RuleID}` ``, the `File` with any leading `./` stripped, `line: StartLine`, and `preExisting: !isIntroduced({ changed, added }, file, StartLine, EndLine ?? StartLine)`.
- `parseNpmAudit(text, { introduced })`:
  - Run `JSON.parse`. When the result has an `error`, `throw new Error(error.summary || error.code || 'npm audit failed')`.
  - For each `[name, v]` of `Object.entries(vulnerabilities ?? {})`, skip the entry when no `via` item is an object.
  - Otherwise the title is `` `${name}: ${firstObjectVia.title || 'a known security hole'} (${v.severity})` ``.
  - The grade is `{ critical: 'blocking', high: 'blocking', moderate: 'warning' }[v.severity] ?? 'note'`.
  - The detail is `v.fixAvailable ? 'An update that fixes it is available.' : 'No fixed version is available yet.'`, the tool is `'npm-audit'`, and `preExisting` is `!introduced.has(name)`.
- `SCANNER_SETTINGS = /(^|\/)(\.gitleaks\.toml|\.gitleaksignore|\.semgrepignore|\.semgrep\.ya?ml|\.npmrc)$/`.
- `settingsTouched(files)` returns one finding for each match, with:
  - `member: 'security'`, `tool: 'settings'`, `grade: 'warning'`, `locked: true`;
  - `title`: `` `This change edits ${file}, which tells a scanner what to ignore` ``;
  - `detail`: `'Check that it does not hide a real problem.'`.
- `SECURITY.collect(input)`:
  1. `runTool` for semgrep:
     - `bin: 'semgrep'`;
     - `args: ['scan', '--config', input.options.councilSemgrepConfig, '--json', '--quiet', '--metrics=off', '--disable-version-check', '.']`;
     - `install: 'Install: pipx install semgrep (free, runs on this machine).'`;
     - `parse: (t) => parseSemgrep(t, input)`.
  2. `runTool` for gitleaks:
     - `bin: 'gitleaks'`;
     - `args: ['detect', '--no-git', '--source', '.', '--report-format', 'json', '--report-path', '{report}', '--redact', '--no-banner', '--exit-code', '0']`;
     - `install: 'Install: the gitleaks release for Linux from github.com/gitleaks/gitleaks (free, runs on this machine).'`.
  3. npm audit:
     - When `readLock(input.dir)` is null, return `skipped(...)` with the exact note in the test.
     - Otherwise `introduced = lockDelta(lockPackages(await readLock(dir, baseSha)), lockPackages(head))`, then `runTool` with name `'npm-audit'`, `bin: 'npm'`, `args: ['audit', '--json', '--package-lock-only']` and `install: 'Install Node.js with npm.'`.
  4. `{ tool: 'settings', label: TOOL_LABEL.settings, status: 'ran', findings: settingsTouched(input.files), note: null }`.

  Every tool uses `cwd: input.dir`, `options: input.options`, `env: input.env` and `member: 'security'`, and its label comes from `TOOL_LABEL`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/council-security.test.js && npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/council test/helpers/councilStubs.js test/council-security.test.js
git commit -m "feat(council): Security member (Semgrep, Gitleaks, npm audit, scanner settings) and lockfile reader"
```
