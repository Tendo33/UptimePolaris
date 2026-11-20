import { requestJson } from '@/api/client';
import { ApiError } from '@/api/errors';
import { publicApiUrl } from '@/api/public-url';
import { usePageConfig } from '@/components/context/PageConfigContext';
import { usePresentationView } from '@/components/context/PresentationViewContext';
import { GlyphTile } from '@/components/ui/GlyphTile';
import { MotionDisclosure } from '@/components/ui/MotionDisclosure';
import { TONE_TEXT } from '@/components/ui/StatusDot';
import { useTimeAgo } from '@/hooks/useTimeAgo';
import type { MonitorStatusKey } from '@/lib/monitor-status';
import type { MonitorFilterStatus } from '@/types/monitor';
import type { Tone } from '@/types/tone';
import clsx from 'clsx';
import { ArrowUpRight, Bot, ChevronDown, Globe, Rss } from 'lucide-react';
import { useId, useState } from 'react';
import useSWR from 'swr';
import { useFormatter, useTranslations } from 'use-intl';
import type { PublicSubscriptionItem, SubscriptionCategory } from '../../../../shared/subscriptions';
import { ObservationRail, stateTone, toneCounts, ToneMix } from './observation';
import { SubscriptionGlyph } from './SubscriptionGlyph';

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

/** The state a visitor should read: the status only while the data is current. / 访客应看到的状态：数据有效时显示来源状态，否则显示数据状态。 */
function stateOf(item: PublicSubscriptionItem, unavailable: boolean) {
  return unavailable ? 'stale' : item.freshness === 'current' ? item.status : item.freshness;
}

function availabilityInk(value: number) {
  if (value >= 99) return 'text-[var(--polaris-ink)]';
  if (value >= 95) return 'text-warning-700';
  return 'text-danger-600';
}

const FOLDS_KEY = 'uptime-polaris.subscriptions.collapsed-sources';

