// Shared harness for the build tests: a fake team, a project on a tiny fake foundation, and stub deps.
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { factoryConfig } from '../../src/factory/config.js';
import { git } from '../../src/workspace.js';
import { fakeParticipant, approve } from './fakes.js';
import { makeFoundationRepo, makeProject, sampleBrief } from './factoryFixtures.js';

export const UNITS = [
  { id: 'expenses', title: 'Submit and list expenses', covers: ['submit-expense'], acceptance: ['submit-expense#1', 'submit-expense#2'], instructions: 'Add expenses.', dependsOn: [] },
  { id: 'report', title: 'Monthly report', covers: ['monthly-report'], acceptance: ['monthly-report#1'], instructions: 'Add the report.', dependsOn: ['expenses'] },
];
export const json = (o) => ({ text: '```json\n' + JSON.stringify(o) + '\n```' });
export const PLAN = { summary: 'S', chunks: [{ title: 'Build it', instructions: 'write the code' }] };

export function team({ local } = {}) {
  return {
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role, task) => (role === 'reviewer' ? approve() : /Split this approved brief/.test(task) ? json({ units: UNITS }) : json(PLAN)) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: (role, task) => (/member of a review council/.test(task) ? json({ findings: [] }) : approve()) }),
    local: fakeParticipant({ name: 'local', kind: 'local-agent', roles: ['grunt'], script: local ?? ((role, task, c, opts) => {
      const step = task.match(/You are doing chunk \d+ of \d+: (.*)/)[1];
      const id = task.match(/^Build step \d+ of \d+ for Acme Ltd: .* \(([a-z0-9-]+)\)/m)[1];   // ruling Q5: fix-1, feedback-1
      mkdirSync(path.join(opts.cwd, 'apps/server/test', id), { recursive: true });
      if (step === 'Acceptance tests') {
        const tags = [...new Set(task.match(/\[[a-z-]+#\d+\]/g))];
        writeFileSync(path.join(opts.cwd, 'apps/server/test', id, 'accept.test.ts'), tags.map((t) => `it('${t} works', () => {});`).join('\n') + '\n');
      } else writeFileSync(path.join(opts.cwd, `${id}.ts`), 'export {};\n');
      return { text: 'done' };
    }) }),
  };
}

// The real runFinal runs unless the caller's deps replace it.
export async function setup({ status = 'briefing', testCommand = 'node -e "process.exit(0)"', deps = {} } = {}) {
  const repo = await makeFoundationRepo();
  const { projectsRoot, projectDir, slug } = makeProject({ status });
  const raw = { projectsRoot, foundation: { repo, tag: 'v0.1.0' }, build: { testCommand, browserGate: false } };
  const factory = factoryConfig({ factory: raw }, { env: {} });
  const checks = [];
  const defaults = {
    loadBrief: () => sampleBrief(), renderBrief: (b) => `# ${b.client}`, currentBriefInfo: () => ({ version: 1, approvedAt: '2026-10-27T10:00:00Z', approvedBy: 'operator' }),
    runAppChecks: async (o) => { checks.push(o); return { verify: { status: 'passed', summary: 'ok', output: '' }, browser: { status: 'skipped', summary: '', output: '' }, reports: [] }; },
  };
  const hooks = { escalate: async () => 'reject', approveBuild: async () => true };
  const baseDir = mkdtempSync(path.join(tmpdir(), 'build-ws-'));   // ruling Q4: never the real ~/.conductor
  return { repo, raw, projectsRoot, projectDir, slug, factory, deps: { ...defaults, ...deps }, hooks, checks, baseDir };
}

export const log = async (dir, ref) => (await git(dir, ['log', '--format=%s', ref])).stdout.trim().split('\n');
