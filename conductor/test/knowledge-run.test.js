// K8 slice 3: knowledge-base evidence wired into runlog.callAgent (knowledge/run.js), per design §9. A stub knowledge
// service on loopback, fake participants, real Seats and a real RunLog; no knowledge service, no model.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { callAgent } from '../src/runlog.js';
import { Seat } from '../src/router.js';
import { checkKnowledgeOptions, refuseKnowledge } from '../src/knowledge/run.js';
import { PARTICIPANT_NOTICE } from '../src/knowledge/evidence.js';
import { childEnv, strictChildEnv, addScrubEnv, KB_TOKEN_ENV } from '../src/secrets.js';
import { runCommand } from '../src/exec.js';
import { runWakeCommand } from '../src/wake.js';
import { loadConfig } from '../src/config.js';
import { LocalAgentAdapter } from '../src/adapters/localAgent.js';
import { fakeParticipant, makeCtx } from './helpers/fakes.js';
import { writeStubCli } from './helpers/stubCli.js';

const TOKEN = `kb1.${'c'.repeat(32)}.${'D'.repeat(43)}`;
// The token is set, and the route settings that would make Claude Code or Codex unverifiable are cleared (this cloud
// container sets ANTHROPIC_BASE_URL for its own session); everything is restored afterwards.
const ROUTE_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'OPENAI_BASE_URL'];
const savedEnv = Object.fromEntries([KB_TOKEN_ENV, ...ROUTE_ENV].map((k) => [k, process.env[k]]));
for (const k of ROUTE_ENV) delete process.env[k];
process.env[KB_TOKEN_ENV] = TOKEN;
after(() => { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
const APPROVED = { claude: 'claude-subscription', codex: 'codex-subscription', local: 'local-model' };
// Fake participants with the route details a real config gives them: a private local endpoint, Codex's frontier home.
function routed(p) {
  if (p.adapter.kind === 'local-agent') p.adapter.baseUrl = 'http://127.0.0.1:8080/v1';
  if (p.adapter.kind === 'codex') { p.adapter.homeIdentity = ['frontier', 'codex']; p.adapter.extraConfig = []; }
  return p;
}

const EXCERPT = 'EXCERPT-Never log passwords or session tokens.';
const ALL = ['local-model', 'claude-subscription', 'codex-subscription'];
// A stub knowledge service whose policy (destinations and revision) a test can change between calls.
async function kbStub({ destinations = ALL, revision = 'a'.repeat(64), evidence = 'strong' } = {}) {
  const st = { destinations, revision, evidence, requests: [], down: false, policySequence: [] }; // policySequence: revisions for the next /collections reads
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      st.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      if (st.down) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'index-unavailable', message: 'x', retryable: true, requestId: 'r' } })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/kb/v1/collections') {
        res.end(JSON.stringify({ viewRevision: st.policySequence.length ? st.policySequence.shift() : st.revision, collections: [{ collectionId: 'standards', kind: 'reference', destinations: st.destinations, documents: 1, lastIngestedAt: '2026-10-29T12:00:00Z' }] }));
      } else {
        res.end(JSON.stringify({ viewRevision: st.revision, evidence: st.evidence, results: [{
          chunkId: 'k'.repeat(64), documentId: 'standards/logging.md', versionId: 1, collectionId: 'standards', title: 'Logging', excerpt: EXCERPT,
          locator: { page: null, sectionPath: ['Logging'], sheet: null, cellRange: null, slide: null },
          source: { display: 'standards', versionLabel: 'v1', modifiedAt: null, ingestedAt: '2026-10-29T12:00:00Z' },
          scores: { rank: 1, keyword: 1, vector: null, rerank: null },
          flags: { stale: false, supersededBy: null, conflictsWith: [], ocr: false, ocrConfidence: null, instructionLike: false } }] }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  st.url = `http://127.0.0.1:${server.address().port}`;
  st.close = () => new Promise((r) => server.close(r));
  return st;
}
const ok = () => ({ text: 'done' });
const teamOf = () => ({
  author: routed(fakeParticipant({ name: 'claude', kind: 'claude-code', script: ok })),
  reviewer: routed(fakeParticipant({ name: 'codex', kind: 'codex', script: ok })),
  local: routed(fakeParticipant({ name: 'local', kind: 'local-agent', script: ok })),
});
const ctxWith = async (kb, extra = {}) => makeCtx({ team: extra.team ?? teamOf(), request: 'add logging without secrets',
  options: { knowledge: kb ? { url: kb.url, participants: extra.participants ?? APPROVED } : null, ...(extra.options ?? {}) } });
const events = (ctx, type) => readFileSync(ctx.log.transcript, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === type);

test('off by default: no knowledge request, and calls carry no evidence context', async () => {
  const kb = await kbStub();
  try {
    const ctx = await ctxWith(null);
    await callAgent(ctx, ctx.team.author, 'author', 'plan it');
    assert.equal(kb.requests.length, 0);
    assert.equal(ctx.team.author.calls[0].context, '');
  } finally { await kb.close(); }
});

test('on: evidence reaches the call in its context; only provenance is saved, never the passage', async () => {
  const kb = await kbStub();
  try {
    const ctx = await ctxWith(kb);
    await callAgent(ctx, ctx.team.author, 'author', 'plan it');
    assert.match(ctx.team.author.calls[0].context, /EXCERPT-Never log/);
    assert.ok(kb.requests.every((r) => r.auth === `Bearer ${TOKEN}`));
    assert.deepEqual(ctx.state.knowledge, { sent: true, scope: ['claude', 'codex', 'local'], origin: kb.url, viewRevision: 'a'.repeat(64) });
    assert.equal(events(ctx, 'evidence-used').length, 1);
    const saved = readFileSync(ctx.log.statePath, 'utf8');
    assert.doesNotMatch(saved, /EXCERPT|Never log/, 'a passage was written to state.json');
    assert.doesNotMatch(readFileSync(ctx.log.transcript, 'utf8'), new RegExp(TOKEN), 'the token is in the transcript');
    await callAgent(ctx, ctx.team.reviewer, 'reviewer', 'review it');
    assert.match(ctx.team.reviewer.calls[0].context, /EXCERPT-Never log/);
    assert.equal(kb.requests.filter((r) => r.url === '/kb/v1/search').length, 1, 'searched once per run');
    assert.equal(kb.requests.filter((r) => r.url === '/kb/v1/collections').length, 3, 'one policy read to assemble, then one freshness check per call');
  } finally { await kb.close(); }
});

test('a local-only collection is withheld from a mixed run: no passage to anyone, reports to the operator only', async () => {
  const kb = await kbStub({ destinations: ['local-model'] });
  try {
    const ctx = await ctxWith(kb);
    for (const seat of ['author', 'reviewer', 'local']) await callAgent(ctx, ctx.team[seat], 'author', 'go');
    for (const seat of ['author', 'reviewer', 'local']) {
      assert.doesNotMatch(ctx.team[seat].calls[0].context, /EXCERPT/);
      assert.equal(ctx.team[seat].calls[0].context, PARTICIPANT_NOTICE);
    }
    assert.deepEqual(events(ctx, 'evidence-withheld').map((e) => e.report.participant), ['claude', 'codex']);
    assert.equal(ctx.state.knowledge, undefined, 'nothing was sent, so no provenance');
  } finally { await kb.close(); }
});

test('a seat with an API fallback candidate keeps the evidence from the whole run, end to end through callAgent', async () => {
  const kb = await kbStub();
  try {
    const cli = fakeParticipant({ name: 'claude', kind: 'claude-code', script: () => ({ ok: false, failure: 'infrastructure', error: 'reset' }) });
    const api = fakeParticipant({ name: 'claude-api', kind: 'anthropic-api', script: ok });
    const team = { ...teamOf(), author: new Seat({ name: 'claude', candidates: [cli, api] }) };
    const ctx = await ctxWith(kb, { team });
    await callAgent(ctx, team.author, 'author', 'plan it');
    assert.equal(api.calls.length, 1);
    assert.doesNotMatch(api.calls[0].context, /EXCERPT/);
    assert.deepEqual(events(ctx, 'evidence-withheld').map((e) => e.report.participant), ['claude-api']);
  } finally { await kb.close(); }
});

test('policy lost before any evidence was used: drop it once and carry on', async () => {
  const kb = await kbStub();
  try {
    const ctx = await ctxWith(kb);
    kb.policySequence = ['a'.repeat(64), 'b'.repeat(64)]; // assembled at revision a; the freshness check then sees b
    const r = await callAgent(ctx, ctx.team.author, 'author', 'plan it');
    assert.equal(r.ok, true, 'nothing had been sent yet, so the run carries on');
    assert.equal(ctx.team.author.calls[0].context, '');
    assert.equal(ctx.state.knowledge, undefined);
    await callAgent(ctx, ctx.team.reviewer, 'reviewer', 'review it');
    assert.equal(ctx.team.reviewer.calls[0].context, '', 'dropped for the rest of the run');
    assert.equal(events(ctx, 'evidence-dropped').length, 1);
    assert.equal(kb.requests.filter((q) => q.url === '/kb/v1/search').length, 1, 'never fetched again after dropping');
  } finally { await kb.close(); }
});

test('policy lost after evidence was used: the next call is stopped as a resumable pause and never sent', async () => {
  const kb = await kbStub();
  try {
    const ctx = await ctxWith(kb);
    await callAgent(ctx, ctx.team.author, 'author', 'plan it');
    assert.equal(ctx.state.knowledge.sent, true);
    for (const change of [() => { kb.revision = 'b'.repeat(64); }, () => { kb.revision = 'a'.repeat(64); kb.down = true; }]) {
      change();
      const r = await callAgent(ctx, ctx.team.reviewer, 'reviewer', 'review the plan (derived from evidence)');
      assert.equal(r.ok, false);
      assert.equal(r.failure, 'no-participant', 'the phases turn this into a resumable pause');
      assert.match(r.error, /could not be confirmed after evidence had been used/);
      assert.equal(ctx.team.reviewer.calls.length, 0, 'the derived task was never sent');
    }
    assert.ok(events(ctx, 'evidence-stopped').length >= 2);
  } finally { await kb.close(); }
});

test('resume: an unchanged policy lets evidence-derived work continue; a changed one stops it', async () => {
  const kb = await kbStub();
  try {
    const first = await ctxWith(kb);
    await callAgent(first, first.team.author, 'author', 'plan it');
    const saved = JSON.parse(readFileSync(first.log.statePath, 'utf8'));
    // A new process: a fresh ctx (no process-local evidence) with the saved provenance.
    const resumed = await ctxWith(kb);
    resumed.state.knowledge = saved.knowledge;
    const r1 = await callAgent(resumed, resumed.team.reviewer, 'reviewer', 'continue');
    assert.equal(r1.ok, true);
    assert.match(resumed.team.reviewer.calls[0].context, /EXCERPT/);
    kb.revision = 'c'.repeat(64);
    const again = await ctxWith(kb);
    again.state.knowledge = saved.knowledge;
    const r2 = await callAgent(again, again.team.reviewer, 'reviewer', 'continue');
    assert.equal(r2.failure, 'no-participant');
    assert.equal(again.team.reviewer.calls.length, 0);
    const off = await ctxWith(null); // resumed without the knowledge settings at all
    off.state.knowledge = saved.knowledge;
    assert.equal((await callAgent(off, off.team.reviewer, 'reviewer', 'continue')).failure, 'no-participant');
  } finally { await kb.close(); }
});

test('an unreachable service or a missing token: no evidence, the run goes on', async () => {
  const kb = await kbStub();
  kb.down = true;
  try {
    const ctx = await ctxWith(kb);
    const r = await callAgent(ctx, ctx.team.author, 'author', 'plan it');
    assert.equal(r.ok, true);
    assert.equal(ctx.team.author.calls[0].context, '');
    assert.equal(events(ctx, 'evidence-unavailable')[0].reason, 'index-unavailable');
  } finally { await kb.close(); }
  delete process.env[KB_TOKEN_ENV];
  try {
    const kb2 = await kbStub();
    const ctx = await ctxWith(kb2);
    await callAgent(ctx, ctx.team.author, 'author', 'plan it');
    assert.equal(kb2.requests.length, 0, 'no request without a token');
    assert.equal(events(ctx, 'evidence-unavailable')[0].reason, 'config');
    await kb2.close();
  } finally { process.env[KB_TOKEN_ENV] = TOKEN; }
});

test('council and factory runs never fetch evidence (backstop), and their entry points refuse the setting', async () => {
  const kb = await kbStub();
  try {
    for (const options of [{ council: true }, { factoryFeature: { id: 'f1', tags: [] } }]) {
      const ctx = await ctxWith(kb, { options });
      await callAgent(ctx, ctx.team.author, 'author', 'plan it');
      assert.equal(ctx.team.author.calls[0].context, '');
    }
    assert.equal(kb.requests.length, 0);
  } finally { await kb.close(); }
  assert.throws(() => refuseKnowledge({ knowledge: { url: 'http://127.0.0.1:1' } }, 'conductor build'), /ordinary Conductor runs only/);
  assert.doesNotThrow(() => refuseKnowledge({ knowledge: null }, 'conductor build'));
});

test('options.knowledge is validated: private origin, known settings, bounded values, not with the council', () => {
  const P = { participants: APPROVED };
  assert.doesNotThrow(() => checkKnowledgeOptions({ knowledge: { url: 'http://127.0.0.1:8700', ...P, collections: ['standards'], maxPassages: 5, maxChars: 8000 } }));
  for (const [k, re] of [
    [{ url: 'https://kb.example.com', ...P }, /private network/], [{ url: 'http://127.0.0.1:1', ...P, token: 'x' }, /unknown setting "token"/],
    [{ url: 'http://127.0.0.1:1', ...P, maxPassages: 50 }, /maxPassages/], [{ url: 'http://127.0.0.1:1', ...P, maxChars: 100 }, /maxChars/],
    [{ url: 'http://127.0.0.1:1', ...P, collections: [] }, /collections/], ['http://127.0.0.1:1', /must be an object/],
    [{ url: 'http://127.0.0.1:1' }, /participants must approve/], [{ url: 'http://127.0.0.1:1', participants: { claude: 'anthropic-api' } }, /participants must approve/],
  ]) assert.throws(() => checkKnowledgeOptions({ knowledge: k }), re, JSON.stringify(k));
  assert.throws(() => checkKnowledgeOptions({ knowledge: { url: 'http://127.0.0.1:1', ...P }, council: true }), /council/);
  const dir = mkdtempSync(path.join(tmpdir(), 'kb-config-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ participants: [], options: { knowledge: { url: 'https://kb.example.com', participants: APPROVED } } }));
  assert.throws(() => loadConfig(file), /options\.knowledge\.url/);
});

test('the token reaches no child: any spelling, any allow list; it is refused as a provider key or wake variable', async () => {
  const env = { PATH: process.env.PATH, [KB_TOKEN_ENV]: TOKEN, conductor_kb_token: TOKEN, Conductor_Kb_Token: TOKEN, KEEP: 'yes' };
  for (const out of [childEnv({ env }), childEnv({ env, allow: [KB_TOKEN_ENV, 'conductor_kb_token'] }), strictChildEnv({ env })]) {
    assert.deepEqual(Object.keys(out).filter((k) => k.toUpperCase() === KB_TOKEN_ENV), []);
  }
  assert.equal(childEnv({ env }).KEEP, 'yes');
  assert.throws(() => addScrubEnv(KB_TOKEN_ENV), /reserved/);
  assert.throws(() => addScrubEnv('conductor_kb_token'), /reserved/);
  assert.throws(() => new LocalAgentAdapter({ model: 'm', envKey: KB_TOKEN_ENV }), /reserved/);
  const dir = mkdtempSync(path.join(tmpdir(), 'kb-wake-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ participants: [{ name: 'local', adapter: 'local-agent', model: 'm', roles: ['grunt'],
    wake: { method: 'command', cmd: 'true', env: [KB_TOKEN_ENV] } }] }));
  assert.throws(() => loadConfig(file), /reserved/);
  // A wake command and an ordinary child (git, a test command, a model CLI) never see it, even with it in process.env.
  const seen = writeStubCli(dir, 'print-env', "process.stdout.write(Object.keys(process.env).filter((k) => k.toUpperCase() === 'CONDUCTOR_KB_TOKEN').join(','));");
  const viaDefault = await runCommand({ cmd: seen, timeoutMs: 10000 });
  assert.equal(viaDefault.stdout, '');
  let wakeEnv;
  await runWakeCommand({ cmd: seen, env: [KB_TOKEN_ENV] }, { env: { ...process.env, [KB_TOKEN_ENV]: TOKEN }, run: async (o) => { wakeEnv = o.env; return { code: 0, stdout: '', stderr: '' }; } });
  assert.deepEqual(Object.keys(wakeEnv).filter((k) => k.toUpperCase() === KB_TOKEN_ENV), []);
});

// ---- whole runs through runTask/resume: the stop really is a resumable pause ----
import { runTask, resume } from '../src/conductor.js';
import { makeRepo } from './helpers/gitRepo.js';
import { approve } from './helpers/fakes.js';

const PLAN = { summary: 'S', chunks: [{ title: 'One', instructions: 'make one' }] };
function runTeam(onAuthor = () => {}) {
  return {
    author: routed(fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role) => { if (role === 'reviewer') return approve(); onAuthor(); return { text: '```json\n' + JSON.stringify(PLAN) + '\n```' }; } })),
    reviewer: routed(fakeParticipant({ name: 'codex', kind: 'codex', script: () => approve() })),
    local: routed(fakeParticipant({ name: 'local', kind: 'local-agent', roles: ['grunt'], script: (role, task, c, opts) => { writeFileSync(path.join(opts.cwd, 'one.txt'), 'x\n'); return { text: 'ok' }; } })),
  };
}
const runHooks = () => ({ escalate: async () => 'reject', approveResult: async () => true, approveChunk: async () => true });

