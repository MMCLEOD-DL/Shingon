import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createAppServer } from '../../src/service/server.js';
import { StateStore } from '../../src/service/state.js';

const workerFile = fileURLToPath(new URL('../fixtures/operator-app/fake-worker.cjs', import.meta.url));
async function setup(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-app-test-'));
  const configFile = path.join(root, 'config.json');
  const dataDir = path.join(root, 'data');
  const repo = path.join(root, 'repo'); mkdirSync(repo);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid']]) execFileSync('git', ['-C', repo, ...args]);
  writeFileSync(path.join(repo, 'README.md'), 'synthetic\n'); execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'initial']);
  const config = { participants: [
    { name: 'claude', adapter: 'claude-code', roles: ['author', 'reviewer'], capabilities: { can_edit_files: true } },
    { name: 'codex', adapter: 'codex', roles: ['author', 'reviewer'], capabilities: { can_edit_files: true } },
    { name: 'local', adapter: 'local-agent', model: 'synthetic', roles: ['grunt'], capabilities: { can_edit_files: true } },
  ], routing: { allowApi: false }, options: { testCommand: 'node --test' }, factory: { operatorName: 'preserved' } };
  writeFileSync(configFile, JSON.stringify(config));
  const app = await createAppServer({ dataDir, configFile, port: 0, workerFile, ...options });
  let cookie = '';
  const call = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(app.origin + '/api/v1' + p, { method, headers: { origin: app.origin,
      ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json(), headers: res.headers };
  };
  const login = async () => { const r = await call('/session', { method: 'POST', body: { bootstrapToken: app.bootstrapToken } }); assert.equal(r.status, 200); cookie = r.headers.get('set-cookie').split(';')[0]; };
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const register = async () => { const r = await call('/repositories', { method: 'POST', body: { path: repo } }); assert.equal(r.status, 201); return r.json.id; };
  const start = async repositoryId => call('/runs', { method: 'POST', body: { repositoryId, request: 'synthetic task', presetId: 'default', clientRequestId: 'request-1' } });
  const wait = async (runId, status) => {
    for (let i = 0; i < 100; i++) { const r = await call('/runs/' + runId); if (r.json.status === status) return r.json; await new Promise(r => setTimeout(r, 20)); }
    throw new Error('run never reached ' + status);
  };
  return { root, dataDir, configFile, config, repo, app, call, login, register, start, wait, stream: p => fetch(app.origin + '/api/v1' + p, { headers: { cookie, origin: app.origin } }) };
}

