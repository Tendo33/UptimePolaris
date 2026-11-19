import assert from 'node:assert/strict';
import { responseCacheWrites,readResponseCache } from '../../backends/worker/src/lib/subscriptions/response-cache';
import { encryptSubscriptionSecrets } from '../../backends/worker/src/lib/subscriptions/credentials';
import type { SubscriptionStore } from '../../backends/worker/src/lib/subscriptions/store';
import type { Subscription } from '../../shared/subscriptions';

const documents=new Map<string,unknown>();
const store={
  document:async(kind:string,id:string)=>documents.get(`${kind}:${id}`)??null,
  documentWrite:(kind:string,id:string,value:unknown)=>({kind,id,value}),
  write:()=>({kind:'delete'}),
} as unknown as SubscriptionStore;
const subscription={id:'fixture',configId:'config'} as Subscription;
const cache={status:{value:{services:[{id:'api',status:'up'}]},etag:'one',modified:null,fetchedAt:1}};
for(const write of await responseCacheWrites(store,subscription,cache,'fixture-only-key') as any[]){if(write.kind!=='delete')documents.set(`${write.kind}:${write.id}`,write.value)}
assert.deepEqual(await readResponseCache(store,subscription,'fixture-only-key'),cache);
await assert.rejects(readResponseCache(store,subscription,'wrong-key'),{code:'subscription_credential_unavailable'});
const compressed=new Uint8Array(await new Response(new Blob(['x'.repeat(12*1024*1024)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
const value=await encryptSubscriptionSecrets({value:Buffer.from(compressed).toString('base64')},'response:fixture:config','fixture-only-key');
documents.set('response-cache:fixture',{parts:1,configId:'config'});documents.set('response-part:fixture:0',{value});
await assert.rejects(readResponseCache(store,subscription,'fixture-only-key'),{code:'subscription_limit_exceeded'});
console.log('PASS encrypted response cache round-trip, wrong-key refusal and bounded decompression');
