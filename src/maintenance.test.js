import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The runner opens the real checkpointer: keep its memory.sqlite out of the repo.
process.env.GATEWAY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'gateway-maintenance-test-'));
import assert from 'node:assert/strict';
import { maintenanceTools,MAINTENANCE_TOOL_NAMES,createMaintenanceRunner,maintenanceJournal } from './maintenance.js';
import { createGatewayBoundaryMiddleware,buildGatewayAgent } from './agent.js';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { AIMessage } from 'langchain';
const authority={endpoint:'http://manager.local',token:'cycle-secret',cycleId:'cycle'};
test('maintenance has only state and nine narrow tools, no approval, filesystem or generic execution',()=>{const {tools}=maintenanceTools(authority);assert.deepEqual(tools.map(t=>t.name),MAINTENANCE_TOOL_NAMES);for(const name of ['task','write_file','maintenance_approve','agent_execute','shell'])assert.ok(!tools.some(t=>t.name===name));});
test('scoped bridge sends only the canonical candidate selector and cycle credential',async()=>{let request;const {tools}=maintenanceTools(authority,{fetchImpl:async(url,args)=>{request={url,args};return Response.json({status:'pending'});}});await tools.find(t=>t.name==='maintenance_ingest').invoke({target:'raw/untracked'});assert.equal(request.args.headers.authorization,'Bearer cycle-secret');assert.deepEqual(JSON.parse(request.args.body),{cycleId:'cycle',command:'action',action:'ingest',target:'raw/untracked',async:true});});
test('a long action is followed on its ticket, never held on one request',async()=>{const bodies=[];let polls=0;const {tools}=maintenanceTools(authority,{fetchImpl:async(_url,args)=>{const body=JSON.parse(args.body);bodies.push(body);if(body.command==='action')return Response.json({status:'running',ticket:'t1'},{status:202});polls++;return Response.json(polls<2?{status:'running',ticket:'t1'}:{status:'settled',result:{status:'done',jobId:'job-1'}});}});const out=JSON.parse(await tools.find(t=>t.name==='maintenance_ingest').invoke({target:'raw/untracked'}));assert.deepEqual(out,{status:'done',jobId:'job-1'});assert.deepEqual(bodies.slice(1).map(b=>[b.command,b.ticket]),[['action_status','t1'],['action_status','t1']]);});
test('a failed ticket surfaces the manager error to the model',async()=>{const {tools}=maintenanceTools(authority,{fetchImpl:async(_url,args)=>{const body=JSON.parse(args.body);return Response.json(body.command==='action'?{status:'running',ticket:'t2'}:{status:'failed',error:'maintenance_target_changed'});}});await assert.rejects(tools.find(t=>t.name==='maintenance_index').invoke({target:'wiki'}),/maintenance_target_changed/);});
test('only delivery maintenance accepts an export or polish operation',()=>{
  const {tools}=maintenanceTools(authority);
  const curate=tools.find(t=>t.name==='maintenance_curate').schema.safeParse({target:'wiki',operation:'export'});
  assert.equal(curate.success,true);
  assert.deepEqual(curate.data,{target:'wiki'});
  const deliver=tools.find(t=>t.name==='maintenance_deliver').schema.safeParse({target:'deliverables/a.md',operation:'export'});
  assert.equal(deliver.success,true);
  assert.deepEqual(deliver.data,{target:'deliverables/a.md',operation:'export'});
});
test('no actionable fact means no model call',async()=>{let calls=0;const runner=createMaintenanceRunner({authority,fetchImpl:async()=>{calls++;return Response.json({candidates:[]});}});const result=await runner.run({workspace:{name:'demo'}});assert.equal(calls,1);assert.match(result.content,/no model call/);});
test('maintenance cannot execute harness tools even if the model invents one',async()=>{const boundary=createGatewayBoundaryMiddleware({allowedToolNames:MAINTENANCE_TOOL_NAMES});const result=await boundary.wrapToolCall({toolCall:{name:'write_file',id:'bad'}},()=>{throw new Error('executed');});assert.equal(result.status,'error');});
test('the real deepagents boundary exposes exactly maintenance tools and settles model budget',async()=>{const seen=[];let settled=0;const {tools}=maintenanceTools(authority);const agent=buildGatewayAgent({tools,chatModel:new FakeListChatModel({responses:[new AIMessage({content:'done'})]}),onModelCall:async names=>{seen.push(...names);return ()=>{settled++;};}});await agent.invoke({messages:[{role:'user',content:'maintain'}]},{recursionLimit:6});assert.deepEqual([...new Set(seen)],MAINTENANCE_TOOL_NAMES);assert.equal(settled,1);});
test('authority refuses credentials in URLs and unsupported protocols',()=>{for(const endpoint of ['file:///tmp/a','http://user:pass@example.org'])assert.throws(()=>maintenanceTools({...authority,endpoint}));});
test('a model that decides nothing is retried once, then the due actions run in canonical order',async()=>{const commands=[];const events=[];const fetchImpl=async(_url,args)=>{const body=JSON.parse(args.body);commands.push(body);if(body.command==='state')return Response.json({candidates:[{action:'build',target:'templates/a.md',mode:'auto',summary:'Rebuild a'},{action:'ingest',target:'raw/untracked',mode:'ask',summary:'Ingest 2'}]});if(body.command==='action')return Response.json({status:body.action==='ingest'?'pending':'done'});return Response.json({ok:true});};const runner=createMaintenanceRunner({model:{baseUrl:'http://model.local/v1',model:'fake'},authority,fetchImpl,onEvent:(e)=>events.push(e),chatModelOverride:new FakeListChatModel({responses:['\n\n','\n\n']})});const result=await runner.run({workspace:{name:'demo'},objective:'maintain'});assert.deepEqual(commands.filter(c=>c.command==='action').map(c=>c.action),['ingest','build']);assert.equal(events.filter(e=>e.type==='degraded'&&e.capability==='maintenance-decision').length,2);assert.match(result.content,/canonical order/);});

