import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../../src/service/server.js';
import { writeStubCli } from '../helpers/stubCli.js';
import { git } from '../../src/workspace.js';

async function fixture(t, { workerFile, request = 'add multiply' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'service-engine-')); const repo = path.join(root, 'repo'); mkdirSync(repo);
  await git(repo, ['init', '-q', '-b', 'main']); writeFileSync(path.join(repo, 'README.md'), 'original\n');
  writeFileSync(path.join(repo, 'checks.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('multiply.txt','utf8'), 'local did it\\n');\n");
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'initial']);
  const originalHead = (await git(repo, ['rev-parse', 'HEAD'])).stdout;
  const local = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[]}'); }); });
  await new Promise(r => local.listen(0, '127.0.0.1', r));
  const bin = path.join(root, 'bin');
  const claude = writeStubCli(bin, 'claude', `
    if (args[0] === '--version') { console.log('synthetic'); process.exit(0); }
    const sys = args[args.indexOf('--append-system-prompt')+1] || '';
    const result = sys.includes('REVIEWER') ? 'Fine.\\nVERDICT: APPROVE'
      : 'Plan.\\n\`\`\`json\\n'+JSON.stringify({summary:'s',chunks:[{title:'Add multiply',instructions:'add it'}]})+'\\n\`\`\`';
    console.log(JSON.stringify({result,is_error:false}));`);
  const codex = writeStubCli(bin, 'codex', `
    if (args[0] === '--version') { console.log('synthetic'); process.exit(0); }
    const fs=require('fs'); const out=args[args.indexOf('-o')+1];
    if(args.includes('model_provider=localai')) { fs.writeFileSync('multiply.txt','local did it\\n'); fs.writeFileSync(out,'Edited multiply.txt.'); }
    else fs.writeFileSync(out,'Fine.\\nVERDICT: APPROVE');`);
  const configFile = path.join(root, 'config.json'), dataDir = path.join(root, 'data');
  writeFileSync(configFile, JSON.stringify({ participants: [
    { name: 'claude', adapter: 'claude-code', bin: claude, roles: ['author','reviewer'], capabilities: { can_edit_files:true } },
    { name: 'codex', adapter: 'codex', bin: codex, roles: ['author','reviewer'], capabilities: { can_edit_files:true } },
    { name: 'local', adapter: 'local-agent', bin: codex, model:'synthetic', baseUrl:`http://127.0.0.1:${local.address().port}/v1`,roles:['grunt'],capabilities:{can_edit_files:true} },
  ], options: { testCommand: 'node checks.cjs' }, routing: { allowApi: false } }));
  let app = await createAppServer({ dataDir, configFile, port:0, workerFile });
  let cookie;
  async function api(p, method='GET', body) {
    const res=await fetch(app.origin+'/api/v1'+p,{method,headers:{origin:app.origin,...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
    if(p==='/session')cookie=res.headers.get('set-cookie').split(';')[0];
    return {status:res.status,body:await res.json()};
  }
  await api('/session','POST',{bootstrapToken:app.bootstrapToken});
  const repositoryId=(await api('/repositories','POST',{path:repo})).body.id;
  const runId=(await api('/runs','POST',{repositoryId,request,presetId:'default',clientRequestId:'start-1'})).body.id;
  const wait=async status=>{for(let i=0;i<400;i++){const r=await api('/runs/'+runId);if(r.body.status===status)return r.body;if(['failed','rejected'].includes(r.body.status)&&status!=='rejected')throw new Error(JSON.stringify(r.body));await new Promise(r=>setTimeout(r,25));}throw new Error('timed out');};
  t.after(async()=>{await app.close();await new Promise(r=>local.close(r));rmSync(root,{recursive:true,force:true});});
  return {get app(){return app;}, api,repo,runId,wait,originalHead, restart: async()=>{await app.close();app=await createAppServer({dataDir,configFile,port:0});cookie=null;await api('/session','POST',{bootstrapToken:app.bootstrapToken});}};
}
test('HTTP service drives the real engine with deterministic model CLIs, tests and approval branch', async t=>{
  const s=await fixture(t);const run=await s.wait('awaiting-decision');
  assert.equal(run.decision.kind,'result');
  const review=(await s.api(`/runs/${s.runId}/review`)).body;
  assert.equal(review.tests.ran,true);assert.equal(review.tests.passed,true);assert.match(review.diff,/local did it/);
  assert.equal(run.coverage.local,'used');assert.deepEqual(run.coverage.vendors.sort(),['anthropic','openai']);
  const d=run.decision;
  assert.equal((await s.api(`/runs/${s.runId}/decisions/${d.id}`,'POST',{choiceId:'approve',expectedRevision:d.revision,reviewedCommit:d.evidence.commit,clientRequestId:'approve-1'})).status,200);
  const done=await s.wait('completed');
  assert.match((await git(s.repo,['show',`${done.landedBranch}:multiply.txt`])).stdout,/local did it/);
  assert.equal((await git(s.repo,['rev-parse','HEAD'])).stdout,s.originalHead);
  assert.equal((await git(s.repo,['status','--porcelain'])).stdout,'');
});
test('changing reviewed files invalidates approval and never lands a branch', async t=>{
  const s=await fixture(t);const run=await s.wait('awaiting-decision');
  const internal=s.app.runs.get(s.runId);writeFileSync(path.join(internal.workspaceDir,'multiply.txt'),'changed after review\n');
  const d=run.decision;
  const answer=await s.api(`/runs/${s.runId}/decisions/${d.id}`,'POST',{choiceId:'approve',expectedRevision:d.revision,reviewedCommit:d.evidence.commit,clientRequestId:'approve-1'});
  assert.equal(answer.status,409);assert.equal(answer.body.error.code,'stale-decision');
  await s.wait('interrupted');
  assert.doesNotMatch((await git(s.repo,['branch'])).stdout,/conductor\//);
  assert.equal(readFileSync(path.join(s.repo,'README.md'),'utf8'),'original\n');
});

test('worker refuses drift after the service approval check, preserving work for fresh review (N2)', async t=>{
  const s=await fixture(t); const run=await s.wait('awaiting-decision');
  const internal=s.app.runs.get(s.runId);
  const workspace=internal.workspaceDir;
  writeFileSync(path.join(s.repo,'README.md'),'operator edits\n');
  writeFileSync(path.join(s.repo,'personal.txt'),'keep this untracked file\n');
  const sourceStatus=(await git(s.repo,['status','--porcelain'])).stdout;
  const sourceIndex=(await git(s.repo,['ls-files','--stage'])).stdout;
  // Simulate the race after the parent has persisted approval but before the
  // real worker rechecks its own snapshot. Do not bypass that second check.
  internal.landingPending=true; internal.status='running'; internal.activeDecisionId=null;
  s.app.store.save();
  writeFileSync(path.join(workspace,'multiply.txt'),'changed after parent check\n');
  s.app.runs.active.child.send({type:'answer',id:run.decision.id,value:true});
  const stopped=await s.wait('failed');
  assert.equal(stopped.recoveryRequired,false); assert.equal(stopped.resumable,true);
  assert.equal(stopped.landingPending,false);
  assert.match(internal.events.at(-1).message,/nothing was landed/i);
  assert.equal(readFileSync(path.join(workspace,'multiply.txt'),'utf8'),'changed after parent check\n');
  assert.doesNotMatch((await git(s.repo,['branch'])).stdout,/conductor\//);
  assert.equal((await git(s.repo,['rev-parse','HEAD'])).stdout,s.originalHead);
  assert.equal((await git(s.repo,['status','--porcelain'])).stdout,sourceStatus);
  assert.equal((await git(s.repo,['ls-files','--stage'])).stdout,sourceIndex);
  assert.equal(readFileSync(path.join(s.repo,'README.md'),'utf8'),'operator edits\n');
  assert.equal(readFileSync(path.join(s.repo,'personal.txt'),'utf8'),'keep this untracked file\n');
  for(let i=0;i<100&&s.app.runs.active;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal((await s.api(`/runs/${s.runId}/resume`,'POST')).status,202);
  const fresh=await s.wait('awaiting-decision');
  assert.notEqual(fresh.decision.id,run.decision.id);
  assert.equal(fresh.landingPending,false);
});

test('inspection after a crash before landing still requires a fresh result approval', async t=>{
  const workerFile=fileURLToPath(new URL('../fixtures/operator-app/crash-land-worker.js',import.meta.url));
  const s=await fixture(t,{workerFile,request:'before-land'}); const run=await s.wait('awaiting-decision'); const d=run.decision;
  await s.api(`/runs/${s.runId}/decisions/${d.id}`,'POST',{
    choiceId:'approve',expectedRevision:d.revision,reviewedCommit:d.evidence.commit,clientRequestId:'approve-before-crash',
  });
  const interrupted=await s.wait('interrupted');
  const refs=(await git(s.repo,['show-ref'])).stdout;
  const input={clientRequestId:'inspect-before-land',repositoryInspected:true,
    expectedEventSeq:interrupted.lastEventSeq,reviewedCommit:interrupted.workspaceCommit};
  assert.equal((await s.api(`/runs/${s.runId}/recover`,'POST',input)).status,200);
  // Resume with the normal production worker, not the crash-injection wrapper.
  await s.restart();
  assert.equal((await s.api(`/runs/${s.runId}/resume`,'POST')).status,202);
  const fresh=await s.wait('awaiting-decision');
  assert.notEqual(fresh.decision.id,d.id); assert.equal(fresh.landingPending,false);
  assert.equal((await git(s.repo,['show-ref'])).stdout,refs);
  assert.equal((await s.api(`/runs/${s.runId}/recover`,'POST',input)).status,200);
  assert.equal((await s.api(`/runs/${s.runId}`)).body.activeDecisionId,fresh.decision.id);
  const next=fresh.decision;
  await s.api(`/runs/${s.runId}/decisions/${next.id}`,'POST',{
    choiceId:'reject',expectedRevision:next.revision,reviewedCommit:next.evidence.commit,clientRequestId:'reject-fresh',
  });
  await s.wait('rejected');
  assert.equal((await git(s.repo,['show-ref'])).stdout,refs);
});

test('inspection and resume reconcile a real landed branch after worker loss without duplicate landing (N1)', async t=>{
  const workerFile=fileURLToPath(new URL('../fixtures/operator-app/crash-land-worker.js',import.meta.url));
  const s=await fixture(t,{workerFile}); const run=await s.wait('awaiting-decision'); const d=run.decision;
  assert.equal((await s.api(`/runs/${s.runId}/decisions/${d.id}`,'POST',{
    choiceId:'approve',expectedRevision:d.revision,reviewedCommit:d.evidence.commit,clientRequestId:'approve-crash',
  })).status,200);
  const interrupted=await s.wait('interrupted');
  assert.equal(interrupted.recoveryRequired,true);
  const refs=(await git(s.repo,['show-ref'])).stdout;
  const chunks=s.app.runs.get(s.runId).events.filter(e=>e.data.engineType==='chunk-done').length;
  const inspections={clientRequestId:'inspect-real',repositoryInspected:true,
    expectedEventSeq:interrupted.lastEventSeq,reviewedCommit:interrupted.workspaceCommit};
  assert.equal((await s.api(`/runs/${s.runId}/recover`,'POST',inspections)).status,200);
  assert.equal(s.app.runs.active,null);
  assert.equal((await git(s.repo,['show-ref'])).stdout,refs);
  // A second worker loss before reconciliation must reinstate the guard.
  const pending=s.app.runs.get(s.runId);
  pending.status='running'; s.app.store.save();
  await s.restart();
  const again=(await s.api(`/runs/${s.runId}`)).body;
  assert.equal(again.recoveryRequired,true); assert.equal(again.resumable,false);
  assert.equal((await s.api(`/runs/${s.runId}/resume`,'POST')).status,409);
  const ack=await s.api(`/runs/${s.runId}/recover`,'POST',{
    ...inspections,clientRequestId:'inspect-after-restart',expectedEventSeq:again.lastEventSeq,
  });
  assert.equal(ack.status,200);
  assert.equal((await s.api(`/runs/${s.runId}/resume`,'POST')).status,202);
  const done=await s.wait('completed');
  assert.equal(done.recoveryRequired,false);
  assert.match((await git(s.repo,['show',`${done.landedBranch}:multiply.txt`])).stdout,/local did it/);
  assert.equal((await git(s.repo,['show-ref'])).stdout,refs);
  assert.equal((await git(s.repo,['rev-parse','HEAD'])).stdout,s.originalHead);
  assert.equal(s.app.runs.get(s.runId).events.filter(e=>e.data.engineType==='chunk-done').length,chunks);
  assert.equal(s.app.runs.get(s.runId).events.filter(e=>e.type==='decision-pending').length,1);
});

test('restart and explicit resume regenerate decisions without repeating a completed chunk', async t=>{
  const s=await fixture(t);const before=await s.wait('awaiting-decision');
  const oldDecision=before.decision.id;
  const chunkCount=s.app.runs.get(s.runId).events.filter(e=>e.data.engineType==='chunk-done').length;
  await s.restart();
  const interrupted=(await s.api('/runs/'+s.runId)).body;
  assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.decision,null);
  assert.equal((await s.api('/runs/'+s.runId+'/resume','POST')).status,202);
  const after=await s.wait('awaiting-decision');
  assert.notEqual(after.decision.id,oldDecision);assert.match(after.decision.evidence.commit,/^[a-f0-9]{40}$/);
  assert.equal(s.app.runs.get(s.runId).events.filter(e=>e.data.engineType==='chunk-done').length,chunkCount);
  const d=after.decision;
  assert.equal((await s.api(`/runs/${s.runId}/decisions/${d.id}`,'POST',{choiceId:'approve',expectedRevision:d.revision,reviewedCommit:d.evidence.commit,clientRequestId:'after-restart'})).status,200);
  await s.wait('completed');
});
