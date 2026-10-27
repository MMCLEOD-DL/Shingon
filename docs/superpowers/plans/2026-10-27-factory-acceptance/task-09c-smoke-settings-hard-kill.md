# Task 9c: Foundation follow-ups, part 3 — smoke settings and a hard-kill step

**Repo: `/root/highland-foundation`, branch `plan12-modules`.** Contract 7.9 item 6.

The foundation smoke (`deploy/smoke/run-smoke.sh`) is what Plan 9's Reliability member runs on every client build. Two changes:
- **Settings.** It hard-codes `DIR=/tmp/hf-smoke` and `PROJECT=hfsmoke`. It now reads **`HF_SMOKE_DIR`** and **`HF_SMOKE_PROJECT`** (defaults unchanged), so the factory can give each run its own folder and Compose project (Contract 3's `hf-<slug>-<runId>`). The names derived from them follow: the alert log, the cookie jar, the image file and the REST server container (`<project>-rest`). Ports stay fixed (8080, 8000, 8099), so two smokes still cannot run at once on one host; the `static` provider's host lock already ensures that.
- **A hard-kill step.** Spec §4.3 asks Reliability to "kill and restart services". Today the smoke only stops and starts them cleanly. New **step 7a** sends `SIGKILL` to the database, the app and ops together, starts them again, and proves nothing was lost and everything is healthy.

Both settings are checked **before** anything else (before the Docker checks), so a bad value is refused at once and the refusal can be tested on any machine.

**Files:**
- Modify: `deploy/smoke/run-smoke.sh`, `deploy/smoke/RESULT.md` (a "Settings" line and the step 7a line, filled in by the run in Task 10), `CHANGELOG.md`
- Create: `deploy/test/smoke.test.ts`

**Interfaces:**
- Consumes: the v0.1.0 smoke's helpers (`dc`, `ops_cli`, `notes_count`, `wait_healthy`, `fail`, `ok`, `say`).
- Produces:
  - env `HF_SMOKE_DIR` (default `/tmp/hf-smoke`): absolute, matching `^/[A-Za-z0-9._/-]+$`, no `..`, not `/`;
  - env `HF_SMOKE_PROJECT` (default `hfsmoke`): matching `^[a-z0-9][a-z0-9_-]{0,62}$`, and never `highland`;
  - refusals (exit 2, one line on standard error):
    - `HF_SMOKE_DIR must be an absolute folder path such as /tmp/hf-smoke-acme-r1 (letters, digits, dot, dash, underscore and slash only).`
    - `HF_SMOKE_PROJECT must be a Compose project name such as hf-acme-r1 (lower-case letters, digits, dash and underscore), and never "highland".`
  - step 7a output: `ok: hard kill of db, app and ops: back healthy in <n> s, <count> notes kept, every check ✓`.

- [ ] **Step 1: Write the failing tests** (`deploy/test/smoke.test.ts`)

```ts
import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const script = new URL('../smoke/run-smoke.sh', import.meta.url).pathname;
const text = readFileSync(script, 'utf8');
// PATH holds only bash's own folder, so if a check were reached after the settings, "docker" would be missing.
const run = (env: Record<string, string>) => spawnSync('bash', [script], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });

test('a bad HF_SMOKE_DIR is refused before anything else', () => {
  for (const bad of ['relative/dir', '/', '/tmp/../etc', '/tmp/with space']) {
    const r = run({ HF_SMOKE_DIR: bad });
    expect(r.status, bad).toBe(2);
    expect(r.stderr).toContain('HF_SMOKE_DIR must be an absolute folder path');
  }
});
test('a bad HF_SMOKE_PROJECT is refused, and "highland" never allowed', () => {
  for (const bad of ['highland', 'Has-Caps', '-dash', 'x'.repeat(64)]) {
    const r = run({ HF_SMOKE_PROJECT: bad });
    expect(r.status, bad).toBe(2);
    expect(r.stderr).toContain('HF_SMOKE_PROJECT must be a Compose project name');
  }
});
test('the defaults are unchanged and every derived name follows the settings', () => {
  expect(text).toContain('DIR="${HF_SMOKE_DIR:-/tmp/hf-smoke}"');
  expect(text).toContain('PROJECT="${HF_SMOKE_PROJECT:-hfsmoke}"');
  expect(text).not.toMatch(/\/tmp\/hf-smoke-(alerts|cookies|images)/);   // derived from $DIR now
  expect(text).not.toContain('hf-smoke-rest');                          // "$PROJECT-rest" now
});
test('the smoke has a hard-kill step that checks data, health and every ops check', () => {
  const step = text.split('STEP="step 7a (hard kill)"')[1]?.split('STEP="step 8')[0] ?? '';
  expect(step).toContain('kill -s SIGKILL db app ops');
  expect(step).toContain('wait_healthy');
  expect(step).toMatch(/notes_count/);
  expect(step).toMatch(/ops_cli check/);
});
```

Run: `npx vitest run deploy/test/smoke.test.ts` → FAIL.

- [ ] **Step 2: Add the settings**

At the top of `run-smoke.sh`, after `set -euo pipefail` and before the Docker checks:

```bash
DIR="${HF_SMOKE_DIR:-/tmp/hf-smoke}"
PROJECT="${HF_SMOKE_PROJECT:-hfsmoke}"
if ! [[ "$DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$DIR" == *..* ]] || [ "$DIR" = / ]; then
  echo "HF_SMOKE_DIR must be an absolute folder path such as /tmp/hf-smoke-acme-r1 (letters, digits, dot, dash, underscore and slash only)." >&2; exit 2
fi
if ! [[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || [ "$PROJECT" = highland ]; then
  echo "HF_SMOKE_PROJECT must be a Compose project name such as hf-acme-r1 (lower-case letters, digits, dash and underscore), and never \"highland\"." >&2; exit 2
fi
ALERTS="$DIR-alerts.log"; COOKIES="$DIR-cookies"; REST_NAME="$PROJECT-rest"
```

Then replace every `hf-smoke-rest` with `"$REST_NAME"` (start, guard, teardown), every `/tmp/hf-smoke-images-…` with `"$DIR-images-…"`, and `/tmp/hf-smoke-catcher.out` with `"$DIR-catcher.out"`. The header comment names the two settings. The "previous run left behind" guard checks the chosen `$DIR`, `$REST_NAME` and `$PROJECT`. The guard against existing `highland/app`/`highland/ops` images stays (Contract 7.8: Plan 10's clean-up removes the images it builds).

- [ ] **Step 3: Add step 7a**

Between step 7 and step 8:

```bash
# ---- 7a. Hard kill: no clean shutdown for the database, the app or ops; everything must come back with its data.
STEP="step 7a (hard kill)"
say "Step 7a: SIGKILL db, app and ops, start them again, check the data and every check"
NOTES_BEFORE="$(notes_count)"
T0=$SECONDS
dc kill -s SIGKILL db app ops >/dev/null 2>&1 || fail "docker compose kill failed"
dc up -d >/dev/null 2>&1 || { dc ps; fail "docker compose up -d failed after the hard kill"; }
wait_healthy
[ "$(notes_count)" = "$NOTES_BEFORE" ] || fail "the notes count changed across the hard kill"
t=0; until OUT="$(ops_cli check 2>&1)" && ! echo "$OUT" | grep -q '^✗'; do
  t=$((t + 5)); [ "$t" -ge 180 ] && { echo "$OUT"; fail "ops check still reports a problem 3 minutes after the hard kill"; }; sleep 5
done
ok "hard kill of db, app and ops: back healthy in $((SECONDS - T0)) s, $NOTES_BEFORE notes kept, every check ✓"
```

Step 8's "no 'not answering' alert during a planned update" count is taken at the start of step 8, so an alert caused by the hard kill does not affect it.

Run: `npx vitest run deploy` → PASS.

- [ ] **Step 4: Changelog, verify and commit**

`CHANGELOG.md` Unreleased: `- The smoke test takes HF_SMOKE_DIR and HF_SMOKE_PROJECT, and kills the database, app and ops without warning to prove they recover.`

Run: `npm run verify` → PASS. (The full smoke is run on the build machine in Task 10 Step 3, which also fills in `deploy/smoke/RESULT.md`.)

```bash
git add -A
git commit -m "feat: smoke settings HF_SMOKE_DIR/HF_SMOKE_PROJECT and a hard-kill step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
