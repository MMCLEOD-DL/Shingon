# Task 3: Legal member (licences)

On an ordinary repo, the Legal member checks licences only (spec §8 item 2). It applies the permissive-only rule from spec §5a in two ways:

- **Dependency licences.** These come from the npm lockfile, which records each package's `license`. Conductor reads them itself, with no external tool.
  - A dependency **added or changed by this run** that is copyleft, unknown or missing, and that is not dev-only, is a **locked blocking** finding.
  - Only the operator can clear one, by listing the licence (`"LGPL-3.0-only"`) or that one package (`"left-pad@1.3.0"`) in `councilAcceptLicences` for the project. The `name@version` form is the only way to clear a package with a missing or unrecognised licence (index Ruling 6; Operator Question 3).
  - Anything that was already there before, or is dev-only, is a warning, and its ceiling is warning, so the interpreter cannot raise it.
  - A **v1 lockfile** records no licences at all. The check is then skipped with a note asking the operator to update the lockfile, instead of reporting every added package as unlicensed.
- **Copied code.** ScanCode (optional) scans the files this run changed for licence text, which catches code copied from a copyleft project.
  - A copyleft match is blocking but not locked, because the interpreter can set aside a false match, such as a comment that merely mentions the GPL.
  - An unrecognised licence match is a warning (ceiling warning).

**Files:**
- Create: `src/council/licences.js`
- Modify: `test/helpers/councilStubs.js` (add `SCANCODE_GPL`)
- Test: `test/council-legal.test.js` (new)

**Interfaces:**
- Consumes:
  - `makeFinding` (Task 1);
  - `runTool`, `skipped` and `TOOL_LABEL` (Task 1);
  - `readLock`, `lockPackages`, `hasLicenceData` and `lockDelta` (Task 2).
- Produces:
  - `PERMISSIVE`: a frozen array of SPDX ids. `classifyLicence(expr, { accept = [] } = {}) -> 'permissive' | 'copyleft' | 'unknown'`.
  - `licenceFindings(packages, { introduced, accept }) -> Finding[]`. `accept` mixes licence ids and `name@version` entries (an entry whose last `@` is not its first character, so `@scope/pkg@0.1.0` works and no SPDX id matches).
  - `splitAccept(accept) -> { ids: string[], packages: Set<string> }` (lower-cased `name@version`).
  - `parseScancode(text, { accept }) -> Finding[]`.
  - `LEGAL = { member: 'legal', label: 'Legal', alwaysInterpret: false, collect(input) }`. `collect` returns `ToolRun`s in the order `licences`, `scancode`.

- [ ] **Step 1: Add the ScanCode stub to `test/helpers/councilStubs.js`**

```js
// ScanCode: reads the directory given as the last argument and reports GPL for any file that
// contains the GPL's name, written to --json-pp. Paths are relative (as with --strip-root).
export const SCANCODE_GPL = `
  const fs = require('fs'), path = require('path');
  const root = args[args.length - 1];
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(root);
  const out = { files: files.map((p) => ({ path: path.relative(root, p), type: 'file',
    detected_license_expression_spdx: fs.readFileSync(p, 'utf8').includes('GNU General Public License') ? 'GPL-3.0-or-later' : null })) };
  fs.writeFileSync(args[args.indexOf('--json-pp') + 1], JSON.stringify(out));
`;
```

- [ ] **Step 2: Write the failing tests**