test('a whole run with evidence lands; every agent got the evidence; state keeps provenance only', async () => {
  const kb = await kbStub();
  try {
    const team = runTeam();
    const out = await runTask({ repoDir: await makeRepo(), request: 'Add one', team, hooks: runHooks(), baseDir: mkdtempSync(path.join(tmpdir(), 'kb-run-')),
      options: { knowledge: { url: kb.url, participants: APPROVED }, keepWorkspace: true } });
    assert.equal(out.status, 'landed');
    for (const p of [team.author, team.reviewer, team.local]) assert.ok(p.calls.every((c) => /EXCERPT-Never log/.test(c.context)), p.name);
    const state = readFileSync(path.join(`${out.workspaceDir}.conductor`, 'state.json'), 'utf8');
    assert.match(state, /"sent": true/);
    assert.doesNotMatch(state, /EXCERPT/);
  } finally { await kb.close(); }
});

test('the policy changes after the author used evidence: the run pauses before the reviewer sees the plan, and resumes when it is back', async () => {
  const kb = await kbStub();
  try {
    let first = true;
    const team = runTeam(() => { if (first) { first = false; kb.revision = 'b'.repeat(64); } });
    const repo = await makeRepo();
    const out = await runTask({ repoDir: repo, request: 'Add one', team, hooks: runHooks(), baseDir: mkdtempSync(path.join(tmpdir(), 'kb-run-')),
      options: { knowledge: { url: kb.url, participants: APPROVED } } });
    assert.equal(out.status, 'paused');
    assert.match(out.reason, /could not be confirmed after evidence had been used/);
    assert.equal(team.reviewer.calls.length, 0, 'the evidence-derived plan was never sent to the reviewer');
    kb.revision = 'a'.repeat(64); // the policy is back as it was
    const again = runTeam();
    const resumed = await resume({ workspaceDir: out.workspaceDir, repoDir: repo, team: again, hooks: runHooks() });
    assert.equal(resumed.status, 'landed');
    assert.ok(again.reviewer.calls.length > 0);
  } finally { await kb.close(); }
});

