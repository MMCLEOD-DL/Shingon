# Task 9a: Foundation follow-ups, part 1 — the release stamp and `update --json`

**Repo: `/root/highland-foundation`, branch `plan12-modules`.** Contract 7.9 items 1 and 2.

Two small fixes the factory needs from foundation v0.2.0:
- **`scripts/release.ts` stamps `foundation.json` only when `package.json.name` is `highland-foundation`.** Today a client app that runs `npm run release` overwrites its inherited `foundation.json` with the **app's** version, although `docs/BUILDING-ON.md` says to keep it untouched (Plan 11 Operator question 6). After this fix an app's release leaves `foundation.json` byte for byte as inherited, and the "versions must match" check applies only to the foundation itself.
- **`update --to <version> --json`** (run in the updater service: `docker compose run --rm -T updater update --to 0.2.1 --json`) prints exactly **one line of JSON** on standard output with the outcome; the progress lines go to standard error instead. The exit codes are unchanged. Plan 10 keeps its v0.1.0 text parser for now; switching to this is a later Conductor follow-up (Contract 7.9).

**Files:**
- Modify: `scripts/release.ts` (`runRelease`, `runFirstRelease`), `scripts/release.test.ts`
- Modify: `ops/src/update.ts` (export `UPDATE_EXIT`, `updateExitCode`, `updateOutcomeJson`), `ops/src/cli.ts` (`updateCli` gains `--json`; `withDeps` takes the log function), `ops/src/init-cli.ts` (`USAGE`), `ops/test/update.test.ts`, `docs/RUNBOOK.md` ("Updating": one paragraph on `--json`), `CHANGELOG.md`

**Interfaces:**
- Consumes: `runRelease`, `runFirstRelease`, `ReleaseDeps` (`scripts/release.ts`, v0.1.0); `UpdateOutcome`, `runUpdate` (`ops/src/update.ts`); the `EXIT` map in `ops/src/cli.ts` (moved, not copied).
- Produces:

```ts
// scripts/release.ts — behaviour only; signatures unchanged
FOUNDATION_PACKAGE = 'highland-foundation'
// runRelease / runFirstRelease: foundation.json is read, checked against package.json and stamped only when
// package.json.name === FOUNDATION_PACKAGE; otherwise it is neither read nor written.

// ops/src/update.ts
UPDATE_EXIT = { updated: 0, cancelled: 1, 'rolled-back': 1, 'rollback-failed': 3 } as const   // moved from cli.ts
updateExitCode(o: UpdateOutcome): 0 | 1 | 3                  // urgent -> 3, else UPDATE_EXIT[o.outcome]
interface UpdateJson { schema: 1; outcome: UpdateOutcome['outcome'] | 'refused'; to: string | null; message: string; urgent: boolean; exitCode: number }
updateOutcomeJson(o: UpdateOutcome | { refused: string; exitCode: 2 }, to: string | null): string   // one line, no trailing newline, no secrets
```

- [ ] **Step 1: Write the failing release tests**

In `scripts/release.test.ts`, first change `setup()`'s default `package.json` name from `"x"` to `"highland-foundation"`, so the existing stamping tests still describe the foundation's own release. Give `setup` an option `{ name?: string; foundation?: string }` for the app cases. Then add:

```ts
const INHERITED = '{\n  "name": "highland-foundation",\n  "version": "0.2.0",\n  "commit": "v0.2.0"\n}\n';

test('an app release leaves foundation.json exactly as inherited', () => {
  const { deps, calls, root } = setup({ name: 'acme-expenses', foundation: INHERITED });
  expect(runRelease('minor', deps)).toBe('0.2.0');
  expect(readFileSync(path.join(root, 'foundation.json'), 'utf8')).toBe(INHERITED);
  expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version).toBe('0.2.0');
  expect(calls).toContain('commit+tag v0.2.0');
});
test('an app release does not need its version to match foundation.json', () => {
  const { deps } = setup({ name: 'acme-expenses', foundation: INHERITED.replace('0.2.0', '0.1.0') });
  expect(() => runRelease('patch', deps)).not.toThrow();
});
```

The existing tests ('a clean release writes the three files, stamps the tag name …', 'refuses … when the versions disagree', and the first-release ones) keep their expectations unchanged: with the new default name they now pin that the foundation's own release still checks and stamps `foundation.json`.

