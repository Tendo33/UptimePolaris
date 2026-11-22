import { parseSubscriptionCatalog, subscriptionRepositoryUrl } from '../../../../../shared/subscription-catalog';
import { readSubscriptionJson } from '../../../../../shared/subscription-fetch';
import { SUBSCRIPTION_LIMITS, SubscriptionError, type SubscriptionCatalogEntry, type SubscriptionRepository } from '../../../../../shared/subscriptions';
import { validateSubscriptionDestination } from './egress';
import type { SubscriptionStore } from './store';

export type StoredSubscriptionRepository = SubscriptionRepository & { entries: SubscriptionCatalogEntry[]; checkedAt?: number };
export async function refreshSubscriptionRepository(store: SubscriptionStore, previous: StoredSubscriptionRepository): Promise<StoredSubscriptionRepository> {
  const url = new URL(subscriptionRepositoryUrl(previous.url));
  await validateSubscriptionDestination(url);
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
  if (!response.ok) { await response.body?.cancel(); throw new SubscriptionError('subscription_catalog_unavailable', 502); }
  const entries = parseSubscriptionCatalog((await readSubscriptionJson(response, SUBSCRIPTION_LIMITS.catalogBytes)).value);
  const result = { ...previous, entries, fetchedAt: Math.floor(Date.now() / 1000), checkedAt: Math.floor(Date.now() / 1000), stale: false, error: null };
  await store.putDocument('repository', result.id, result);
  return result;
}
export const repositoryView = ({ entries: _entries, checkedAt: _checkedAt, ...repository }: StoredSubscriptionRepository): SubscriptionRepository => repository;
export function repositoryEntries(repository: StoredSubscriptionRepository): SubscriptionCatalogEntry[] {
  return repository.entries.map(entry => ({ ...entry, id: `${repository.id}:${entry.id}`, origin: 'third-party', repositoryId: repository.id, repositoryName: repository.name, sourceUrl: new URL(entry.path, repository.url).href }));
}
export async function subscriptionRepositories(store: SubscriptionStore, refresh = false) {
  const rows = await store.documents<StoredSubscriptionRepository>('repository', undefined, 8);
  return Promise.all(rows.map(async row => {
    if (!refresh && (row.stale ? Date.now() / 1000 - (row.checkedAt ?? 0) < 60 : row.fetchedAt && Date.now() / 1000 - row.fetchedAt < 21600)) return row;
    try { return await refreshSubscriptionRepository(store, row); }
    catch {
      const failed = { ...row, checkedAt: Math.floor(Date.now() / 1000), stale: true, error: 'subscription_catalog_unavailable' };
      await store.putDocument('repository', row.id, failed);
      return failed;
    }
  }));
}
