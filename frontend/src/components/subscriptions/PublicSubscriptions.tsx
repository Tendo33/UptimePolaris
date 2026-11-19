import { requestJson } from '@/api/client';
import { ApiError } from '@/api/errors';
import { publicApiUrl } from '@/api/public-url';
import { usePageConfig } from '@/components/context/PageConfigContext';
import { usePresentationView } from '@/components/context/PresentationViewContext';
import { useId } from 'react';
import useSWR from 'swr';
import { useFormatter, useTranslations } from 'use-intl';
import type { PublicSubscriptionItem, SubscriptionCategory } from '../../../../shared/subscriptions';
import type { MonitorFilterStatus } from '@/types/monitor';
import type { MonitorStatusKey } from '@/lib/monitor-status';

export function usePublicSubscriptions(category: SubscriptionCategory, enabled: boolean) {
  const { pageId } = usePageConfig();
  const url = publicApiUrl(`/api/public/subscriptions/items?category=${category}`, pageId);
  const resource = useSWR(enabled ? ['public:subscriptions', url] : null, async () => {
    const items: PublicSubscriptionItem[] = []; let offset: number | null = 0;
    do { const response: { items: PublicSubscriptionItem[]; nextOffset: number | null } = await requestJson(`${url}&limit=200&offset=${offset}`, { cache: 'no-store' }); items.push(...response.items); offset = response.nextOffset; } while (offset !== null);
    return items;
  }, { refreshInterval: 60000, shouldRetryOnError: false });
  const hidden = resource.error instanceof ApiError && [401, 403, 404].includes(resource.error.status);
  return { ...resource, items: !enabled || hidden ? [] : resource.data ?? [], hidden };
}
export function subscriptionBucket(item: PublicSubscriptionItem): MonitorStatusKey {
  return item.freshness !== 'current' ? 'unknown' : item.status === 'degraded' ? 'warn' : item.status === 'maintenance' ? 'unknown' : item.status;
}
export function filterSubscriptions(items: PublicSubscriptionItem[], search: string, filter: MonitorFilterStatus) {
  return items.filter(item => `${item.name} ${item.source.name} ${item.modelId || ''} ${item.group || ''}`.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || subscriptionBucket(item) === filter));
}
function PublicState({ item, unavailable }: { item: PublicSubscriptionItem; unavailable: boolean }) {
  const t = useTranslations('subscriptions.status');
  const value = unavailable ? 'stale' : item.freshness === 'current' ? item.status : item.freshness;
  const color = value === 'up' ? 'text-success' : value === 'down' ? 'text-danger' : value === 'degraded' ? 'text-warning' : 'text-default-500';
  return <span className={`inline-flex items-center gap-2 text-small ${color}`}><span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />{t(value)}</span>;
}
export function PublicSubscriptions({ items, category, error, loading, retry, view }: { items: PublicSubscriptionItem[]; category: SubscriptionCategory; error: boolean; loading: boolean; retry: () => void; view: 'grid' | 'list' }) {
  const t = useTranslations('subscriptions'), format = useFormatter(), presentation = usePresentationView(), titleId = useId();
  const columns = ['lg:grid-cols-1', 'lg:grid-cols-2', 'lg:grid-cols-3', 'lg:grid-cols-4'][Math.max(0, Math.min(3, (presentation?.columns ?? 3) - 1))];
  if (!items.length && !error && !loading) return null;
  const stamp = (time: number | null | undefined) => time ? format.dateTime(new Date(time * 1000), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : t('noObservation');
  return <section className="mt-8" aria-labelledby={titleId}>
    <h2 id={titleId} className="mb-3 text-medium font-semibold">{t(category === 'model' ? 'models' : 'websites')}</h2>
    {error ? <p role="alert" className="mb-3 text-small text-default-500">{t('loadFailed')} <button className="underline underline-offset-4" onClick={retry}>{t('retry')}</button></p> : null}
    {loading && !items.length ? <div aria-busy="true" aria-label={t('loading')} className="polaris-shimmer h-20 rounded-medium" /> : null}
    <ul className={view === 'grid' ? `grid gap-4 sm:grid-cols-2 ${columns}` : 'polaris-card divide-y divide-divider'}>{items.map(item => <li key={item.id} className={view === 'grid' ? 'polaris-card p-4' : 'p-4'}>
      <div className="flex flex-wrap items-center gap-3"><h3 className="min-w-32 flex-1 text-small font-semibold">{item.name}</h3><PublicState item={item} unavailable={error} /></div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-small text-default-500"><span>{t('source', { name: item.source.name })}{item.source.url ? <> · <a href={item.source.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">{t('sourcePage')}</a></> : null}</span><span>{t(item.mode === 'heartbeat' ? 'observedAt' : 'fetchedAt', { time: stamp(item.mode === 'heartbeat' ? item.observation?.observedAt : item.observation?.fetchedAt) })}</span>{item.modelId ? <span>{item.modelId}</span> : null}</div>
      {item.availability && presentation?.showAvailability !== false ? <p className="mt-2 text-small text-default-500">{t('availability', { hours: item.availability.windowSec / 3600, value: format.number(item.availability.value, { maximumFractionDigits: 2 }) })}</p> : null}
      {presentation?.showHistory !== false && item.recent.length ? <details className="mt-3 text-small"><summary className="cursor-pointer text-default-500">{t('history')}</summary><p className="my-2 text-default-500">{t(item.mode === 'heartbeat' ? 'heartbeatHint' : 'snapshotHint')}</p><ul className="max-h-64 overflow-auto">{[...item.recent].reverse().map((point, index) => <li key={index} className="flex flex-wrap gap-3 py-1.5"><span>{t(`status.${point.status}`)}</span><time className="tabular-nums text-default-500">{stamp(point.observedAt ?? point.fetchedAt)}</time>{presentation?.showLatency !== false && point.latencyMs !== null ? <span className="tabular-nums">{format.number(point.latencyMs)} ms</span> : null}</li>)}</ul></details> : null}
    </li>)}</ul>
  </section>;
}
