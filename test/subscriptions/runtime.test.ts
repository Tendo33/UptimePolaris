import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSubscriptionItem, subscriptionItemView, subscriptionTransition } from '../../shared/subscription-runtime';
import { subscriptionNotifications, subscriptionRuntime, type Subscription, type SubscriptionItem, type SubscriptionSourceItem } from '../../shared/subscriptions';
import { notificationRoutingReason } from '../../shared/notification-policy';

const now = Date.parse('2026-11-20T00:00:00Z') / 1000;
const subscription: Subscription = { id: 's', name: 'Source', category: 'website', enabled: true, archivedAt: null, isPublic: false, autoSubscribe: false, intervalSec: 60, staleAfterSec: 300, revision: 'r', syncRevision: 'r', configId: 'c', templateName: 'Test', templateVersion: '1.0.0', sourceUrl: null, origin: 'local', createdAt: now, updatedAt: now, notifications: subscriptionNotifications(), runtime: subscriptionRuntime() };
const source: SubscriptionSourceItem = { sourceItemId: '1', name: 'Source name', group: null, url: null, modelId: null, provider: null, protocol: null, mode: 'heartbeat', observation: null, recent: [], availability: null };
const item: SubscriptionItem = { ...source, id: 'i', subscriptionId: 's', category: 'website', revision: 'a', selected: true, isPublic: true, muted: false, localName: 'My name', groupId: 'g', sortOrder: 3, removedAt: null, syncRevision: 'r', baseline: false, announced: null, observationWatermark: null, days: [], freshness: 'never_received', displayStatus: 'unknown' };
const observation = (status: 'up' | 'down', time: number) => ({ status, observedAt: time, changedAt: null, fetchedAt: now, latencyMs: null, reason: null });

test('upstream freshness overrides recently fetched observations without adding history', () => {
  const incoming = { ...source, sourceCurrent: false, observation: observation('up', now), recent: [observation('up',now)] };
  const merged = mergeSubscriptionItem(item, incoming, 'r', now);
  assert.equal(merged.days.length, 0);
  assert.equal(subscriptionItemView(merged,subscription,now).displayStatus, 'unknown');
  assert.equal(subscriptionItemView(merged,subscription,now).freshness, 'stale');
});

test('repeated heartbeats preserve local settings and count each source observation once', () => {
  const data = { ...source, observation: observation('up', now - 60), recent: [observation('up', now - 60)] };
  const first = mergeSubscriptionItem(item, data, 'r', now);
  const second = mergeSubscriptionItem(first, data, 'r', now);
  assert.equal(second.days[0].total, 1);
  assert.equal(second.days[0].up, 1);
  assert.equal(second.localName, 'My name');
  assert.equal(second.groupId, 'g');
  assert.equal(second.isPublic, true);
});

test('corrections replace retained points without counting a second check', () => {
  const first = mergeSubscriptionItem(item, { ...source, recent: [observation('up', now - 60)] }, 'r', now);
  const second = mergeSubscriptionItem(first, { ...source, recent: [observation('down', now - 60)] }, 'r', now);
  assert.equal(second.days[0].total, 1); assert.equal(second.days[0].up, 0);
});

test('old data and changed configuration cannot manufacture a current healthy state', () => {
  const merged = mergeSubscriptionItem(item, { ...source, recent: [observation('up', now - 600)] }, 'r', now);
  assert.equal(subscriptionItemView(merged, subscription, now).displayStatus, 'unknown');
  assert.equal(subscriptionItemView(merged, { ...subscription, syncRevision: 'new' }, now).freshness, 'configuration_changed');
});

test('configuration revisions establish a baseline and retain historical observations', () => {
  const first = mergeSubscriptionItem(item, { ...source, recent: [observation('up', now - 60)] }, 'r', now);
  const changed = mergeSubscriptionItem(first, { ...source, recent: [observation('up', now)] }, 'next', now);
  assert.equal(changed.days.reduce((sum, day) => sum + day.total, 0), 2); assert.equal(changed.baseline, false); assert.equal(changed.recent.length, 2);
});

test('snapshots do not create probe-count availability', () => {
  const data = { ...source, mode: 'snapshot' as const, observation: { ...observation('up', now), observedAt: null } };
  const first = mergeSubscriptionItem(item, data, 'r', now);
  const second = mergeSubscriptionItem(first, data, 'r', now);
  assert.equal(second.days.length, 0); assert.equal(second.recent.length, 1);
});

test('first observation sets a baseline, a subsequent failure produces one transition', () => {
  const first = subscriptionTransition(subscriptionItemView(mergeSubscriptionItem(item, { ...source, recent: [observation('up', now - 60)] }, 'r', now), subscription, now), true);
  assert.equal(first.transition, null);
  const failed = subscriptionTransition(subscriptionItemView(mergeSubscriptionItem(first.item, { ...source, recent: [observation('down', now)] }, 'r', now), subscription, now), true);
  assert.deepEqual(failed.transition, { from: 'up', to: 'down' });
  assert.equal(subscriptionTransition(failed.item, true).transition, null);
});

test('routing preserves local defaults while subscriptions require an explicit scope or selection', () => {
  const channel = { id: 'n', active: 1, group_ids: [] };
  assert.equal(notificationRoutingReason(channel, { monitorType: 'http' }), null);
  assert.equal(notificationRoutingReason(channel, { subscriptionId: 's' }), 'source_outside_scope');
  assert.equal(notificationRoutingReason(channel, { subscriptionId: 's', notificationChannelIds: ['n'] }), null);
  assert.equal(notificationRoutingReason(channel, { notificationEnabled: false, notificationChannelIds: ['n'] }), 'notifications_disabled');
  assert.equal(notificationRoutingReason({ ...channel, active: 0 }, { notificationChannelIds: ['n'] }), 'channel_inactive');
  assert.equal(notificationRoutingReason({ ...channel, group_ids: ['g'] }, { aiModelId: 'm' }), 'group_outside_scope');
  const stored = { ...channel, ai_channel_ids: ['old-ai'], subscription_ids: ['old-subscription'] };
  assert.equal(notificationRoutingReason(stored, { aiModelId: 'm', aiChannelId: 'other-ai' }), null);
  assert.equal(notificationRoutingReason({ ...stored, source_types: ['local', 'subscription'] }, { subscriptionId: 'other-subscription' }), null);
});

test('pending or maintenance baselines do not produce a false recovery', () => {
  for (const announced of ['pending', 'maintenance', 'unknown'] as const) {
    const next = subscriptionTransition({ ...item, baseline: true, announced, freshness: 'current', observation: observation('up', now) }, true);
    assert.equal(next.transition, null);
    assert.equal(next.item.announced, 'up');
  }
});
