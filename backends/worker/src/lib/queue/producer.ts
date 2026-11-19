import type { CheckQueueTask } from '../../../../../shared/check-queue';
import type { Env, Monitor } from '../../types';
import { getDB } from '../db/factory';
import { monitorProbeSource } from '../agent/probes';
import { monitorQueueVersion } from '../monitor/writes';
import { loadLiveFresh } from '../monitor/store';
import { loadPresentation } from '../presentation/store';
import { AiStore, aiStorageError } from '../ai/store';
import { SubscriptionStore } from '../subscriptions/store';
import { ExternalRequestBudget } from '../http/request-budget';
import { commitTickWrites } from '../jobs/tick-commit';
import { loadQueue, queueWrite, taskKey } from './control';
export const queueEligible = (monitor: Monitor) => Boolean(monitor.active && (monitor.type === 'http' || monitor.type === 'tcp') && monitorProbeSource(monitor).type === 'worker');
export async function enqueueDueChecks(env: Env, now: number, owner: string, ensure: () => Promise<void>, budget: ExternalRequestBudget): Promise<void> {
  let snapshot = await loadQueue(env);
  if (!snapshot.state.enabled)
    return;
  const previous = JSON.stringify(snapshot.state);
  const db = getDB(env), monitors = (await db.query<Monitor>('SELECT * FROM monitors WHERE active=1')).filter(queueEligible), live = await loadLiveFresh(env);
  const versions = new Map<string, string>();
  for (const m of monitors)
    versions.set(`monitor:${m.id}`, await monitorQueueVersion(m));
  const ai = new AiStore(db);
  let models: Awaited<ReturnType<AiStore['models']>> = [];
  try {
    if ((await loadPresentation(env)).config.aiEnabled) models = (await ai.models()).filter(model => model.enabled);
  }
  catch (error) {
    if (aiStorageError(error).code !== 'ai_schema_required')
      throw error;
  }
  for (const model of models)
    versions.set(`ai:${model.id}`, `${model.live.revision}:${model.live.channelRevision}`);
  const aiEnabled = (await loadPresentation(env)).config.aiEnabled;
  await new SubscriptionStore(db).cleanup();
  const subscriptions = (await new SubscriptionStore(db).list()).filter(item => item.enabled && item.archivedAt === null && (item.category !== 'model' || aiEnabled));
  for (const item of subscriptions) versions.set(`subscription:${item.id}`, item.syncRevision);
  for (const [id, batch] of Object.entries(snapshot.state.pending)) {
    batch.message.tasks = batch.message.tasks.filter(task => task.expiresAt > now && versions.get(taskKey(task)) === (task.kind === 'ai' ? `${task.version}:${task.channelVersion}` : task.version));
    if (!batch.message.tasks.length)
      delete snapshot.state.pending[id];
  }
  const existing = new Set(Object.values(snapshot.state.pending).flatMap(batch => batch.message.tasks.map(taskKey)));
  const tasks: CheckQueueTask[] = [];
  for (const m of monitors.sort((a, b) => (live[a.id]?.ts ?? 0) - (live[b.id]?.ts ?? 0))) {
    if (existing.has(`monitor:${m.id}`) || now - (live[m.id]?.ts ?? 0) < m.interval_sec - 1)
      continue;
    tasks.push({ kind: 'monitor', id: m.id, version: versions.get(`monitor:${m.id}`)!, token: crypto.randomUUID(), scheduledAt: now, expiresAt: now + 900 });
  }
  for (const model of models.sort((a, b) => a.live.nextCheckAt - b.live.nextCheckAt)) {
    if (existing.has(`ai:${model.id}`) || model.live.nextCheckAt > now)
      continue;
    tasks.push({ kind: 'ai', id: model.id, version: model.live.revision, channelVersion: model.live.channelRevision, token: crypto.randomUUID(), scheduledAt: now, expiresAt: now + 900 });
  }
  const subscriptionsDue: CheckQueueTask[] = subscriptions.filter(item => item.runtime.nextDueAt <= now && !existing.has(`subscription:${item.id}`)).map(item => ({ kind: 'subscription', id: item.id, version: item.syncRevision, token: crypto.randomUUID(), scheduledAt: now, expiresAt: now + 900 }));
  const native = tasks.filter(task => task.kind === 'monitor'), modelsDue = tasks.filter(task => task.kind === 'ai'), mixed: CheckQueueTask[] = [];
  while (native.length || modelsDue.length || subscriptionsDue.length) {
    if (native.length)
      mixed.push(native.shift()!);
    if (modelsDue.length)
      mixed.push(modelsDue.shift()!);
    if (subscriptionsDue.length) mixed.push(subscriptionsDue.shift()!);
  }
  if (mixed.length > 1000 - existing.size)
    snapshot.state.lastError = { code: 'capacity_exceeded', at: now };
  mixed.length = Math.min(mixed.length, 1000 - existing.size);
  for (let index = 0; index < mixed.length; index += 10) {
    const id = crypto.randomUUID();
    snapshot.state.pending[id] = { message: { type: 'checks', id, generation: snapshot.state.generation, createdAt: now, expiresAt: now + 900, tasks: mixed.slice(index, index + 10) }, sentAt: null };
  }
  if (JSON.stringify(snapshot.state) !== previous) {
    await ensure();
    await commitTickWrites(db, owner, Math.floor(Date.now() / 1000), [queueWrite(env, snapshot)]);
    snapshot = await loadQueue(env);
  }
  if (!env.CHECK_QUEUE) {
    snapshot.state.lastError = { code: 'binding_missing', at: now };
    await commitTickWrites(db, owner, Math.floor(Date.now() / 1000), [queueWrite(env, snapshot)]);
    return;
  }
  const due = Object.values(snapshot.state.pending).filter(batch => batch.sentAt === null || now - batch.sentAt >= 90);
  if (!due.length)
    return;
  const deadline = Date.now() + 10000;
  for (let offset = 0; offset < due.length; offset += 50) {
    const group = due.slice(offset, offset + 50);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (Date.now() >= deadline)
        throw new Error('enqueue_timeout');
      budget.reserve();
      await Promise.race([env.CHECK_QUEUE.sendBatch(group.map(batch => ({ body: batch.message, contentType: 'json' as const }))), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('enqueue_timeout')), deadline - Date.now()); })]);
      for (const batch of group)
        batch.sentAt = now;
      snapshot.state.lastEnqueuedAt = now;
      if (snapshot.state.lastError?.code !== 'capacity_exceeded')
        snapshot.state.lastError = null;
    }
    catch {
      snapshot.state.lastError = { code: 'enqueue_failed', at: now };
      break;
    }
    finally {
      if (timer)
        clearTimeout(timer);
    }
  }
  await ensure();
  await commitTickWrites(db, owner, Math.floor(Date.now() / 1000), [queueWrite(env, snapshot)]);
}
