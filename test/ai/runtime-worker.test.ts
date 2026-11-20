import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { api } from '../../backends/worker/src/api';
import { loadPresentation, savePresentation } from '../../backends/worker/src/lib/presentation/store';
import { AiStore } from '../../backends/worker/src/lib/ai/store';
import { runTick } from '../../backends/worker/src/lib/jobs/tick';
import { runAiTick, archiveAiDays } from '../../backends/worker/src/lib/ai/runtime';
import { TickLeaseLost } from '../../backends/worker/src/lib/jobs/tick-commit';
import { beginAnalyticsBatch, AnalyticsWriter } from '../../backends/worker/src/lib/analytics-engine';
import { ExternalRequestBudget } from '../../backends/worker/src/lib/http/request-budget';
import { BOOTSTRAP_FILES } from '../../backends/worker/src/lib/db/schema-bootstrap';
import { D1Adapter } from '../../backends/worker/src/lib/db/d1';
import type { DBAdapter } from '../../backends/worker/src/lib/db/adapter';
import type { Env } from '../../backends/worker/src/types';
import { writeSettings } from '../../backends/worker/src/lib/settings/store';
import { defaultPresentation } from '../../shared/presentation';
import { readFileSync } from 'node:fs';
import { aiEntry,aiBackoff,recordAiObservation } from '../../shared/ai-runtime';
import { classifyAiResponse } from '../../shared/ai-probe';
import { probeAiModel } from '../../backends/worker/src/lib/ai/probe';
import { aiNextCheckAt } from '../../shared/ai-runtime';