Create `test/council-legal.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyLicence, licenceFindings, splitAccept, parseScancode, LEGAL } from '../src/council/licences.js';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { git } from '../src/workspace.js';
import { makeRepo } from './helpers/gitRepo.js';
import { councilStubs, SCANCODE_GPL } from './helpers/councilStubs.js';

test('classifyLicence: SPDX expressions under the permissive-only rule (spec §5a)', () => {
  const table = {
    MIT: 'permissive', mit: 'permissive', 'Apache-2.0': 'permissive', ISC: 'permissive', 'BSD-3-Clause': 'permissive', '0BSD': 'permissive',
    '(MIT OR GPL-3.0-only)': 'permissive', 'MIT AND GPL-2.0': 'copyleft', '(MIT OR Apache-2.0) AND BSD-3-Clause': 'permissive',
    'GPL-2.0-or-later': 'copyleft', 'GPL-2.0+': 'copyleft', 'LGPL-3.0': 'copyleft', 'MPL-2.0': 'copyleft', 'AGPL-3.0-only': 'copyleft',
    'Apache-2.0 WITH LLVM-exception': 'permissive', 'GPL-2.0-only WITH Classpath-exception-2.0': 'copyleft',
    'GPL-3.0-only OR WeirdLicense': 'unknown', 'Proprietary-Foo': 'unknown', UNLICENSED: 'unknown',
    'SEE LICENSE IN LICENSE.md': 'unknown', '(MIT': 'unknown', '': 'unknown',
  };
  for (const [expr, want] of Object.entries(table)) assert.equal(classifyLicence(expr), want, expr);
  assert.equal(classifyLicence(null), 'unknown');
  assert.equal(classifyLicence('LGPL-3.0-only', { accept: ['lgpl-3.0-only'] }), 'permissive', 'the operator accepted it for this project');
});

test('licenceFindings: only an introduced, shipped, non-permissive dependency blocks (locked)', () => {
  const pkgs = [
    { name: 'gpl-lib', version: '1.0.0', license: 'GPL-3.0-only', dev: false },
    { name: 'gpl-dev', version: '1.0.0', license: 'GPL-3.0-only', dev: true },
    { name: 'old-gpl', version: '2.0.0', license: 'AGPL-3.0-only', dev: false },
    { name: 'nolicence', version: '0.1.0', license: null, dev: false },
    { name: 'odd', version: '0.1.0', license: 'Custom-1.0', dev: false },
    { name: 'lgpl-ok', version: '1.0.0', license: 'LGPL-3.0-only', dev: false },
    { name: 'mit', version: '1.0.0', license: 'MIT', dev: false },
    { name: 'gpl-lib', version: '1.0.0', license: 'GPL-3.0-only', dev: false },
  ];
  const f = licenceFindings(pkgs, { introduced: new Set(['gpl-lib', 'gpl-dev', 'nolicence', 'odd', 'lgpl-ok', 'mit']), accept: ['LGPL-3.0-only'] });
  assert.deepEqual(f.map((x) => [x.title, x.grade, x.locked, x.preExisting]), [
    ['gpl-lib 1.0.0 uses GPL-3.0-only, a copyleft licence', 'blocking', true, false],
    ['gpl-dev 1.0.0 uses GPL-3.0-only, a copyleft licence', 'warning', false, false],
    ['old-gpl 2.0.0 uses AGPL-3.0-only, a copyleft licence', 'warning', false, true],
    ['nolicence 0.1.0 has no licence', 'blocking', true, false],
    ['odd 0.1.0 has a licence Conductor does not recognise (Custom-1.0)', 'blocking', true, false],
  ]);
  assert.equal(f[0].tool, 'licences');
  assert.equal(f[0].file, 'package-lock.json');
  assert.match(f[0].detail, /councilAcceptLicences/);
  assert.match(f[0].detail, /name@version/);
  assert.equal(f[1].maxGrade, 'warning', 'a dev-only licence can never be raised to blocking (Ruling 6)');
});

test('councilAcceptLicences: name@version clears one specific package, even with no licence', () => {
  assert.deepEqual(splitAccept(['MIT-like', 'NoLicence@0.1.0', '@scope/pkg@2.0.0']), { ids: ['MIT-like'], packages: new Set(['nolicence@0.1.0', '@scope/pkg@2.0.0']) });
  const pkgs = [
    { name: 'nolicence', version: '0.1.0', license: null, dev: false },
    { name: 'nolicence', version: '0.2.0', license: null, dev: false },
    { name: '@scope/pkg', version: '2.0.0', license: 'GPL-3.0-only', dev: false },
  ];
  const f = licenceFindings(pkgs, { introduced: new Set(['nolicence', '@scope/pkg']), accept: ['nolicence@0.1.0', '@scope/pkg@2.0.0'] });
  assert.deepEqual(f.map((x) => x.title), ['nolicence 0.2.0 has no licence'], 'only the exact version is accepted');
});

test('parseScancode: a copyleft match in a changed file blocks; unrecognised warns; the rest is ignored', () => {
  const text = JSON.stringify({ files: [
    { path: 'src/copied.js', type: 'file', detected_license_expression_spdx: 'GPL-3.0-or-later' },
    { path: 'src/ok.js', type: 'file', detected_license_expression_spdx: 'MIT' },
    { path: 'src', type: 'directory' },
    { path: 'src/odd.js', type: 'file', detected_license_expression_spdx: 'LicenseRef-scancode-unknown' },
    { path: 'src/none.js', type: 'file', detected_license_expression_spdx: null },
  ] });
  const f = parseScancode(text, { accept: [] });
  assert.deepEqual(f.map((x) => [x.file, x.grade, x.locked, x.tool]), [
    ['src/copied.js', 'blocking', false, 'scancode'],
    ['src/odd.js', 'warning', false, 'scancode'],
  ]);
  assert.equal(f[0].title, 'src/copied.js contains text matching GPL-3.0-or-later');
  assert.throws(() => parseScancode('{}', { accept: [] }), /no file list/);
});

async function legalInput(repo, files, options = {}) {
  const baseSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  return { dir: repo, files, changed: new Set(files), baseSha, tests: null, request: 'r', plan: null, diff: '', env: process.env, options: { ...DEFAULT_OPTIONS, ...options } };
}

test('LEGAL.collect: lockfile delta plus ScanCode on changed files only (never lockfiles or package.json)', async () => {
  const lock = (pkgs) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...pkgs } });
  const repo = await makeRepo({ 'package-lock.json': lock({ 'node_modules/left-pad': { version: '1.3.0', license: 'MIT' } }), 'package.json': '{}' });
  writeFileSync(path.join(repo, 'package-lock.json'), lock({ 'node_modules/left-pad': { version: '1.3.0', license: 'MIT' }, 'node_modules/gpl-lib': { version: '1.0.0', license: 'GPL-3.0-only' } }));
  writeFileSync(path.join(repo, 'package.json'), '{ "description": "GNU General Public License" }');
  writeFileSync(path.join(repo, 'copied.js'), '// This program is free software under the GNU General Public License\n');
  const files = ['package-lock.json', 'package.json', 'copied.js', 'deleted.js'];
  const tools = councilStubs(mkdtempSync(path.join(tmpdir(), 'cleg-')), { scancode: SCANCODE_GPL });
  const runs = await LEGAL.collect(await legalInput(repo, files, { councilTools: tools }));
  assert.deepEqual(runs.map((r) => [r.tool, r.status]), [['licences', 'ran'], ['scancode', 'ran']]);
  assert.deepEqual(runs.flatMap((r) => r.findings).map((f) => [f.tool, f.file, f.grade]), [
    ['licences', 'package-lock.json', 'blocking'],
    ['scancode', 'copied.js', 'blocking'],
  ]);
  const accepted = await LEGAL.collect(await legalInput(repo, files, { councilTools: tools, councilAcceptLicences: ['GPL-3.0-only'] }));
  assert.equal(accepted[0].findings.length, 0);
});

test('LEGAL.collect: a v1 lockfile has no licence data, so the licence check is skipped, not failed', async () => {
  const v1 = (deps) => JSON.stringify({ lockfileVersion: 1, dependencies: deps });
  const repo = await makeRepo({ 'package-lock.json': v1({ a: { version: '1.0.0' } }) });
  writeFileSync(path.join(repo, 'package-lock.json'), v1({ a: { version: '1.0.0' }, b: { version: '2.0.0' } }));
  const runs = await LEGAL.collect(await legalInput(repo, ['package-lock.json'], { councilTools: councilStubs(mkdtempSync(path.join(tmpdir(), 'cleg-')), {}) }));
  assert.deepEqual([runs[0].status, runs[0].findings.length, runs[0].note], ['skipped', 0,
    'package-lock.json is in the old format (lockfileVersion 1), which does not record licences, so dependency licences were not checked. Updating it with npm 7 or later (run npm install) lets the council check them.']);
});

test('LEGAL.collect: no lockfile and nothing to scan are skipped with reasons', async () => {
  const runs = await LEGAL.collect(await legalInput(await makeRepo(), [], { councilTools: councilStubs(mkdtempSync(path.join(tmpdir(), 'cleg-')), { scancode: SCANCODE_GPL }) }));
  assert.deepEqual(runs.map((r) => [r.status, r.note]), [
    ['skipped', 'There is no package-lock.json, so dependency licences were not checked (only Node projects are checked in this version).'],
    ['skipped', 'No changed files to scan for copied licensed code.'],
  ]);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/council-legal.test.js`
