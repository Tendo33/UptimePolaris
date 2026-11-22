import { requestJson } from '@/api/client';
import { ApiError } from '@/api/errors';
import useSWR from 'swr';
import type { Subscription, SubscriptionCatalogEntry, SubscriptionConfig, SubscriptionDescriptor, SubscriptionItem, SubscriptionPreview, SubscriptionSummary, SubscriptionRepository } from '../../../../shared/subscriptions';

export type Page<T> = { items: T[]; total: number; nextOffset: number | null };
export type Catalog = { entries: SubscriptionCatalogEntry[]; fetchedAt: number | null; stale: boolean; error: string | null; repositories?: SubscriptionRepository[] };
export type Run = { id: string; state: string; phase: string; startedAt: number; finishedAt: number | null; updatedItems: number; requests: number; error: string | null };
const root = '/api/admin/subscriptions';
const path = (id: string) => `${root}/${encodeURIComponent(id)}`;
const write = <T>(url: string, method: string, input: unknown = {}) => requestJson<T>(url, { method, body: JSON.stringify(input) });
async function awaitPreview(result: { preview: SubscriptionPreview; previewId: string }) {
  const deadline = Date.now() + 45000;
  while (result.preview.state === 'running') {
    if (Date.now() > deadline) throw new ApiError('request_timeout', 0);
    await new Promise(resolve => setTimeout(resolve, 750));
    result.preview = (await requestJson<{ preview: SubscriptionPreview }>(`/api/admin/subscription-previews/${encodeURIComponent(result.previewId)}`)).preview;
  }
  return result;
}
async function awaitRun(result: { run: Run; runId: string }, onProgress?: (run: Run) => void) {
  const deadline = Date.now() + 45000;
  while (result.run.state === 'running') {
    onProgress?.(result.run);
    if (Date.now() > deadline) return result;
    await new Promise(resolve => setTimeout(resolve, 750));
    result.run = (await requestJson<{ run: Run }>(`/api/admin/subscription-runs/${encodeURIComponent(result.runId)}`)).run;
  }
  return result;
}
export const subscriptionsApi = {
  list: (query = '') => requestJson<Page<Subscription> & { summary: SubscriptionSummary }>(`${root}?${query}`),
  all: async (query = '') => {
    const params = new URLSearchParams(query), items: Subscription[] = [];
    params.set('limit', '200');
    let offset: number | null = 0;
    do {
      params.set('offset', String(offset));
      const page: Page<Subscription> = await subscriptionsApi.list(params.toString());
      items.push(...page.items); offset = page.nextOffset;
    } while (offset !== null);
    return { items };
  },
  get: (id: string) => requestJson<{ subscription: Subscription }>(path(id)),
  create: (input: unknown) => write<{ subscription: Subscription }>(root, 'POST', input),
  update: (subscription: Subscription, input: unknown) => write<{ subscription: Subscription }>(path(subscription.id), 'PATCH', { revision: subscription.revision, ...input as object }),
  remove: (subscription: Subscription) => write<{ ok: boolean }>(path(subscription.id), 'DELETE', { revision: subscription.revision }),
  items: (id: string, query = '') => requestJson<Page<SubscriptionItem>>(`${path(id)}/items?${query}`),
  updateItems: (id: string, items: Partial<SubscriptionItem>[]) => write<{ results: { id: string; ok: boolean; error?: string }[] }>(`${path(id)}/items`, 'PATCH', { items }),
  sync: async (id: string, onProgress?: (run: Run) => void) => awaitRun(await write<{ runId: string; run: Run }>(`${path(id)}/sync`, 'POST'), onProgress),
  run: (id: string) => requestJson<{ run: Run }>(`/api/admin/subscription-runs/${encodeURIComponent(id)}`),
  runs: (id: string) => requestJson<{ runs: Run[] }>(`${path(id)}/runs`),
  catalog: () => requestJson<Catalog>('/api/admin/subscription-catalog'),
  addRepository: (input: { name: string; url: string }) => write<{ repository: SubscriptionRepository }>('/api/admin/subscription-repositories', 'POST', input),
  removeRepository: (id: string) => write<{ ok: true }>(`/api/admin/subscription-repositories/${encodeURIComponent(id)}`, 'DELETE'),
  refreshCatalog: async () => { await write<Catalog>('/api/admin/subscription-catalog/refresh', 'POST'); return requestJson<Catalog>('/api/admin/subscription-catalog'); },
  removeConfig: (id: string) => write<{ ok: boolean }>(`/api/admin/subscription-configs/${encodeURIComponent(id)}`, 'DELETE'),
  template: (id: string) => requestJson<{ descriptor: SubscriptionDescriptor; sourceUrl: string }>(`/api/admin/subscription-catalog/${encodeURIComponent(id)}`),
  import: (input: { url?: string; descriptor?: unknown }) => write<{ descriptor: SubscriptionDescriptor; sourceUrl: string | null }>('/api/admin/subscription-configs/import', 'POST', input),
  preview: (input: unknown) => write<{ preview: SubscriptionPreview; previewId: string }>('/api/admin/subscription-configs/preview', 'POST', input).then(awaitPreview),
  config: (id: string) => requestJson<{ config: SubscriptionConfig; revision: string }>(`${path(id)}/config`),
  checkUpdate: (id: string) => write<{ changed: boolean; conflict: boolean; currentVersion: string; candidate: SubscriptionDescriptor }>(`${path(id)}/config/check-update`, 'POST'),
  previewConfig: (id: string, input: unknown) => write<{ preview: SubscriptionPreview; previewId: string }>(`${path(id)}/config/preview`, 'POST', input).then(awaitPreview),
  applyConfig: (id: string, input: unknown) => write<{ subscription: Subscription }>(`${path(id)}/config`, 'PUT', input),
};
export const subscriptionKey = (id: string) => `console:subscription:${id}`;
export function useSubscription(id?: string) {
  return useSWR(id ? subscriptionKey(id) : null, () => subscriptionsApi.get(id!), { refreshInterval: 30000, shouldRetryOnError: false });
}
