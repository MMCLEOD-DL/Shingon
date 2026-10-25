# Task 1: Options, findings & tool runner

This task builds the council's foundations. It has no LLM and no members yet:

- **The council options.** They are all off or empty by default.
- **The `Finding` shape and its grading rules.** Grades are blocking, warning or note. Every finding carries a ceiling, `maxGrade`, that the interpreter can never raise it above (index Ruling 6). By default the ceiling is `blocking` only when the tool itself graded the finding blocking, otherwise `warning`. A finding without tool evidence, or one that was already there before the run, has a ceiling of warning.
- **The optional-tool runner.** It finds a CLI on `PATH` (or at a configured path) and runs it with no credentials in its environment. The result is a `ToolRun` with status `ran`, `missing`, `off`, `skipped` or `error`. A missing or broken tool never throws.

**Files:**
- Modify: `src/options.js`
- Create: `src/council/findings.js`, `src/council/tools.js`
- Test: `test/council-findings.test.js`, `test/council-tools.test.js` (new)

**Interfaces:**
- Consumes:
  - `redact` (`src/secrets.js`);
  - `clip` (`src/text.js`);
  - `runCommand` (`src/exec.js`);
  - `strictChildEnv` (`src/secrets.js`).
- Produces: everything listed under "Task 1" in the index's Shared Interfaces: `DEFAULT_OPTIONS` council keys, `GRADES`, `MEMBER_LABEL`, `makeFinding`, `clampGrade`, `findingKey`, `tally`, `findBin`, `resolveTool`, `runTool`, `skipped`, `TOOL_LABEL`.

- [ ] **Step 1: Write the failing tests**