Expected: FAIL with `Cannot find module '../src/council/licences.js'`.

- [ ] **Step 4: Implement `classifyLicence` in `src/council/licences.js`**

`PERMISSIVE = ['MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Unlicense', 'CC0-1.0', 'Zlib', 'BlueOak-1.0.0', 'Python-2.0', 'BSL-1.0', 'CC-BY-3.0', 'CC-BY-4.0']`. Comparisons are case-insensitive. The grammar is the one the tests do not fully pin down, so write it as follows:

```js
const COPYLEFT = /^(a?gpl|lgpl|mpl|epl|eupl|cddl|cpl|osl|sspl|cc-by-sa|cc-by-nc|sleepycat|rpl|qpl|ms-rl|cecill)/i;
const BEST = ['permissive', 'unknown', 'copyleft'];   // OR takes the best alternative, AND the worst part

export function classifyLicence(expr, { accept = [] } = {}) {
  const raw = typeof expr === 'string' ? expr.trim() : '';
  if (!raw || /^unlicensed$/i.test(raw) || /^see licen[cs]e in/i.test(raw)) return 'unknown';
  const ok = new Set([...PERMISSIVE, ...accept].map((s) => String(s).toLowerCase()));
  const leaf = (id) => {
    const bare = id.replace(/\+$/, '').toLowerCase();
    if (ok.has(id.toLowerCase()) || ok.has(bare)) return 'permissive';
    return COPYLEFT.test(bare) ? 'copyleft' : 'unknown';
  };
  const tokens = raw.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const peek = () => tokens[i]?.toUpperCase();
  const pick = (a, b, best) => (BEST.indexOf(a) <= BEST.indexOf(b)) === best ? a : b;
  function atom() {
    if (tokens[i] === '(') { i++; const v = or(); if (tokens[i++] !== ')') throw new Error('unbalanced'); return v; }
    const id = tokens[i++];
    if (!id || id === ')' || ['AND', 'OR', 'WITH'].includes(id.toUpperCase())) throw new Error('bad token');
    if (peek() === 'WITH') { i++; if (!tokens[i++]) throw new Error('bad exception'); }   // an exception never changes the family
    return leaf(id);
  }
  function and() { let v = atom(); while (peek() === 'AND') { i++; v = pick(v, atom(), false); } return v; }
  function or() { let v = and(); while (peek() === 'OR') { i++; v = pick(v, and(), true); } return v; }
  try { const v = or(); return i === tokens.length ? v : 'unknown'; } catch { return 'unknown'; }
}
```

