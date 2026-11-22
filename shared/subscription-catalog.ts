import { publicSubscriptionUrl, subscriptionFileUrl } from './subscription-fetch';
import { SUBSCRIPTION_LIMITS, SubscriptionError, type SubscriptionCatalogEntry } from './subscriptions';

export function subscriptionRepositoryUrl(value: string): string {
  const url = publicSubscriptionUrl(subscriptionFileUrl(value));
  if (url.search || !url.pathname.endsWith('/catalog.json')) throw new SubscriptionError('subscription_catalog_invalid');
  return url.href;
}

export function parseSubscriptionCatalog(value: unknown): SubscriptionCatalogEntry[] {
  const catalog = value as { schemaVersion?: number; entries?: unknown[] } | null;
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.entries) || catalog.entries.length > SUBSCRIPTION_LIMITS.catalogEntries) throw new SubscriptionError('subscription_catalog_invalid', 502);
  const ids = new Set<string>();
  return catalog.entries.map(raw => {
    const entry = raw as SubscriptionCatalogEntry;
    if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(entry.id) || ids.has(entry.id) || typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.description !== 'string' || typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(entry.version) || !['template', 'site'].includes(entry.kind) || !Array.isArray(entry.categories) || !entry.categories.length || entry.categories.some(category => !['website', 'model'].includes(category)) || typeof entry.path !== 'string' || !/^(templates|sites)\/[a-z0-9-]+\/\d+\.\d+\.\d+\.json$/.test(entry.path) || !entry.path.endsWith(`/${entry.version}.json`) || !Array.isArray(entry.capabilities) || !Array.isArray(entry.limitations)) throw new SubscriptionError('subscription_catalog_invalid', 502);
    ids.add(entry.id);
    return { id: entry.id, name: entry.name.slice(0, 120), description: entry.description.slice(0, 2000), categories: entry.categories, kind: entry.kind, version: entry.version, path: entry.path, capabilities: entry.capabilities.filter(item => typeof item === 'string'), verifiedAt: typeof entry.verifiedAt === 'string' ? entry.verifiedAt : null, limitations: entry.limitations.filter(item => typeof item === 'string'), versions: Array.isArray(entry.versions) ? entry.versions.filter(item => item && /^\d+\.\d+\.\d+$/.test(item.version) && item.path === `${entry.path.split('/').slice(0, -1).join('/')}/${item.version}.json`) : [], minimumAppVersion: typeof entry.minimumAppVersion === 'string' ? entry.minimumAppVersion : undefined, origin: 'official' };
  });
}
