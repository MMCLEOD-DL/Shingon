import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { projectContext } from '../src/council/project.js';
import { BRIEF } from './fixtures/council-full/brief.js';

const ARGS = { projectDir: '/p/acme', appDir: '/p/acme/app', sha: 'abc123', brief: BRIEF, policy: BRIEF.policy, runId: 'r1', slug: 'acme' };
const IDS = { SLUG_RE: /^[a-z0-9][a-z0-9-]*$/, RUN_ID_RE: /^[a-z0-9][a-z0-9-]*$/ };
const PROJECT = { schema: 1, slug: 'acme', client: 'Acme Ltd', foundation: { repo: '/root/highland-foundation', tag: 'v0.1.0', commit: 'f00d' }, status: 'building' };

test('projectContext: build folder, client and foundation from project.json', async () => {
  const c = await projectContext(ARGS, { ids: IDS, loadProject: async (dir) => { assert.equal(dir, '/p/acme'); return PROJECT; } });
  assert.equal(c.buildDir, path.join('/p/acme', 'builds', 'r1'));
  assert.equal(c.client, 'Acme Ltd');
  assert.deepEqual(c.foundation, { repo: '/root/highland-foundation', tag: 'v0.1.0', commit: 'f00d' });
  assert.equal(c.brief, BRIEF);
  assert.equal(c.policy, BRIEF.policy);
  assert.equal(c.checks, null);
  assert.equal(c.problem, null);
});

test("projectContext: carries Plan 8's checks for the same commit", async () => {
  const checks = { verify: { status: 'passed', summary: 'ok', output: '' }, browser: { status: 'passed', summary: 'ok', output: '' }, reports: ['/p/acme/builds/r1/reports/vitest.json'] };
  const c = await projectContext({ ...ARGS, checks }, { ids: IDS, loadProject: async () => PROJECT });
  assert.equal(c.checks, checks);
});

test("projectContext: a missing policy argument falls back to the brief's", async () => {
  const c = await projectContext({ ...ARGS, policy: undefined }, { ids: IDS, loadProject: async () => PROJECT });
  assert.equal(c.policy, BRIEF.policy);
});

test('projectContext: refuses an unsafe run id', async () => {
  await assert.rejects(projectContext({ ...ARGS, runId: '../x' }, { ids: IDS, loadProject: async () => PROJECT }), /The run id "\.\.\/x" cannot be used in a folder name\./);
});

test('projectContext: refuses an unsafe project name; defaults to the real id patterns', async () => {
  await assert.rejects(projectContext({ ...ARGS, slug: '../x' }, { ids: IDS, loadProject: async () => PROJECT }), /The project name "\.\.\/x" cannot be used in a folder name\./);
  await assert.rejects(projectContext({ ...ARGS, runId: 'r1' }, { loadProject: async () => PROJECT }), /The run id "r1" cannot be used/);
  const c = await projectContext({ ...ARGS, runId: '20261027-101500-ab12' }, { loadProject: async () => PROJECT });
  assert.equal(c.buildDir, path.join('/p/acme', 'builds', '20261027-101500-ab12'));
});
