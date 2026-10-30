// Browser reproduction for P04-R2: real service + Git workspace + deterministic IPC worker; no models.
// Requires the UI build and Playwright. Optionally set P04_BROWSER_EXECUTABLE for a system Chromium browser.
// Exit 1 records stale passed tests with approval enabled while the current report is failed.
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createAppServer } from '../../../../../../src/service/server.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const conductor=path.resolve(here,'../../../../../..');
const {chromium}=createRequire(import.meta.url)('playwright');
const root=mkdtempSync(path.join(tmpdir(),'p04-evidence-review-'));
const repo=path.join(root,'repo');mkdirSync(repo);
const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
for(const args of [['init','-q'],['config','user.name','Review'],['config','user.email','review@example.invalid']])git(...args);
writeFileSync(path.join(repo,'README.md'),'synthetic\n');git('add','.');git('commit','-qm','synthetic baseline');
const sourceHead=git('rev-parse','HEAD');
const configFile=path.join(root,'config.json');
writeFileSync(configFile,JSON.stringify({participants:[
 {name:'claude',adapter:'claude-code',roles:['author','reviewer'],capabilities:{can_edit_files:true}},
 {name:'codex',adapter:'codex',roles:['author','reviewer'],capabilities:{can_edit_files:true}},
 {name:'local',adapter:'local-agent',model:'synthetic',baseUrl:'http://127.0.0.1:9/v1',roles:['grunt'],capabilities:{can_edit_files:true}},
],routing:{allowApi:false},options:{testCommand:'node --test'}}));
const app=await createAppServer({dataDir:path.join(root,'data'),configFile,port:0,
 uiDir:path.join(conductor,'operator-web/dist'),workerFile:path.join(here,'p04-stale-review-worker.cjs')});
let browser;const releases=[];
const bounded=async(promise)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Review fixture timed out')),15000);})]);}finally{clearTimeout(timer);}};
try{
 browser=await chromium.launch(process.env.P04_BROWSER_EXECUTABLE?{executablePath:process.env.P04_BROWSER_EXECUTABLE}:{});
 const page=await browser.newPage();let count=0,releaseOld,oldReady;let oldReview;
 const captured=new Promise(resolve=>{oldReady=resolve;});
 await page.route('**/review',async route=>{
  const response=await route.fetch();count++;
  if(count===1){await route.fulfill({response});return;}
  if(count===2){oldReview=await response.json();await new Promise(resolve=>{releaseOld=resolve;releases.push(resolve);oldReady();});}
  else await new Promise(resolve=>releases.push(resolve));
  await route.fulfill({response});
 });
 // Ensure the initial UI snapshot is already awaiting a question. Its SSE replay then starts a second old-review GET.
 await page.route('**/api/v1/runs',async route=>{
  if(route.request().method()!=='POST'){await route.continue();return;}
  const response=await route.fetch();const created=await response.json();
  const end=Date.now()+10000;let ready=false;
  while(Date.now()<end){const snapshot=await(await page.request.get(`${app.origin}/api/v1/runs/${created.id}`)).json();if(snapshot.status==='awaiting-decision'){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
  assert.ok(ready,'fixture question ready');await route.fulfill({response});
 });
 await page.goto(`${app.origin}/#bootstrap=${app.bootstrapToken}`);
 await page.getByLabel(/Full path/).fill(repo);
 await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.getByRole('button',{name:'Add repository',exact:true}).click();
 await page.getByLabel(/Describe the change/).fill('Synthetic stale test evidence');
 await page.getByRole('button',{name:'Start',exact:true}).click();
 await page.getByText('Tests passed',{exact:true}).waitFor();await bounded(captured);
 const runId=new URL(page.url()).pathname.split('/').pop();
 const post=async action=>page.evaluate(async({runId,action})=>{
  const r=await fetch(`/api/v1/runs/${runId}/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return r.status;
 },{runId,action});
 assert.equal(await post('cancel'),202);await page.getByText('Interrupted',{exact:true}).waitFor();
 assert.equal(await post('resume'),202);await page.getByText('CURRENT_FAILED_REVIEW',{exact:true}).waitFor();
 const current=await(await page.request.get(`${app.origin}/api/v1/runs/${runId}/review`)).json();
 assert.equal(oldReview.commit,current.commit);assert.notDeepEqual(oldReview.testReportIds,current.testReportIds);
 assert.equal(current.tests.passed,false);
 releaseOld();await page.waitForTimeout(150);
 const observed={currentReportPassed:current.tests.passed,
  stalePassedLabel:await page.getByText('Tests passed',{exact:true}).count(),
  currentFailedLabel:await page.getByText('Tests failed (exit code 1)',{exact:true}).count(),
  approveEnabled:await page.getByRole('button',{name:'Approve: create a branch'}).isEnabled()};
 const reproduced=observed.stalePassedLabel===1&&observed.currentFailedLabel===0&&observed.approveEnabled;
 console.log(JSON.stringify({finding:'P04-R2',result:reproduced?'REPRODUCED':'NOT_REPRODUCED',...observed}));
 if(!reproduced){assert.equal(observed.stalePassedLabel,0);assert.equal(observed.approveEnabled,false);}
 for(const release of releases)release();await page.getByText('Tests failed (exit code 1)',{exact:true}).waitFor();
 assert.equal(await page.getByText('Tests passed',{exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Approve: create a branch'}).isEnabled(),true);
 console.log(JSON.stringify({control:'current failed evidence becomes visible and reviewable',passed:true}));
 assert.equal(git('rev-parse','HEAD'),sourceHead);assert.equal(git('status','--porcelain'),'');
 assert.equal(git('branch','--list','conductor/*'),'');
 if(reproduced)process.exitCode=1;
}finally{
 for(const release of releases)release();if(browser)await browser.close();await app.close();
 const scratch=path.resolve(root);assert.equal(path.dirname(scratch),path.resolve(tmpdir()));
 assert.ok(path.basename(scratch).startsWith('p04-evidence-review-'));rmSync(scratch,{recursive:true,force:true});
}
