# Task 9: `--council` and doctor

This task puts the council on the command line:

- **`--council`** turns it on for one run. `"options": { "council": true }` in a project's `conductor.json` turns it on for every run in that project.
- **`conductor doctor`** lists which optional council tools are installed. That way the operator knows, before a run, which checks will actually happen.

**Files:**
- Modify: `src/cli/args.js`, `src/cli/main.js`
- Test: `test/cli.test.js` (edit two assertions, append), `test/cli-e2e.test.js` (append)

**Interfaces:**
- Consumes: `councilToolStatus` (Task 6); `DEFAULT_OPTIONS`.
- Produces:
  - `parseCli(...).flags.council: boolean`;
  - doctor output section `Council checks (used with --council):`;
  - the run override `council: true`.

- [ ] **Step 1: Update and write the failing tests**

In `test/cli.test.js`, in the test `parseCli: a request, subcommands and flags`, change the two flag lines to:

```js
  const f = parseCli(['fix it', '--config', 'c.json', '--test', 'npm test', '--approve-plan', '--approve-each-chunk', '--watch-diffs', '--keep-workspace', '--no-bell', '--council']).flags;
  assert.deepEqual(f, { config: 'c.json', testCommand: 'npm test', approvePlan: true, approveEachChunk: true, watchDiffs: true, keepWorkspace: true, bell: false, council: true });
  assert.deepEqual(parseCli(['x']).flags, { config: null, testCommand: null, approvePlan: false, approveEachChunk: false, watchDiffs: false, keepWorkspace: false, bell: true, council: false });
```

If Plan 4 has already added flags, keep its keys as well. The point is only that `council` is in both objects.

Append to `test/cli.test.js`:

```js
import { USAGE } from '../src/cli/args.js';

test('the usage text explains --council in plain words', () => {
  assert.match(USAGE, /--council +have specialist reviewers check security, licences and correctness before you approve/);
});
```

Append to `test/cli-e2e.test.js`:

```js
function councilConfig(cfgPath, councilTools) {
  const c = JSON.parse(readFileSync(cfgPath, 'utf8'));
  c.options = { councilTools };
  const out = path.join(tmp(), 'conductor.json');
  writeFileSync(out, JSON.stringify(c));
  return out;
}

test('doctor lists the council checks; --council runs them and the report reaches the gate', async () => {
  const s = await setup();
  try {
    const gl = writeStubCli(tmp(), 'gitleaks', 'console.log("8.21.0")');
    const cfg = councilConfig(s.cfg, { semgrep: false, gitleaks: gl, 'npm-audit': false, scancode: false });
    const d = await spawnBin(['doctor', '--config', cfg], { cwd: s.repo, env: s.env });
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /Council checks \(used with --council\):\n {2}✗ Semgrep \(code scanner\): turned off in the config\n {2}✓ Gitleaks \(secret scanner\)\n/);

    const off = councilConfig(s.cfg, { semgrep: false, gitleaks: false, 'npm-audit': false, scancode: false });
    const r = await spawnBin(['add multiply', '--config', off, '--council'], { cwd: s.repo, env: s.env });
    assert.equal(r.code, 1, r.out); // no TTY at the gate → rejected
    assert.match(r.out, /✓ Council \(round 1\) +approved/);
    assert.match(r.out, /Council report: approved, nothing to fix/);
    assert.match(r.out, /Semgrep \(code scanner\) is turned off in the config\./);
  } finally { await s.close(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/cli.test.js test/cli-e2e.test.js`
Expected: FAIL. `--council` is an unknown option, so parsing errors out, and doctor has no council section.

- [ ] **Step 3: Implement**

`src/cli/args.js`:
- Add `council: { type: 'boolean' }` to `OPTIONS`.
- Add `council: v.council === true` to `flags`.
- Add this USAGE line after `--watch-diffs`, aligned like the others: `  --council              have specialist reviewers check security, licences and correctness before you approve`.

`src/cli/main.js`:
- Import `councilToolStatus` from `../council/index.js` and `DEFAULT_OPTIONS` from `../options.js`.
- The existing block `if (cli.command === 'doctor' || !built.ok) { … }` also runs for a normal run whose team could not be built. Print the council section **only for `doctor`**: inside that block, after the existing `if (built.ok) { … } else { … }` and before `term.close()`, add:

  ```js
      if (cli.command === 'doctor') {
        term.say(['Council checks (used with --council):',
          ...councilToolStatus({ options: { ...DEFAULT_OPTIONS, ...config.options }, env })
            .map((t) => `  ${t.ok ? '✓' : '✗'} ${t.label}${t.ok ? '' : `: ${t.why}`}`)].join('\n'));
      }
  ```

- In `overrides`, add `...(f.council ? { council: true } : {}),`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/cli.test.js test/cli-e2e.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli test/cli.test.js test/cli-e2e.test.js
git commit -m "feat(council): --council flag and council tool status in doctor"
```