test('model reservation identities remain distinct when maintenance tools are recreated',async()=>{
  const calls=[];const fetchImpl=async(_url,args)=>{calls.push(JSON.parse(args.body));return Response.json({ok:true});};
  for(let i=0;i<2;i++){const tools=maintenanceTools(authority,{fetchImpl});const settle=await tools.onModelCall();await settle();}
  const admitted=calls.filter(c=>c.command==='model'),settled=calls.filter(c=>c.command==='model_done');
  assert.equal(new Set(admitted.map(c=>c.call)).size,2);
  assert.deepEqual(settled.map(c=>c.call),admitted.map(c=>c.call));
});
test('maintenance status and cycle replay read the durable receipt after replay-cache expiry',async()=>{
  const {startGateway}=await import('./server.js');const before=process.env.GATEWAY_RUN_TTL_MS;process.env.GATEWAY_RUN_TTL_MS='1';
  let launches=0;const server=startGateway({port:0,config:{version:'test',capabilities:[{name:'agent.maintain',operations:['run']}]},createRunner:()=>({run:async()=>{launches++;return {content:'finished'};}})});
  if(before===undefined)delete process.env.GATEWAY_RUN_TTL_MS;else process.env.GATEWAY_RUN_TTL_MS=before;
  await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const body={capability:'agent.maintain',model:{baseUrl:'http://model.test/v1',model:'fake'},maintenance:{...authority,cycleId:'ttl-'+Date.now()}};
  const launch=()=>fetch(base+'/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  try {
    const run=await launch();for(let i=0;i<100;i++){if(maintenanceJournal().byId(run.runId)?.status==='completed')break;await new Promise(r=>setTimeout(r,5));}
    assert.equal(maintenanceJournal().byId(run.runId).status,'completed');
    assert.ok(maintenanceJournal().byId(run.runId).finishedAt);
    await new Promise(r=>setTimeout(r,1300));
    const replay=await launch();assert.equal(replay.runId,run.runId);assert.equal(launches,1);
    const response=await fetch(base+'/runs/'+run.runId);assert.equal(response.status,200);
    const status=await response.json();assert.equal(status.status,'completed');assert.equal(status.result.content,'finished');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