// ---- Codex review of PR101: trusted destinations, and the gate inside Seat.run's retry boundary ----
import { trustedDestination } from '../src/knowledge/run.js';

test('a destination is trusted only if the operator approved the name and nothing visible contradicts the route', () => {
  const p = (name, kind, adapter = {}) => ({ name, adapter: { kind, ...adapter } });
  const approved = { local: 'local-model', lan: 'local-model', claude: 'claude-subscription', codex: 'codex-subscription', odd: 'claude-subscription' };
  const clean = trustedDestination(approved, {});
  assert.equal(clean(p('local', 'local-agent', { baseUrl: 'http://127.0.0.1:8080/v1' })), 'local-model');
  assert.equal(clean(p('lan', 'local-agent', { baseUrl: 'http://10.0.0.5:8080/v1' })), 'local-model');
  assert.equal(clean(p('local', 'local-agent', { baseUrl: 'https://example.invalid/v1' })), null, 'a public endpoint is not the local model');
  assert.equal(clean(p('claude', 'claude-code')), 'claude-subscription');
  assert.equal(clean(p('codex', 'codex', { homeIdentity: ['frontier', 'codex'], extraConfig: [] })), 'codex-subscription');
  assert.equal(clean(p('codex', 'codex', { homeIdentity: ['frontier', 'codex'], extraConfig: ['model_provider=other'] })), null, 'provider override');
  assert.equal(clean(p('codex', 'codex', { homeIdentity: ['frontier', 'codex'], extraConfig: ['model_providers.x.base_url="https://x"'] })), null);
  assert.equal(clean(p('codex', 'codex', { homeIdentity: ['codex', []], extraConfig: [] })), null, 'not the frontier home');
  assert.equal(clean(p('odd', 'local-agent', { baseUrl: 'http://127.0.0.1:1/v1' })), null, 'approved destination does not match the kind');
  assert.equal(clean(p('stranger', 'claude-code')), null, 'not approved');
  assert.equal(clean(p('claude-api', 'anthropic-api')), null);
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
    assert.equal(trustedDestination(approved, { [k]: 'x' })(p('claude', 'claude-code')), null, k);
  }
  assert.equal(trustedDestination(approved, { OPENAI_BASE_URL: 'https://x' })(p('codex', 'codex', { homeIdentity: ['frontier', 'codex'], extraConfig: [] })), null);
});

