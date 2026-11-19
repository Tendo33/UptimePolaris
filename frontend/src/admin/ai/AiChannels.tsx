import { GlyphTile } from '@/components/ui/GlyphTile';
import { Dropdown } from '@/components/ui/MotionOverlays';
import { useTimeAgo } from '@/hooks/useTimeAgo';
import { Button, DropdownItem, DropdownMenu, DropdownSection, DropdownTrigger, Tooltip } from '@heroui/react';
import clsx from 'clsx';
import { Bot, ChevronRight, Copy, KeyRound, ListChecks, MoreHorizontal, Pencil, Plus, SearchCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useFormatter, useTranslations } from 'use-intl';
import type { AiChannel, AiManualResult, AiModel } from '../../../../shared/ai-management';
import type { Tone } from '@/types/tone';
import { EmptyState } from '../components/ConsolePrimitives';
import { SearchArt } from '../components/illustrations';
import { Panel } from '../components/Panel';
import { ListFooter, ListFrame, ListToolbar, ManualResult, ProtocolChip, availabilityInk } from './AiParts';
import { aiBucket, aiTone, bucketCounts, byCreated, channelAvailability, hostOf, manualResult, requestUrl, type AiBucket, type ManualResults } from './presentation';

const TONE_RANK: Tone[] = ['down', 'warn', 'pending', 'up', 'idle'];
const MIX_FILL: Record<AiBucket, string> = {
  up: 'bg-[var(--polaris-rail-up)]',
  down: 'bg-danger',
  unknown: 'bg-warning',
  paused: 'bg-default-300',
};