- [ ] **Step 5: Implement the rest of `src/council/licences.js`**

- `splitAccept(accept)`: entries (as strings) with `s.lastIndexOf('@') > 0` go to `packages`, lower-cased; the rest go to `ids` unchanged.
- `licenceFindings(packages, { introduced, accept = [] })`:
  - Let `{ ids, packages: acceptedPkgs } = splitAccept(accept)`.
  - Dedupe by `name@version`, skip every package whose lower-cased `name@version` is in `acceptedPkgs`, then skip every package that `classifyLicence(license, { accept: ids })` calls `permissive`.
  - `shipped = introduced.has(name) && !dev`.
  - Titles:
    - copyleft → `` `${name} ${version} uses ${license}, a copyleft licence` ``;
    - no licence → `` `${name} ${version} has no licence` ``;
    - otherwise → `` `${name} ${version} has a licence Conductor does not recognise (${license})` ``.
  - Detail:
    - shipped → `'Apps handed to clients may only use permissive licences (MIT, Apache-2.0, BSD, ISC). Replace it, or accept it for this project by adding its licence, or "name@version" for just this package, to "councilAcceptLicences" in conductor.json.'`;
    - dev → `'It is only used while developing, so it is not shipped.'`;
    - otherwise → `'It was already in the project before this change.'`.
  - Call `makeFinding` with:
    - `member: 'legal'`, `tool: 'licences'`, `file: 'package-lock.json'`;
    - `grade`: `shipped ? 'blocking' : 'warning'`;
    - `locked: shipped`;
    - `preExisting: !introduced.has(name)`.
  - Leave `maxGrade` to the default, so the ceiling equals the grade: blocking for a shipped finding, warning for the rest.