test('a local model whose endpoint is not private makes the collection unusable for the whole run', async () => {
  const kb = await kbStub();
  try {
    const team = teamOf();
    team.local.adapter.baseUrl = 'https://example.invalid/v1';
    const ctx = await ctxWith(kb, { team });
    for (const seat of ['author', 'local']) await callAgent(ctx, team[seat], 'author', 'go');
    assert.doesNotMatch(team.author.calls[0].context + team.local.calls[0].context, /EXCERPT/);
    assert.deepEqual(events(ctx, 'evidence-withheld').map((e) => e.report.participant), ['local']);
  } finally { await kb.close(); }
});

test('revocation between attempts inside one Seat.run: the next candidate is never sent anything, and there is no failover', async () => {
  const kb = await kbStub();
  try {
    const first = routed(fakeParticipant({ name: 'claude', kind: 'claude-code', script: () => { kb.revision = 'b'.repeat(64); return { ok: false, failure: 'infrastructure', error: 'reset' }; } }));
    const second = routed(fakeParticipant({ name: 'claude-b', kind: 'claude-code', script: ok }));
    const team = { ...teamOf(), author: new Seat({ name: 'claude', candidates: [first, second] }) };
    const ctx = await ctxWith(kb, { team, participants: { ...APPROVED, 'claude-b': 'claude-subscription' } });
    const r = await callAgent(ctx, team.author, 'author', 'plan it');
    assert.match(first.calls[0].context, /EXCERPT/, 'the first attempt was cleared and carried evidence');
    assert.equal(second.calls.length, 0, 'the retry after the policy changed was never dispatched');
    assert.equal(r.ok, false);
    assert.equal(r.failure, 'no-participant', 'a resumable pause, not a failover');
    assert.match(r.error, /could not be confirmed after evidence had been used/, 'the knowledge stop itself, not the router running out of candidates');
    assert.equal(r.servedBy, 'claude-b', 'stopped at the candidate it was about to try');
    assert.ok(events(ctx, 'evidence-stopped').length >= 1);
  } finally { await kb.close(); }
});

test('a candidate added to a seat after evidence was used is outside the approved scope and is stopped', async () => {
  const kb = await kbStub();
  try {
    const cli = routed(fakeParticipant({ name: 'claude', kind: 'claude-code', script: ok }));
    const seat = new Seat({ name: 'claude', candidates: [cli] });
    const team = { ...teamOf(), author: seat };
    const ctx = await ctxWith(kb, { team, participants: { ...APPROVED, late: 'claude-subscription' } });
    await callAgent(ctx, seat, 'author', 'plan it');
    assert.equal(ctx.state.knowledge.sent, true);
    const late = routed(fakeParticipant({ name: 'late', kind: 'claude-code', script: ok }));
    seat.candidates.unshift(late); // e.g. a route added after the evidence was chosen
    const r = await callAgent(ctx, seat, 'author', 'next, from the plan');
    assert.equal(r.failure, 'no-participant');
    assert.equal(late.calls.length, 0);
  } finally { await kb.close(); }
});
