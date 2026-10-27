# Task 3: Update outcomes in plain English

`updater update --to <v>` ends with an exit code and one outcome message (printed by the updater and also sent to the alert channel). Exit code 1 alone means four different things, so this task reads the message as well. It turns both into one of Contract 4's outcomes, the backup id when there is one, any front-door warning, and a short paragraph for the operator. It also fixes `ship`'s own exit codes.

The messages below are the foundation's v0.1.0 wording, copied from `/root/highland-foundation/ops/src/update.ts` and `ops/src/journal.ts`. They are test fixtures: **if a foundation release changes the wording, these tests are where it shows** (Contract gap 8).

**Files:**
- Create: `src/factory/ship/outcomes.js`
- Test: `test/factory-outcomes.test.js`

**Interfaces:**
- Consumes: `redact` from `src/secrets.js`.
- Produces: `SHIP_EXIT`, `interpretUpdate`, `exitFor` (index, Task 3).

**How the message is found:** split `output` into lines, strip a leading `[<anything>] ` from each, and take the **last** line that starts with one of: `Updated from `, `Update to `, `URGENT: update to `, `Already on `, `Another update is already running.`, `A backup or restore is still running`. No such line → outcome `lost-contact` (fail closed: Conductor cannot tell what happened).

| Exit | Message starts | Outcome | `exitFor` |
|---|---|---|---|
| 0 | `Updated from A to B. A backup (id) was taken first.` | `updated` | 0 |
| 1 | `Update to B failed (reason), so it was undone automatically.` | `rolled-back` | 1 |
| 1 | `Update to B cancelled: …` | `cancelled` | 1 |
| 1 | `Already on B.` | `already-on` | 1 |
| 1 | `Another update is already running.` / `A backup or restore is still running…` | `busy` | 1 |
| 2 | anything | `settings-error` | 1 |
| 3 | anything (normally `URGENT: update to …`) | `urgent` | 3 |
| other / no outcome line / exit 0 without `Updated from` | — | `lost-contact` | 2 |

`installed` → 0, `confirmed` → 0 (used by later tasks).

**Texts** (`name` is the deployment name; `<reason>` is the text inside the first `(…)` after `failed`, or after `cancelled: ` up to ` Nothing was changed`; all of it through `redact`):
- `updated`: `acme-office is now on 0.1.4 (it was on 0.1.3). The box took a backup (1a2b3c4d) first.` and, for each ` Warning: …` sentence after the outcome sentence, a line `Note from the box: Warning: …`; a ` (The monitor did not restart; run: docker compose up -d ops)` suffix becomes the line `Note from the box: the monitor did not restart. Run on the box: docker compose up -d ops`.
- `rolled-back`: `The update to 0.1.4 did not work (<reason>), so the box undid it by itself. acme-office is back on 0.1.3 with its data exactly as before. Nothing needs recovering; find out why the new version failed before shipping it again.`
- `cancelled`: `The update to 0.1.4 was cancelled before anything changed: <reason>.`
- `already-on`: `acme-office is already on 0.1.4. Nothing was done.`
- `busy`: `The box was busy with another update, backup or restore, so the update to 0.1.4 did not start. Nothing was changed. Try again in a few minutes.`
- `settings-error`: `The box refused the update because of a settings or command problem: <last non-empty output line>. Nothing was changed.`
- `urgent`: `URGENT: the update to 0.1.4 failed and could not be undone, or an earlier update was left half done. acme-office may be down or on the wrong data. Follow "Recovering from a failed update" in RUNBOOK.md in /opt/highland/acme on the box, then run there: docker compose run --rm updater update --mark-recovered. The box said: <outcome line>`
- `lost-contact`: `Conductor could not tell how the update to 0.1.4 ended. It may still be running on the box, or have finished. Run: conductor deployments status`

- [ ] **Step 1: Write the failing tests**

