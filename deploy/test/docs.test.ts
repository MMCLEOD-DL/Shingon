import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const doc = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('the runbook has every section the operator needs', () => {
  const headings = [...doc('docs/RUNBOOK.md').matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  expect(headings).toEqual(['What this is', 'Setting up a new deployment', 'Where data goes', 'What the alerts mean', 'Reading receipts (OCR)', 'Scheduled jobs', 'Backups and restoring',
    'Updating', 'Recovering from a failed update', 'Locked out: no admin can sign in', 'Remote access', 'HTTPS on a client\'s network', 'Rotating secrets']);
});
test('every alert the monitor can send is explained', () => {
  const runbook = doc('docs/RUNBOOK.md');
  for (const phrase of ['The app is not answering.', 'Disk space is low', 'Backups are being kept on this box only', 'The remote-access tunnel is down',
    'emails are waiting to be sent', 'The last successful backup was', 'The last restore test failed', 'URGENT: update',
    'The backup destination is busy'])
    expect(runbook, phrase).toContain(phrase);
});
test('every outbound destination variable is listed under Where data goes', () => {
  const section = doc('docs/RUNBOOK.md').split('## Where data goes')[1]!.split('\n## ')[0]!;
  for (const v of ['SMTP_URL', 'BACKUP_REPOSITORY', 'MATRIX_HOMESERVER', 'ALERT_WEBHOOK_URL', 'HEARTBEAT_URL', 'TUNNEL_TOKEN', 'OCR_AZURE_ENDPOINT']) expect(section, v).toContain(v);
});
test('the building guide has its sections', () => {
  const headings = [...doc('docs/BUILDING-ON.md').matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  expect(headings).toEqual(['Starting a client app', 'Making it theirs', 'Adding a feature (follow notes)', 'Numbers people rely on', 'Permissions', 'Optional modules', 'Taking foundation fixes', 'The quality gates']);
});
test('the building guide says how to switch modules on and the rules each one keeps', () => {
  const section = doc('docs/BUILDING-ON.md').split('## Optional modules')[1]!.split('\n## ')[0]!;
  for (const phrase of ['app-profile.json', 'Contract 7.5', 'Staff always confirm', 'never the proposal', 'receipt-reading', 'buildMoneyReport', 'renderPdf', 'renderXlsx',
    'W1_MARCH', 'sendReport', 'registerAppJob', 'apps/server/src/jobs/index.ts', 'database and a log only', 'queue the work for the app', 'safe to run once late',
    'azure-document-intelligence', '500 MB'])
    expect(section, phrase).toContain(phrase);
});
test('the runbook covers the OCR settings, cloud OCR and ops jobs', () => {
  const runbook = doc('docs/RUNBOOK.md');
  for (const phrase of ['OCR_ENGINE', 'OCR_CONCURRENCY', 'OCR_TIMEOUT_MS', 'OCR_AZURE_KEY', 'docker compose run --rm ops jobs', 'A reading is slow', 'Setting up cloud OCR',
    "This receipt couldn't be read automatically. Please type the details.", 'the scheduled job'])
    expect(runbook, phrase).toContain(phrase);
});
test('LICENCES.md is current', async () => {
  // Made from package-lock.json, which is the same on every computer (it lists the platform-specific builds for every OS).
  const { renderMarkdown, collectLockfile } = await import('../../scripts/check-licences.js');
  const locked = await collectLockfile(new URL('../../', import.meta.url).pathname);
  expect(locked).not.toBeNull();
  expect(doc('docs/LICENCES.md')).toBe(renderMarkdown(locked ?? []));
});
test('the lockout section gives the exact recovery command, its fallback, and when it is allowed', () => {
  const section = doc('docs/RUNBOOK.md').split('## Locked out: no admin can sign in')[1]!.split('\n## ')[0]!;
  expect(section).toContain('docker compose run --rm app node apps/server/dist/auth/bootstrap-admin.js --recover --email ');
  expect(section).toContain('docker compose run --rm --no-deps app node apps/server/dist/auth/bootstrap-admin.js --recover --email ');
  expect(section).toContain('only when no admin is both switched on and has a password');
  expect(section).toMatch(/UPDATE users SET disabled_at = NULL/);
});
test('the runbook covers the operator notes from the final review', () => {
  const runbook = doc('docs/RUNBOOK.md');
  for (const phrase of ['email_outbox', 'INSTANCE_MODE', 'within 30 days of the newest pre-update backup', '--any-host', 'superuser', 'did not come back', 'being updated'])
    expect(runbook, phrase).toContain(phrase);
});
