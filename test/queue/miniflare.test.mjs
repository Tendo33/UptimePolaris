import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const bundled=await build({stdin:{contents:`
import worker from './backends/worker/src/index.ts';
import { api } from './backends/worker/src/api.ts';
import { runTick } from './backends/worker/src/lib/jobs/tick.ts';
import { AiStore } from './backends/worker/src/lib/ai/store.ts';
import { getDB } from './backends/worker/src/lib/db/factory.ts';
let calls=0,points=0;
globalThis.fetch=async(input,init)=>{
 const url=String(input);if(!['https://provider.example/v1/chat/completions','https://native.example/check'].includes(url))throw Error('unexpected fixture egress');
 calls++;if(url.includes('provider.example')){if(new Headers(init.headers).get('authorization')!=='Bearer fixture-local-queue')throw Error('missing fixture credential');return Response.json({choices:[{message:{content:'OK'}}]});}return new Response('OK');
};
const scope=env=>Object.assign(Object.create(env),{UPTIME:{writeDataPoint(){points++;}}});
export default {
 queue(batch,env,ctx){return worker.queue(batch,scope(env),ctx);},
 async fetch(request,env,ctx){env=scope(env);const path=new URL(request.url).pathname;
 if(path==='/fixture/seed'){const store=new AiStore(getDB(env));const c=await store.saveChannel({name:'local',baseUrl:'https://provider.example/v1',protocol:'openai',apiKey:'fixture-local-queue'},env.ADMIN_TOKEN);const m=await store.saveModel({channelId:c.id,name:'local',modelId:'local',intervalSec:300,timeoutMs:1000,enabled:true,isPublic:false});await env.DB.prepare('INSERT INTO monitors(id,name,type,target,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind('native','Native','http','https://native.example/check',1,1).run();return Response.json({id:m.id});}
 if(path==='/fixture/tick')return Response.json(await runTick(env,Math.floor(Date.now()/1000)));
 if(path==='/fixture/calls')return Response.json({calls,points});
 return api.fetch(request,env,ctx);
 }
};`,resolveDir:process.cwd(),sourcefile:'queue-harness.ts'},bundle:true,format:'esm',platform:'neutral',target:'es2022',write:false,external:['cloudflare:sockets'],plugins:[{name:'no-postgres',setup(b){b.onResolve({filter:/^postgres$/},()=>({path:'pg',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export default function(){throw Error("unexpected postgres")}' }));}}]});
const mf=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2025-01-01',d1Databases:{DB:crypto.randomUUID()},kvNamespaces:{CONFIG:crypto.randomUUID()},bindings:{ADMIN_TOKEN:'fixture-local-material',DATABASE_TYPE:'d1'},queueProducers:{CHECK_QUEUE:'fixture-checks'},queueConsumers:{'fixture-checks':{maxBatchSize:3,maxBatchTimeout:0,retryDelay:1}}});
const req=async(method,path,body)=>{const response=await mf.dispatchFetch('https://fixture.test'+path,{method,headers:{authorization:'Bearer fixture-local-material','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(response.ok,await response.clone().text());return response.json();};
const poll=async(read,accept)=>{const end=Date.now()+20000;let value;while(Date.now()<end){value=await read();if(accept(value))return value;await new Promise(r=>setTimeout(r,100));}assert.fail('local queue roundtrip timed out: '+JSON.stringify(value));};
try{
 const db=await mf.getD1Database('DB');
 const {BOOTSTRAP_FILES}=await import('../../artifacts/tmp/queue-schema.mjs');
 for(const file of BOOTSTRAP_FILES)if(file.statements.length)await db.batch(file.statements.map(s=>db.prepare(s)));
 let q=await req('GET','/api/admin/check-queue');assert.equal(q.canEnable,false);
 q=await req('POST','/api/admin/check-queue/probe',{revision:q.revision});assert.equal(q.verification.state,'pending');assert.equal((await req('GET','/fixture/calls')).calls,0);
 q=await poll(()=>req('GET','/api/admin/check-queue'),v=>v.verification.state==='passed');assert.equal(q.canEnable,true);assert.equal((await req('GET','/fixture/calls')).calls,0);
 q=await req('PUT','/api/admin/check-queue',{revision:q.revision,enabled:true});assert.equal(q.enabled,true);
 const presentation=await req('GET','/api/admin/presentation');await req('PUT','/api/admin/presentation',{revision:presentation.revision,config:{...presentation.config,aiEnabled:true}});
 const {id}=await req('GET','/fixture/seed');await req('GET','/fixture/tick');
 const completed=await poll(()=>req('GET','/api/admin/ai/models'),v=>v.models[0]?.live.total===1);assert.equal(completed.models[0].id,id);assert.equal(completed.models[0].live.outcome,'ok');
 assert.deepEqual(await req('GET','/fixture/calls'),{calls:2,points:2});
 assert.equal((await req('GET','/api/admin/check-queue')).pendingTasks,0);
 assert.equal(JSON.parse((await db.prepare("SELECT json FROM live_state WHERE id='all'").first()).json).native.st,1);
 console.log('PASS real local Miniflare Queue: producer binding → actual index.queue consumer, no-cost probe, explicit enable, mixed native + AI commit and AE');
}finally{await mf.dispose();}
