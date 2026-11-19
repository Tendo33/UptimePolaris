import type { CheckQueueTask } from '../../../../../shared/check-queue';
import type { Env, Monitor } from '../../types';
import { getDB, withDBScope } from '../db/factory';
import { beginAnalyticsBatch, remainingAnalyticsPoints } from '../analytics-engine';
import { ExternalRequestBudget } from '../http/request-budget';
import { withWriterLease } from '../jobs/writer-lease';
import { commitTickWrites, newTickWriteBatch } from '../jobs/tick-commit';
import { runClaimedTick } from '../jobs/tick';
import { loadLiveFresh, invalidateConfig } from '../monitor/store';
import { monitorQueueVersion } from '../monitor/writes';
import { runAiTick } from '../ai/runtime';
import { SubscriptionStore } from '../subscriptions/store';
import { runSubscription } from '../subscriptions/runtime';
import { subscriptionTransport } from '../subscriptions/config';
import { AiStore, aiStorageError } from '../ai/store';
import { retryPending } from '../notification/dispatch';
import { loadQueue, queueWrite } from './control';
import { queueEligible } from './producer';
import { parseQueueMessage, sameQueueTask } from './messages';

export async function consumeCheckQueue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
  const started = Date.now();
  const deadline = Math.min(started + 80000, (Math.floor(started / 60000) + 1) * 60000 + 25000);
  const budget = new ExternalRequestBudget(deadline - 5000);
  await withDBScope(env, async (scoped) => {
    beginAnalyticsBatch(scoped);
    let handled = 0;
    for (const message of batch.messages) {
      const body = parseQueueMessage(message.body);
      if (!body) {
        message.ack();
        continue;
      }
      if (++handled > 25 || Date.now() + 1000 >= deadline || body.type === 'checks' && !budget.remaining) {
        message.retry({ delaySeconds: 5 });
        continue;
      }
      try {
        const result = await withWriterLease(scoped, async (owner, ensure) => {
          let snapshot = await loadQueue(scoped), now = Math.floor(Date.now() / 1000);
          if (body.generation !== snapshot.state.generation)
            return true;
          if (body.type === 'probe') {
            const probe = snapshot.state.verification;
            if (probe?.id === body.id && !probe.processedAt && !probe.failed && now < probe.expiresAt && body.expiresAt === probe.expiresAt) {
              probe.processedAt = now;
              snapshot.state.lastProcessedAt = now;
              snapshot.state.lastError = null;
              await commitTickWrites(getDB(scoped), owner, now, [queueWrite(scoped, snapshot)]);
            }
            return true;
          }
          const pending = snapshot.state.pending[body.id];
          if (!snapshot.state.enabled || !pending)
            return true;
          if (!scoped.CHECK_QUEUE) {
            snapshot.state.lastError = { code: 'binding_missing', at: now };
            await commitTickWrites(getDB(scoped), owner, now, [queueWrite(scoped, snapshot)]);
            return false;
          }
          if (pending.message.createdAt !== body.createdAt || pending.message.expiresAt !== body.expiresAt || !pending.message.tasks.every(task => body.tasks.some(sent => sameQueueTask(task, sent))))
            return true;
          const db = getDB(scoped), completed = new Set<string>(), selected: CheckQueueTask[] = [], monitors = new Map<string, Monitor>();
          invalidateConfig();
          const native = await db.query<Monitor>('SELECT * FROM monitors WHERE active=1');
          for (const monitor of native)
            monitors.set(monitor.id, monitor);
          const live = await loadLiveFresh(scoped), ai = new AiStore(db);
          const subscriptions = new Map((await new SubscriptionStore(db).list()).map(item => [item.id, item]));
          let models: Awaited<ReturnType<AiStore['models']>> = [];
          try {
            models = await ai.models();
          }
          catch (error) {
            if (aiStorageError(error).code !== 'ai_schema_required')
              throw error;
          }
          let remaining = Math.max(0, Math.floor((deadline - Date.now()) / 1000) - 5), reserved = 0;
          for (const task of pending.message.tasks) {
            if (task.expiresAt <= now || task.scheduledAt > now + 60) {
              completed.add(task.token);
              continue;
            }
            let timeout = 0, valid = false, due = true;
            if (task.kind === 'monitor') {
              const monitor = monitors.get(task.id);
              valid = Boolean(monitor && queueEligible(monitor) && await monitorQueueVersion(monitor) === task.version);
              if (monitor) {
                timeout = Math.ceil(monitor.timeout_ms / 1000);
                due = !live[task.id]?.ts || live[task.id]!.ts < task.scheduledAt && now - live[task.id]!.ts >= monitor.interval_sec - 1;
              }
            }
            else if (task.kind === 'subscription') {
              const item = subscriptions.get(task.id);
              valid = Boolean(item?.enabled && item.archivedAt === null && item.syncRevision === task.version);
              timeout = 30;
              due = Boolean(item && item.runtime.nextDueAt <= now);
            }
            else {
              const model = models.find(model => model.id === task.id);
              valid = Boolean(model?.enabled && model.live.revision === task.version && model.live.channelRevision === task.channelVersion);
              if (model) {
                timeout = Math.ceil(model.timeoutMs / 1000);
                due = model.live.nextCheckAt <= now;
              }
            }
            if (!valid || !due) {
              completed.add(task.token);
              continue;
            }
            if (timeout > remaining || Date.now() + (timeout + 5) * 1000 > task.expiresAt * 1000 || reserved >= Math.min(10, budget.remaining, task.kind === 'subscription' ? 10 : remainingAnalyticsPoints(scoped)))
              continue;
            selected.push(task);
            remaining -= timeout;
            reserved++;
          }
          const writes = newTickWriteBatch();
          const onProcessed = (kind: 'ai' | 'monitor', id: string) => {
            for (const task of selected) if (task.kind === kind && task.id === id) completed.add(task.token);
          };
          const nativeTasks = selected.filter(task => task.kind === 'monitor');
          const aiTasks = selected.filter(task => task.kind === 'ai');
          try {
            if (nativeTasks.length) {
              await runClaimedTick(scoped, now, owner, ensure, budget, {
                ids: new Set(nativeTasks.map(task => task.id)), batch: writes,
                onProcessed: id => onProcessed('monitor', id),
                beforeCheck: async monitor => Date.now() + monitor.timeout_ms + 5000 <= deadline &&
                  await monitorQueueVersion(monitor) === nativeTasks.find(task => task.id === monitor.id)?.version,
              });
            }
            if (aiTasks.length) {
              await runAiTick(scoped, now, owner, ensure, budget, {
                ids: new Set(aiTasks.map(task => task.id)), batch: writes,
                versions: new Map(aiTasks.map(task => [task.id, { revision: task.version, channelRevision: task.channelVersion! }])),
                onProcessed: id => onProcessed('ai', id),
                beforeCheck: model => Date.now() + model.timeoutMs + 5000 <= deadline,
              });
            }
            for (const task of selected.filter(task => task.kind === 'subscription')) {
              if (Date.now() + 35000 > deadline || budget.remaining < 2) break;
              await runSubscription(scoped, task.id, false, subscriptionTransport(budget), task.version);
              completed.add(task.token);
            }
            pending.message.tasks = pending.message.tasks.filter(task => !completed.has(task.token));
            if (!pending.message.tasks.length)
              delete snapshot.state.pending[body.id];
            snapshot.state.lastProcessedAt = Math.floor(Date.now() / 1000);
            snapshot.state.lastError = null;
            writes.writes.push(queueWrite(scoped, snapshot));
            await ensure();
            await commitTickWrites(db, owner, Math.floor(Date.now() / 1000), writes.writes, writes.monitors, writes.checks);
            for (const publish of writes.afterCommit)
              try {
                await publish();
              }
              catch {
                console.warn(JSON.stringify({ event: 'queue_history_write_failed' }));
              }
            return !pending.message.tasks.length;
          }
          catch {
            snapshot = await loadQueue(scoped);
            snapshot.state.lastError = { code: 'consumer_failed', at: now };
            await ensure();
            await commitTickWrites(db, owner, Math.floor(Date.now() / 1000), [queueWrite(scoped, snapshot)]);
            return false;
          }
        }, body.type === 'checks', deadline);
        if (result.acquired && result.value)
          message.ack();
        else
          message.retry({ delaySeconds: 5 });
      }
      catch {
        message.retry({ delaySeconds: 5 });
      }
    }
    if (budget.remaining && Date.now() + 25000 < deadline)
      try {
        await retryPending(scoped, Math.floor(Date.now() / 1000), budget, 5);
      }
      catch {
        console.warn(JSON.stringify({ event: 'queue_notification_deferred' }));
      }
  }, ctx);
}
