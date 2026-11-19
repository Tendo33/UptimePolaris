import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import workerd from 'workerd';
import {build} from 'esbuild';

const directory=mkdtempSync(resolve('artifacts/tmp/subscription-egress-'));
let reached=0;
const privateServer=createServer((_request,response)=>{reached++;response.end('private data');});
await new Promise(resolve=>privateServer.listen(0,'127.0.0.1',resolve));
const reservation=createServer();
await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
const port=reservation.address().port;
await new Promise(resolve=>reservation.close(resolve));
const bundle=await build({stdin:{contents:`import {validateSubscriptionDestination} from './backends/worker/src/lib/subscriptions/egress';export default {async fetch(){const results=[];for(const host of ['127.0.0.1','localhost','127.0.0.1.nip.io']){try{await validateSubscriptionDestination(new URL('https://'+host),undefined,async()=>Response.json({Status:0,Answer:[{type:1,data:'127.0.0.1'}]}));const response=await fetch('http://'+host+':${privateServer.address().port}',{signal:AbortSignal.timeout(5000)});results.push({host,status:response.status,body:await response.text()})}catch{results.push({host,blocked:true})}}return Response.json(results)}};`,resolveDir:resolve('.'),sourcefile:'egress-fixture.ts'},bundle:true,format:'esm',write:false});
writeFileSync(join(directory,'worker.js'),bundle.outputFiles[0].text);
writeFileSync(join(directory,'config.capnp'),`using Workerd = import "/workerd/workerd.capnp"; const config :Workerd.Config = (services=[(name="main",worker=(modules=[(name="worker.js",esModule=embed "worker.js")],compatibilityDate="2025-01-01"))],sockets=[(name="http",address="127.0.0.1:${port}",http=(),service="main")]);`);
let diagnostics='';
const process=spawn(workerd.default,['serve',join(directory,'config.capnp')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
process.stdout.on('data',chunk=>{diagnostics+=chunk});process.stderr.on('data',chunk=>{diagnostics+=chunk});
try{
 let result;
 for(let attempt=0;attempt<100;attempt++){
  if(process.exitCode!==null)throw new Error(diagnostics);
  try{result=await fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(16000)}).then(r=>r.json());break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}
 }
 assert.equal(result?.length,3,diagnostics);
 assert.equal(reached,0,`workerd contacted a loopback destination: ${JSON.stringify(result)}`);
 assert.ok(result.every(row=>row.blocked || row.status>=400),JSON.stringify(result));
 console.log('PASS subscription destination validation blocks literal, localhost and DNS-resolved loopback addresses inside workerd');
}finally{process.kill();await new Promise(resolve=>privateServer.close(resolve));}
