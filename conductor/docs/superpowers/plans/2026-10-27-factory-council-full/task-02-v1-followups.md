# Task 2: Plan 5 follow-ups

The Plan 5 final review left follow-ups in `spikes/council-smoke/RESULT.md`. The ones inside the council are fixed here (index Ruling 12), before the full council builds on them. They apply to ordinary repos and projects alike.

1. **An added `gitleaks:allow` comment hides a key.** Today it raises only the locked "skip-this-line" warning, and the commits are not combined. Now:
   - the suppression check makes a **blocking** Security finding for `gitleaks:allow` on an added line: "This change tells the secret scanner to skip a line, so a key may be hidden there". It is not locked, so the interpreter can set it aside with a reason (for example a plainly fake key in a test fixture). The other markers keep their locked warning;
   - the round treats it like a Gitleaks hit: the file is hidden from the diff in every later prompt, and `secretSeen` is set, so `drive` combines the commits (Plan 5 Ruling 10). On a client build the hook returns the same flag as `secretSeen` and Plan 8 squashes the build branch (Task 12, Contract 7.7).
2. **Semgrep's short `nosem` marker** raises the same warning as `nosemgrep`.
3. **npm 6 `audit` output** (neither `vulnerabilities` nor `advisories`) is treated as an error, not as clean. npm 6's `advisories` format also throws, with "npm audit gave the old npm 6 report, which this version cannot read. Update npm to version 7 or later.", so the check shows as "did not finish" (a warning), never as a silent pass.
4. **An errored check is listed twice** (its warning finding and its "did not finish" note). Now the report lists it once: the error finding's title carries the reason (`Gitleaks (secret scanner) could not run (it wrote no report)`), and `toolNotes` skips ToolRuns with status `error`. The ToolRun keeps its `note`, which the events and doctor still use.

**Files:**
- Modify: `src/council/security.js` (`SUPPRESSION`, `suppressionsAdded`, `parseNpmAudit`), `src/council/findings.js` (`secretHint`), `src/council/tools.js` (error finding title), `src/council/report.js` (`toolNotes`), `src/council/index.js` (hidden files and `secretSeen` also from the `gitleaks:allow` finding)
- Test: `test/council-security.test.js`, `test/council-tools.test.js`, `test/council-report.test.js`, `test/council-round.test.js`, `test/council-drive.test.js` (one existing assertion changes, see Step 3)

**Interfaces:**
- Consumes: Plan 5's `makeFinding`, `isIntroduced`, `hideFiles`, `runCouncilRound`.
- Produces:
  - a Security finding `{ tool: 'settings', grade: 'blocking', locked: false, secretHint: true }` for an added `gitleaks:allow`. `secretHint` is a new optional boolean on findings made by `suppressionsAdded`; `makeFinding` copies it through (default `false`);
  - `runCouncilRound` hides the file of every non-`preExisting` finding where `f.tool === 'gitleaks' || f.secretHint`, and sets `secretSeen` from the same set.

- [ ] **Step 1: Write the failing tests**

In `test/council-security.test.js`, replace the first `suppressionsAdded` test's expectations and add two tests:

```js
test('suppressionsAdded: an added gitleaks:allow is a blocking possible secret; other markers stay locked warnings', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'a.js'), 'eval(x) // nosemgrep\nconst k = 1; // gitleaks:allow\nrun(); // nosemgrep\n');
  writeFileSync(path.join(dir, 'b.py'), 'x = 1  # nosec\n');
  const added = new Map([['a.js', new Set([2])], ['b.py', new Set()]]);
  const f = suppressionsAdded({ dir, files: ['a.js', 'b.py'], changed: new Set(['a.js', 'b.py']), added, wholeFiles: new Set(['b.py']) });
  assert.deepEqual(f.map((x) => [x.file, x.line, x.grade, x.locked, x.secretHint]), [
    ['a.js', 2, 'blocking', false, true],
    ['b.py', 1, 'warning', true, false],
  ]);
  assert.equal(f[0].title, 'This change tells the secret scanner to skip a line, so a key may be hidden there');
});

test('suppressionsAdded: the short nosem marker counts', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'c.js'), 'eval(x) // nosem\n');
  const f = suppressionsAdded({ dir, files: ['c.js'], changed: new Set(['c.js']), added: new Map([['c.js', new Set([1])]]) });
  assert.deepEqual(f.map((x) => [x.line, x.grade]), [[1, 'warning']]);
});

test('parseNpmAudit: npm 6 output is an error, not clean', () => {
  assert.throws(() => parseNpmAudit(JSON.stringify({ advisories: {}, metadata: {} }), { introduced: new Set() }), /old npm 6 report/);
  assert.throws(() => parseNpmAudit(JSON.stringify({ metadata: {} }), { introduced: new Set() }), /npm audit gave no list of vulnerabilities/);
  assert.deepEqual(parseNpmAudit(JSON.stringify({ vulnerabilities: {} }), { introduced: new Set() }), []);
});
```

In `test/council-tools.test.js`, the errored-run test also asserts `r.findings[0].title` matches `/^Semgrep \(code scanner\) could not run \(.+\)$/`.

In `test/council-report.test.js`:

```js
test('an errored check is listed once, as its warning', () => {
  const run = { tool: 'gitleaks', label: 'Gitleaks (secret scanner)', status: 'error', note: 'Gitleaks (secret scanner) did not finish (it wrote no report), so this check gave no answer.',
    findings: [makeFinding({ member: 'security', tool: 'gitleaks', grade: 'warning', title: 'Gitleaks (secret scanner) could not run (it wrote no report)' })] };
  const r = buildReport({ round: 1, findings: run.findings, toolRuns: [run], by: null });
  assert.deepEqual(r.toolNotes, []);
  assert.equal(r.text.split('Gitleaks').length - 1, 1);
});
```

In `test/council-round.test.js`, a round whose Security stub reports nothing but whose new file carries `// gitleaks:allow` on an added line ends with `state.council.secretSeen === true`, and the Legal and Correctness prompts show `(changes to new.js hidden: the secret scanner found a possible secret in it)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-security.test.js test/council-tools.test.js test/council-report.test.js test/council-round.test.js`
Expected: FAIL on each new assertion.

- [ ] **Step 3: Implement**

- `security.js`:
  - `SUPPRESSION = /nosemgrep|\bnosem\b|gitleaks:allow|\bnosec\b/i`;
  - in `suppressionsAdded`, when `m[0].toLowerCase() === 'gitleaks:allow'`, make `{ grade: 'blocking', locked: false, secretHint: true, title: <exact title above>, detail: 'Remove the comment and the key, and keep the key out of the code.' }`; otherwise the existing locked warning;
  - `parseNpmAudit`: after the `error` check, if `data.advisories` is an object, throw `npm audit gave the old npm 6 report, which this version cannot read. Update npm to version 7 or later.`; if `data.vulnerabilities` is not an object, throw `npm audit gave no list of vulnerabilities`.
- `findings.js`: `makeFinding` copies `secretHint: Boolean(spec.secretHint)`.
- `tools.js`: the error finding's title becomes `${label} could not run (${why})` (`makeFinding` clips it at 200).
- `report.js`: `toolNotes` keeps only runs with status `missing`, `off` or `skipped`.
- `index.js`: the hidden-files line becomes `if ((f.tool === 'gitleaks' || f.secretHint) && !f.preExisting && f.file) hidden.add(f.file);`.
- `test/council-drive.test.js` line ~124: replace the "did not finish" match with `/Gitleaks \(secret scanner\) could not run \(.+\)/`. That is the only existing assertion this task changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/security.js src/council/findings.js src/council/tools.js src/council/report.js src/council/index.js test/council-security.test.js test/council-tools.test.js test/council-report.test.js test/council-round.test.js test/council-drive.test.js
git commit -m "fix(council): gitleaks:allow counts as a possible secret, nosem marker, npm 6 audit, errored checks listed once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
