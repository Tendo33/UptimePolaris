import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { SubscriptionStore } from '../../backends/worker/src/lib/subscriptions/store';
import type { DBAdapter } from '../../backends/worker/src/lib/db/adapter';

const mf = new Miniflare({ modules:true, script:'export default {fetch(){return new Response("ok")}}', compatibilityDate:'2025-01-01', d1Databases:['DB'] });
try {
  const db=await mf.getD1Database('DB');
  await db.exec('CREATE TABLE subscription_items(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
  const ids=Array.from({length:200},(_,index)=>String(index));
  await db.batch(ids.map(id=>db.prepare('INSERT INTO subscription_items VALUES(?,?)').bind(id,JSON.stringify({id,recent:[{status:'up'}]}))));
  let queries=0;
  const adapter={type:'d1',query:async(sql:string,params:unknown[])=>{queries++;assert.ok(params.length<=100);return(await db.prepare(sql).bind(...params).all()).results}} as unknown as DBAdapter;
  const rows=await new SubscriptionStore(adapter).itemsById([...ids].reverse());
  assert.deepEqual(rows.map(row=>row.id),[...ids].reverse());assert.equal(rows.length,200);assert.equal(queries,3);
  assert.ok(rows.every(row=>row.recent.length===1&&row.recent[0].status==='up'));
  console.log('PASS subscription 200-item page respects D1 bindings and preserves order and history');
} finally {await mf.dispose()}