export function AiChannelList({
  channels,
  models,
  unavailable,
  filter,
  onFilter,
  query,
  onQuery,
  refreshInterval,
  results,
  busy,
  onAdd,
  onTest,
  onEdit,
  onDelete,
}: {
  channels: AiChannel[];
  models: AiModel[];
  unavailable: boolean;
  filter: AiBucket | null;
  onFilter: (bucket: AiBucket | null) => void;
  query: string;
  onQuery: (query: string) => void;
  refreshInterval: number;
  results: ManualResults;
  busy: string | null;
  onAdd: () => void;
  onTest: (channel: AiChannel) => void;
  onEdit: (channel: AiChannel) => void;
  onDelete: (channel: AiChannel) => void;
}) {
  const t = useTranslations('admin.ai');
  const needle = query.trim().toLowerCase();
  const modelsOf = (channel: AiChannel) => models.filter((model) => model.channelId === channel.id);
  const shown = [...channels].sort(byCreated).filter((channel) => {
    const own = modelsOf(channel);
    if (filter && !own.some((model) => aiBucket(model, unavailable) === filter)) return false;
    if (!needle) return true;
    return [channel.name, channel.baseUrl, ...own.flatMap((model) => [model.name, model.modelId])].some((text) => text.toLowerCase().includes(needle));
  });

  return (
    <ListFrame
      toolbar={<ListToolbar counts={bucketCounts(models, unavailable)} filter={filter} onFilter={onFilter} query={query} onQuery={onQuery} placeholder={t('searchChannels')} />}
      footer={<ListFooter label="footChannels" shown={shown.length} total={channels.length} refreshInterval={refreshInterval} />}
    >
      {channels.length === 0 ? (
        <EmptyState
          art={<ChannelArt />}
          title={t('noChannels')}
          hint={t('noChannelsHint')}
          action={
            <Button color="primary" size="sm" startContent={<Plus size={15} />} onPress={onAdd}>
              {t('addChannel')}
            </Button>
          }
        />
      ) : shown.length === 0 ? (
        <EmptyState
          art={<SearchArt />}
          title={t('noMatchChannels')}
          action={
            <Button
              size="sm"
              variant="bordered"
              onPress={() => {
                onFilter(null);
                onQuery('');
              }}
            >
              {t('clearFilter')}
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-[var(--polaris-line-soft)]">
          {shown.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              models={modelsOf(channel)}
              unavailable={unavailable}
              result={manualResult(results, 'channel', channel.id, channel.revision, channel.revision)}
              busy={busy}
              onTest={onTest}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </ListFrame>
  );
}

function ChannelRow({
  channel,
  models,
  unavailable,
  result,
  busy,
  onTest,
  onEdit,
  onDelete,
}: {
  channel: AiChannel;
  models: AiModel[];
  unavailable: boolean;
  result: AiManualResult | undefined;
  busy: string | null;
  onTest: (channel: AiChannel) => void;
  onEdit: (channel: AiChannel) => void;
  onDelete: (channel: AiChannel) => void;
}) {
  const t = useTranslations('admin.ai');
  const format = useFormatter();
  const action = useTranslations('admin.action');
  const navigate = useNavigate();
  const href = `/admin/ai/${encodeURIComponent(channel.id)}`;
  const counts = bucketCounts(models, unavailable);
  const worst = models.length ? TONE_RANK.find((tone) => models.some((model) => aiTone(model, unavailable) === tone)) : undefined;
  const mix = (['down', 'unknown', 'up', 'paused'] as const).filter((bucket) => counts[bucket] > 0);
  const availability = channelAvailability(models);

  return (
    <li className="group grid grid-cols-1 gap-3 px-4 py-4 transition-colors hover:bg-[var(--polaris-hover)] sm:px-5 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_5.5rem_auto] md:items-center md:gap-6">
      <div className="flex min-w-0 items-center gap-3">
        <GlyphTile badge={worst}>
          <Bot size={17} />
        </GlyphTile>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Link to={href} className="min-w-0 truncate text-[14px] font-medium text-[var(--polaris-ink)] underline-offset-4 hover:underline">
              {channel.name}
            </Link>
            <ProtocolChip protocol={channel.protocol} />
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--polaris-ink-3)]">
            <span className="truncate font-mono" title={channel.baseUrl}>
              {hostOf(channel.baseUrl)}
            </span>
            {!channel.hasApiKey ? (
              <span className="flex shrink-0 items-center gap-1 text-warning-700">
                · <KeyRound size={12} /> {t('keyMissing')}
              </span>
            ) : null}
            {channel.headerNames.length ? <span className="shrink-0">· {t('headersCount', { count: channel.headerNames.length })}</span> : null}
          </p>
        </div>
      </div>

      <div className="min-w-0 pl-11 md:pl-0">
        {models.length ? (
          <>
            <span aria-hidden="true" className="flex h-1.5 w-full max-w-40 gap-px overflow-hidden rounded-full bg-[var(--polaris-rail-empty)]">
              {mix.map((bucket) => (
                <span key={bucket} className={clsx('h-full', MIX_FILL[bucket])} style={{ width: `${(counts[bucket] / models.length) * 100}%` }} />
              ))}
            </span>
            <p className="polaris-num mt-1.5 flex flex-wrap gap-x-2 text-[12px] text-[var(--polaris-ink-3)]">
              <span className="text-[var(--polaris-ink-2)]">{t('modelCount', { count: models.length })}</span>
              {mix.map((bucket) => (
                <span key={bucket} className={bucket === 'down' ? 'text-danger-600' : bucket === 'unknown' ? 'text-warning-700' : undefined}>
                  {counts[bucket]} {t(`bucket.${bucket}`)}
                </span>
              ))}
            </p>
          </>
        ) : (
          <p className="text-[12px] text-[var(--polaris-ink-4)]">{t('noModelsShort')}</p>
        )}
        {result ? <ManualResult className="mt-1.5" result={result} label={t('lastTest')} /> : null}
      </div>

      <div className="flex items-baseline gap-2 pl-11 md:block md:pl-0 md:text-right">
        <span className={clsx('polaris-num text-[13.5px] font-semibold', availabilityInk(availability))}>{availability === null ? '—' : `${format.number(availability, { maximumFractionDigits: 2 })}%`}</span>
        <span className="block text-[11px] text-[var(--polaris-ink-4)]">{t('channelAvailability')}</span>
      </div>

      <div className="flex items-center gap-1 pl-11 md:pl-0">
        <Tooltip content={t('testChannel')} delay={200} closeDelay={0}>
          <Button size="sm" isIconOnly variant="light" aria-label={t('testChannel')} isDisabled={busy !== null && busy !== `channel:${channel.id}`} isLoading={busy === `channel:${channel.id}`} onPress={() => onTest(channel)}>
            <SearchCheck size={16} />
          </Button>
        </Tooltip>
        <Dropdown placement="bottom-end">
          <DropdownTrigger>
            <Button size="sm" isIconOnly variant="light" aria-label={t('moreNamed', { name: channel.name })}>
              <MoreHorizontal size={16} />
            </Button>
          </DropdownTrigger>
          <DropdownMenu aria-label={t('moreNamed', { name: channel.name })} disabledKeys={busy !== null ? ['delete'] : []}>
            <DropdownSection showDivider>
              <DropdownItem key="open" startContent={<ListChecks size={15} />} onPress={() => navigate(href)}>
                {t('viewModels')}
              </DropdownItem>
              <DropdownItem key="edit" startContent={<Pencil size={15} />} onPress={() => onEdit(channel)}>
                {action('edit')}
              </DropdownItem>
            </DropdownSection>
            <DropdownSection>
              <DropdownItem key="delete" color="danger" className="text-danger" startContent={<Trash2 size={15} />} onPress={() => onDelete(channel)}>
                {action('delete')}
              </DropdownItem>
            </DropdownSection>
          </DropdownMenu>
        </Dropdown>
        <Link to={href} aria-label={t('viewModels')} className="hidden h-8 w-6 items-center justify-center text-[var(--polaris-ink-4)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--polaris-ink-2)] md:inline-flex">
          <ChevronRight size={16} />
        </Link>
      </div>
    </li>
  );
}

/** The channel's settings at a glance, above its models. / 模型列表上方的渠道配置摘要。 */
export function ChannelSummary({
  channel,
  result,
  busy,
  onTest,
  onEdit,
  onDelete,
}: {
  channel: AiChannel;
  result: AiManualResult | undefined;
  busy: string | null;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('admin.ai');
  const action = useTranslations('admin.action');
  const ago = useTimeAgo();
  const url = requestUrl(channel) ?? channel.baseUrl;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };
  const testing = busy === `channel:${channel.id}`;

  return (
    <Panel>
      <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2.2fr)_repeat(3,minmax(0,1fr))]">
        <div className="min-w-0">
          <dt className="text-[12px] text-[var(--polaris-ink-3)]">{t('requestUrl')}</dt>
          <dd className="mt-1 flex min-w-0 items-center gap-1">
            <span className="truncate font-mono text-[12.5px] text-[var(--polaris-ink)]" title={url}>
              {url}
            </span>
            <Tooltip content={copied ? t('copied') : action('copy')} delay={200} closeDelay={0}>
              <Button size="sm" isIconOnly variant="light" className="h-6 w-6 min-w-6 text-[var(--polaris-ink-4)]" aria-label={action('copy')} onPress={copy}>
                <Copy size={13} />
              </Button>
            </Tooltip>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[12px] text-[var(--polaris-ink-3)]">{t('protocol')}</dt>
          <dd className="mt-1 truncate text-[13px] text-[var(--polaris-ink)]">{t(channel.protocol)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[12px] text-[var(--polaris-ink-3)]">{t('apiKey')}</dt>
          <dd className={clsx('mt-1 flex items-center gap-1.5 text-[13px]', channel.hasApiKey ? 'text-[var(--polaris-ink)]' : 'text-warning-700')}>
            <KeyRound size={13} className="shrink-0 text-[var(--polaris-ink-4)]" />
            {t(channel.hasApiKey ? 'keySet' : 'keyMissing')}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[12px] text-[var(--polaris-ink-3)]">{t('headers')}</dt>
          <dd className="mt-1 truncate font-mono text-[12.5px] text-[var(--polaris-ink)]" title={channel.headerNames.join(', ')}>
            {channel.headerNames.length ? channel.headerNames.join(', ') : <span className="font-sans text-[var(--polaris-ink-4)]">{t('noHeaders')}</span>}
          </dd>
        </div>
      </dl>
      <div className="mt-4 flex flex-col gap-3 border-t border-[var(--polaris-line-soft)] pt-3 sm:flex-row sm:items-center sm:gap-x-4">
        <div className="flex min-w-0 flex-wrap sm:flex-1 items-center gap-x-4 gap-y-1 text-[12px] text-[var(--polaris-ink-3)]">
          {result ? <ManualResult result={result} label={t('lastTest')} /> : <span>{t('testHint')}</span>}
          <span className="text-[var(--polaris-ink-4)]">{t('updatedAgo', { time: ago(channel.updatedAt) })}</span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button size="sm" variant="bordered" isDisabled={busy !== null && !testing} isLoading={testing} onPress={onTest} startContent={testing ? null : <SearchCheck size={14} />}>
            {t('testChannel')}
          </Button>
          <Button size="sm" variant="bordered" onPress={onEdit} startContent={<Pencil size={14} />}>
            {t('editChannel')}
          </Button>
          <Tooltip content={t('deleteNamed', { name: channel.name })} delay={300} closeDelay={0}>
            <Button size="sm" isIconOnly variant="light" color="danger" isDisabled={busy !== null} aria-label={t('deleteNamed', { name: channel.name })} onPress={onDelete}>
              <Trash2 size={15} />
            </Button>
          </Tooltip>
        </div>
      </div>
    </Panel>
  );
}

function ChannelArt() {
  return (
    <svg viewBox="0 0 120 88" width="132" height="97" aria-hidden="true" className="overflow-visible">
      <circle cx="60" cy="44" r="40" className="fill-primary/[0.06]" />
      <rect x="18" y="20" width="84" height="22" rx="7" className="fill-[var(--polaris-card)] stroke-default-200" strokeWidth="1.5" />
      <rect x="18" y="48" width="84" height="22" rx="7" className="fill-[var(--polaris-card)] stroke-default-200" strokeWidth="1.5" />
      <rect x="27" y="27" width="8" height="8" rx="2.5" className="fill-primary" />
      <rect x="27" y="55" width="8" height="8" rx="2.5" className="fill-default-200" />
      <rect x="41" y="29" width="30" height="4" rx="2" className="fill-default-200" />
      <rect x="41" y="57" width="22" height="4" rx="2" className="fill-default-200" />
      <circle cx="91" cy="31" r="3" className="fill-success" />
      <circle cx="91" cy="59" r="3" className="fill-default-100" />
    </svg>
  );
}
