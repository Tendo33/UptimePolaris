import type { AiDayStat, AiHistoryPoint, AiModel, AiSkipReason } from '../../../../../shared/ai-management';
import { aiBackoff, aiDay, aiEntry, aiNextCheckAt, recordAiObservation, type AiRuntimeEntry, type AiRuntimeState } from '../../../../../shared/ai-runtime';
import type { Env } from '../../types';
import { loadPresentation } from '../presentation/store';
import { AnalyticsWriter, remainingAnalyticsPoints } from '../analytics-engine';
import { mapConcurrent } from '../concurrency';
import { getDB } from '../db/factory';
import { ExternalBudgetExceeded, type ExternalRequestBudget } from '../http/request-budget';
import { commitTickWrites, TickLeaseLost, type TickWriteBatch } from '../jobs/tick-commit';
import { prepareNotificationOutbox, retryPending } from '../notification/dispatch';
import type { NotifyEvent } from '../notification/message';
import { alertsSuppressed } from '../settings/maintenance';
import { readAll } from '../settings/store';
import { decryptAiCredential, decryptAiHeaders } from './credentials';
import { probeAiModel } from './probe';
import { AiStore, aiStorageError, type ChannelRow } from './store';

export interface AiTickOptions { versions?:Map<string,{revision:string;channelRevision:string}>; ids?:Set<string>; batch?:TickWriteBatch; onProcessed?:(id:string)=>void; beforeCheck?:(model:AiModel)=>boolean }
export async function runAiTick(env: Env, now: number, owner: string, ensureOwned: () => Promise<void>, budget: ExternalRequestBudget,options:AiTickOptions={}): Promise<void> {
  if (!(await loadPresentation(env)).config.aiEnabled) return;
  try { await run(env, now, owner, ensureOwned, budget,options); }
  catch (error) {
    if(options.batch)throw error;
    if (error instanceof TickLeaseLost) throw error;
    if (/NOT NULL constraint failed: ai_runtime.json|ai_configuration_changed|ai_runtime_changed/.test(String(error))) {
      console.info(JSON.stringify({ event: 'ai_tick_discarded', reason: 'configuration_or_state_changed' })); return;
    }
    console.warn(JSON.stringify({ event: 'ai_tick_incomplete', reason: aiStorageError(error).code }));
  }
}