```js
// test/factory-outcomes.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretUpdate, exitFor, SHIP_EXIT } from '../src/factory/ship/outcomes.js';

const base = { to: '0.1.4', from: '0.1.3', name: 'acme-office', bundleDir: '/opt/highland/acme' };
const run = (code, output) => interpretUpdate({ ...base, code, output });
const PROGRESS = 'Stopping the app and the monitor.\nTaking a backup.\n';

test('exit codes are fixed', () => {
  assert.deepEqual(SHIP_EXIT, { done: 0, notDone: 1, partway: 2, urgent: 3, usage: 64, interrupted: 130 });
});

test('updated, with the backup id and the front-door warning passed on', () => {
  const r = run(0, `${PROGRESS}[Acme Ltd] Updated from 0.1.3 to 0.1.4. A backup (1a2b3c4d) was taken first. Warning: TUNNEL_IP and EDGE_SUBNET in .env do not match, so the front door was not restarted.\n`);
  assert.equal(r.outcome, 'updated');
  assert.equal(r.backup, '1a2b3c4d');
  assert.match(r.text, /^acme-office is now on 0\.1\.4 \(it was on 0\.1\.3\)\. The box took a backup \(1a2b3c4d\) first\./);
  assert.deepEqual(r.warnings, ['Warning: TUNNEL_IP and EDGE_SUBNET in .env do not match, so the front door was not restarted.']);
  assert.equal(exitFor(r.outcome), 0);
});

test('rolled back automatically', () => {
  const r = run(1, `${PROGRESS}[Acme Ltd] Update to 0.1.4 failed (version 0.1.4 did not become healthy within 3 minutes: the app was not answering), so it was undone automatically. The app is back on 0.1.3 with its data exactly as it was before the update.\n`);
  assert.equal(r.outcome, 'rolled-back');
  assert.match(r.text, /did not work \(version 0\.1\.4 did not become healthy within 3 minutes: the app was not answering\), so the box undid it by itself\. acme-office is back on 0\.1\.3/);
  assert.equal(exitFor(r.outcome), 1);
});

test('cancelled, already on, busy', () => {
  assert.equal(run(1, '[Acme Ltd] Update to 0.1.4 cancelled: the new images are not on this box. Nothing was changed; the app is running 0.1.3 again.\n').outcome, 'cancelled');
  assert.match(run(1, '[Acme Ltd] Update to 0.1.4 cancelled: the new images are not on this box. Nothing was changed.').text, /cancelled before anything changed: the new images are not on this box\./);
  assert.equal(run(1, 'Already on 0.1.4.\n').outcome, 'already-on');
  assert.equal(run(1, 'Another update is already running.\n').outcome, 'busy');
  assert.equal(run(1, 'A backup or restore is still running, so the update to 0.1.4 did not start. Nothing was changed. Try again when it has finished.\n').outcome, 'busy');
});

test('urgent: rollback failed, or an earlier update left half done', () => {
  const r = run(3, '[Acme Ltd] URGENT: update to 0.1.4 failed (the database update failed) and the automatic undo also failed (restore stopped). The app may be down. Backup 1a2b3c4d holds the data from before the update.\n');
  assert.equal(r.outcome, 'urgent');
  assert.match(r.text, /^URGENT: .*RUNBOOK\.md in \/opt\/highland\/acme on the box, then run there: docker compose run --rm updater update --mark-recovered\./);
  assert.equal(exitFor(r.outcome), 3);
  assert.equal(run(3, '[Acme Ltd] URGENT: update to 0.1.4 (from 0.1.3, started 27 Oct 2026, 10:00) stopped part-way while migrating').outcome, 'urgent');
});

test('settings error (exit 2)', () => {
  const r = run(2, 'update runs in the updater service, which knows where the bundle is (HF_BUNDLE_DIR): docker compose run --rm updater update --to <version>\n');
  assert.equal(r.outcome, 'settings-error');
  assert.equal(exitFor(r.outcome), 1);
});

test('anything Conductor cannot read fails closed as lost contact', () => {
  for (const [code, out] of [[0, 'no outcome here'], [1, ''], [137, 'Killed'], [null, '']]) {
    const r = run(code, out);
    assert.equal(r.outcome, 'lost-contact', `${code} ${out}`);
    assert.match(r.text, /Run: conductor deployments status$/);
  }
  assert.equal(exitFor('lost-contact'), 2);
  assert.equal(exitFor('installed'), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/factory-outcomes.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/factory/ship/outcomes.js`** to the table and texts above. Exit code checks come first (2 → `settings-error`, 3 → `urgent`), then the message prefixes for 0 and 1. The backup id is `/A backup \(([0-9a-f]{8})\)/`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/factory-outcomes.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/ship/outcomes.js test/factory-outcomes.test.js
git commit -m "feat(ship): map the foundation's update outcomes to plain English and exit codes"
```
