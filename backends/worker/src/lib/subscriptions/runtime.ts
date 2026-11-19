import { fetchSubscriptionResponses, type SubscriptionFetchResult, type SubscriptionTransport } from '../../../../../shared/subscription-fetch';
import { parseSubscriptionResponses } from '../../../../../shared/subscription-parser';
import { redactSubscriptionItems, redactSubscriptionIssues } from '../../../../../shared/subscription-redaction';
import { mergeSubscriptionItem, subscriptionItemView, subscriptionTransition } from '../../../../../shared/subscription-runtime';
import { SubscriptionError, type Subscription, type SubscriptionItem, type SubscriptionSourceItem } from '../../../../../shared/subscriptions';
import type { Env } from '../../types';
import { getDB } from '../db/factory';
import type { ExternalRequestBudget } from '../http/request-budget';
import { prepareNotificationOutbox } from '../notification/dispatch';
import type { NotifyEvent } from '../notification/message';
import { loadPresentation } from '../presentation/store';
import { alertsSuppressed } from '../settings/maintenance';
import { subscriptionTransport, type StoredSubscriptionConfig } from './config';
import { decryptSubscriptionSecrets } from './credentials';
import { SubscriptionStore } from './store';
import { readResponseCache, responseCacheWrites } from './response-cache';

export interface SubscriptionRun {
  id: string; subscriptionId: string; state: 'running' | 'ready' | 'partial' | 'failed' | 'obsolete' | 'deferred';
  phase: 'fetching' | 'parsing' | 'committing' | 'complete';
  startedAt: number; finishedAt: number | null; updatedItems: number; requests: number; error: string | null;
}
export async function subscriptionRunView(store: SubscriptionStore, run: SubscriptionRun): Promise<SubscriptionRun> {
  if (run.state !== 'running') return run;
  const lease = await store.db.queryOne<{ lease_token: string; lease_until: number }>(store.sql('SELECT lease_token,lease_until FROM subscriptions WHERE id=?'), [run.subscriptionId]);
  return lease?.lease_token === run.id && Number(lease.lease_until) > Date.now() / 1000 ? run : { ...run, state: 'obsolete', phase: 'complete', finishedAt: Math.floor(Date.now() / 1000) };
}
interface SubscriptionCheckpoint {
  version: string; payloadId: string; offset: number; fetchedAt: number;
  failures: SubscriptionFetchResult['failures']; requests: number;
}

export function newSubscriptionItem(source: SubscriptionSourceItem, subscription: Subscription, selected: boolean): SubscriptionItem {
  return { ...source, id: crypto.randomUUID(), subscriptionId: subscription.id, category: subscription.category, revision: crypto.randomUUID(), selected, isPublic: false, muted: false,
    localName: null, groupId: null, sortOrder: 0, removedAt: null, syncRevision: subscription.syncRevision, baseline: false, announced: null, observationWatermark: null, days: [], freshness: 'never_received', displayStatus: 'unknown', recent: [], observation: null };
}

const numericStatus = (status: string): 0 | 1 | 2 => status === 'up' ? 1 : status === 'down' ? 0 : 2;

