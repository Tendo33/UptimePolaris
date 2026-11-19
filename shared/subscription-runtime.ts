import { SUBSCRIPTION_LIMITS, type Subscription, type SubscriptionItem, type SubscriptionObservation, type SubscriptionSourceItem, type SubscriptionStatus } from './subscriptions';

export function subscriptionItemView(item: SubscriptionItem, subscription: Pick<Subscription, 'enabled' | 'archivedAt' | 'syncRevision' | 'staleAfterSec'> & Partial<Pick<Subscription, 'intervalSec'>>, now: number): SubscriptionItem {
  const observation = item.observation;
  if (item.sourceCurrent === false && item.removedAt === null && subscription.enabled && subscription.archivedAt === null && item.syncRevision === subscription.syncRevision) return { ...item, freshness: 'stale', displayStatus: 'unknown' };
  const freshness = item.removedAt !== null ? 'removed' : !subscription.enabled || subscription.archivedAt !== null ? 'paused' : item.syncRevision !== subscription.syncRevision ? 'configuration_changed' : !observation ? 'never_received' : now > (item.mode === 'heartbeat' ? observation.observedAt ?? 0 : observation.fetchedAt) + subscription.staleAfterSec || now > observation.fetchedAt + Math.max(subscription.staleAfterSec, (subscription.intervalSec ?? 60) * 3) ? 'stale' : 'current';
  return { ...item, freshness, displayStatus: freshness === 'current' ? observation!.status : 'unknown' };
}

export function mergeSubscriptionItem(previous: SubscriptionItem, incoming: SubscriptionSourceItem, syncRevision: string, now: number): SubscriptionItem {
  const changed = previous.syncRevision !== syncRevision || previous.removedAt !== null;
  const recent = [...previous.recent];
  const days = new Map(previous.days.map(day => [day.date, { ...day }]));
  let watermark = previous.observationWatermark;
  let latest = changed ? null : previous.observation;
  const record = (observation: SubscriptionObservation) => {
    if (incoming.mode === 'snapshot') {
      if (!latest || latest.status !== observation.status) recent.push(observation);
      latest = observation;
      return;
    }
    const timestamp = observation.observedAt!;
    const index = recent.findIndex(point => point.observedAt === timestamp);
    const old = index >= 0 ? recent[index] : null;
    if (!old && watermark !== null && timestamp <= watermark) return;
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const day = days.get(date) ?? { date, total: 0, up: 0, availabilityPct: null, origin: 'received_observations' as const };
    if (old) {
      if (old.status === 'up') day.up--;
      recent[index] = observation;
    } else { day.total++; recent.push(observation); }
    if (observation.status === 'up') day.up++;
    day.availabilityPct = day.total ? day.up * 100 / day.total : null;
    days.set(date, day);
    if (!latest || timestamp >= (latest.observedAt ?? 0)) latest = observation;
    watermark = Math.max(watermark ?? 0, timestamp);
  };
  if (previous.selected && incoming.sourceCurrent !== false) for (const observation of incoming.mode === 'heartbeat' ? incoming.recent : incoming.observation ? [incoming.observation] : []) record(observation);
  const cutoff = new Date((now - (SUBSCRIPTION_LIMITS.historyDays - 1) * 86400) * 1000).toISOString().slice(0, 10);
  return {
    ...previous, ...incoming, recent: recent.sort((a, b) => (a.observedAt ?? a.fetchedAt) - (b.observedAt ?? b.fetchedAt)).slice(-SUBSCRIPTION_LIMITS.recent),
    observation: previous.selected ? latest : previous.observation, days: [...days.values()].filter(day => day.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date)),
    syncRevision, removedAt: null, observationWatermark: watermark,
    baseline: changed ? false : previous.baseline, announced: changed ? null : previous.announced,
  };
}

export function subscriptionTransition(item: SubscriptionItem, eligible: boolean): { item: SubscriptionItem; transition: { from: SubscriptionStatus; to: SubscriptionStatus } | null } {
  const current = item.observation?.status;
  if (!current || item.freshness !== 'current' || !['up', 'down', 'degraded'].includes(current)) return { item, transition: null };
  const transition = eligible && item.baseline && item.announced && ['up', 'down', 'degraded'].includes(item.announced) && item.announced !== current ? { from: item.announced, to: current } : null;
  return { item: { ...item, baseline: true, announced: current }, transition };
}