In the `describe('the first release …')` block add `'an app\'s first release tags package.json\'s version and leaves foundation.json alone'`: name `acme-expenses`, `package.json` version `0.1.0`, `foundation.json` = `INHERITED` (0.2.0), no tags, dated `## [0.1.0]` section → returns `'0.1.0'`, `foundation.json` unchanged.

Run: `npx vitest run scripts/release.test.ts`
Expected: FAIL (the app cases stamp `foundation.json` or refuse on the version mismatch).

- [ ] **Step 2: Implement the release fix**

In `scripts/release.ts` export `FOUNDATION_PACKAGE = 'highland-foundation'`. In both `runRelease` and `runFirstRelease`, read `package.json` once, set `const isFoundation = pkg.name === FOUNDATION_PACKAGE`, and wrap the `foundation.json` read, the version-match refusal and the stamp in `if (isFoundation)`. `commitAndTag` already adds `foundation.json` by name; an unchanged file adds nothing. Update the doc comments to say why: "an app keeps the stamp it inherited (docs/BUILDING-ON.md); only the foundation's own release writes it".

Run: `npx vitest run scripts/release.test.ts` → PASS.

- [ ] **Step 3: Write the failing `update --json` tests**

In `ops/test/update.test.ts`:

```ts
import { updateExitCode, updateOutcomeJson, UPDATE_EXIT } from '../src/update.js';

test('update exit codes are unchanged and urgent wins', () => {
  expect(UPDATE_EXIT).toEqual({ updated: 0, cancelled: 1, 'rolled-back': 1, 'rollback-failed': 3 });
  expect(updateExitCode({ outcome: 'updated', message: 'x' })).toBe(0);
  expect(updateExitCode({ outcome: 'cancelled', message: 'x', urgent: true })).toBe(3);
});
test('the JSON outcome is one line with every field', () => {
  const line = updateOutcomeJson({ outcome: 'rolled-back', message: '[Acme] Update to 0.2.1 failed …\nsecond line' }, '0.2.1');
  expect(line).not.toContain('\n');
  expect(JSON.parse(line)).toEqual({ schema: 1, outcome: 'rolled-back', to: '0.2.1', message: '[Acme] Update to 0.2.1 failed … second line', urgent: false, exitCode: 1 });
});
test('a refusal before the update starts is JSON too, with exit code 2', () => {
  expect(JSON.parse(updateOutcomeJson({ refused: 'update needs exactly one of --to <version>, --status or --mark-recovered.', exitCode: 2 }, null)))
    .toEqual({ schema: 1, outcome: 'refused', to: null, message: 'update needs exactly one of --to <version>, --status or --mark-recovered.', urgent: false, exitCode: 2 });
});
```

Run: `npx vitest run ops/test/update.test.ts` → FAIL (not exported).

- [ ] **Step 4: Implement `--json`**

- `ops/src/update.ts`: move the `EXIT` map from `cli.ts` here as `UPDATE_EXIT`; add `updateExitCode` and `updateOutcomeJson` (newlines in the message become single spaces; the message is already redacted by `runUpdate`'s caller, and `updateOutcomeJson` adds nothing else).
- `ops/src/cli.ts`:
  - `updateCli` accepts `json: { type: 'boolean' }`, allowed only with `--to` (with `--status` or `--mark-recovered` it is a usage error).
  - With `--json`, every progress line (`say`, the `log` passed to `runUpdate`, and `recordRun`'s print through `createOpsDeps`) goes to standard error, and the last thing written to standard output is `updateOutcomeJson(outcome, to)` plus `\n`. `withDeps(fn, log = say)` passes `log` to `createOpsDeps`.
  - Refusals before `runUpdate` (bad arguments, no `HF_BUNDLE_DIR`, a bad `--image-file`) print their usual sentence to standard error **and** the `refused` JSON line to standard output, exit 2.
  - Without `--json` nothing changes.
- `USAGE`: add `update --to <version> [--image-file <file>] [--json]` and one line: `--json  prints one line of JSON with the outcome on standard output (progress goes to standard error); the exit codes are the same.`
- `docs/RUNBOOK.md` "Updating": one paragraph saying the same, for scripts.
- `CHANGELOG.md` Unreleased:
  - `- An app's release no longer overwrites foundation.json; only the foundation's own release stamps it.`
  - `- ops update --json prints the outcome as one line of JSON, for scripts.`

Run: `npx vitest run ops/test/update.test.ts ops/test/init-cli.test.ts scripts` → PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify` → PASS.

```bash
git add -A
git commit -m "fix: app releases keep the inherited foundation.json; ops update --json gives one line of JSON

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