function foldedSources(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

export function PublicSubscriptions({ items, category, error, loading, retry, view }: { items: PublicSubscriptionItem[]; category: SubscriptionCategory; error: boolean; loading: boolean; retry: () => void; view: 'grid' | 'list' }) {
  const t = useTranslations('subscriptions');
  const presentation = usePresentationView();
  const titleId = useId();
  const [expanded, setExpanded] = useState<string | null>(null);
  const columns = ['lg:grid-cols-1', 'lg:grid-cols-2', 'lg:grid-cols-3', 'lg:grid-cols-4'][Math.max(0, Math.min(3, (presentation?.columns ?? 3) - 1))];
  if (!items.length && !error && !loading) return null;

  const tones = items.map(item => stateTone(stateOf(item, error)));
  const up = tones.filter(tone => tone === 'up').length;
  const sources = new Map<string, { source: PublicSubscriptionItem['source']; items: PublicSubscriptionItem[] }>();
  for (const item of items) {
    const group = sources.get(item.source.id);
    if (group) group.items.push(item);
    else sources.set(item.source.id, { source: item.source, items: [item] });
  }
  const toggle = (id: string) => setExpanded(previous => previous === id ? null : id);
  const Icon = category === 'model' ? Bot : Globe;

  return (
    <section className="polaris-rise mt-10" aria-labelledby={titleId}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={titleId} className="flex items-center gap-2 text-[14px] leading-6 font-semibold tracking-[-0.01em] text-[var(--polaris-ink)]">
          <Rss size={15} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
          {t(category === 'model' ? 'models' : 'websites')}
        </h2>
        {items.length ? (
          <span className="polaris-num ml-auto flex items-center gap-3 text-[12.5px] text-[var(--polaris-ink-3)]">
            <ToneMix counts={toneCounts(tones)} className="hidden w-16 sm:flex" />
            {t('upCount', { up, total: items.length })}
          </span>
        ) : null}
      </div>
      <p className="-mt-1.5 mb-4 text-[12.5px] text-[var(--polaris-ink-4)]">{t('externalHint')}</p>

      {error ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 text-[13px] text-[var(--polaris-ink-3)]">
          <p>{t('loadFailed')}</p>
          <button type="button" className="underline underline-offset-4 hover:text-[var(--polaris-ink)]" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {loading && !items.length ? <span role="status" aria-label={t('loading')} className="polaris-shimmer block h-[68px] rounded-xl" /> : null}

      <div className="flex flex-col gap-8">
        {[...sources.values()].map(({ source, items: own }) => (
          <SourceGroup key={source.id} source={source} items={own} error={error}>
            {view === 'grid' ? (
              <ul className={clsx('grid grid-cols-1 gap-4 sm:grid-cols-2', columns)}>
                {own.map(item => <ItemTile key={item.id} item={item} icon={<Icon size={17} />} error={error} expanded={expanded === item.id} onToggle={() => toggle(item.id)} />)}
              </ul>
            ) : (
              <ul className="polaris-card divide-y divide-[var(--polaris-line-soft)] overflow-hidden">
                {own.map(item => <ItemRow key={item.id} item={item} icon={<Icon size={17} />} error={error} expanded={expanded === item.id} onToggle={() => toggle(item.id)} />)}
              </ul>
            )}
          </SourceGroup>
        ))}
      </div>
    </section>
  );
}

function SourceGroup({ source, items, error, children }: { source: PublicSubscriptionItem['source']; items: PublicSubscriptionItem[]; error: boolean; children: React.ReactNode }) {
  const t = useTranslations('subscriptions');
  const { pageId } = usePageConfig();
  const id = useId();
  const [folded, setFolded] = useState(() => foldedSources().includes(source.id));
  const open = !folded;
  const tones = items.map(item => stateTone(stateOf(item, error)));
  const up = tones.filter(tone => tone === 'up').length;
  const toggle = () => {
    const next = !folded;
    setFolded(next);
    try {
      const ids = new Set(foldedSources());
      if (next) ids.add(source.id); else ids.delete(source.id);
      localStorage.setItem(FOLDS_KEY, JSON.stringify([...ids]));
    } catch {}
  };
  return (
    <section aria-labelledby={id}>
      <div className="mb-3 flex items-center gap-3">
        <SubscriptionGlyph id={source.id} category={items[0].category} pageId={pageId} publicView />
        <h3 id={id} className="flex min-w-0 items-center gap-2 text-[14px] leading-6 font-semibold text-[var(--polaris-ink)]">
          <button type="button" aria-expanded={open} aria-controls={`${id}-items`} onClick={toggle} className="-ml-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 text-left transition-colors hover:text-[var(--polaris-ink-2)]">
            <ChevronDown size={16} aria-hidden="true" className={clsx('shrink-0 text-[var(--polaris-ink-4)] transition-transform duration-200', !open && '-rotate-90')} />
            <span className="truncate" title={source.name}>{source.name}</span>
          </button>
          {source.url ? (
            <a href={source.url} target="_blank" rel="noreferrer" aria-label={t('sourcePage')} title={t('sourcePage')} className="inline-flex shrink-0 text-[var(--polaris-ink-4)] transition-colors hover:text-[var(--polaris-ink)]">
              <ArrowUpRight size={14} />
            </a>
          ) : null}
        </h3>
        <span className="polaris-num ml-auto flex shrink-0 items-center gap-3 text-[12.5px] text-[var(--polaris-ink-3)]">
          <ToneMix counts={toneCounts(tones)} className="hidden w-16 sm:flex" />
          {t('upCount', { up, total: items.length })}
        </span>
      </div>
      <MotionDisclosure open={open}><div id={`${id}-items`}>{children}</div></MotionDisclosure>
    </section>
  );
}

interface ItemProps {
  item: PublicSubscriptionItem;
  icon: React.ReactNode;
  error: boolean;
  expanded: boolean;
  onToggle: () => void;
}

function MetaLine({ item, error }: { item: PublicSubscriptionItem; error: boolean }) {
  const t = useTranslations('subscriptions');
  const presentation = usePresentationView();
  const ago = useTimeAgo();
  const state = stateOf(item, error);
  const tone: Tone = stateTone(state);
  const at = item.mode === 'heartbeat' ? item.observation?.observedAt : item.observation?.fetchedAt;
  const parts: React.ReactNode[] = [];
  if (presentation?.showLatency !== false && item.observation?.latencyMs != null && tone !== 'down') parts.push(<span className="polaris-num">{Math.round(item.observation.latencyMs)} ms</span>);
  if (at) parts.push(<span className="text-[var(--polaris-ink-4)]" title={t(item.mode === 'heartbeat' ? 'observedAt' : 'fetchedAt', { time: new Date(at * 1000).toLocaleString() })}>{ago(at)}</span>);
  if (item.modelId) parts.push(<span className="truncate font-mono text-[11.5px]">{item.modelId}</span>);
  return (
    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-[var(--polaris-ink-3)]">
      <span className={clsx('font-medium', tone === 'idle' ? 'text-[var(--polaris-ink-3)]' : TONE_TEXT[tone])}>{t(`status.${state}`)}</span>
      {parts.map((part, index) => (
        <span key={index} className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden="true" className="text-[var(--polaris-ink-4)]">·</span>
          {part}
        </span>
      ))}
    </div>
  );
}

function Availability({ item, large = false }: { item: PublicSubscriptionItem; large?: boolean }) {
  const t = useTranslations('subscriptions');
  const format = useFormatter();
  const presentation = usePresentationView();
  if (presentation?.showAvailability === false || !item.availability) return null;
  const { value, windowSec } = item.availability;
  return (
    <div className="shrink-0 text-right" title={t('availability', { hours: windowSec / 3600, value: format.number(value, { maximumFractionDigits: 2 }) })}>
      <span className={clsx('polaris-num block font-semibold', large ? 'text-[14px] leading-5' : 'text-[13.5px]', availabilityInk(value))}>
        {format.number(value, { maximumFractionDigits: 2 })}%
      </span>
      <span className="block text-[12px] text-[var(--polaris-ink-4)]">{t('availabilityShort', { hours: windowSec / 3600 })}</span>
    </div>
  );
}

function History({ item }: { item: PublicSubscriptionItem }) {
  const t = useTranslations('subscriptions');
  const format = useFormatter();
  const presentation = usePresentationView();
  const points = [...item.recent].reverse();
  return (
    <div id={`subscription-history-${item.id}`} className="border-t border-[var(--polaris-line-soft)] px-4 py-4 sm:px-5">
      <p className="mb-3 text-[12px] text-[var(--polaris-ink-4)]">{t(item.mode === 'heartbeat' ? 'heartbeatHint' : 'snapshotHint')}</p>
      <ol className="max-h-72 space-y-px overflow-auto">
        {points.map((point, index) => {
          const at = point.observedAt ?? point.fetchedAt;
          const tone = stateTone(point.status);
          return (
            <li key={index} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-2 py-1.5 text-[12.5px] hover:bg-[var(--polaris-hover)]">
              <span className={clsx('flex items-center gap-1.5 font-medium', tone === 'idle' ? 'text-[var(--polaris-ink-3)]' : TONE_TEXT[tone])}>
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                {t(`status.${point.status}`)}
              </span>
              <span className="min-w-0 truncate text-[var(--polaris-ink-4)]" title={point.reason ?? undefined}>{point.reason}</span>
              <span className="polaris-num flex items-center gap-3 text-[var(--polaris-ink-3)]">
                {presentation?.showLatency !== false && point.latencyMs !== null ? <span>{format.number(point.latencyMs)} ms</span> : null}
                <time dateTime={new Date(at * 1000).toISOString()}>{format.dateTime(new Date(at * 1000), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function HistoryToggle({ item, expanded, onToggle, className }: { item: PublicSubscriptionItem; expanded: boolean; onToggle: () => void; className?: string }) {
  const t = useTranslations('subscriptions');
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={`subscription-history-${item.id}`}
      aria-label={`${item.name} · ${t('history')}`}
      onClick={onToggle}
      className={clsx('inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-[var(--polaris-ink-3)] transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]', className)}
    >
      {t('history')}
      <ChevronDown size={14} className={clsx('transition-transform duration-200', expanded && 'rotate-180')} />
    </button>
  );
}

function ItemRow({ item, icon, error, expanded, onToggle }: ItemProps) {
  const presentation = usePresentationView();
  const history = presentation?.showHistory !== false && item.recent.length > 0;
  return (
    <li>
      <div
        className={clsx(
          'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 px-4 sm:px-5 md:grid-cols-[minmax(0,1fr)_minmax(0,300px)_4.75rem_auto] md:gap-6',
          presentation?.density === 'compact' ? 'py-2' : presentation?.density === 'comfortable' ? 'py-5' : 'py-3.5',
        )}
      >
        <div className="col-span-2 flex min-w-0 items-center gap-3 md:col-span-1">
          <GlyphTile badge={stateTone(stateOf(item, error))}>{icon}</GlyphTile>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[14px] font-medium text-[var(--polaris-ink)]" title={item.name}>{item.name}</h3>
            <MetaLine item={item} error={error} />
          </div>
        </div>
        {presentation?.showHistory !== false ? <ObservationRail points={item.recent} max={40} height="h-6" showLatency={presentation?.showLatency !== false} className="min-w-0" /> : <span className="hidden md:block" />}
        <div className="flex justify-end">{item.availability ? <Availability item={item} /> : <span className="hidden md:block" />}</div>
        {history ? <HistoryToggle item={item} expanded={expanded} onToggle={onToggle} className="col-span-2 justify-self-start md:col-span-1 md:justify-self-end" /> : <span className="hidden md:block md:w-[5.5rem]" />}
      </div>
      {history && expanded ? <History item={item} /> : null}
    </li>
  );
}

function ItemTile({ item, icon, error, expanded, onToggle }: ItemProps) {
  const presentation = usePresentationView();
  const history = presentation?.showHistory !== false && item.recent.length > 0;
  return (
    <li className={clsx('polaris-card min-w-0 overflow-hidden', expanded && 'sm:col-span-2 lg:col-span-full')}>
      <div className={clsx('flex flex-col gap-4', presentation?.density === 'compact' ? 'p-3' : presentation?.density === 'comfortable' ? 'p-6' : 'p-4')}>
        <div className="flex items-start gap-3">
          <GlyphTile badge={stateTone(stateOf(item, error))}>{icon}</GlyphTile>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[14px] font-medium text-[var(--polaris-ink)]" title={item.name}>{item.name}</h3>
            <MetaLine item={item} error={error} />
          </div>
          <Availability item={item} large />
        </div>
        {presentation?.showHistory !== false ? <ObservationRail points={item.recent} max={30} height="h-5" showLatency={presentation?.showLatency !== false} /> : null}
        {history ? <HistoryToggle item={item} expanded={expanded} onToggle={onToggle} className="-mx-1 -mt-1 self-start" /> : null}
      </div>
      {history && expanded ? <History item={item} /> : null}
    </li>
  );
}