Create `test/council-findings.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFinding, clampGrade, findingKey, tally, GRADES, MEMBER_LABEL } from '../src/council/findings.js';
import { DEFAULT_OPTIONS } from '../src/options.js';

test('council options: off by default, frozen containers', () => {
  assert.equal(DEFAULT_OPTIONS.council, false);
  assert.equal(DEFAULT_OPTIONS.councilFixRounds, 3);
  assert.equal(DEFAULT_OPTIONS.councilToolTimeoutMs, 600000);
  assert.deepEqual(DEFAULT_OPTIONS.councilTools, {});
  assert.deepEqual(DEFAULT_OPTIONS.councilAcceptLicences, []);
  assert.equal(DEFAULT_OPTIONS.councilSemgrepConfig, 'p/default');
  assert.ok(Object.isFrozen(DEFAULT_OPTIONS.councilTools));
  assert.ok(Object.isFrozen(DEFAULT_OPTIONS.councilAcceptLicences));
});

test('grades run blocking > warning > note; clamp only ever lowers', () => {
  assert.deepEqual(GRADES, ['blocking', 'warning', 'note']);
  assert.deepEqual(MEMBER_LABEL, { security: 'Security', legal: 'Legal', correctness: 'Correctness' });
  assert.equal(clampGrade('blocking', 'warning'), 'warning');
  assert.equal(clampGrade('note', 'warning'), 'note');
  assert.equal(clampGrade('warning', 'blocking'), 'warning');
});

test('no tool evidence, or already there before the change: at most a warning', () => {
  assert.equal(makeFinding({ member: 'security', grade: 'blocking', title: 't' }).grade, 'warning');
  assert.equal(makeFinding({ member: 'security', tool: 'semgrep', grade: 'blocking', title: 't', preExisting: true }).grade, 'warning');
  assert.deepEqual(makeFinding({ member: 'security', tool: 'semgrep', grade: 'blocking', title: 't', file: 'a.js', line: 3 }), {
    member: 'security', tool: 'semgrep', grade: 'blocking', maxGrade: 'blocking', title: 't', detail: '', file: 'a.js', line: 3,
    evidence: true, locked: false, preExisting: false, dismissed: false, why: null, fix: null,
  });
  assert.throws(() => makeFinding({ member: 'design', tool: 'x', grade: 'note', title: 't' }), /unknown council member/);
  assert.throws(() => makeFinding({ member: 'legal', tool: 'x', grade: 'fatal', title: 't' }), /unknown grade/);
});

test('the ceiling (maxGrade): only a finding its tool graded blocking can ever block (Ruling 6)', () => {
  const ceiling = (o) => makeFinding({ member: 'security', tool: 'semgrep', title: 't', ...o }).maxGrade;
  assert.equal(ceiling({ grade: 'blocking' }), 'blocking');
  assert.equal(ceiling({ grade: 'warning' }), 'warning');
  assert.equal(ceiling({ grade: 'note' }), 'warning', 'a note may be raised to a warning, never further');
  assert.equal(ceiling({ grade: 'blocking', preExisting: true }), 'warning');
  assert.equal(ceiling({ grade: 'blocking', tool: null }), 'warning');
  const f = makeFinding({ member: 'legal', tool: 'licences', grade: 'blocking', maxGrade: 'warning', title: 't' });
  assert.deepEqual([f.grade, f.maxGrade], ['warning', 'warning'], 'an explicit ceiling also caps the grade');
  assert.throws(() => makeFinding({ member: 'legal', tool: 'x', grade: 'note', maxGrade: 'fatal', title: 't' }), /unknown grade/);
});

test('a finding never carries a secret value; long text is clipped', () => {
  process.env.COUNCIL_TEST_TOKEN = 'sk-test-abcdefgh12345';
  try {
    const f = makeFinding({ member: 'security', tool: 'gitleaks', grade: 'blocking', title: 'leak sk-test-abcdefgh12345', detail: 'x sk-test-abcdefgh12345' });
    assert.doesNotMatch(JSON.stringify(f), /abcdefgh12345/);
  } finally { delete process.env.COUNCIL_TEST_TOKEN; }
  const long = makeFinding({ member: 'legal', tool: 'licences', grade: 'note', title: 'x'.repeat(500), detail: 'y'.repeat(5000) });
  assert.ok(long.title.length <= 260 && long.detail.length <= 2100);
});

test('findingKey ignores line numbers; tally skips set-aside findings', () => {
  const a = makeFinding({ member: 'security', tool: 'semgrep', grade: 'blocking', title: 'eval', file: 'a.js', line: 3 });
  const b = { ...a, line: 9 };
  assert.equal(findingKey(a), 'security|semgrep|a.js|eval');
  assert.equal(findingKey(a), findingKey(b));
  assert.equal(findingKey(makeFinding({ member: 'correctness', grade: 'warning', title: 'gap' })), 'correctness|ai||gap');
  assert.deepEqual(tally([a, { ...b, dismissed: true }, makeFinding({ member: 'legal', tool: 'x', grade: 'note', title: 'n' })]),
    { blocking: 1, warning: 0, note: 1 });
});
```

