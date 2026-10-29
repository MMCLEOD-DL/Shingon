# Task 13: Wiring, status and doctor

This task makes `conductor build` use the full council, shows its progress in plain words, extends doctor, and finishes the Plan 5 follow-ups that live in the UI (index Ruling 12).

1. **Wire the hook.** Factory commands are dispatched through `FACTORY_COMMANDS` (Contract 7.3); `main.js` is not touched for this. Plan 8's `build` handler is `buildCommand` in `src/cli/factoryBuild.js` (Plan 8 Task 15; `resume` inside a project goes through it too). Where it builds the hooks for `runBuild`, add:
   ```js
   council: (a) => runProjectCouncil({ ...a, onEvent: (e) => { a.onEvent?.(e); const line = councilProgressLine(e); if (line) term.say(line); } }, { options: config.options })
   ```
   `a` is Plan 8's full hook argument object, `checks` and `factory` included (Contract 7.7), passed through unchanged. `term.say` is what the build handler already uses for progress lines (its `hooks.onProgress`); `config` is the handler's `ctx.config ?? loadConfig(ctx.configPath)` (Contract 7.11). With this in place, Plan 8's `NO_COUNCIL_YET` sentence no longer appears.
2. **Progress lines.** `councilProgressLine(event) -> string | null`:

   | Event | Line |
   |---|---|
   | `council-start` | `Council round <n>: <labels joined by ", ">` |
   | `council-evidence` `reuse:ok` | `Council: using the build's own checks for this version.` |
   | `council-evidence` `gates:start` | `Council: running the checks the build did not cover (axe, or missing reports)…` |
   | `council-evidence` `acquire:start` | `Council: starting a test machine…` |
   | `council-evidence` `smoke:start` | `Council: deploying on test machine <id>: backup, restore, alerts and updates (10–20 minutes)…` |
   | `council-evidence` `cached` | `Council: using the checks already done for this version.` |
   | `council-evidence` with status `error` | `Council: <stage words> did not finish.` |
   | `council-member` `interpreting` | `Council: <Label> is being read by the reviewer…` |
   | `council-verdict` | `Council round <n>: approved` / `approved, <w> warning(s)` / `<b> problem(s) to fix` |
   | `council-report-saved` | `Council report saved: <md>` |
   | anything else | `null` |

3. **Status line** (Plan 5's `StatusModel`, used by ordinary `--council` runs): `council-fix` sets `this.council.blocking = e.blocking`, so "sent back to be fixed" counts what the fix step was given.
4. **Doctor.** The council section gains two lines:
   - `✓ axe-core 4.10.3 (accessibility scanner; MPL-2.0, used by Conductor only)` or `✗ axe-core (accessibility scanner): not installed`;
   - `✓ Test machines for the council: <provider kind>` or `✗ Test machines for the council: not set up (client builds then show reliability as not proven)`, from `getMachineProvider(factoryConfig(config, { env, home }))` (`src/factory/config.js`, Contract 7.2) in a `try`. Doctor never calls `acquire`.
   Doctor's could-not-check path prints the council section too, using `DEFAULT_OPTIONS` when the config could not be read.
   `councilLines` is defined in `src/cli/main.js`; after Plan 8 Task 15 its doctor calls sit in `prepareTeam` (`src/cli/prepareRun.js`, Contract 7.11). Edit `councilLines` where it is defined and the doctor paths where they now live.
5. **`fixVendors` test** (Plan 5 follow-up): a drive test pins that a council fix step's vendor is recorded in `state.council.fixVendors`.

**Files:**
- Create: `src/council/progress.js` (`councilProgressLine`)
- Modify: `src/cli/factoryBuild.js` (Plan 8's `build` handler), `src/cli/main.js` (`councilLines`) and `src/cli/prepareRun.js` (doctor paths, moved there by Plan 8), `src/ui/status.js`
- Test: `test/council-progress.test.js` (new), `test/status-council.test.js` (append), `test/cli.test.js` (append), `test/council-drive.test.js` (append)

**Interfaces:**
- Consumes: `runProjectCouncil` (Task 12); `detectAxe` (Task 4); `MEMBER_LABEL`; Plan 8's `build` handler in `FACTORY_COMMANDS` and `getMachineProvider` (index A1, A2); Plan 7's `factoryConfig` (Contract 7.1, 7.2).
- Produces: `councilProgressLine(event) -> string | null`; `councilLines(config, env)` with the two new lines.

- [ ] **Step 1: Write the failing tests**

Create `test/council-progress.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { councilProgressLine as line } from '../src/council/progress.js';

test('council events become short plain progress lines', () => {
  assert.equal(line({ type: 'council-start', round: 1, members: ['security', 'legal', 'correctness', 'design', 'reliability'] }), 'Council round 1: Security, Legal, Correctness, Design, Reliability');
  assert.equal(line({ type: 'council-evidence', stage: 'smoke', status: 'start', machine: 'ct111' }), 'Council: deploying on test machine ct111: backup, restore, alerts and updates (10–20 minutes)…');
  assert.equal(line({ type: 'council-evidence', stage: 'smoke', status: 'error', machine: 'ct111' }), 'Council: the reliability test did not finish.');
  assert.equal(line({ type: 'council-evidence', stage: 'cached', status: 'ok' }), 'Council: using the checks already done for this version.');
  assert.equal(line({ type: 'council-verdict', round: 2, verdict: 'blocked', blocking: 1, warning: 3 }), 'Council round 2: 1 problem to fix');
  assert.equal(line({ type: 'council-verdict', round: 3, verdict: 'approved-with-warnings', blocking: 0, warning: 2 }), 'Council round 3: approved, 2 warnings');
  assert.equal(line({ type: 'council-tool', member: 'design', tool: 'axe', status: 'ran', findings: 1 }), null);
});
```

Append to `test/status-council.test.js`:

```js
test('the fix count comes from council-fix itself', () => {
  const m = new StatusModel();
  m.apply({ type: 'council-start', round: 1 });
  m.apply({ type: 'council-verdict', round: 1, verdict: 'blocked', blocking: 3, warning: 0 });
  m.apply({ type: 'council-fix', round: 1, title: 'Council fixes, round 1', blocking: 2 });
  assert.match(m.lines().join('\n'), /2 problems sent back to be fixed/);
});
```

Append to `test/cli.test.js`:
- `conductor doctor` with `options.councilTools.axe: false` and no `factory.machines` prints `✗ axe-core (accessibility scanner): turned off in the config` and `✗ Test machines for the council: not set up (client builds then show reliability as not proven)`. With no axe setting and no file at the default path, it prints `✗ axe-core (accessibility scanner): not installed`;
- the could-not-check path still prints `Council checks (used with --council):`;
- the `conductor build` hooks object built by the `build` handler (`buildCommand` in `src/cli/factoryBuild.js`) has a `council` function, and calling it passes `checks` through to `runProjectCouncil` unchanged. Check it through Plan 8's build CLI test seam (a stubbed `runBuild` that records its `hooks`).

Append to `test/council-drive.test.js`: a council fix step written by the local model records `fixVendors: ['local']`. In the fallback variant (the local model fails and the step falls back), it records the fallback vendor.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-progress.test.js test/status-council.test.js test/cli.test.js test/council-drive.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** the five items above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/progress.js src/cli/factoryBuild.js src/cli/main.js src/cli/prepareRun.js src/ui/status.js test/council-progress.test.js test/status-council.test.js test/cli.test.js test/council-drive.test.js
git commit -m "feat(council): conductor build uses the full council; plain progress lines; doctor lists axe and test machines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