test('session bootstrap is single use, cookies are HttpOnly, and unauthenticated reads fail', async t => {
  const s = await setup(t);
  assert.equal((await s.call('/health')).status, 401);
  const login = await s.call('/session', { method: 'POST', body: { bootstrapToken: s.app.bootstrapToken } });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await s.call('/session', { method: 'POST', body: { bootstrapToken: s.app.bootstrapToken } })).status, 401);
});
test('host, origin and fetch-site checks reject cross-site browser operations', async t => {
  const s = await setup(t); await s.login();
  for (const headers of [{ origin: 'https://evil.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await s.call('/setup', { headers })).status, 403, JSON.stringify(headers));
    assert.equal((await s.call('/repositories', { method: 'POST', body: { path: s.repo }, headers })).status, 403);
  }
});
test('raw DNS-rebinding Host requests are refused before authentication', async t => {
  const s = await setup(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.get(s.app.origin + '/api/v1/health', { headers: { host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(status, 403);
});
test('setup changes preserve unrelated config, reject browser-supplied executable commands and disable API routing', async t => {
  const s = await setup(t); await s.login();
  assert.equal((await s.call('/setup', { method: 'PUT', body: { bin: '/arbitrary' } })).status, 400);
  assert.equal((await s.call('/setup', { method: 'PUT', body: { local: { model: 'new', baseUrl: 'http://remote.invalid/v1' } } })).status, 400);
  const result = await s.call('/setup', { method: 'PUT', body: { local: { model: 'new', baseUrl: 'http://127.0.0.1:8080/v1' } } });
  assert.equal(result.status, 200);
  const raw = JSON.parse(readFileSync(s.configFile)); assert.equal(raw.factory.operatorName, 'preserved'); assert.equal(raw.routing.allowApi, false);
});
test('run creation is idempotent, registered repositories required, and only one operation is active', async t => {
  const s = await setup(t); await s.login();
  assert.equal((await s.start('unknown')).status, 400);
  const repositoryId = await s.register(); const r = await s.start(repositoryId); assert.equal(r.status, 202);
  assert.equal((await s.start(repositoryId)).json.id, r.json.id);
  assert.equal((await s.call('/runs', { method: 'POST', body: { repositoryId, request: 'different', presetId: 'default', clientRequestId: 'request-1' } })).status, 409);
  assert.equal((await s.call('/runs', { method: 'POST', body: { repositoryId, request: 'different', presetId: 'default', clientRequestId: 'request-2' } })).status, 409);
  assert.equal((await s.call('/participants/local/probe', { method: 'POST', body: { kind: 'installation' } })).status, 409);
});
for (const choice of ['approve', 'reject']) test(`fake IPC journey: ${choice}, exact evidence and no duplicate approval`, async t => {
  const s = await setup(t); await s.login(); const repositoryId = await s.register(); const initial = await s.start(repositoryId);
  const run = await s.wait(initial.json.id, 'awaiting-decision'); const d = run.decision;
  const input = { choiceId: choice, expectedRevision: d.revision, reviewedCommit: d.evidence.commit, clientRequestId: 'answer-1' };
  assert.equal((await s.call(`/runs/${run.id}/decisions/${d.id}`, { method: 'POST', body: { ...input, expectedRevision: 'stale' } })).status, 409);
  const result = await s.call(`/runs/${run.id}/decisions/${d.id}`, { method: 'POST', body: input }); assert.equal(result.status, 200);
  assert.equal((await s.call(`/runs/${run.id}/decisions/${d.id}`, { method: 'POST', body: input })).status, 200);
  assert.equal((await s.call(`/runs/${run.id}/decisions/${d.id}`, { method: 'POST', body: { ...input, clientRequestId: 'answer-2' } })).status, 409);
  const finished = await s.wait(run.id, choice === 'approve' ? 'completed' : 'rejected');
  assert.equal(finished.landedBranch, choice === 'approve' ? 'conductor/synthetic' : null);
  // Fixture reports a branch but does not run Git. Prove this is not mistaken for
  // real-engine acceptance: original repo still has only its original branch.
  assert.doesNotMatch(execFileSync('git', ['-C', s.repo, 'branch'], { encoding: 'utf8' }), /conductor\/synthetic/);
  assert.equal((await s.call('/runs/' + run.id + '/review')).json.diff, '+synthetic change');
});
test('cancel acknowledges the request before reporting worker interruption', async t => {
  const s = await setup(t); await s.login(); const r = await s.start(await s.register());
  const run = await s.wait(r.json.id, 'awaiting-decision');
  const result = await s.call('/runs/' + run.id + '/cancel', { method: 'POST' });
  assert.equal(result.status, 202); assert.equal(result.json.status, 'cancelling');
  const stopped = await s.wait(run.id, 'interrupted'); assert.equal(stopped.decision, null);
});
test('recovery invalidates orphaned decisions and refuses malformed state', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conductor-state-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  store.data.repositories.push({ id: 'repo', path: '/synthetic' });
  store.data.runs.push({ id: 'run', repositoryId: 'repo', status: 'awaiting-decision', workspaceDir: '/synthetic-workspace', events: [], decision: { status: 'pending' }, activeDecisionId: 'old' }); store.save();
  const recovered = new StateStore(dir).data.runs[0]; assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.activeDecisionId, null); assert.equal(recovered.decision.status, 'invalidated');
  writeFileSync(path.join(dir, 'service-state.json'), '{}'); assert.throws(() => new StateStore(dir), /cannot be read/);
});

test('same data directory cannot have two service owners, even on different HTTP ports', async t => {
  const s = await setup(t);
  await assert.rejects(createAppServer({ dataDir: s.dataDir, configFile: s.configFile, port: 0, workerFile }), /already in use/);
  await s.app.close();
  const replacement = await createAppServer({ dataDir: s.dataDir, configFile: s.configFile, port: 0, workerFile });
  await replacement.close();
});
test('configuration edits invalidate cached authenticated probe status', async t => {
  const s = await setup(t, { probe: async ({ participantId }) => ({ participantId, authentication: 'verified', checkedAt: '2026-10-29T00:00:00Z' }) });
  await s.login();
  assert.equal((await s.call('/participants/codex/probe', { method: 'POST', body: { kind: 'authenticated' } })).status, 200);
  assert.equal((await s.call('/setup')).json.participants.find(p => p.participantId === 'codex').authentication, 'verified');
  assert.equal((await s.call('/setup', { method: 'PUT', body: { local: { model: 'changed', baseUrl: 'http://127.0.0.1:8080/v1' } } })).status, 200);
  assert.equal((await s.call('/setup')).json.participants.find(p => p.participantId === 'codex').authentication, 'unknown');
});
test('event replay returns persisted ordered events and refuses future cursors', async t => {
  const s = await setup(t); await s.login(); const r = await s.start(await s.register());
  const run = await s.wait(r.json.id, 'awaiting-decision');
  assert.equal((await s.call(`/runs/${run.id}/events?after=9999`)).status, 409);
  const response = await s.stream(`/runs/${run.id}/events?after=1`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = await reader.read();
  const text = new TextDecoder().decode(first.value);
  assert.match(text, /^id: 2\nevent: run\ndata: /);
  const event = JSON.parse(text.split('data: ')[1].split('\n')[0]);
  assert.equal(event.seq, 2); assert.equal(event.runId, run.id);
  await reader.cancel();
});

test('a storage failure blocks approval before it reaches the worker', async t => {
  const s = await setup(t); await s.login(); const r = await s.start(await s.register());
  const run = await s.wait(r.json.id, 'awaiting-decision'); const d = run.decision;
  const file = path.join(s.dataDir, 'service-state.json');
  rmSync(file); mkdirSync(file); // real rename failure, not a mocked success
  const result = await s.call(`/runs/${run.id}/decisions/${d.id}`, { method: 'POST', body: {
    choiceId: 'approve', expectedRevision: d.revision, reviewedCommit: d.evidence.commit, clientRequestId: 'disk-failure',
  } });
  assert.equal(result.status, 503); assert.equal(result.json.error.code, 'storage-unavailable');
  assert.equal((await s.call('/health')).status, 503);
  for (let i = 0; i < 50 && s.app.runs.active; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(s.app.runs.active, null);
  assert.notEqual(s.app.runs.get(run.id).status, 'completed');
});
