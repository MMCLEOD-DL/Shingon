// Synthetic IPC worker for the stale-review browser reproduction: real Git workspace, no models.
const path=require('node:path');const{pathToFileURL}=require('node:url');const{createHash}=require('node:crypto');
process.on('message',async msg=>{
 if(msg?.type!=='start')return;
 const{Workspace}=await import(pathToFileURL(path.resolve(__dirname,'../../../../../../src/workspace.js')).href);
 const ws=msg.workspaceDir?await Workspace.open(msg.workspaceDir):await Workspace.create({repoDir:msg.repoDir,baseDir:msg.baseDir,taskId:'evidence-review'});
 process.send({type:'event',event:{type:'start',message:'Synthetic workspace ready'},workspaceDir:ws.dir});
 const tests={ran:true,passed:!msg.workspaceDir,code:msg.workspaceDir?1:0,output:msg.workspaceDir?'NEW_TEST_FAILED':'OLD_TEST_PASSED'};
 const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const diff=await ws.diffRange(ws.baseSha,await ws.head());
 process.send({type:'question',id:msg.workspaceDir?'new-result':'old-result',kind:'result',payload:{summary:msg.workspaceDir?'CURRENT_FAILED_REVIEW':'OLD_PASSED_REVIEW',diff,files:[],tests},evidence:{commit:await ws.head(),diffId:digest(diff),testReportIds:[digest(tests)]}});
});
process.on('disconnect',()=>process.exit(0));
