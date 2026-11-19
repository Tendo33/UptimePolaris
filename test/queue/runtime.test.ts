import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import type { Env } from '../../backends/worker/src/types';
import type { DBAdapter } from '../../backends/worker/src/lib/db/adapter';
import { api } from '../../backends/worker/src/api';
import { loadPresentation,savePresentation } from '../../backends/worker/src/lib/presentation/store';
import { AiStore } from '../../backends/worker/src/lib/ai/store';
import { consumeCheckQueue } from '../../backends/worker/src/lib/queue/consumer';
import { enqueueDueChecks } from '../../backends/worker/src/lib/queue/producer';
import { loadQueue, INITIAL_QUEUE_JSON, queueSql } from '../../backends/worker/src/lib/queue/control';
import { AnalyticsWriter, beginAnalyticsBatch } from '../../backends/worker/src/lib/analytics-engine';
import { writeSettings } from '../../backends/worker/src/lib/settings/store';
import { checkDomain } from '../../backends/worker/src/lib/check/domain';
import { TickLeaseLost } from '../../backends/worker/src/lib/jobs/tick-commit';
import { withWriterLease } from '../../backends/worker/src/lib/jobs/writer-lease';
import { runTick } from '../../backends/worker/src/lib/jobs/tick';
import { invalidateConfig, loadLiveFresh } from '../../backends/worker/src/lib/monitor/store';
import { ExternalRequestBudget } from '../../backends/worker/src/lib/http/request-budget';
import { D1Adapter } from '../../backends/worker/src/lib/db/d1';
import { BOOTSTRAP_FILES } from '../../backends/worker/src/lib/db/schema-bootstrap';
import type { CheckQueueMessage } from '../../shared/check-queue';
const ctx = { waitUntil() { } } as ExecutionContext;
export async function queueScenario(env: Env, db: DBAdapter) {
 const presentation=await loadPresentation(env);await savePresentation(env,{...presentation.config,aiEnabled:true},presentation.revision);
  const realNow = Date.now, realFetch = globalThis.fetch;
  let clock = Math.floor(realNow() / 60000) * 60 + 1, calls = 0, failSend = false, status = 200, mutate: (() => Promise<void>) | undefined;
  const sent: CheckQueueMessage[] = [], ae: any[] = [];
  Date.now = () => clock * 1000;
  env.UPTIME = { writeDataPoint(point: any) { ae.push(point); } } as AnalyticsEngineDataset;
  const producer = { async send(body: CheckQueueMessage) { if (failSend)
      throw Error('fixture private failure'); sent.push(structuredClone(body)); }, async sendBatch(messages: any[]) { assert.ok(messages.length <= 50); assert.ok(JSON.stringify(messages).length < 256 * 1024); if (failSend)
      throw Error('fixture private failure'); sent.push(...structuredClone(messages.map(m => m.body))); } } as Queue<CheckQueueMessage>;
  const sql = (q: string) => queueSql(db, q), store = new AiStore(db);
  globalThis.fetch = async (input, init) => { calls++; if (mutate && String(input).includes('provider.example')) {
    const fn = mutate;
    mutate = undefined;
    await fn();
  } if (String(input).includes('provider.example')) {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-queue-key');
    assert.equal(init?.redirect, 'manual');
    return Response.json(status === 200 ? { choices: [{ message: { content: 'OK' } }] } : { error: { code: 'rate_limit_exceeded', message: 'fixture-queue-key' } }, { status, headers: status === 429 ? { 'retry-after': '7200' } : {} });
  } return new Response('OK'); };
  const request = async (method: string, path = '/api/admin/check-queue', input?: any, auth = true) => {
    const response = await api.fetch(new Request('https://fixture.test' + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${env.ADMIN_TOKEN}` } : {}) }, body: input === undefined ? undefined : JSON.stringify(input) }), env, ctx);
    const text = await response.text();
    assert.doesNotMatch(text, /fixture-queue-key|fixture private|ciphertext/);
    return { status: response.status, body: JSON.parse(text) };
  };
  const control = async (change: any) => { const q = await loadQueue(env); Object.assign(q.state, change); await db.execute(sql('UPDATE check_queue_control SET json=?,revision=? WHERE id=1'), [JSON.stringify(q.state), crypto.randomUUID()]); };
  const reset = async () => {
    for (const table of ['monitors', 'ai_models', 'ai_channels', 'pending_notifications', 'events', 'heartbeat_ring'])
      await db.execute(`DELETE FROM ${table}`);
    await db.execute("DELETE FROM live_state");
    await db.execute('DELETE FROM cron_tick_lease');
    await db.execute(sql('UPDATE ai_runtime SET json=?,revision=? WHERE id=1'), ['{"models":{},"channels":{}}', crypto.randomUUID()]);
    await db.execute(sql('UPDATE check_queue_control SET json=?,revision=? WHERE id=1'), [INITIAL_QUEUE_JSON, crypto.randomUUID()]);
    sent.length = 0;
    ae.length = 0;
    calls = 0;
    failSend = false;
    status = 200;
    clock += 120;
    clock = Math.floor(clock / 60) * 60 + 1;
    env.CHECK_QUEUE = producer;
    invalidateConfig();
  };
  const native = async (id: string) => { await db.execute(sql('INSERT INTO monitors(id,name,type,target,interval_sec,timeout_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)'), [id, id, 'http', 'https://native.example/check', 60, 1000, clock, clock]); invalidateConfig(); };
  const channel = async (name = 'channel') => store.saveChannel({ name, baseUrl: 'https://provider.example/v1', protocol: 'openai', apiKey: 'fixture-queue-key' }, env.ADMIN_TOKEN);
  const model = async (channelId: string, name: string, timeoutMs = 1000) => store.saveModel({ channelId, name, modelId: name, intervalSec: 300, timeoutMs, enabled: true, isPublic: false, notificationChannelIds: [] });
  const cronDone = async () => { await db.execute(sql('INSERT INTO cron_tick_lease(id,owner,lease_until,completed_minute) VALUES(1,NULL,0,?) ON CONFLICT(id) DO UPDATE SET owner=NULL,lease_until=0,completed_minute=excluded.completed_minute'), [Math.floor(clock / 60) * 60]); };
  const enqueue = async () => { await cronDone(); const lease = await withWriterLease(env, (owner, ensure) => enqueueDueChecks(env, clock, owner, ensure, new ExternalRequestBudget())); assert.equal(lease.acquired, true); };
  const consume = async (bodies: unknown[], override = env) => {
    const result = bodies.map(body => ({ body, acked: 0, retried: 0, ack() { this.acked++; }, retry() { this.retried++; } }));
    await consumeCheckQueue({ queue: 'fixture', messages: result } as any, override, ctx);
    return result;
  };
  try {
    await reset();
    assert.equal((await request('GET', undefined, undefined, false)).status, 401);
    let q = (await request('GET')).body;
    assert.equal(q.bound, true);
    assert.equal(q.canEnable, false);
    assert.equal((await request('PUT', undefined, { revision: q.revision, enabled: true })).body.error, 'probe_required');
    let accepted = await request('POST', '/api/admin/check-queue/probe', { revision: q.revision });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.verification.state, 'pending');
    assert.equal(accepted.body.canEnable, false);
    assert.equal(calls, 0);
    assert.equal((await request('POST', '/api/admin/check-queue/probe', { revision: accepted.body.revision })).body.error, 'probe_pending');
    assert.equal((await consume([sent.shift()!]))[0].acked, 1);
    q = (await request('GET')).body;
    assert.equal(q.verification.state, 'passed');
    assert.equal(q.canEnable, true);
    assert.equal(calls, 0);
    assert.equal((await request('PUT', undefined, { revision: 'stale', enabled: true })).body.error, 'revision_conflict');
    q = (await request('PUT', undefined, { revision: q.revision, enabled: true })).body;
    assert.equal(q.enabled, true);
    clock += 601;
    q = (await request('GET')).body;
    assert.equal(q.canEnable, false);
    assert.equal(q.enabled, true);
    q = (await request('PUT', undefined, { revision: q.revision, enabled: false })).body;
    assert.equal(q.enabled, false);
    q = (await request('POST', '/api/admin/check-queue/probe', { revision: q.revision })).body;
    clock += 121;
    q = (await request('GET')).body;
    assert.equal(q.verification.state, 'timed_out');
    assert.equal(q.canEnable, false);
    assert.equal((await consume([sent.shift()!]))[0].acked, 1);
    assert.equal((await request('GET')).body.canEnable, false);
    failSend = true;
    assert.equal((await request('POST', '/api/admin/check-queue/probe', { revision: q.revision })).body.error, 'enqueue_failed');
    assert.equal((await request('GET')).body.verification.state, 'failed');
    await reset();
    await native('direct');
    delete env.CHECK_QUEUE;
    assert.equal((await runTick(env, clock)).status, 'completed');
    assert.equal(calls, 1);
    clock += 60;
    env.CHECK_QUEUE = producer;
    await runTick(env, clock);
    assert.equal(calls, 2);
    assert.equal(sent.length, 0);
    await reset();
    await native('native');
    const c = await channel(), m = await model(c.id, 'mixed');
    await control({ enabled: true });
    await runTick(env, clock);
    assert.equal(calls, 0);
    assert.equal(sent.length, 1);
    const mixed = structuredClone(sent[0]);
    assert.equal(mixed.type, 'checks');
    assert.deepEqual((mixed as any).tasks.map((t: any) => t.kind), ['monitor', 'ai']);
    assert.doesNotMatch(JSON.stringify(mixed), /https|fixture-queue-key|baseUrl|apiKey/);
    const r = await consume([mixed, mixed]);
    assert.deepEqual(r.map(x => x.acked), [1, 1]);
    assert.equal(calls, 2);
    assert.equal((await store.model(m.id)).live.total, 1);
    assert.equal((await loadLiveFresh(env)).native.ts, clock);
    assert.equal((await loadQueue(env)).state.pending[mixed.id], undefined);
    assert.equal(ae.length, 2);
    clock += 60;
    await runTick(env, clock);
    assert.equal(sent.length, 2);
    const changed = sent[1];
    await db.execute(sql('UPDATE monitors SET target=? WHERE id=?'), ['https://changed.example', 'native']);
    await consume([changed]);
    assert.equal(calls, 2);
    await reset();
    await native('atomic');
    const ac = await channel(), am = await model(ac.id, 'atomic-model');
    await control({ enabled: true });
    await enqueue();
    const atomic = sent[0];
    mutate = async () => { const revision = crypto.randomUUID(); await db.execute(sql('UPDATE ai_models SET revision=?,check_revision=? WHERE id=?'), [revision, revision, am.id]); };
    assert.equal((await consume([atomic]))[0].retried, 1);
    assert.equal((await store.model(am.id)).live.total, 0);
    assert.equal((await loadLiveFresh(env)).atomic, undefined);
    assert.equal(ae.length, 0);
    assert.equal((await loadQueue(env)).state.pending[atomic.id].message.tasks.length, 2);
    await consume([atomic]);
    assert.equal((await loadLiveFresh(env)).atomic.ts, clock);
    assert.equal((await store.model(am.id)).live.total, 0);
    await reset();
    const fc = await channel(), fm = await model(fc.id, 'recover');
    await control({ enabled: true });
    failSend = true;
    await enqueue();
    q = (await request('GET')).body;
    assert.equal(q.pendingTasks, 1);
    assert.equal(q.lastError.code, 'enqueue_failed');
    assert.equal(calls, 0);
    failSend = false;
    await enqueue();
    assert.equal(sent.length, 1);
    delete env.CHECK_QUEUE;
    assert.equal((await consume([sent[0]]))[0].retried, 1);
    assert.equal(calls, 0);
    env.CHECK_QUEUE = producer;
    await consume([sent[0]]);
    assert.equal(calls, 1);
    assert.equal((await store.model(fm.id)).live.total, 1);
    await reset();
    const ec = await channel(), em = await model(ec.id, 'expired');
    await control({ enabled: true });
    await enqueue();
    clock += 901;
    await cronDone();
    await consume([sent[0]]);
    assert.equal(calls, 0);
    assert.equal((await store.model(em.id)).live.total, 0);
    assert.equal(Object.keys((await loadQueue(env)).state.pending).length, 0);
    await reset();
    const pc = await channel(), pm = await model(pc.id, 'paused');
    await control({ enabled: true });
    await enqueue();
    await db.execute(sql('UPDATE ai_models SET enabled=0 WHERE id=?'), [pm.id]);
    await consume([sent[0]]);
    assert.equal(calls, 0);
    await reset();
    const dc = await channel(), dm = await model(dc.id, 'deleted');
    await control({ enabled: true });
    await enqueue();
    await db.execute(sql('DELETE FROM ai_models WHERE id=?'), [dm.id]);
    await consume([sent[0]]);
    assert.equal(calls, 0);
    await reset();
    const tc = await channel();
    for (let i = 0; i < 10; i++)
      await model(tc.id, 'long-' + i, 60000);
    await control({ enabled: true });
    await enqueue();
    assert.equal((await consume([sent[0]]))[0].retried, 1);
    assert.equal(calls, 1);
    assert.equal(Object.values((await loadQueue(env)).state.pending)[0].message.tasks.length, 9);
    clock = Math.floor(clock / 60) * 60 + 61;
    assert.equal((await consume([sent[0]]))[0].retried, 1);
    assert.equal(calls, 1);
    assert.equal((await runTick(env, clock)).status, 'completed');
    await consume([sent[0]]);
    assert.equal(calls, 2);
    await reset();
    const bc = await channel();
    for (let i = 0; i < 60; i++)
      await model(bc.id, 'budget-' + i);
    await control({ enabled: true });
    await enqueue();
    const many = structuredClone(sent);
    assert.equal(many.length, 6);
    const multi = await consume(many);
    assert.equal(calls, 50);
    assert.equal(ae.length, 50);
    assert.deepEqual(multi.map(m => m.acked), [1, 1, 1, 1, 1, 0]);
    assert.equal(multi[5].retried, 1);
    await consume([many[5], many[0]]);
    assert.equal(calls, 60);
    assert.equal(ae.length, 60);
    await reset();
    const rc = await channel();
    await model(rc.id, 'limited-a');
    await model(rc.id, 'limited-b');
    await control({ enabled: true });
    await enqueue();
    status = 429;
    await consume([sent[0]]);
    assert.equal(calls, 1);
    assert.equal((await store.models()).filter(m => m.live.total === 1).length, 1);
    clock += 60;
    await enqueue();
    assert.equal(sent.length, 1);
    await reset();
    await db.execute('DELETE FROM cron_tick_lease');
    assert.equal((await withWriterLease(env, async () => true, true)).acquired, false);
    await db.execute('DROP TABLE check_queue_control');
    await native('no-queue-schema');
    assert.equal((await request('GET')).body.schema, 'missing');
    await runTick(env, clock);
    assert.equal(calls, 1);
    await db.execute("CREATE TABLE check_queue_control(id INTEGER PRIMARY KEY,json TEXT NOT NULL,revision TEXT NOT NULL)");
    await db.execute(sql('INSERT INTO check_queue_control VALUES(1,?,?)'), ['{broken', 'broken']);
    assert.equal((await request('GET')).body.schema, 'unavailable');
    clock += 60;
    await runTick(env, clock);
    assert.equal(calls, 1);
    console.log(`PASS Queue ${db.type}: API/CAS/probe expiry, direct fallback boundaries, mixed atomic commit, duplicate/config/paused/deleted/expired, send recovery, Cron fairness, long-timeout subset, multi-message budget, cooldown`);
  }
  finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
  }
}
export async function queueEdgeScenario(env: Env, db: DBAdapter) {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let clock = Math.floor(originalNow() / 60000) * 60 + 1, calls = 0, hold: Promise<void> | undefined, mutate: (() => Promise<void>) | undefined;
  Date.now = () => clock * 1000;
  const sent: CheckQueueMessage[] = [], sql = (q: string) => queueSql(db, q), store = new AiStore(db);
  env.CHECK_QUEUE = { async sendBatch(group: any[]) { assert.ok(group.length <= 50); assert.ok(JSON.stringify(group).length < 256 * 1024); sent.push(...structuredClone(group.map(m => m.body))); } } as Queue<CheckQueueMessage>;
  env.UPTIME = { writeDataPoint() { } } as AnalyticsEngineDataset;
  const reset = async () => {
    for (const table of ['monitors', 'ai_models', 'ai_channels', 'pending_notifications', 'events', 'heartbeat_ring', 'live_state'])
      await db.execute(`DELETE FROM ${table}`);
    await db.execute(sql('UPDATE ai_runtime SET json=?,revision=? WHERE id=1'), ['{"models":{},"channels":{}}', crypto.randomUUID()]);
    await db.execute(sql('UPDATE check_queue_control SET json=?,revision=? WHERE id=1'), [JSON.stringify({ ...JSON.parse(INITIAL_QUEUE_JSON), enabled: true }), crypto.randomUUID()]);
    await db.execute(sql('INSERT INTO cron_tick_lease(id,owner,lease_until,completed_minute) VALUES(1,NULL,0,?) ON CONFLICT(id) DO UPDATE SET owner=NULL,lease_until=0,completed_minute=excluded.completed_minute'), [Math.floor(clock / 60) * 60]);
    sent.length = 0;
    calls = 0;
    invalidateConfig();
  };
  const seed = async () => { const channel = await store.saveChannel({ name: 'edge', baseUrl: 'https://provider.example/v1', protocol: 'openai', apiKey: 'fixture-edge-key' }, env.ADMIN_TOKEN); return store.saveModel({ channelId: channel.id, name: 'edge', modelId: 'edge', intervalSec: 300, timeoutMs: 1000, enabled: true, isPublic: false }); };
  const enqueue = () => withWriterLease(env, (owner, ensure) => enqueueDueChecks(env, clock, owner, ensure, new ExternalRequestBudget()));
  const consume = async (body: unknown, override = env) => { let acked = 0, retried = 0; await consumeCheckQueue({ queue: 'fixture', messages: [{ body, ack() { acked++; }, retry() { retried++; } }] } as any, override, ctx); return { acked, retried }; };
  globalThis.fetch = async (input) => { calls++; if (hold)
    await hold; if (mutate) {
    const fn = mutate;
    mutate = undefined;
    await fn();
  } return String(input).includes('provider.example') ? Response.json({ choices: [{ message: { content: 'OK' } }] }) : new Response('OK'); };
  try {
    await reset();
    await withWriterLease(env,async(_owner,ensure)=>{
      const lease=await db.queryOne<{lease_until:number}>('SELECT lease_until FROM cron_tick_lease WHERE id=1');
      assert.equal(Number(lease!.lease_until),clock+10);clock+=11;await assert.rejects(ensure,TickLeaseLost);
    },false,(clock+10)*1000);
    const concurrent = await seed();
    await enqueue();
    let release!: () => void;
    hold = new Promise<void>(r => release = r);
    const first = consume(sent[0]), waiting = originalNow();
    while (!calls && originalNow() - waiting < 10000)
      await new Promise(r => setTimeout(r, 5));
    assert.ok(calls, 'first consumer must begin');
    assert.equal((await consume(sent[0])).retried, 1);
    release();
    assert.equal((await first).acked, 1);
    hold = undefined;
    assert.equal((await store.model(concurrent.id)).live.total, 1);
    assert.equal(calls, 1);
    await reset();
    let notifying = await seed();
    const response = await api.fetch(new Request('https://fixture.test/api/notifications', {method:'POST',headers:{authorization:`Bearer ${env.ADMIN_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({name:'Queue existing notification',type:'webhook',config:{url:'https://notify.example/fixture'},active:1})}),env,ctx);
    assert.equal(response.status,201);
    const notification = (await response.json() as {id:string}).id;
    notifying = await store.saveModel({...notifying,notificationChannelIds:[notification]},notifying.id,notifying.revision);
    await writeSettings(env,{'monitor.defaultRetries':1});
    let notices=0;
    const savedFetch=globalThis.fetch;
    globalThis.fetch=async input=>{if(String(input).startsWith('https://notify.example')){notices++;return new Response('OK');}calls++;return new Response('',{status:503});};
    await enqueue();
    assert.equal((await consume({...sent[0],url:'https://untrusted.example'})).acked,1);
    assert.equal(calls,0);
    await consume(sent[0]);assert.equal((await store.model(notifying.id)).live.outcome,'upstream_unavailable');assert.equal(notices,1);
    await consume(sent[0]);assert.equal(notices,1);assert.equal((await db.query('SELECT id FROM pending_notifications')).length,0);
    globalThis.fetch=savedFetch;await writeSettings(env,{'monitor.defaultRetries':3});
    await reset();
    const changed = await seed();
    await db.execute(sql('INSERT INTO monitors(id,name,type,target,timeout_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?)'), ['native', 'Native', 'http', 'https://native.example', 1000, 1, 1]);
    await enqueue();
    mutate = async () => { const revision = crypto.randomUUID(); await db.execute(sql('UPDATE ai_models SET revision=?,check_revision=? WHERE id=?'), [revision, revision, changed.id]); };
    assert.equal((await consume(sent[0])).retried, 1);
    assert.equal(calls, 1);
    assert.equal((await store.model(changed.id)).live.total, 0);
    await consume(sent[0]);
    assert.equal(calls, 1);
    if (db.type === 'd1') {
      await reset();
      const lost = await seed();
      await enqueue();
      let fault = true;
      const ambiguous = Object.assign(Object.create(env), { DB: new Proxy(env.DB, { get(target, key) { if (key === 'batch')
            return async (statements: any[]) => { const result = await target.batch(statements); if (fault) {
              fault = false;
              throw Error('fixture commit acknowledgement lost');
            } return result; }; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } }) });
      await consume(sent[0], ambiguous);
      assert.equal((await store.model(lost.id)).live.total, 1);
      assert.equal(calls, 1);
      assert.equal((await consume(sent[0])).acked, 1);
      assert.equal(calls, 1);
    }
    await reset();
    await seed();
    for (let i = 0; i < 1001; i += 10) {
      const count = Math.min(10, 1001 - i), params: unknown[] = [];
      for (let j = 0; j < count; j++)
        params.push('capacity-' + (i + j), 'Capacity', 'http', 'https://native.example', 1, 1);
      await db.execute(sql('INSERT INTO monitors(id,name,type,target,created_at,updated_at) VALUES ' + Array.from({ length: count }, () => '(?,?,?,?,?,?)').join(',')), params);
    }
    await enqueue();
    const tasks = sent.filter((m): m is Extract<CheckQueueMessage, {
      type: 'checks';
    }> => m.type === 'checks').flatMap(m => m.tasks);
    assert.equal(tasks.length, 1000);
    assert.equal(tasks.filter(t => t.kind === 'ai').length, 1);
    assert.equal(sent.length, 100);
    assert.equal((await loadQueue(env)).state.lastError?.code, 'capacity_exceeded');
    const limited = new ExternalRequestBudget(clock * 1000 + 5000);
    assert.throws(() => limited.ensureTime(6000));
    assert.equal(limited.remaining, 50);
    globalThis.fetch = async () => { clock += 4; return Response.json({ services: [[['test'], ['https://rdap.example/']]] }); };
    await assert.rejects(() => checkDomain({ domain: 'fixture.test', timeoutMs: 3000, warnDays: 14, budget: limited }));
    assert.equal(limited.remaining, 49);
    let points = 0;
    env.UPTIME = { writeDataPoint() { points++; } } as AnalyticsEngineDataset;
    beginAnalyticsBatch(env);
    const writer = new AnalyticsWriter(env);
    for (let i = 0; i < 300; i++)
      writer.write({ indexes: ['fixture'] });
    assert.equal(points, 250);
    await reset();
    await db.execute('DROP TABLE ai_daily');
    await db.execute('DROP TABLE ai_models');
    await db.execute(sql('INSERT INTO monitors(id,name,type,target,timeout_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?)'),['without-ai','Without AI','http','https://native.example',1000,1,1]);
    globalThis.fetch=async()=>{calls++;return new Response('OK');};
    await enqueue();await consume(sent[0]);assert.equal(calls,1);assert.equal((await loadLiveFresh(env))['without-ai'].st,1);
    console.log(`PASS Queue ${db.type} edges: concurrent lease exclusion, config changed before execution${db.type==='d1'?', ambiguous commit dedup':''}, 1000-capacity kind fairness, 50-message sends, wall deadline and AE 250 cap`);
  }
  finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
}
export async function runQueueD1() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2025-01-01', d1Databases: { DB: crypto.randomUUID() }, kvNamespaces: { CONFIG: crypto.randomUUID() } });
  try {
    const binding = await mf.getD1Database('DB'), env = { DB: binding, CONFIG: await mf.getKVNamespace('CONFIG'), ADMIN_TOKEN: 'fixture-queue-material', DATABASE_TYPE: 'd1' } as Env;
    for (const migration of BOOTSTRAP_FILES) {
      if (migration.name.startsWith('0047')) {
        assert.equal((await api.fetch(new Request('https://fixture.test/api/admin/check-queue', { headers: { authorization: 'Bearer fixture-queue-material' } }), env, ctx)).status, 200);
        await binding.prepare("INSERT INTO monitors(id,name,type,target,created_at,updated_at) VALUES('retained','Retained','http','https://native.example',1,1)").run();
      }
      if (migration.statements.length)
        await binding.batch(migration.statements.map(s => binding.prepare(s)));
    }
    assert.equal((await binding.prepare("SELECT id FROM monitors WHERE id='retained'").all()).results.length, 1);
    const db = new D1Adapter(binding);
    if (!process.env.QUEUE_EDGES_ONLY)
      await queueScenario(env, db);
    if (!process.env.QUEUE_EDGES_ONLY) {
      await db.execute(sqlForD1ResetQueue());
    }
    await queueEdgeScenario(env, db);
  }
  finally {
    await mf.dispose();
  }
}
function sqlForD1ResetQueue() { return `UPDATE check_queue_control SET json='${INITIAL_QUEUE_JSON}',revision='initial' WHERE id=1`; }
if (!process.env.AI_TEST_PG_PORT)
  await runQueueD1();