async function run(env: Env, now: number, owner: string, ensureOwned: () => Promise<void>, budget: ExternalRequestBudget,options:AiTickOptions): Promise<void> {
  const db = getDB(env), store = new AiStore(db), stored = await store.runtime();
  if (!stored.available) return;
  const allModels = await store.models(),models=allModels.filter(model=>(!options.ids||options.ids.has(model.id))&&(!options.versions||options.versions.get(model.id)?.revision===model.live.revision&&options.versions.get(model.id)?.channelRevision===model.live.channelRevision));
  if (!models.length && !Object.keys(stored.state.models).length && !Object.keys(stored.state.channels).length) return;
  const channels = await db.query<ChannelRow>('SELECT * FROM ai_channels');
  const state: AiRuntimeState = structuredClone(stored.state), events: NotifyEvent[] = [], points: { model: AiModel; point: AiHistoryPoint }[] = [];
  const closed = new Map<string, AiDayStat[]>(), guarded = new Map<string, { model: AiModel; channel: ChannelRow }>();
  const { values } = await readAll(env), required = values['monitor.defaultRetries'] as number;
  const suppressed = (await alertsSuppressed(env, new Date(now*1000))).suppressed;
  let slots = remainingAnalyticsPoints(env);
  const flush = (model: AiModel, channel: ChannelRow, entry: AiRuntimeEntry) => {
    if (suppressed || !entry.alertPending || !entry.checkedAt || now > entry.checkedAt + model.intervalSec*2) return;
    events.push({ aiModelId: model.id, aiRevision: model.live.revision, aiChannelRevision: channel.check_revision,
      notificationChannelIds: JSON.parse(channel.notification_channel_ids), notificationEnabled: channel.notification_enabled !== 0, aiChannelId: channel.id, monitorId: `ai:${model.id}`, monitorName: model.name, monitorTarget: model.name, monitorType: 'ai',
      status: entry.settled === 'up' ? 1 : 0, prevStatus: entry.announced === 'up' ? 1 : 0, message: entry.outcome,
      statusCode: entry.statusCode, latencyMs: entry.latencyMs, at: now, eventKey: `ai:${entry.runId}:${entry.settled}` });
    entry.announced = entry.settled; entry.alertPending = false;
  };
  const skip = (entry: AiRuntimeEntry, model: AiModel, reason: AiSkipReason, next = now + 60) => {
    entry.lastAttemptAt = now; entry.skipReason = reason; entry.nextCheckAt = Math.max(next, now+60);
    if(reason!=='budget_exhausted')options.onProcessed?.(model.id);
  };
  for (const id of Object.keys(state.models)) if (!allModels.some(model => model.id === id)) delete state.models[id];
  for (const id of Object.keys(state.channels)) if (!channels.some(channel => channel.id === id)) delete state.channels[id];
  const executions = await mapConcurrent(channels, 6, async channel => {
    const candidates = models.filter(model => model.channelId === channel.id && model.enabled && model.live.channelRevision === channel.check_revision).sort((a,b) => (state.models[a.id]?.nextCheckAt ?? 0) - (state.models[b.id]?.nextCheckAt ?? 0) || a.id.localeCompare(b.id));
    for (const model of candidates) {
      const entry = aiEntry({ revision: model.live.revision }, channel.check_revision, state.models[model.id]);
      state.models[model.id] = entry; guarded.set(model.id, { model, channel });
      flush(model, channel, entry);
      if (entry.nextCheckAt > now) {options.onProcessed?.(model.id);continue;}
      const cooldown = state.channels[channel.id];
      if (cooldown?.revision === channel.check_revision && cooldown.nextAllowedAt > now) { skip(entry, model, 'channel_backoff', cooldown.nextAllowedAt); continue; }
      if (!env.UPTIME) { skip(entry, model, 'source_unavailable', now+model.intervalSec); continue; }
      if (!budget.remaining || slots <= 0) { skip(entry, model, 'budget_exhausted'); continue; }
      if(options.beforeCheck&&!options.beforeCheck(model)){skip(entry,model,'budget_exhausted');continue;}
      let apiKey: string, headers: Record<string, string>;
      try { apiKey = await decryptAiCredential(channel.credential_ciphertext, channel.id, env.ADMIN_TOKEN); headers = await decryptAiHeaders(channel.headers_ciphertext, channel.id, env.ADMIN_TOKEN); }
      catch { skip(entry, model, 'credential_unavailable', now+model.intervalSec); continue; }
      await ensureOwned();
      if (!(await loadPresentation(env)).config.aiEnabled) return;
      slots--;
      let result;
      try { result = await probeAiModel({ protocol: channel.protocol, baseUrl: channel.base_url, headers, apiKey, model: model.modelId, request: model.request, timeoutMs: model.timeoutMs }, budget); }
      catch (error) { if (error instanceof ExternalBudgetExceeded) { skip(entry, model, 'budget_exhausted'); continue; } throw error; }
      if (result.outcome === 'invalid_config') { skip(entry, model, 'configuration_invalid', now+model.intervalSec); continue; }
      const point: AiHistoryPoint = { checkedAt: Math.floor(Date.now()/1000), outcome: result.outcome, latencyMs: result.latencyMs, statusCode: result.statusCode,
        revision: model.live.revision, channelRevision: channel.check_revision, runId: crypto.randomUUID() };
      if (entry.checkedAt > point.checkedAt) continue;
      const day = recordAiObservation(entry, point, model.intervalSec, required);
      if (day) closed.set(model.id, [...closed.get(model.id) ?? [], day]);
      const backoff = aiBackoff(result.outcome, model.intervalSec, result.retryAfterSec);
      if (backoff) { entry.nextCheckAt = aiNextCheckAt(point.checkedAt,backoff); if(result.outcome !== 'permission_denied') state.channels[channel.id] = { revision: channel.check_revision, nextAllowedAt: entry.nextCheckAt }; }
      flush(model, channel, entry);
      points.push({ model, point });
      options.onProcessed?.(model.id);
    }
  });
  const rejected = executions.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  if (JSON.stringify(state) === JSON.stringify(stored.state)) return;
  await ensureOwned();
  const writes = [...await aiDayWrites(env, closed), ...await prepareNotificationOutbox(env, events, now)];
  const snapshots = [...guarded.values()];
  if (db.type === 'd1') {
    const versions = snapshots.map(({model,channel}) => ({id:model.id,revision:model.revision,channelRevision:channel.revision}));
    writes.push({ sql: `UPDATE ai_runtime SET json=CASE WHEN revision=? AND NOT EXISTS (
      SELECT 1 FROM json_each(?) s LEFT JOIN ai_models m ON m.id=json_extract(s.value,'$.id') LEFT JOIN ai_channels c ON c.id=m.channel_id
      WHERE m.id IS NULL OR m.revision<>json_extract(s.value,'$.revision') OR c.id IS NULL OR c.revision<>json_extract(s.value,'$.channelRevision') OR m.enabled<>1
      ) THEN ? ELSE NULL END,revision=? WHERE id=1`, params: [stored.revision, JSON.stringify(versions), JSON.stringify(state), crypto.randomUUID()] });
    if(options.batch)options.batch.writes.push(...writes);
    else await commitTickWrites(db, owner, Math.floor(Date.now()/1000), writes);
  } else {
    const validate=async(tx:import('../db/adapter').DBAdapter)=>{
      const lease = await tx.queryOne<{ owner: string; lease_until: number }>('SELECT owner,lease_until FROM cron_tick_lease WHERE id=1 FOR UPDATE');
      if (lease?.owner !== owner || Number(lease.lease_until) <= Math.floor(Date.now()/1000)) throw new TickLeaseLost();
      for (const { model, channel } of snapshots) {
        const current = await tx.queryOne('SELECT m.id FROM ai_models m JOIN ai_channels c ON c.id=m.channel_id WHERE m.id=$1 AND m.revision=$2 AND c.revision=$3 AND m.enabled=1 FOR SHARE OF m,c', [model.id, model.revision, channel.revision]);
        if (!current) throw new Error('ai_configuration_changed');
      }
      const runtime = await tx.queryOne<{ revision: string }>('SELECT revision FROM ai_runtime WHERE id=1 FOR UPDATE');
      if (runtime?.revision !== stored.revision) throw new Error('ai_runtime_changed');
    };
    writes.push({sql:'UPDATE ai_runtime SET json=$1,revision=$2 WHERE id=1',params:[JSON.stringify(state),crypto.randomUUID()]});
    if(options.batch){options.batch.checks.push(validate);options.batch.writes.push(...writes);}
    else await db.transaction(async tx=>{await validate(tx);for(const write of writes)await tx.execute(write.sql,write.params);});
  }
  const publish=()=>{
  const writer = new AnalyticsWriter(env);
  for (const { model, point } of points) {
    try { writer.write({ indexes: [`ai:${model.id}`], blobs: [point.outcome, point.runId, 'ai_model', point.revision, point.channelRevision], doubles: [point.latencyMs, point.outcome === 'ok' ? 1 : 0, point.statusCode, point.checkedAt] }); }
    catch { console.warn(JSON.stringify({ event: 'ai_history_write_failed' })); }
  }
  };
  if(options.batch){options.batch.afterCommit.push(publish);return;}
  publish();
  if (events.length) await retryPending(env, now, budget, 10);
}

