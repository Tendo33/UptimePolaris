import { SubscriptionError, type SubscriptionConfig, type SubscriptionItem, type SubscriptionPreview } from './subscriptions';

export function subscriptionIdentity(config: SubscriptionConfig): string {
  const { items, requests, inputs } = config.descriptor;
  const request = requests[items.request];
  const used = new Set([request.baseUrlInput, ...[...JSON.stringify(request).matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1])]);
  const parameters = [...used].sort().filter(key => inputs[key]?.type !== 'secret').map(key => [key, config.parameters[key] ?? inputs[key]?.default]);
  return JSON.stringify([items.request, items.path, items.fields.id, request.method, request.path, request.query, request.body, parameters]);
}

export function subscriptionIdentityDiff(previous: SubscriptionConfig, next: SubscriptionConfig, items: SubscriptionItem[], sourceIds: string[]): NonNullable<SubscriptionPreview['identity']> {
  const active = items.filter(item => !item.identityArchived && item.removedAt === null);
  const oldIds = new Set(active.map(item => item.sourceItemId)), nextIds = new Set(sourceIds);
  return { changed: subscriptionIdentity(previous) !== subscriptionIdentity(next), previous: active.map(item => ({ id: item.id, sourceItemId: item.sourceItemId, name: item.localName || item.name })), added: sourceIds.filter(id => !oldIds.has(id)), removed: [...oldIds].filter(id => !nextIds.has(id)) };
}

export function remapSubscriptionIdentities(items: SubscriptionItem[], sourceIds: string[], mappings: unknown, now: number): SubscriptionItem[] {
  if (!Array.isArray(mappings) || mappings.length > 1000) throw new SubscriptionError('subscription_identity_mapping_invalid');
  const source = new Set(sourceIds), targets = new Set<string>(), mapping = new Map<string, string>();
  for (const entry of mappings) {
    if (!entry || typeof entry !== 'object' || typeof entry.itemId !== 'string' || typeof entry.sourceItemId !== 'string' || mapping.has(entry.itemId) || targets.has(entry.sourceItemId) || !source.has(entry.sourceItemId) || !items.some(item => item.id === entry.itemId && !item.identityArchived && item.removedAt === null)) throw new SubscriptionError('subscription_identity_mapping_invalid');
    mapping.set(entry.itemId, entry.sourceItemId); targets.add(entry.sourceItemId);
  }
  return items.filter(item => !item.identityArchived).map(item => {
    const target = mapping.get(item.id);
    return { ...item, sourceItemId: target ?? item.sourceItemId, identityArchived: !target, removedAt: target ? null : now, baseline: false, revision: crypto.randomUUID() };
  });
}
