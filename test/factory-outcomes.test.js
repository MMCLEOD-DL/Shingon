// The messages below are the foundation v0.1.0 wording, copied from ops/src/update.ts and ops/src/journal.ts.
// If a foundation release changes the wording, these tests are where it shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretUpdate, exitFor, SHIP_EXIT } from '../src/factory/ship/outcomes.js';
import { OUTCOMES } from '../src/factory/deployments/store.js';
import { rememberSecret, forgetRememberedSecrets } from '../src/secrets.js';

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
  assert.match(r.text, /\nNote from the box: Warning: TUNNEL_IP/);
  assert.equal(exitFor(r.outcome), 0);
});

test('updated: monitor note and the real front-door warning wording', () => {
  const w = 'Warning: the front door (web access) could not be started. The app itself is updated and healthy. Run: docker compose up -d proxy';
  const r = run(0, `[Acme Ltd] Updated from 0.1.3 to 0.1.4. A backup (1a2b3c4d) was taken first. (The monitor did not restart; run: docker compose up -d ops) ${w}\n`);
  assert.equal(r.outcome, 'updated');
  assert.deepEqual(r.warnings, [w]);
  assert.match(r.text, /\nNote from the box: the monitor did not restart\. Run on the box: docker compose up -d ops/);
  assert.match(r.text, new RegExp('\\nNote from the box: Warning: the front door'));
});

test('updated with no warnings has none', () => {
  const r = run(0, '[Acme Ltd] Updated from 0.1.3 to 0.1.4. A backup (1a2b3c4d) was taken first.\n');
  assert.deepEqual(r.warnings, []);
  assert.ok(!r.text.includes('Note from the box'));
});

test('rolled back automatically', () => {
  const r = run(1, `${PROGRESS}[Acme Ltd] Update to 0.1.4 failed (version 0.1.4 did not become healthy within 3 minutes: the app was not answering), so it was undone automatically. The app is back on 0.1.3 with its data exactly as it was before the update.\n`);
  assert.equal(r.outcome, 'rolled-back');
  assert.match(r.text, /did not work \(version 0\.1\.4 did not become healthy within 3 minutes: the app was not answering\), so the box undid it by itself\. acme-office is back on 0\.1\.3/);
  assert.equal(exitFor(r.outcome), 1);
});

test('cancelled, already on, busy', () => {
  assert.equal(run(1, '[Acme Ltd] Update to 0.1.4 cancelled: the new images are not on this box. Nothing was changed; the app is running 0.1.3 again.\n').outcome, 'cancelled');
  assert.match(run(1, '[Acme Ltd] Update to 0.1.4 cancelled: the new images are not on this box. Nothing was changed.').text, /cancelled before anything changed: the new images are not on this box\.$/);
  assert.equal(run(1, 'Already on 0.1.4.\n').outcome, 'already-on');
  assert.match(run(1, 'Already on 0.1.4.\n').text, /^acme-office is already on 0\.1\.4\. Nothing was done\.$/);
  assert.equal(run(1, 'Another update is already running.\n').outcome, 'busy');
  const b = run(1, 'A backup or restore is still running, so the update to 0.1.4 did not start. Nothing was changed. Try again when it has finished.\n');
  assert.equal(b.outcome, 'busy');
  assert.match(b.text, /Try again in a few minutes\.$/);
});

test('urgent: rollback failed, or an earlier update left half done', () => {
  const line = '[Acme Ltd] URGENT: update to 0.1.4 failed (the database update failed) and the automatic undo also failed (restore stopped). The app may be down. Backup 1a2b3c4d holds the data from before the update.';
  const r = run(3, `${line}\n`);
  assert.equal(r.outcome, 'urgent');
  assert.match(r.text, /^URGENT: .*RUNBOOK\.md in \/opt\/highland\/acme on the box, then run there: docker compose run --rm updater update --mark-recovered\./);
  assert.ok(r.text.endsWith('The box said: URGENT: update to 0.1.4 failed (the database update failed) and the automatic undo also failed (restore stopped). The app may be down. Backup 1a2b3c4d holds the data from before the update.'));
  assert.equal(exitFor(r.outcome), 3);
  assert.equal(run(3, '[Acme Ltd] URGENT: update to 0.1.4 (from 0.1.3, started 27 Oct 2026, 10:00) stopped part-way while migrating').outcome, 'urgent');
  // Refused because an earlier update was never recovered: the CLI prints "cancelled" but exits 3.
  assert.equal(run(3, '[Acme Ltd] Update to 0.1.4 cancelled: an earlier update could not be undone and has not been marked as recovered. Nothing was changed.').outcome, 'urgent');
  assert.equal(run(3, '').outcome, 'urgent');
});

test('settings error (exit 2)', () => {
  const r = run(2, 'update runs in the updater service, which knows where the bundle is (HF_BUNDLE_DIR): docker compose run --rm updater update --to <version>\n\n');
  assert.equal(r.outcome, 'settings-error');
  assert.match(r.text, /problem: update runs in the updater service.*<version>\. Nothing was changed\.$/);
  assert.equal(exitFor(r.outcome), 1);
});

test('anything Conductor cannot read fails closed as lost contact', () => {
  for (const [code, out] of [[0, 'no outcome here'], [1, ''], [137, 'Killed'], [null, ''], [undefined, undefined],
    [1, '[Acme Ltd] Updated from 0.1.3 to 0.1.4. A backup (1a2b3c4d) was taken first.'],
    [0, 'Already on 0.1.4.'], [0, '[x] Update to 0.1.4 failed (a), so it was undone automatically.']]) {
    const r = run(code, out);
    assert.equal(r.outcome, 'lost-contact', `${code} ${out}`);
    assert.match(r.text, /Run: conductor deployments status$/);
    assert.ok(OUTCOMES.includes(r.outcome));
  }
  assert.equal(exitFor('lost-contact'), 2);
  assert.equal(exitFor('installed'), 0);
  assert.equal(exitFor('confirmed'), 0);
});

test('the last matching line wins, and every outcome is a known one', () => {
  const r = run(1, 'Already on 0.1.4.\n[Acme Ltd] Update to 0.1.4 cancelled: nope. Nothing was changed.\ntrailing chatter\n');
  assert.equal(r.outcome, 'cancelled');
  for (const [c, o] of [[0, 'x'], [1, 'Already on 0.1.4.'], [2, 'x'], [3, 'x']]) assert.ok(OUTCOMES.includes(run(c, o).outcome));
});

test('output is redacted', () => {
  rememberSecret('s3cr3t-value-123');
  try {
    const r = run(1, '[Acme Ltd] Update to 0.1.4 cancelled: the token s3cr3t-value-123 was refused. Nothing was changed.');
    assert.ok(!r.text.includes('s3cr3t-value-123'));
    assert.ok(!run(2, 'bad s3cr3t-value-123').text.includes('s3cr3t-value-123'));
  } finally { forgetRememberedSecrets(); }
});