export async function aiDayWrites(env: Env, completed: Map<string, AiDayStat[]>): Promise<{ sql: string; params: unknown[] }[]> {
  if (!completed.size) return [];
  const db = getDB(env), rows = await db.query<{ model_id: string; days_json: string }>('SELECT model_id,days_json FROM ai_daily');
  const { values } = await readAll(env), floor = new Date(Date.now() - Number(values['retention.availabilityDays'])*86400000).toISOString().slice(0,10);
  const writes: { sql: string; params: unknown[] }[] = [];
  for (const [id, days] of completed) {
    const previous = rows.find(row => row.model_id === id), map = new Map<string,AiDayStat>((JSON.parse(previous?.days_json ?? '[]') as AiDayStat[]).map(day => [day.date,day]));
    for (const day of days) map.set(day.date, day);
    const json = JSON.stringify([...map.values()].filter(day => day.date >= floor).sort((a,b) => a.date.localeCompare(b.date)));
    if (json !== previous?.days_json) writes.push({ sql: new AiStore(db).sql('INSERT INTO ai_daily(model_id,days_json) VALUES(?,?) ON CONFLICT(model_id) DO UPDATE SET days_json=excluded.days_json'), params: [id,json] });
  }
  return writes;
}

export async function archiveAiDays(env: Env, now: number): Promise<void> {
  const store = new AiStore(getDB(env)), stored = await store.runtime();
  if (!stored.available) return;
  const today = new Date(now*1000).toISOString().slice(0,10), ids = new Set((await store.models()).map(model => model.id)), days = new Map<string,AiDayStat[]>();
  for (const [id,entry] of Object.entries(stored.state.models)) if (ids.has(id) && entry.day && entry.day.date < today) days.set(id,[aiDay(entry.day)]);
  const writes = await aiDayWrites(env, days);
  if (writes.length) await getDB(env).commit(writes);
}
