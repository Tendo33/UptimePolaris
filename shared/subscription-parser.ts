import { subscriptionField, subscriptionFilter, subscriptionPath, subscriptionValue, type PathMatch } from './subscription-path';
import { SUBSCRIPTION_LIMITS, SubscriptionError, type SubscriptionDescriptor, type SubscriptionIssue, type SubscriptionObservation, type SubscriptionParseResult, type SubscriptionSourceItem, type SubscriptionTime } from './subscriptions';

function text(value: unknown, max = 160): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return [...String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, max).join('') || null;
}

export function subscriptionTime(value: unknown, spec: SubscriptionTime, now: number): number | null {
  if (value === undefined || value === null || value === '') return null;
  let seconds: number;
  if (spec.format === 'unix-seconds' || spec.format === 'unix-milliseconds') {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) return null;
    seconds = Number(value) / (spec.format === 'unix-milliseconds' ? 1000 : 1);
  } else {
    if (typeof value !== 'string') return null;
    const iso = spec.format === 'yyyy-MM-dd HH:mm:ss[.SSS]'
      ? /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value) ? `${value.replace(' ', 'T')}Z` : ''
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : '';
    if (!iso) return null;
    const [year, month, day, hour, minute, second] = iso.slice(0, 19).split(/[-T:]/).map(Number);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) return null;
    seconds = Date.parse(iso) / 1000;
  }
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= now + 300 ? seconds : null;
}

function point(value: unknown, descriptor: SubscriptionDescriptor, fetchedAt: number, sourceItemId: string, issues: SubscriptionIssue[]): SubscriptionObservation | null {
  const spec = descriptor.observations;
  const observedAt = spec.observedAt ? subscriptionTime(subscriptionValue(value, spec.observedAt.path), spec.observedAt, fetchedAt) : null;
  if (spec.mode === 'heartbeat' && observedAt === null) {
    issues.push({ code: 'subscription_time_invalid', path: spec.observedAt?.path ?? '$', itemId: sourceItemId, requestId: spec.request });
    return null;
  }
  const changedAt = spec.changedAt ? subscriptionTime(subscriptionValue(value, spec.changedAt.path), spec.changedAt, fetchedAt) : null;
  const raw = subscriptionValue(value, spec.status.path);
  const key = typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean' ? String(raw) : '';
  const status = Object.hasOwn(spec.status.map, key) ? spec.status.map[key] : 'unknown';
  if (!Object.hasOwn(spec.status.map, key)) issues.push({ code: 'subscription_status_unknown', path: spec.status.path, itemId: sourceItemId, requestId: spec.request });
  const latency = spec.latency ? subscriptionValue(value, spec.latency.path) : null;
  const latencyMs = typeof latency === 'number' && Number.isFinite(latency) && latency >= 0 ? latency * (spec.latency?.unit === 's' ? 1000 : 1) : null;
  return { status, observedAt, changedAt, fetchedAt, latencyMs, reason: spec.reason ? text(subscriptionValue(value, spec.reason), 500) : null };
}

function rows(value: unknown): unknown[] { return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]; }