- `parseScancode(text, { accept })`:
  - Run `JSON.parse`. A non-array `files` throws `ScanCode gave no file list`.
  - For each entry with `type === 'file'`, let `expr = f.detected_license_expression_spdx ?? (Array.isArray(f.license_expressions) ? f.license_expressions.join(' AND ') : null)`. Skip the entry when `expr` is empty.
  - Classify with `accept`:
    - copyleft → blocking;
    - unknown → warning;
    - permissive → skip.
  - Each finding has `title: `${path} contains text matching ${expr}``, the detail `'This may be code copied from a copyleft project. If it is, it cannot ship: rewrite or remove it.'`, `file: path` (leading `./` stripped), `tool: 'scancode'` and `locked: false`.
- `SCAN_EXCLUDE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|package\.json|(LICEN[CS]E|COPYING|NOTICE)(\.\w+)?)$|(^|\/)node_modules\//i`.
- `LEGAL.collect(input)`:
  1. **licences.**
     - When `readLock(input.dir)` is null, return `skipped` with the exact note in the test.
     - When `!hasLicenceData(head)`, return `skipped` with the exact v1 note in the test.
     - Otherwise return `{ tool: 'licences', label: TOOL_LABEL.licences, status: 'ran', findings: licenceFindings(lockPackages(head), { introduced: lockDelta(lockPackages(await readLock(dir, baseSha)), lockPackages(head)), accept: options.councilAcceptLicences }), note: null }`.
  2. **scancode.**
     - Candidates are `input.files` that are not `SCAN_EXCLUDE`, exist under `input.dir` as regular files of at most 1 MB, and number at most 200.
     - No candidates → `skipped` with the exact note in the test.
     - Otherwise copy them, keeping their relative paths, into `mkdtempSync(path.join(tmpdir(), 'council-scan-'))`.
     - Call `runTool` with `name: 'scancode'`, `bin: 'scancode'`, `args: ['--license', '--strip-root', '--quiet', '-n', '2', '--json-pp', '{report}', scanDir]`, `install: 'Install: pipx install scancode-toolkit (free, runs on this machine; slow on big changes).'` and `parse: (t) => parseScancode(t, { accept: splitAccept(options.councilAcceptLicences).ids })`.
     - Remove `scanDir` in a `finally`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/council-legal.test.js && npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/council/licences.js test/helpers/councilStubs.js test/council-legal.test.js
git commit -m "feat(council): Legal member (lockfile licences against the permissive-only rule, optional ScanCode)"
```