export async function runtimeScenario(env: Env, db: DBAdapter) {
 const feature=await loadPresentation(env);await savePresentation(env,{...feature.config,aiEnabled:true},feature.revision);
  const fetchBeforeHeaders=globalThis.fetch;
  try {
    for(const [status,outcome] of [[401,'authentication_failed'],[429,'rate_limit_or_quota']] as const){
      globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.error(new Error('isolated unreadable error body'));}}),{status,headers:{'retry-after':'7200'}});
      const result=await probeAiModel({protocol:'openai',baseUrl:'https://provider.example/v1',apiKey:'fixture-runtime-key',model:'fixture',timeoutMs:1000});assert.equal(result.outcome,outcome);if(status===429)assert.equal(result.retryAfterSec,7200);
    }
    assert.equal(aiNextCheckAt(1700000000,Number.MAX_SAFE_INTEGER),Number.MAX_SAFE_INTEGER);
  }finally{globalThis.fetch=fetchBeforeHeaders;}
  for(const fixture of JSON.parse(readFileSync('test/fixtures/ai-runtime-contract.json','utf8'))){
    const entry=aiEntry({revision:'model-v1'},'channel-v1');let at=1700000000;
    for(const [index,step] of fixture.steps.entries()){
      assert.equal(classifyAiResponse(step.status,step.body),step.outcome);
      assert.equal(aiBackoff(step.outcome,300,step.retryAfter),step.backoff);
      const point={checkedAt:at+=300,outcome:step.outcome,latencyMs:10,statusCode:step.status,revision:'model-v1',channelRevision:'channel-v1',runId:String(index)};
      recordAiObservation(entry,point,300,3);const total=entry.total;recordAiObservation(entry,point,300,3);assert.equal(entry.total,total);
    }
    assert.equal(entry.total,fixture.total);assert.equal(entry.ok,fixture.ok);assert.equal(entry.settled,fixture.settled);
  }
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let clock = Math.floor(originalNow()/60000)*60, status=200, providerCalls=0, notices=0;
  let mutate: (()=>Promise<void>) | undefined, mutateModel: string | undefined, hold: Promise<void> | undefined;
  const ae: any[]=[];
  env.UPTIME = { writeDataPoint(point:any) { ae.push(point); } } as AnalyticsEngineDataset;
  Date.now=()=>clock*1000;
  const store=new AiStore(db), sql=(q:string)=>store.sql(q);
  const request=async(method:string,path:string,input?:unknown,auth=true)=>{
    const response=await api.fetch(new Request('https://fixture.test'+path,{method,headers:{...(auth?{authorization:`Bearer ${env.ADMIN_TOKEN}`} : {}),'content-type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)}),env,{waitUntil(){}} as ExecutionContext);
    const text=await response.text();assert.doesNotMatch(text,/fixture-runtime-key|credential_ciphertext|"apiKey"/);
    return {status:response.status,body:JSON.parse(text),response};
  };
  const expect=async(method:string,path:string,input:unknown,code=200)=>{const result=await request(method,path,input);assert.equal(result.status,code,JSON.stringify(result.body));return result.body;};
  const model=async(id:string)=>store.model(id);
  const createChannel=async(name:string)=>(await expect('POST','/api/admin/ai/channels',{name,baseUrl:'https://provider.example/custom/v1',protocol:'openai',apiKey:'fixture-runtime-key'},201)).channel;
  const createModel=async(channelId:string,name:string,extra={})=>(await expect('POST','/api/admin/ai/models',{channelId,name,modelId:name,timeoutMs:1000,...extra},201)).model;
  const direct=async(budget=new ExternalRequestBudget(),override=env,reset=true)=>{
    const owner=crypto.randomUUID();await db.execute(sql('UPDATE cron_tick_lease SET owner=?,lease_until=? WHERE id=1'),[owner,clock+120]);
    if(reset)beginAnalyticsBatch(override);
    await runAiTick(override,clock,owner,async()=>{},budget);
  };
  const force=async(id:string)=>{const runtime=await store.runtime();if(runtime.state.models[id])runtime.state.models[id].nextCheckAt=0;runtime.state.channels={};await db.execute(sql('UPDATE ai_runtime SET json=?,revision=? WHERE id=1'),[JSON.stringify(runtime.state),crypto.randomUUID()]);};
  globalThis.fetch=async(input,init)=>{
    const url=String(input);
    if(url.startsWith('https://notify.example')){notices++;return new Response('ok');}
    assert.equal(url,'https://provider.example/custom/v1/chat/completions');providerCalls++;
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-runtime-key');assert.equal(init?.redirect,'manual');
    assert.equal(JSON.parse(String(init?.body)).max_tokens,64);assert.ok(init?.signal);
    if(hold)await hold;
    if(mutate&&(!mutateModel||JSON.parse(String(init?.body)).model===mutateModel)){const callback=mutate;mutate=undefined;mutateModel=undefined;await callback();}
    return Response.json(status===200?{choices:[{message:{content:'OK'}}]}:{error:{message:'fixture-runtime-key',code:status===429?'rate_limit_exceeded':'bad_request'}},{status,headers:status===429?{'retry-after':'7200'}:{}});
  };
  try {
    assert.equal((await db.query<any>('SELECT id FROM monitors')).length,0);
    const channel=await createChannel('Scheduled');let first=await createModel(channel.id,'first',{isPublic:true});
    assert.equal(first.live.freshness,'never_checked');assert.equal(first.live.availabilityPct,null);
    assert.equal((await runTick(env,clock)).status,'completed');assert.equal(providerCalls,1);
    first=await model(first.id);assert.equal(first.live.total,1);assert.equal(first.live.ok,1);assert.equal(first.live.checkedAt,clock);assert.equal(first.live.outcome,'ok');assert.equal(ae.length,1);
    assert.equal((await db.query<any>('SELECT id FROM ai_runtime')).length,1);assert.equal((await db.query<any>('SELECT model_id FROM ai_daily')).length,0);
    assert.equal((await runTick(env,clock)).status,'skipped');assert.equal(providerCalls,1);
    clock+=60;await runTick(env,clock);assert.equal(providerCalls,1);
    clock+=240;status=429;await runTick(env,clock);first=await model(first.id);
    assert.equal(first.live.total,2);assert.equal(first.live.ok,1);assert.equal(first.live.availabilityPct,50);assert.equal(first.live.nextCheckAt,clock+7200);
    const second=await createModel(channel.id,'second');clock+=60;await runTick(env,clock);assert.equal(providerCalls,2);assert.equal((await model(second.id)).live.skipReason,'channel_backoff');assert.equal((await model(second.id)).live.total,0);
    let active=await createChannel('Concurrent');let concurrent=await createModel(active.id,'concurrent');status=200;clock+=60;
    let release!:()=>void;hold=new Promise<void>(resolve=>{release=resolve;});const before=providerCalls;
    const running=runTick(env,clock);while(providerCalls===before)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal((await runTick(env,clock)).status,'skipped');release();await running;hold=undefined;assert.equal(providerCalls,before+1);
    concurrent=await model(concurrent.id);await force(concurrent.id);clock+=60;
    mutate=async()=>{concurrent=(await expect('PUT',`/api/admin/ai/models/${concurrent.id}`,{...concurrent,modelId:'changed'})).model;};
    const pointsBefore=ae.length;await runTick(env,clock);assert.equal(ae.length,pointsBefore);assert.equal((await model(concurrent.id)).live.freshness,'configuration_changed');
    clock+=60;await runTick(env,clock);concurrent=await model(concurrent.id);assert.equal(concurrent.live.revision,concurrent.revision);
    await force(concurrent.id);clock+=60;mutate=async()=>{active=(await expect('PUT',`/api/admin/ai/channels/${active.id}`,{name:active.name,baseUrl:active.baseUrl,protocol:'openai',revision:active.revision,headers:{'x-fixture':'changed'}})).channel;};
    await runTick(env,clock);assert.equal((await model(concurrent.id)).live.freshness,'configuration_changed');
    clock+=60;await runTick(env,clock);concurrent=await model(concurrent.id);
    await expect('PUT',`/api/admin/ai/models/${concurrent.id}`,{...concurrent,enabled:false});clock+=60;const pausedCalls=providerCalls;await runTick(env,clock);assert.equal(providerCalls,pausedCalls);
    assert.equal((await model(concurrent.id)).live.freshness,'paused');
    const budgetChannel=await createChannel('Budget');const budgetModel=await createModel(budgetChannel.id,'budget');
    const exhausted=new ExternalRequestBudget();while(exhausted.remaining)exhausted.reserve();clock+=60;await direct(exhausted);
    assert.equal((await model(budgetModel.id)).live.skipReason,'budget_exhausted');assert.equal((await model(budgetModel.id)).live.total,0);
    clock+=60;await direct(new ExternalRequestBudget(),{...env,UPTIME:undefined} as Env);assert.equal((await model(budgetModel.id)).live.skipReason,'source_unavailable');
    await force(budgetModel.id);clock+=60;await direct(new ExternalRequestBudget(),{...env,ADMIN_TOKEN:'wrong-material'});assert.equal((await model(budgetModel.id)).live.skipReason,'credential_unavailable');
    await force(budgetModel.id);clock+=60;beginAnalyticsBatch(env);const writer=new AnalyticsWriter(env);for(let i=0;i<250;i++)writer.write({indexes:['fixture'],doubles:[0]});const noPointCalls=providerCalls;await direct(new ExternalRequestBudget(),env,false);assert.equal(providerCalls,noPointCalls);
    assert.equal((await model(budgetModel.id)).live.total,0);
    await force(budgetModel.id);clock+=60;const savedWriter=env.UPTIME;
    env.UPTIME={writeDataPoint(){throw new Error('isolated AE write failure');}} as AnalyticsEngineDataset;
    await direct();assert.equal((await model(budgetModel.id)).live.total,1);assert.equal((await model(budgetModel.id)).live.outcome,'ok');env.UPTIME=savedWriter;
    const notificationGroup=(await expect('POST','/api/groups',{name:'Ordinary monitors'},201)).id;
    let notification=(await expect('POST','/api/notifications',{name:'Existing',type:'webhook',config:{url:'https://notify.example/webhook'},group_ids:[notificationGroup],active:1},201)).id;
    const notifyChannel=await createChannel('Notify');
    await expect('PUT',`/api/admin/ai/channels/${notifyChannel.id}`,{...notifyChannel,notificationChannelIds:[notification]});
    let notify=await createModel(notifyChannel.id,'notify');
    assert.equal((await request('POST','/api/admin/ai/channels',{name:'invalid',baseUrl:'https://provider.example/v1',protocol:'openai',apiKey:'fixture-runtime-key',notificationChannelIds:['missing']})).body.error,'notification_channel_not_found');
    await writeSettings(env,{'maintenance.enabled':true,'monitor.defaultRetries':3});
    status=503;
    for(let i=0;i<3;i++){clock+=300;await force(notify.id);await direct();}
    notify=await model(notify.id);assert.equal(notify.live.total,3);assert.equal(notify.live.ok,0);assert.equal(notify.live.availabilityPct,0);assert.equal(notices,0);
    const pendingBefore=await db.query<any>('SELECT id FROM pending_notifications');assert.equal(pendingBefore.length,0);
    await writeSettings(env,{'maintenance.enabled':false});clock+=60;await direct();assert.equal(notices,1);
    await direct();assert.equal(notices,1);
    status=200;await force(notify.id);clock+=300;await direct();assert.equal(notices,2);
    const history=await expect('GET',`/api/admin/ai/models/${notify.id}/history?days=7`,undefined);assert.equal(history.days[0].total,4);assert.equal(history.days[0].ok,1);assert.equal(history.days[0].exact,true);assert.equal(history.detailStatus,'unconfigured');assert.deepEqual(history.points,[]);
    const runtime=await store.runtime();const oldDay={date:new Date((clock-86400)*1000).toISOString().slice(0,10),total:3,ok:1,latencyTotalMs:15};runtime.state.models[notify.id].day=oldDay;
    await db.execute(sql('UPDATE ai_runtime SET json=?,revision=? WHERE id=1'),[JSON.stringify(runtime.state),crypto.randomUUID()]);await archiveAiDays(env,clock);await archiveAiDays(env,clock);
    const archived=JSON.parse((await db.queryOne<any>(sql('SELECT days_json FROM ai_daily WHERE model_id=?'),[notify.id])).days_json);assert.equal(archived.length,1);assert.equal(archived[0].total,3);assert.equal(archived[0].availabilityPct,100/3);
    env.ANALYTICS_SQL={query:async()=>{throw new Error('fixture analytics unavailable');}} as AnalyticsSQLBinding;
    assert.equal((await expect('GET',`/api/admin/ai/models/${notify.id}/history`,undefined)).detailStatus,'unavailable');
    env.ANALYTICS_SQL={query:async()=>({data:[]})} as AnalyticsSQLBinding;
    const sparse=await expect('GET',`/api/admin/ai/models/${notify.id}/history`,undefined);assert.equal(sparse.detailStatus,'ready');assert.deepEqual(sparse.points,[]);assert.equal(sparse.days.length,1);
    let pub=await request('GET','/api/public/ai/models',undefined,false);assert.equal(pub.status,200);assert.equal(pub.body.models.length,1);assert.doesNotMatch(JSON.stringify(pub.body),/baseUrl|channelId|modelId|notificationChannelIds|ciphertext/);assert.match(pub.response.headers.get('cache-control')??'',/no-store/);
    assert.equal((await request('GET',`/api/public/ai/models/${notify.id}/history`,undefined,false)).status,404);
    assert.equal((await request('GET',`/api/public/ai/models/${concurrent.id}/history`,undefined,false)).status,404);
    const presentation=defaultPresentation();presentation.aiEnabled=true;presentation.agentEnabled=true;presentation.domains=[{hostname:'fixture.test',page:'agent'}];
    await db.execute(sql('INSERT INTO presentation_state(config_json,revision,id,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,revision=excluded.revision'),[JSON.stringify(presentation),crypto.randomUUID(),'main',clock]);
    assert.equal((await request('GET','/api/public/ai/models',undefined,false)).status,404);
    assert.equal((await request('GET','/api/public/ai/models?preview=monitor',undefined,false)).status,401);
    assert.equal((await request('GET','/api/public/ai/models?preview=monitor&pageId=default')).status,200);
    await db.execute(sql('UPDATE presentation_state SET config_json=?,revision=? WHERE id=?'),[JSON.stringify({...defaultPresentation(),aiEnabled:true}),crypto.randomUUID(),'main']);
    const validRuntime=await store.runtime();await db.execute(sql('UPDATE ai_runtime SET json=? WHERE id=1'),['{broken']);
    assert.equal((await request('GET','/api/public/ai/models',undefined,false)).status,503);
    await db.execute(sql('UPDATE ai_runtime SET json=? WHERE id=1'),[JSON.stringify(validRuntime.state)]);
    const deleting=await createModel(notifyChannel.id,'delete-during');clock+=60;status=200;mutateModel='delete-during';mutate=async()=>{await expect('DELETE',`/api/admin/ai/models/${deleting.id}`,{revision:deleting.revision});};const rawBefore=ae.length;await direct();assert.equal((await request('GET',`/api/admin/ai/models/${deleting.id}`)).status,404);assert.equal(ae.length,rawBefore);
    const fenceChannel=await createChannel('Lease fence'),fenced=await createModel(fenceChannel.id,'fenced');clock+=60;mutateModel='fenced';mutate=async()=>{await db.execute(sql('UPDATE cron_tick_lease SET owner=?,lease_until=? WHERE id=1'),['other-owner',clock+120]);};
    await assert.rejects(()=>direct(),TickLeaseLost);assert.equal((await model(fenced.id)).live.total,0);
    assert.equal((await db.query<any>('SELECT id FROM monitors')).length,0);
    console.log(`PASS AI Worker ${db.type} runtime: AI-only tick, versions, lease overlap, cooldown, exact counts, notifications, sparse archive and public boundaries`);
  } finally {globalThis.fetch=originalFetch;Date.now=originalNow;}
}

export async function runRuntimeD1(){
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2025-01-01',d1Databases:{DB:crypto.randomUUID()},kvNamespaces:{CONFIG:crypto.randomUUID()}});
  try{
    const binding=await mf.getD1Database('DB'),db=new D1Adapter(binding),env={DB:binding,CONFIG:await mf.getKVNamespace('CONFIG'),ADMIN_TOKEN:'fixture-runtime-material',DATABASE_TYPE:'d1'} as Env;
    for(const migration of BOOTSTRAP_FILES){if(migration.name.startsWith('0045')){
      const publicResponse=await api.fetch(new Request('https://fixture.test/api/public/ai/models'),env,{waitUntil(){}} as ExecutionContext);assert.equal(publicResponse.status,404);assert.deepEqual(await publicResponse.json(),{error:'not_found'});
      const feature=await loadPresentation(env);assert.equal(await savePresentation(env,{...feature.config,aiEnabled:true},feature.revision),true);
      const enabledResponse=await api.fetch(new Request('https://fixture.test/api/public/ai/models'),env,{waitUntil(){}} as ExecutionContext);assert.equal(enabledResponse.status,200);assert.deepEqual(await enabledResponse.json(),{models:[]});
    }if(migration.statements.length)await binding.batch(migration.statements.map(statement=>binding.prepare(statement)));}
    await runtimeScenario(env,db);
  }finally{await mf.dispose();}
}
if(process.env.AI_TEST_DRIVER!=='postgres')await runRuntimeD1();
