import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const doc = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('the runbook has every section the operator needs', () => {
  const headings = [...doc('docs/RUNBOOK.md').matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  expect(headings).toEqual(['What this is', 'Setting up a new deployment', 'Where data goes', 'What the alerts mean', 'Backups and restoring',
    'Updating', 'Recovering from a failed update', 'Remote access', 'HTTPS on a client\'s network', 'Rotating secrets']);
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
  for (const v of ['SMTP_URL', 'BACKUP_REPOSITORY', 'MATRIX_HOMESERVER', 'ALERT_WEBHOOK_URL', 'HEARTBEAT_URL', 'TUNNEL_TOKEN']) expect(section, v).toContain(v);
});
test('the building guide has its sections', () => {
  const headings = [...doc('docs/BUILDING-ON.md').matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  expect(headings).toEqual(['Starting a client app', 'Making it theirs', 'Adding a feature (follow notes)', 'Numbers people rely on', 'Permissions', 'Taking foundation fixes', 'The quality gates']);
});
test('LICENCES.md is current', async () => {
  // Made from package-lock.json, which is the same on every computer (it lists the platform-specific builds for every OS).
  const { renderMarkdown, collectLockfile } = await import('../../scripts/check-licences.js');
  const locked = await collectLockfile(new URL('../../', import.meta.url).pathname);
  expect(locked).not.toBeNull();
  expect(doc('docs/LICENCES.md')).toBe(renderMarkdown(locked ?? []));
});
