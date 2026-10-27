// Shared factory fixtures. Never touches /root/highland-foundation: the "foundation" is a tiny repo in a temp dir.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../../src/workspace.js';
import { projectDir as projectDirOf, saveProject } from '../../src/factory/projects.js';

export async function makeFoundationRepo({ tag = 'v0.1.0', extra = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'foundation-'));
  const files = {
    'foundation.json': '{"name":"highland-foundation","version":"0.1.0","commit":"v0.1.0"}\n',
    'package.json': JSON.stringify({ name: 'highland-foundation', version: '0.1.0', scripts: { verify: 'node -e 0', test: 'node -e 0', lint: 'node -e 0' } }, null, 2) + '\n',
    'apps/web/src/brand.ts': "export const BRAND = { appName: 'Highland App', shortName: 'HA' } as const;\n",
    'docs/BUILDING-ON.md': '# Building\n',
    'apps/server/test/crossing/harness.ts': '// crossing harness\n',
    'apps/server/test/crossing/cases.ts': '// crossing cases\n',
    'apps/web/e2e/pages.ts': '// e2e pages\n',
    'apps/web/src/appPaths.ts': '// app paths\n',
    'apps/server/src/db/schema/index.ts': '// schema\n',
    '.gitignore': 'node_modules/\nreports/\n',
    ...extra,
  };
  await git(dir, ['init', '-q', '-b', 'main']);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  await git(dir, ['add', '-A']);
  await git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'foundation']);
  await git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'tag', '-a', tag, '-m', tag]);
  return dir;
}

export function sampleBrief(over = {}) {
  return {
    schema: 1,
    client: 'Acme Ltd',
    purpose: 'Staff submit expenses on their phones and the office manager gets a monthly report of spending by category.',
    kind: 'web-app',
    roles: [
      { name: 'Office manager', whatTheyDo: 'Reviews expenses and runs the monthly report', sees: "Everyone's expenses", mapsTo: 'manager' },
      { name: 'Staff', whatTheyDo: 'Submit expenses', sees: 'Only their own expenses', mapsTo: 'member' },
      { name: 'Administrator', whatTheyDo: 'Manages users and settings', sees: 'Everything', mapsTo: 'admin' }, // Plan 7's validator requires an admin role (ruling Q1)
    ],
    records: [{ name: 'Expense', description: 'One amount spent, with VAT and a category', holdsFiles: false, personalData: true }],
    features: [
      { id: 'submit-expense', title: 'Submit an expense', story: 'A member of staff enters an amount, the VAT and a category for something they paid for.', roles: ['Staff'], data: ['Expense'],
        acceptance: [
          { id: 'submit-expense#1', given: 'a member', when: 'they submit £12.40 with £2.07 VAT for Travel', then: 'it appears in their list as £12.40' },
          { id: 'submit-expense#2', given: 'a member', when: 'they submit a negative amount', then: 'they are told the amount must be above £0' },
        ] },
      { id: 'monthly-report', title: 'Monthly report', story: 'The office manager opens a month and sees spending totalled by category.', roles: ['Office manager'], data: ['Expense'],
        acceptance: [{ id: 'monthly-report#1', given: 'two Travel expenses of £12.40 and £7.60 in March', when: 'a manager opens March', then: 'Travel shows £20.00' }] },
    ],
    outputs: [], integrations: [], modules: [],
    policy: {
      hosting: 'client-box', outbound: [], residency: 'uk',
      retention: { text: 'Kept for 6 years, then deleted', days: 2190 },
      backupDestination: { kind: 'client-owned', detail: "A USB disk kept in the client's office" },
      operatorAccess: true,
    },
    assumptions: [], openQuestions: [],
    exampleSeq: { 'submit-expense': 2, 'monthly-report': 1 }, slug: 'acme-ltd', version: 1, createdAt: '2026-10-27T09:00:00.000Z', revisedFrom: null,
    approvedAt: '2026-10-27T10:00:00.000Z', approvedBy: 'operator',
    ...over,
  };
}

export function makeProject({ root = mkdtempSync(path.join(tmpdir(), 'projects-')), slug = 'acme-ltd', status = 'briefing', foundation } = {}) {
  const dir = projectDirOf(root, slug);
  mkdirSync(dir, { recursive: true });
  saveProject(dir, { schema: 1, slug, client: 'Acme Ltd', createdAt: '2026-10-27T09:00:00.000Z', status,
    foundation: foundation ?? { repo: null, tag: null }, approved: null, builtFromBrief: null });
  return { projectsRoot: root, projectDir: dir, slug };
}
