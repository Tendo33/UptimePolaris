import { publicApiUrl } from '@/api/public-url';
import { AiHistory } from '@/components/ai/AiHistory';
import { AiRail, recentLatency } from '@/components/ai/AiRail';
import { aiLiveLabelKey, aiLiveTone, aiStatusKey } from '@/components/ai/status';
import { usePageConfig } from '@/components/context/PageConfigContext';
import { usePresentationView } from '@/components/context/PresentationViewContext';
import { GlyphTile } from '@/components/ui/GlyphTile';
import { SparkLine } from '@/components/ui/MetricFigures';
import { TONE_TEXT } from '@/components/ui/StatusDot';
import { MotionDisclosure } from '@/components/ui/MotionDisclosure';
import { useTimeAgo } from '@/hooks/useTimeAgo';
import type { MonitorFilterStatus } from '@/types/monitor';
import type { Tone } from '@/types/tone';
import clsx from 'clsx';
import { Bot, ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import type { PublicAiModel } from '../../../../shared/ai-management';

export function filterAiModels(models: PublicAiModel[], search: string, filter: MonitorFilterStatus, unavailable = false, searchChannels = true) {
  const term = search.trim().toLowerCase();
  return models.filter((model) => (!term || model.name.toLowerCase().includes(term) || searchChannels && model.channel.name.toLowerCase().includes(term)) && (filter === 'all' || (!unavailable && aiStatusKey(model.live) === filter)));
}

const MIX: Array<{ tone: Tone; fill: string }> = [
  { tone: 'down', fill: 'bg-danger' },
  { tone: 'warn', fill: 'bg-warning' },
  { tone: 'pending', fill: 'bg-orange-500' },
  { tone: 'up', fill: 'bg-[var(--polaris-rail-up)]' },
  { tone: 'idle', fill: 'bg-default-300' },
];

function availabilityInk(value: number | null) {
  if (value === null) return 'text-[var(--polaris-ink-4)]';
  if (value >= 99) return 'text-[var(--polaris-ink)]';
  if (value >= 95) return 'text-warning-700';
  return 'text-danger-600';
}

export function AiModels({ models, error, loading, retry, view, filtering = false }: { models: PublicAiModel[]; error: boolean; loading: boolean; retry: () => void; view?: 'grid' | 'list'; filtering?: boolean }) {
  const t = useTranslations('ai');
  const presentation = usePresentationView();
  const [expanded, setExpanded] = useState<string | null>(null);
  const cards = view ? view === 'grid' : presentation?.layout === 'cards';
  const columns = ['lg:grid-cols-1', 'lg:grid-cols-2', 'lg:grid-cols-3', 'lg:grid-cols-4'][Math.max(0, Math.min(3, (presentation?.columns ?? 3) - 1))];
  if (!models.length && !error && !loading) return null;

  const tones = models.map((model) => aiLiveTone(model.live, error));
  const up = tones.filter((tone) => tone === 'up').length;
  const mix = MIX.map((row) => ({ ...row, n: tones.filter((tone) => tone === row.tone).length })).filter((row) => row.n > 0);
  const toggle = (id: string) => setExpanded((previous) => (previous === id ? null : id));
  const channels = new Map<string, { channel: PublicAiModel['channel']; models: PublicAiModel[] }>();
  for (const model of models) {
    const group = channels.get(model.channel.id);
    if (group) group.models.push(model);
    else channels.set(model.channel.id, { channel: model.channel, models: [model] });
  }

  return (
    <section className="polaris-rise mt-10" aria-labelledby="ai-models-title">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="ai-models-title" className="flex items-center gap-2 text-[16px] leading-6 font-semibold tracking-[-0.01em] text-[var(--polaris-ink)]">
          <Bot size={16} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
          {t('title')}
        </h2>
        {models.length ? (
          <span className="polaris-num ml-auto flex items-center gap-3 text-[12.5px] text-[var(--polaris-ink-3)]">
            <span aria-hidden="true" className="hidden h-1.5 w-16 gap-px overflow-hidden rounded-full bg-[var(--polaris-rail-empty)] sm:flex">
              {mix.map((row) => (
                <span key={row.tone} className={clsx('h-full', row.fill)} style={{ width: `${(row.n / models.length) * 100}%` }} />
              ))}
            </span>
            {t('upCount', { up, total: models.length })}
          </span>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 text-[13px] text-[var(--polaris-ink-3)]">
          <p>{t(models.length ? 'staleData' : 'loadFailed')}</p>
          <button type="button" className="underline underline-offset-4 hover:text-[var(--polaris-ink)]" onClick={retry}>
            {t('retry')}
          </button>
        </div>
      ) : null}
      {loading && !models.length ? <span role="status" aria-label={t('loading')} className="polaris-shimmer block h-[68px] rounded-xl" /> : null}

      <div className="flex flex-col gap-8">
        {[...channels.values()].map(({ channel, models: own }) => (
          <ChannelGroup key={channel.id} channel={channel} models={own} error={error} filtering={filtering}>
            {cards ? (
              <ul className={clsx('grid grid-cols-1 gap-4 sm:grid-cols-2', columns)}>
                {own.map(model => <ModelTile key={model.id} model={model} error={error} expanded={expanded === model.id} onToggle={() => toggle(model.id)} />)}
              </ul>
            ) : (
              <ul className="polaris-card divide-y divide-[var(--polaris-line-soft)] overflow-hidden">
                {own.map(model => <ModelRow key={model.id} model={model} error={error} expanded={expanded === model.id} onToggle={() => toggle(model.id)} />)}
              </ul>
            )}
          </ChannelGroup>
        ))}
      </div>
    </section>
  );
}

const CHANNEL_FOLDS_KEY = 'uptime-polaris.ai.collapsed-channels';

function foldedChannels(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CHANNEL_FOLDS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

function ChannelGroup({ channel, models, error, filtering, children }: { channel: PublicAiModel['channel']; models: PublicAiModel[]; error: boolean; filtering: boolean; children: React.ReactNode }) {
  const t = useTranslations('ai');
  const id = useId();
  const [folded, setFolded] = useState(() => foldedChannels().includes(channel.id));
  const open = filtering || !folded;
  const tones = models.map(model => aiLiveTone(model.live, error));
  const up = tones.filter(tone => tone === 'up').length;
  const mix = MIX.map(row => ({ ...row, n: tones.filter(tone => tone === row.tone).length })).filter(row => row.n);
  const toggle = () => {
    const next = !folded;
    setFolded(next);
    try {
      const ids = new Set(foldedChannels());
      if (next) ids.add(channel.id); else ids.delete(channel.id);
      localStorage.setItem(CHANNEL_FOLDS_KEY, JSON.stringify([...ids]));
    } catch {}
  };
  return (
    <section aria-labelledby={id}>
      <div className="mb-3 flex items-center gap-3">
        <h3 id={id} className="min-w-0 text-[15px] leading-6 font-semibold text-[var(--polaris-ink)]">
          <button type="button" aria-expanded={open} aria-controls={`${id}-models`} onClick={toggle} className="-ml-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 text-left transition-colors hover:text-[var(--polaris-ink-2)]">
            <ChevronDown size={16} aria-hidden="true" className={clsx('shrink-0 text-[var(--polaris-ink-4)] transition-transform duration-200', !open && '-rotate-90')} />
            <span className="truncate" title={channel.name}>{channel.name}</span>
          </button>
        </h3>
        <span className="polaris-num ml-auto flex shrink-0 items-center gap-3 text-[12.5px] text-[var(--polaris-ink-3)]">
          <span aria-hidden="true" className="hidden h-1.5 w-16 gap-px overflow-hidden rounded-full bg-[var(--polaris-rail-empty)] sm:flex">
            {mix.map(row => <span key={row.tone} className={clsx('h-full', row.fill)} style={{ width: `${row.n / models.length * 100}%` }} />)}
          </span>
          {t('upCount', { up, total: models.length })}
        </span>
      </div>
      <MotionDisclosure open={open}><div id={`${id}-models`}>{children}</div></MotionDisclosure>
    </section>
  );
}

interface ItemProps {
  model: PublicAiModel;
  error: boolean;
  expanded: boolean;
  onToggle: () => void;
}

function MetaLine({ model, error }: { model: PublicAiModel; error: boolean }) {
  const t = useTranslations('ai');
  const presentation = usePresentationView();
  const ago = useTimeAgo();
  const { live } = model;
  const tone = aiLiveTone(live, error);
  const parts: React.ReactNode[] = [];
  if (presentation?.showLatency !== false && live.checkedAt && live.latencyMs !== null && tone !== 'down') parts.push(<span className="polaris-num">{Math.round(live.latencyMs)} ms</span>);
  if (live.checkedAt) parts.push(<span className="text-[var(--polaris-ink-4)]">{ago(live.checkedAt)}</span>);
  return (
    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-[var(--polaris-ink-3)]">
      <span className={clsx('font-medium', tone === 'idle' ? 'text-[var(--polaris-ink-3)]' : TONE_TEXT[tone])}>{t(aiLiveLabelKey(live, error))}</span>
      {parts.map((part, index) => (
        <span key={index} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="text-[var(--polaris-ink-4)]">
            ·
          </span>
          {part}
        </span>
      ))}
    </div>
  );
}

function Availability({ model, large = false }: { model: PublicAiModel; large?: boolean }) {
  const t = useTranslations('ai');
  const format = useFormatter();
  const presentation = usePresentationView();
  if (presentation?.showAvailability === false) return null;
  const value = model.live.availabilityPct;
  return (
    <div className="shrink-0 text-right">
      <span className={clsx('polaris-num block font-semibold', large ? 'text-[15px] leading-5' : 'text-[13.5px]', availabilityInk(value))}>
        {value === null ? '—' : `${format.number(value, { maximumFractionDigits: 2 })}%`}
      </span>
      <span className="block text-[11px] text-[var(--polaris-ink-4)]">{t('availabilityShort')}</span>
    </div>
  );
}

function HistoryPanel({ model }: { model: PublicAiModel }) {
  const { pageId } = usePageConfig();
  return (
    <div id={`ai-history-${model.id}`} className="border-t border-[var(--polaris-line-soft)] px-4 py-5 sm:px-5">
      <AiHistory recent={model.recent} url={(days) => publicApiUrl(`/api/public/ai/models/${encodeURIComponent(model.id)}/history?days=${days}`, pageId)} />
    </div>
  );
}

function HistoryToggle({ model, expanded, onToggle, className }: { model: PublicAiModel; expanded: boolean; onToggle: () => void; className?: string }) {
  const t = useTranslations('ai');
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={`ai-history-${model.id}`}
      aria-label={`${model.name} · ${t('history')}`}
      onClick={onToggle}
      className={clsx('inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-[var(--polaris-ink-3)] transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]', className)}
    >
      {t('history')}
      <ChevronDown size={14} className={clsx('transition-transform duration-200', expanded && 'rotate-180')} />
    </button>
  );
}

function ModelRow({ model, error, expanded, onToggle }: ItemProps) {
  const presentation = usePresentationView();
  const history = presentation?.showHistory !== false;
  return (
    <li>
      <div
        className={clsx(
          'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 px-4 sm:px-5 md:grid-cols-[minmax(0,1fr)_minmax(0,300px)_4.75rem_auto] md:gap-6',
          presentation?.density === 'compact' ? 'py-2' : presentation?.density === 'comfortable' ? 'py-5' : 'py-3.5',
        )}
      >
        <div className="col-span-2 flex min-w-0 items-center gap-3 md:col-span-1">
          <GlyphTile badge={aiLiveTone(model.live, error)}>
            <Bot size={17} />
          </GlyphTile>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[14px] font-medium text-[var(--polaris-ink)]">{model.name}</h3>
            <MetaLine model={model} error={error} />
          </div>
        </div>
        {history ? <AiRail checks={model.recent} max={40} className="min-w-0" /> : <span className="hidden md:block" />}
        <Availability model={model} />
        {history ? <HistoryToggle model={model} expanded={expanded} onToggle={onToggle} className="col-span-2 justify-self-start md:col-span-1 md:justify-self-end" /> : null}
      </div>
      {history && expanded ? <HistoryPanel model={model} /> : null}
    </li>
  );
}

function ModelTile({ model, error, expanded, onToggle }: ItemProps) {
  const presentation = usePresentationView();
  const history = presentation?.showHistory !== false;
  const series = recentLatency(model.recent, 60);
  const hasLine = series.filter((value) => value !== null).length > 1;
  return (
    <li className={clsx('polaris-card min-w-0 overflow-hidden', expanded && 'sm:col-span-2 lg:col-span-full')}>
      <div className={clsx('flex flex-col gap-4', presentation?.density === 'compact' ? 'p-3' : presentation?.density === 'comfortable' ? 'p-6' : 'p-4')}>
        <div className="flex items-start gap-3">
          <GlyphTile badge={aiLiveTone(model.live, error)}>
            <Bot size={17} />
          </GlyphTile>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[14px] font-medium text-[var(--polaris-ink)]">{model.name}</h3>
            <MetaLine model={model} error={error} />
          </div>
          <Availability model={model} large />
        </div>
        {presentation?.showLatency === false ? null : hasLine ? (
          <SparkLine values={series} height={44} className="text-[var(--polaris-chart)]" />
        ) : (
          <div className="h-11 rounded-lg bg-[var(--polaris-well)]" aria-hidden="true" />
        )}
        {history ? (
          <>
            <AiRail checks={model.recent} max={30} height="h-5" />
            <HistoryToggle model={model} expanded={expanded} onToggle={onToggle} className="-mx-1 -mt-1 self-start" />
          </>
        ) : null}
      </div>
      {history && expanded ? <HistoryPanel model={model} /> : null}
    </li>
  );
}