export function parseSubscriptionResponses(descriptor: SubscriptionDescriptor, responses: Record<string, unknown>, fetchedAt: number, requestTimes: Record<string, number> = {}): SubscriptionParseResult {
  const issues: SubscriptionIssue[] = [], items: SubscriptionSourceItem[] = [];
  const catalog = responses[descriptor.items.request];
  if (catalog === undefined) throw new SubscriptionError('subscription_catalog_unavailable', 502);
  let matches = subscriptionPath(catalog, descriptor.items.path, SUBSCRIPTION_LIMITS.items + 1, true);
  if (matches.length === 1 && Array.isArray(matches[0].value)) matches = (matches[0].value as unknown[]).map(value => ({ value, parent: matches[0].parent, root: catalog }));
  if (matches.length > SUBSCRIPTION_LIMITS.items) throw new SubscriptionError('subscription_limit_exceeded', 413);
  const observation = descriptor.observations, response = responses[observation.request];
  const remote = observation.path ? subscriptionValue(response, observation.path) : response;
  const joinIndex = new Map<string, unknown[]>();
  if (observation.join) {
    for (const row of rows(remote)) {
      const key = text(subscriptionValue(row, observation.join.path), 256);
      if (key) joinIndex.set(key, [...(joinIndex.get(key) ?? []), row]);
    }
  }
  const counts = new Map<string, number>();
  for (const match of matches) {
    let id: string | null = null;
    try {
      if (descriptor.items.filter && !subscriptionFilter(match.value, descriptor.items.filter)) continue;
      const field = (name: keyof typeof descriptor.items.fields) => descriptor.items.fields[name] === undefined ? null : subscriptionField(descriptor.items.fields[name]!, match);
      const rawId = field('id');
      id = typeof rawId === 'string' ? rawId : typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : null;
      if (!id || id.length > 256 || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id)) throw new SubscriptionError('subscription_item_id_invalid');
      const name = text(field('name'));
      if (!name) throw new SubscriptionError('subscription_item_name_invalid');
      counts.set(id, (counts.get(id) ?? 0) + 1);
      let values: unknown[];
      if (observation.lookupBy) values = remote && typeof remote === 'object' && Object.hasOwn(remote, id) ? rows((remote as Record<string, unknown>)[id]) : [];
      else if (observation.join) {
        const key = observation.join.itemPath ? text(subscriptionValue(match.value, observation.join.itemPath), 256) : id;
        values = key ? joinIndex.get(key) ?? [] : [];
        if (values.length > 1 && observation.mode === 'snapshot') throw new SubscriptionError('subscription_join_ambiguous');
      } else if (observation.request === descriptor.items.request && !observation.path) values = [match.value];
      else values = rows(remote);
      if (values.length > 10000) throw new SubscriptionError('subscription_limit_exceeded', 413);
      if (!values.length) issues.push({ code: 'subscription_observation_missing', path: observation.path ?? '$', itemId: id, requestId: observation.request });
      const points = values.map(value => point(value, descriptor, requestTimes[observation.request] ?? fetchedAt, id!, issues)).filter((value): value is SubscriptionObservation => value !== null);
      if (observation.mode === 'heartbeat') points.sort((a, b) => a.observedAt! - b.observedAt!);
      const unique = new Map<number, SubscriptionObservation>();
      points.forEach(value => unique.set(value.observedAt ?? value.fetchedAt, value));
      const recent = [...unique.values()].slice(-SUBSCRIPTION_LIMITS.recent);
      const metric = descriptor.metrics?.availability;
      let availability: SubscriptionSourceItem['availability'] = null;
      if (metric && responses[metric.request] !== undefined) {
        let raw = subscriptionValue(responses[metric.request], metric.path);
        const key = id + (metric.suffix ?? '');
        if (metric.lookupBy) raw = raw && typeof raw === 'object' && Object.hasOwn(raw, key) ? (raw as Record<string, unknown>)[key] : null;
        const pct = typeof raw === 'number' ? raw * (metric.unit === 'ratio' ? 100 : 1) : NaN;
        if (Number.isFinite(pct) && pct >= 0 && pct <= 100) availability = { value: pct, windowSec: metric.windowSec, fetchedAt: requestTimes[metric.request] ?? fetchedAt, origin: 'source' };
      }
      let url = text(field('url'), 2048);
      if (url) { try { const parsed = new URL(url); url = parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null; } catch { url = null; } }
      items.push({ sourceItemId: id, name, group: text(field('group')), url, modelId: text(field('modelId'), 256), provider: text(field('provider')), protocol: text(field('protocol')), mode: observation.mode, observation: recent.at(-1) ?? null, recent, availability, sourceCurrent: !observation.currentWhen || subscriptionFilter(match.value, observation.currentWhen) });
    } catch (error) {
      issues.push({ code: error instanceof SubscriptionError ? error.code : 'subscription_mapping_failed', path: descriptor.items.path, itemId: id ?? undefined, requestId: descriptor.items.request });
    }
  }
  const duplicates = new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
  for (const id of duplicates) issues.push({ code: 'subscription_item_duplicate', path: descriptor.items.path, itemId: id });
  return { items: items.filter(item => !duplicates.has(item.sourceItemId)), issues: issues.slice(0, 100), complete: !issues.some(issue => ['subscription_item_id_invalid', 'subscription_item_name_invalid', 'subscription_item_duplicate', 'subscription_mapping_failed'].includes(issue.code)) };
}