Create `test/council-tools.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findBin, resolveTool, runTool, skipped } from '../src/council/tools.js';
import { makeFinding } from '../src/council/findings.js';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { writeStubCli } from './helpers/stubCli.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'ctool-'));
const opts = (over = {}) => ({ ...DEFAULT_OPTIONS, ...over });
const parseList = (text) => JSON.parse(text).map((t) => makeFinding({ member: 'security', tool: 'semgrep', grade: 'warning', title: t }));
const base = { member: 'security', name: 'semgrep', label: 'Semgrep (code scanner)', bin: 'semgrep', args: [], install: 'Install: pipx install semgrep' };

test('findBin: a bare name on PATH, executable regular files only', () => {
  const dir = tmp();
  const stub = writeStubCli(dir, 'semgrep', 'console.log(1)');
  writeFileSync(path.join(dir, 'gitleaks'), 'not executable');
  assert.equal(findBin('semgrep', { env: { PATH: `/nonexistent:${dir}` } }), stub);
  assert.equal(findBin('gitleaks', { env: { PATH: dir } }), null);
  assert.equal(findBin('semgrep', { env: { PATH: '' } }), null);
  assert.equal(findBin('../semgrep', { env: { PATH: dir } }), null, 'a name, never a path');
});

test('resolveTool: false turns it off; a configured path wins over PATH', () => {
  const stub = writeStubCli(tmp(), 'my-semgrep', '');
  const env = { PATH: '' };
  assert.deepEqual(resolveTool('semgrep', 'semgrep', { options: opts({ councilTools: { semgrep: false } }), env }), { path: null, off: true });
  assert.deepEqual(resolveTool('semgrep', 'semgrep', { options: opts({ councilTools: { semgrep: stub } }), env }), { path: stub, off: false });
  assert.deepEqual(resolveTool('semgrep', 'semgrep', { options: opts({ councilTools: { semgrep: '/nope/semgrep' } }), env }), { path: null, off: false });
  assert.deepEqual(resolveTool('semgrep', 'semgrep', { options: opts(), env }), { path: null, off: false });
});

test('runTool: not installed and turned off are notes, never failures', async () => {
  const missing = await runTool({ ...base, cwd: tmp(), options: opts({ councilTools: { semgrep: '/nope/semgrep' } }), parse: parseList });
  assert.deepEqual(missing, { tool: 'semgrep', label: 'Semgrep (code scanner)', status: 'missing', findings: [],
    note: 'Semgrep (code scanner) is not installed, so this check did not run. Install: pipx install semgrep' });
  const off = await runTool({ ...base, cwd: tmp(), options: opts({ councilTools: { semgrep: false } }), parse: parseList });
  assert.equal(off.status, 'off');
  assert.equal(off.note, 'Semgrep (code scanner) is turned off in the config.');
  assert.deepEqual(skipped('legal', 'scancode', 'ScanCode (licence scanner)', 'No files changed.'),
    { tool: 'scancode', label: 'ScanCode (licence scanner)', status: 'skipped', findings: [], note: 'No files changed.' });
});

test('runTool: stdout or a {report} file is parsed; the tool gets no credentials', async () => {
  const dir = tmp();
  const out = writeStubCli(dir, 'semgrep', `console.log(JSON.stringify([process.env.MY_SECRET_TOKEN ? 'leaked' : 'clean', process.cwd()]));`);
  const cwd = tmp();
  const env = { ...process.env, MY_SECRET_TOKEN: 'tok-1234567890' };
  const r = await runTool({ ...base, cwd, env, options: opts({ councilTools: { semgrep: out } }), parse: parseList });
  assert.equal(r.status, 'ran');
  assert.equal(r.note, null);
  assert.deepEqual(r.findings.map((f) => f.title), ['clean', cwd]);

  const file = writeStubCli(dir, 'gl', `require('fs').writeFileSync(args[args.indexOf('--report-path') + 1], JSON.stringify(['from-file'])); console.log('banner, not json');`);
  const r2 = await runTool({ ...base, args: ['--report-path', '{report}'], cwd, options: opts({ councilTools: { semgrep: file } }), parse: parseList });
  assert.deepEqual(r2.findings.map((f) => f.title), ['from-file']);
});

test('runTool: garbage output or a hang is a warning, not a crash (Review Focus 1)', async () => {
  const dir = tmp();
  const junk = writeStubCli(dir, 'junk', `console.log('Semgrep 1.2 — please log in'); process.exit(2);`);
  const r = await runTool({ ...base, cwd: tmp(), options: opts({ councilTools: { semgrep: junk } }), parse: parseList });
  assert.equal(r.status, 'error');
  assert.match(r.note, /^Semgrep \(code scanner\) did not finish \(.+\), so this check gave no answer\.$/);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].grade, 'warning');
  assert.equal(r.findings[0].title, 'Semgrep (code scanner) could not run');

  const hang = writeStubCli(dir, 'hang', 'setInterval(() => {}, 1000);');
  const h = await runTool({ ...base, cwd: tmp(), options: opts({ councilTools: { semgrep: hang }, councilToolTimeoutMs: 300 }), parse: parseList });
  assert.equal(h.status, 'error');
  assert.match(h.note, /took longer than the time allowed/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-findings.test.js test/council-tools.test.js`
Expected: FAIL with `Cannot find module '../src/council/findings.js'`, and the `DEFAULT_OPTIONS.council` assertion fails.

- [ ] **Step 3: Add the options**

In `src/options.js`, after `approvePlan`, add:

```js
  council: false,             // true: Security, Legal and Correctness check the finished change before the gate (--council)
  councilFixRounds: 3,        // how many times blocking council findings go back to be fixed before you are asked
  councilToolTimeoutMs: 600000,
  councilTools: Object.freeze({}),          // { semgrep: "/path/to/semgrep" | false }: a path not on PATH, or false to turn a check off
  councilAcceptLicences: Object.freeze([]), // licences you accept for THIS project despite the permissive-only rule, e.g. ["LGPL-3.0-only"]
  councilSemgrepConfig: 'p/default',        // Semgrep rules: a registry pack, or a local rules file to run fully offline
```

- [ ] **Step 4: Implement `src/council/findings.js`**

- `GRADES` and `MEMBER_LABEL` are frozen, exactly as in the index.
- `makeFinding(spec)` behaves as follows:
  - It throws `unknown council member: <m>` or `unknown grade: <g>` on bad input.
  - `title` is `clip(redact(String(title)).split('\n')[0], 200)` and `detail` is `clip(redact(String(detail ?? '')), 2000)`.
  - `line` is an integer or null.
  - `maxGrade` defaults to `grade === 'blocking' ? 'blocking' : 'warning'` and is validated like `grade`. The stored ceiling is `clampGrade(maxGrade, (!evidence || preExisting) ? 'warning' : 'blocking')`.
  - `grade` is `clampGrade(grade, <stored ceiling>)`.
  - Parsers in Tasks 2–4 normally leave `maxGrade` to the default: the grade the tool gives is the ceiling, which is exactly index Ruling 6's block table.
  - It returns the exact key order shown in the test.
- `clampGrade(grade, max)` returns whichever of the two has the higher index in `GRADES`, so the result is never more severe than `max`.
- `findingKey(f)` is `` `${f.member}|${f.tool ?? 'ai'}|${f.file ?? ''}|${f.title}` ``.
- `tally` counts the findings that are not `dismissed`.

- [ ] **Step 5: Implement `src/council/tools.js`**

- `TOOL_LABEL` is copied verbatim from the index.
- `findBin(bin, { env })`:
  - Return `null` when `bin` contains `/`.
  - Otherwise, for each non-empty `env.PATH` entry (split on `path.delimiter`), return the first `path.join(dir, bin)` where `statSync(p).isFile()` and `accessSync(p, constants.X_OK)` succeed. Catch every fs error.
- `resolveTool(name, bin, { options, env })`:
  - Let `v = options.councilTools?.[name]`.
  - `v === false` → `{ path: null, off: true }`.
  - `v` is a non-empty string → `{ path: <v if it is an executable regular file, else null>, off: false }`.
  - Otherwise → `{ path: findBin(bin, { env }), off: false }`.
- `skipped(member, name, label, note)` returns a `ToolRun` with status `skipped` and no findings.
- `runTool(spec)`:
  1. Call `resolveTool`.
     - `off` → status `off`, note `` `${label} is turned off in the config.` ``
     - No path → status `missing`, note `` `${label} is not installed, so this check did not run.${install ? ` ${install}` : ''}` ``
  2. If any arg is exactly `'{report}'`, make `mkdtempSync(path.join(tmpdir(), 'council-'))` and replace that arg with `<dir>/report.json`.
  3. Run `runCommand({ cmd: path, args, cwd, timeoutMs: options.councilToolTimeoutMs, env: strictChildEnv({ env }) })`.
  4. Take `text` from the report file (missing file → error `it wrote no report`), or else from `stdout`. Remove the temp dir in a `finally`.
  5. A timed-out run is an error with why `it took longer than the time allowed`. Otherwise `findings = parse(text, { code, stderr })`, and any throw is an error with why `clip(redact(message), 200)`.
  6. On error, return status `error`. The note is `` `${label} did not finish (${why}), so this check gave no answer.` `` and the one finding is `makeFinding({ member, tool: name, grade: 'warning', title: `${label} could not run`, detail: why })`.
  7. Otherwise return status `ran`, `findings`, note `null`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/council-findings.test.js test/council-tools.test.js && npm test`
Expected: all PASS. The config tests still pass, because `loadConfig` accepts any key of `DEFAULT_OPTIONS`.

- [ ] **Step 7: Commit**

```bash
git add src/options.js src/council test/council-findings.test.js test/council-tools.test.js
git commit -m "feat(council): options, findings model and optional-tool runner"
```