export async function runSubscription(env: Env, id: string, force = false, transport: SubscriptionTransport = subscriptionTransport(), expectedVersion?: string, defer?: (work: Promise<unknown>) => void): Promise<SubscriptionRun> {
  const store = new SubscriptionStore(getDB(env));
  let subscription = await store.get(id);
  const now = Math.floor(Date.now() / 1000), token = crypto.randomUUID();
  if (!subscription.enabled || subscription.archivedAt !== null || expectedVersion && subscription.syncRevision !== expectedVersion) throw new SubscriptionError('subscription_paused', 409);
  if (subscription.category === 'model' && !(await loadPresentation(env)).config.aiEnabled) throw new SubscriptionError('ai_disabled', 409);
  if (!await store.claim(id, subscription.syncRevision, token, now)) {
    const lease = await store.db.queryOne<{ lease_token: string }>(store.sql('SELECT lease_token FROM subscriptions WHERE id=?'), [id]);
    const existing = lease?.lease_token ? await store.document<SubscriptionRun>('run', lease.lease_token) : null;
    if (existing && force) return existing;
    throw new SubscriptionError('subscription_busy', 409);
  }
  const run: SubscriptionRun = { id: token, subscriptionId: id, state: 'running', phase: 'fetching', startedAt: now, finishedAt: null, updatedItems: 0, requests: 0, error: null };
  await store.putDocument('run', token, run, id, now + 7 * 86400);
  const currentVersion = subscription.syncRevision;
  const complete = async () => {
  let failures: SubscriptionFetchResult['failures'] = [];
  const deadline = Date.now() + 25000;
  let committed = false;
  try {
    const config = await store.document<StoredSubscriptionConfig>('config', subscription.configId);
    if (!config) throw new SubscriptionError('subscription_config_unavailable', 503);
    let checkpoint = await store.document<SubscriptionCheckpoint>('checkpoint', id);
    let parsed = checkpoint?.version === currentVersion ? await store.document<ReturnType<typeof parseSubscriptionResponses>>('normalized', checkpoint.payloadId) : null;
    if (!parsed || !checkpoint) {
      const secrets = await decryptSubscriptionSecrets(config.ciphertext, config.id, env.ADMIN_TOKEN);
      const cache = await readResponseCache(store, subscription, env.ADMIN_TOKEN);
      const fetched = await fetchSubscriptionResponses(config.descriptor, { ...config.parameters, ...secrets }, transport, now, cache, force);
      failures = fetched.failures;
      run.requests = fetched.requests; run.phase = 'parsing';
      await store.putDocument('run', token, run, id, now + 7 * 86400);
      parsed = parseSubscriptionResponses(config.descriptor, fetched.responses, now, Object.fromEntries(Object.entries(fetched.cache).map(([key, entry]) => [key, entry.fetchedAt])));
      parsed.items = redactSubscriptionItems(parsed.items, secrets);
      parsed.issues = redactSubscriptionIssues(parsed.issues, secrets);
      checkpoint = { version: currentVersion, payloadId: token, offset: 0, fetchedAt: now, failures, requests: fetched.requests };
      await store.putDocument('normalized', token, parsed, id, now + 3600);
      await store.commitRun(subscription, token, [...await responseCacheWrites(store, subscription, fetched.cache, env.ADMIN_TOKEN), store.documentWrite('checkpoint', id, checkpoint, id, now + 3600)]);
    }
    failures = checkpoint.failures; run.requests = checkpoint.requests; run.updatedItems = checkpoint.offset; run.phase = 'committing';
    const previous = await store.items(id);
    const seen = new Set(parsed.items.map(item => item.sourceItemId));
    const suppressed = (await alertsSuppressed(env, new Date(now * 1000))).suppressed;
    for (let offset = checkpoint.offset; offset < parsed.items.length; offset += 25) {
      subscription = await store.get(id);
      if (subscription.syncRevision !== currentVersion) throw new SubscriptionError('subscription_run_obsolete', 409);
      const currentItems = new Map((await store.items(id, parsed.items.slice(offset, offset + 25).map(item => item.sourceItemId))).filter(item => !item.identityArchived).map(item => [item.sourceItemId, item]));
      const writes: { sql: string; params: unknown[] }[] = [];
      for (const source of parsed.items.slice(offset, offset + 25)) {
        const old = currentItems.get(source.sourceItemId) ?? newSubscriptionItem(source, subscription, subscription.autoSubscribe);
        if (currentItems.has(source.sourceItemId)) writes.push(...store.guardItem(old));
        let item = subscriptionItemView(mergeSubscriptionItem(old, source, currentVersion, now), subscription, now);
        const policy = subscription.notifications.monitor;
        const next = subscriptionTransition(item, item.selected && !item.muted && policy.notificationEnabled && !suppressed);
        item = next.item;
        const events: NotifyEvent[] = next.transition ? [{
          ...policy, subscriptionId: id, subscriptionItemId: item.id, syncRevision: currentVersion,
          eventKind: subscription.category === 'model' ? 'ai_state' : 'monitor_state', sourceType: 'subscription',
          monitorId: `subscription:${item.id}`, monitorName: item.localName || item.name, monitorTarget: item.url ?? '', monitorType: `subscription_${subscription.category}`,
          groupId: subscription.category === 'website' ? item.groupId : null,
          status: numericStatus(next.transition.to), prevStatus: numericStatus(next.transition.from), message: item.observation?.reason ?? '',
          latencyMs: item.observation?.latencyMs, at: item.observation?.observedAt ?? now,
          eventKey: `${currentVersion}:${item.observation?.observedAt ?? now}:${next.transition.to}`,
        }] : [];
        writes.push(store.itemWrite(item), ...await prepareNotificationOutbox(env, events, now));
        run.updatedItems++;
      }
      checkpoint.offset = Math.min(parsed.items.length, offset + 25);
      writes.push(store.documentWrite('checkpoint', id, checkpoint, id, now + 3600), store.documentWrite('run', token, run, id, now + 7 * 86400));
      try { await store.commitRun(subscription, token, writes); } catch (error) { run.updatedItems = offset; throw error; }
      if (Date.now() >= deadline && checkpoint.offset < parsed.items.length) throw new SubscriptionError('subscription_budget_deferred', 503);
    }
    if (parsed.complete && !failures.some(failure => failure.requestId === config.descriptor.items.request)) {
      const removed = previous.filter(item => !seen.has(item.sourceItemId) && item.removedAt === null);
      for (let offset = 0; offset < removed.length; offset += 25) await store.commitRun(subscription, token, removed.slice(offset, offset + 25).flatMap(item => [...store.guardItem(item), store.itemWrite({ ...item, removedAt: now, freshness: 'removed', displayStatus: 'unknown', baseline: false })]));
    }
    run.state = failures.length || parsed.issues.length ? 'partial' : 'ready';
    run.error = failures[0]?.code ?? parsed.issues[0]?.code ?? null;
    committed = true;
  } catch (error) {
    run.state = error instanceof SubscriptionError && error.code === 'subscription_run_obsolete' ? 'obsolete' : error instanceof SubscriptionError && error.code === 'subscription_budget_deferred' ? 'deferred' : run.updatedItems ? 'partial' : 'failed';
    run.error = failures[0]?.code ?? (error instanceof SubscriptionError ? error.code : 'subscription_sync_failed');
  }
  run.phase = 'complete';
  run.finishedAt = Math.floor(Date.now() / 1000);
  subscription = await store.get(id);
  if (run.state === 'obsolete') {
    await store.db.execute(store.sql('UPDATE subscriptions SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?'), [id, token]);
    await store.putDocument('run', token, run, id, now + 7 * 86400);
    return run;
  }
  if (subscription.syncRevision !== currentVersion || !subscription.enabled || subscription.archivedAt !== null) { run.state = 'obsolete'; await store.putDocument('run', token, run, id, now + 7 * 86400); return run; }
  const healthy = run.state === 'ready', items = await store.items(id), runtime = { ...subscription.runtime };
  if (run.state === 'deferred') {
    runtime.nextDueAt = now + 60; runtime.lastAttemptAt = now;
    subscription = { ...subscription, runtime };
    await store.commitRun(subscription, token, [store.write('UPDATE subscriptions SET json=? WHERE id=?', [JSON.stringify(subscription), id]), store.documentWrite('run', token, run, id, now + 7 * 86400)], true);
    return run;
  }
  runtime.lastAttemptAt = now;
  runtime.health = healthy ? 'healthy' : run.state === 'partial' ? 'partial' : 'failed';
  runtime.failures = healthy ? 0 : runtime.failures + 1;
  runtime.failureSince = healthy ? null : runtime.failureSince ?? now;
  runtime.lastSuccessAt = healthy ? now : runtime.lastSuccessAt;
  const slowRetry = /authentication|descriptor|mapping|response_invalid|parameters_invalid/.test(run.error ?? '');
  const backoff = Math.min(3600, subscription.intervalSec * 2 ** Math.min(5, runtime.failures));
  const retryAfter = Math.max(0, ...failures.map(failure => failure.retryAfterSec ?? 0));
  runtime.nextDueAt = now + (healthy ? subscription.intervalSec : Math.max(retryAfter, slowRetry ? 3600 : backoff + Math.floor(Math.random() * Math.min(30, backoff / 10))));
  runtime.error = run.error;
  runtime.itemCount = items.filter(item => item.removedAt === null).length;
  runtime.selectedCount = items.filter(item => item.selected && item.removedAt === null).length;
  runtime.runId = null; runtime.phase = 'idle';
  const shouldAnnounceFailure = !healthy && now - (runtime.failureSince ?? now) >= subscription.notifications.sync.afterSec;
  const transition = healthy && runtime.announcedFailure ? 'up' : shouldAnnounceFailure && !runtime.announcedFailure ? 'down' : null;
  const syncEvents: NotifyEvent[] = [];
  if (transition && subscription.notifications.sync.notificationEnabled && !(await alertsSuppressed(env, new Date(now * 1000))).suppressed) {
    syncEvents.push({ ...subscription.notifications.sync, subscriptionId: id, syncRevision: currentVersion, eventKind: 'subscription_sync', sourceType: 'subscription',
      subscriptionLastSuccessAt: runtime.lastSuccessAt, subscriptionAffectedItems: runtime.selectedCount,
      monitorId: `subscription-sync:${id}`, monitorName: subscription.name, monitorTarget: '', monitorType: 'subscription_sync', status: transition === 'up' ? 1 : 0, prevStatus: transition === 'up' ? 0 : 1,
      message: run.error ?? '', at: now, eventKey: `${currentVersion}:${runtime.failureSince ?? now}:${transition}` });
    runtime.announcedFailure = transition === 'down';
  } else if (!subscription.notifications.sync.notificationEnabled) runtime.announcedFailure = false;
  subscription = { ...subscription, runtime };
  const writes = [store.write('UPDATE subscriptions SET json=? WHERE id=?', [JSON.stringify(subscription), id]), store.documentWrite('run', token, run, id, now + 7 * 86400), ...await prepareNotificationOutbox(env, syncEvents, now)];
  if (committed) writes.push(store.write("DELETE FROM subscription_documents WHERE kind='checkpoint' AND id=?", [id]));
  await store.commitRun(subscription, token, writes, true);
  return run;
  };
  if (defer) { const queued = structuredClone(run); defer(complete()); return queued; }
  return complete();
}

export async function runDueSubscriptions(env: Env, budget: ExternalRequestBudget): Promise<void> {
  const store = new SubscriptionStore(getDB(env)), now = Math.floor(Date.now() / 1000);
  await store.cleanup();
  const rows = await store.db.query<{ id: string }>(store.sql('SELECT id FROM subscriptions WHERE enabled=1 AND next_due<=? AND lease_until<=? ORDER BY next_due LIMIT 4'), [now, now]);
  for (const row of rows) {
    if (budget.remaining < 2) break;
    try { await runSubscription(env, row.id, false, subscriptionTransport(budget)); }
    catch (error) { console.warn(JSON.stringify({ event: 'subscription_deferred', code: error instanceof SubscriptionError ? error.code : 'subscription_storage_unavailable' })); }
  }
}
