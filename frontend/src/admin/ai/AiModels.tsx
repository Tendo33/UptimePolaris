import { AiRail } from '@/components/ai/AiRail';
import { aiLiveLabelKey, aiStatusKey } from '@/components/ai/status';
import { GlyphTile } from '@/components/ui/GlyphTile';
import { Dropdown } from '@/components/ui/MotionOverlays';
import { TONE_TEXT } from '@/components/ui/StatusDot';
import { useTimeAgo } from '@/hooks/useTimeAgo';
import { Button, Checkbox, DropdownItem, DropdownMenu, DropdownSection, DropdownTrigger, Tooltip } from '@heroui/react';
import clsx from 'clsx';
import { Bot, Copy, Download, Eye, EyeOff, History, MoreHorizontal, Pause, Pencil, Play, Plus, SearchCheck, Trash2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import type { AiChannel, AiModel } from '../../../../shared/ai-management';
import { EmptyState } from '../components/ConsolePrimitives';
import { PulseArt, SearchArt } from '../components/illustrations';
import { ListFooter, ListFrame, ListToolbar, ManualResult, SortSelect, availabilityInk } from './AiParts';
import { aiBucket, aiTone, bucketCounts, bulkTargets, manualResult, sortModels, type AiBucket, type AiBulkOp, type AiSort, type ManualResults } from './presentation';

interface ModelHandlers {
  onHistory: (model: AiModel) => void;
  onCheck: (model: AiModel) => void;
  onEdit: (model: AiModel) => void;
  onDuplicate: (model: AiModel) => void;
  onToggle: (model: AiModel) => void;
  onTogglePublic: (model: AiModel) => void;
  onDelete: (model: AiModel) => void;
}

/*
  One template for the header and every row. Below lg a row stacks: name and
  actions, then status and availability, then the rail across the full width.
  一套列模板同时用于表头和各行；小于 lg 时依次为名称与操作、状态与可用率、整行状态条。
*/
const GRID = 'grid grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-3 gap-y-2 lg:grid-cols-[1.25rem_minmax(0,1.25fr)_minmax(0,1fr)_minmax(9rem,15rem)_5.5rem_6.5rem] lg:items-center lg:gap-x-5';

export function useIntervalLabel() {
  const t = useTranslations('admin.ai');
  return (seconds: number) =>
    seconds % 3600 === 0 ? t('everyHours', { n: seconds / 3600 }) : seconds % 60 === 0 ? t('everyMinutes', { n: seconds / 60 }) : t('intervalValue', { seconds });
}

export function AiModelList({
  channel,
  models,
  unavailable,
  filter,
  onFilter,
  query,
  onQuery,
  sort,
  onSort,
  selected,
  onSelect,
  onBulk,
  bulkProgress,
  refreshInterval,
  results,
  busy,
  focusId,
  onAdd,
  onImport,
  ...handlers
}: ModelHandlers & {
  channel: AiChannel;
  models: AiModel[];
  unavailable: boolean;
  filter: AiBucket | null;
  onFilter: (bucket: AiBucket | null) => void;
  query: string;
  onQuery: (query: string) => void;
  sort: AiSort;
  onSort: (sort: AiSort) => void;
  selected: Set<string>;
  onSelect: (ids: string[], on: boolean) => void;
  onBulk: (op: AiBulkOp, models: AiModel[]) => void;
  bulkProgress: { done: number; total: number } | null;
  refreshInterval: number;
  results: ManualResults;
  busy: string | null;
  focusId: string | null;
  onAdd: () => void;
  onImport: () => void;
}) {
  const t = useTranslations('admin.ai');
  const counts = bucketCounts(models, unavailable);
  const needle = query.trim().toLowerCase();
  const shown = sortModels(models, sort, unavailable).filter(
    (model) => (!filter || aiBucket(model, unavailable) === filter) && (!needle || `${model.name}\n${model.modelId}`.toLowerCase().includes(needle)),
  );
  const manual = shown.some((model) => manualResult(results, 'model', model.id, model.revision, channel.revision));
  const picked = models.filter((model) => selected.has(model.id));
  const allShown = shown.length > 0 && shown.every((model) => selected.has(model.id));
  const someShown = shown.some((model) => selected.has(model.id));

  const selectAll = (
    <Checkbox
      size="sm"
      aria-label={t('selectAll')}
      isSelected={allShown}
      isIndeterminate={someShown && !allShown}
      isDisabled={shown.length === 0 || busy !== null}
      onValueChange={(on) => onSelect(shown.map((model) => model.id), on)}
      className="mr-1 pl-2"
    />
  );

  return (
    <ListFrame
      busy={busy === 'bulk'}
      toolbar={
        picked.length ? (
          <BulkBar picked={picked} progress={bulkProgress} busy={busy} leading={selectAll} onBulk={onBulk} onClear={() => onSelect(picked.map((model) => model.id), false)} />
        ) : (
          <ListToolbar
            counts={counts}
            filter={filter}
            onFilter={onFilter}
            query={query}
            onQuery={onQuery}
            placeholder={t('searchModels')}
            leading={models.length ? selectAll : null}
            extra={models.length > 1 ? <SortSelect value={sort} onChange={onSort} /> : null}
          />
        )
      }
      footer={
        <>
          <ListFooter label="footModels" shown={shown.length} total={models.length} refreshInterval={refreshInterval} />
          <span className="min-w-0 sm:ml-auto">{t(manual ? 'manualResultsHint' : 'scheduledHint')}</span>
        </>
      }
    >
      {models.length === 0 ? (
        <EmptyState
          art={<PulseArt />}
          title={t('noModels')}
          hint={t('noModelsHint')}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button color="primary" size="sm" startContent={<Plus size={15} />} onPress={onAdd}>
                {t('addModel')}
              </Button>
              <Button size="sm" variant="bordered" startContent={<Download size={14} />} onPress={onImport}>
                {t('importModels')}
              </Button>
            </div>
          }
        />
      ) : shown.length === 0 ? (
        <EmptyState
          art={<SearchArt />}
          title={t('noMatch')}
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
        <>
          <div aria-hidden="true" className={clsx(GRID, 'hidden border-b border-[var(--polaris-line-soft)] px-5 py-2 text-[12px] text-[var(--polaris-ink-3)] lg:grid')}>
            <span />
            <span>{t('col.model')}</span>
            <span>{t('col.status')}</span>
            <span>{t('col.recent')}</span>
            <span className="text-right">{t('col.availability')}</span>
            <span className="text-right">{t('col.actions')}</span>
          </div>
          <ul className="divide-y divide-[var(--polaris-line-soft)]">
            {shown.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                unavailable={unavailable}
                result={manualResult(results, 'model', model.id, model.revision, channel.revision)}
                busy={busy}
                focused={focusId === model.id}
                selected={selected.has(model.id)}
                onSelect={(on) => onSelect([model.id], on)}
                {...handlers}
              />
            ))}
          </ul>
        </>
      )}
    </ListFrame>
  );
}

function BulkBar({
  picked,
  progress,
  busy,
  leading,
  onBulk,
  onClear,
}: {
  picked: AiModel[];
  progress: { done: number; total: number } | null;
  busy: string | null;
  leading: React.ReactNode;
  onBulk: (op: AiBulkOp, models: AiModel[]) => void;
  onClear: () => void;
}) {
  const t = useTranslations('admin.ai');
  const action = useTranslations('admin.action');
  const locked = busy !== null;
  const ops: Array<{ op: AiBulkOp; icon: React.ReactNode; label: string }> = [
    { op: 'resume', icon: <Play size={14} />, label: t('resume') },
    { op: 'pause', icon: <Pause size={14} />, label: t('pause') },
    { op: 'public', icon: <Eye size={14} />, label: t('makePublic') },
    { op: 'private', icon: <EyeOff size={14} />, label: t('makePrivate') },
  ];
  return (
    <>
      {leading}
      <span className="polaris-num mr-1 text-[13px] font-semibold text-[var(--polaris-ink)]">
        {progress ? t('bulkProgress', { done: progress.done, total: progress.total }) : t('selectedCount', { count: picked.length })}
      </span>
      <div className="flex flex-wrap items-center gap-1">
        {ops.map(({ op, icon, label }) => {
          const count = bulkTargets(picked, op).length;
          return (
            <Button key={op} size="sm" variant="light" isDisabled={locked || count === 0} startContent={icon} onPress={() => onBulk(op, picked)}>
              {label}
              {count && count !== picked.length ? <span className="polaris-num text-[var(--polaris-ink-4)]">{count}</span> : null}
            </Button>
          );
        })}
        <Button size="sm" variant="light" color="danger" isDisabled={locked} startContent={<Trash2 size={14} />} onPress={() => onBulk('delete', picked)}>
          {action('delete')}
        </Button>
      </div>
      <Button size="sm" variant="light" className="ml-auto" isDisabled={locked} startContent={<X size={14} />} onPress={onClear}>
        {t('clearSelection')}
      </Button>
    </>
  );
}

function ModelRow({
  model,
  unavailable,
  result,
  busy,
  focused,
  selected,
  onSelect,
  onHistory,
  onCheck,
  onEdit,
  onDuplicate,
  onToggle,
  onTogglePublic,
  onDelete,
}: ModelHandlers & {
  model: AiModel;
  unavailable: boolean;
  result: ReturnType<typeof manualResult>;
  busy: string | null;
  focused: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
}) {
  const t = useTranslations('admin.ai');
  const ai = useTranslations('ai');
  const action = useTranslations('admin.action');
  const format = useFormatter();
  const ago = useTimeAgo();
  const every = useIntervalLabel();
  const ref = useRef<HTMLLIElement>(null);
  const { live } = model;
  const tone = aiTone(model, unavailable);
  const status = unavailable ? 'unknown' : aiStatusKey(live);
  const rowBusy = busy === `model:${model.id}`;
  const locked = busy !== null;
  const now = Math.floor(Date.now() / 1000);
  const nextIn = model.enabled && live.nextCheckAt > now ? live.nextCheckAt - now : null;

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focused]);

  return (
    <li
      ref={ref}
      className={clsx(
        'px-4 py-3.5 transition-colors duration-500 sm:px-5',
        focused ? 'bg-primary/[0.05]' : selected ? 'bg-[var(--polaris-hover)]' : 'hover:bg-[var(--polaris-hover)]',
      )}
    >
      <div className={GRID}>
        <div className="col-start-1 row-start-1 flex items-center lg:col-start-1">
          <Checkbox size="sm" aria-label={t('selectNamed', { name: model.name })} isSelected={selected} isDisabled={locked} onValueChange={onSelect} />
        </div>

        <div className="col-start-2 row-start-1 flex min-w-0 items-center gap-3 lg:col-start-2">
          <GlyphTile badge={tone}>
            <Bot size={17} />
          </GlyphTile>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <button type="button" onClick={() => onHistory(model)} className="min-w-0 truncate text-left text-[14px] font-medium text-[var(--polaris-ink)] underline-offset-4 hover:underline">
                {model.name}
              </button>
              {model.isPublic && model.enabled ? null : (
                <Tooltip content={t(model.isPublic ? 'pausedHiddenHint' : 'privateHint')} delay={300} closeDelay={0}>
                  <span className="inline-flex shrink-0 text-[var(--polaris-ink-4)]">
                    <EyeOff size={13} aria-label={t('private')} />
                  </span>
                </Tooltip>
              )}
            </div>
            <p className="mt-0.5 truncate font-mono text-[12px] text-[var(--polaris-ink-3)]" title={model.modelId}>
              {model.modelId}
            </p>
          </div>
        </div>

        <div className="col-start-2 row-start-2 min-w-0 lg:col-start-3 lg:row-start-1">
          <p className={clsx('flex min-w-0 items-center gap-1.5 text-[13px] font-medium', tone === 'idle' ? 'text-[var(--polaris-ink-2)]' : TONE_TEXT[tone])}>
            <span className="truncate" title={ai(aiLiveLabelKey(live, unavailable))}>
              {ai(aiLiveLabelKey(live, unavailable))}
            </span>
            {status === 'down' && live.consecutiveFailures > 1 ? (
              <span className="polaris-num shrink-0 rounded-full bg-danger/[0.08] px-1.5 text-[11px] font-medium text-danger-600">{t('failStreak', { count: live.consecutiveFailures })}</span>
            ) : null}
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-[12px] text-[var(--polaris-ink-3)]">
            {live.checkedAt ? (
              <time dateTime={new Date(live.checkedAt * 1000).toISOString()} title={format.dateTime(new Date(live.checkedAt * 1000), { dateStyle: 'medium', timeStyle: 'medium' })}>
                {ago(live.checkedAt)}
              </time>
            ) : null}
            {live.checkedAt && live.latencyMs !== null ? <span className="polaris-num">· {Math.round(live.latencyMs)} ms</span> : null}
            {status === 'unknown' && live.outcome && live.freshness !== 'current' ? <span>· {ai('lastOutcome', { outcome: ai(`outcomes.${live.outcome}`) })}</span> : null}
            <span className="text-[var(--polaris-ink-4)]" title={nextIn !== null ? t('nextCheck', { time: format.relativeTime(new Date(live.nextCheckAt * 1000), new Date(now * 1000)) }) : undefined}>
              · {every(model.intervalSec)}
            </span>
          </p>
        </div>

        <div className="col-span-2 col-start-2 row-start-3 min-w-0 lg:col-span-1 lg:col-start-4 lg:row-start-1">
          <AiRail checks={model.recent} max={30} height="h-5" />
        </div>

        <div className="col-start-3 row-start-2 text-right lg:col-start-5 lg:row-start-1">
          <span className={clsx('polaris-num block text-[13.5px] font-semibold', availabilityInk(live.availabilityPct))}>
            {live.availabilityPct === null ? '—' : `${format.number(live.availabilityPct, { maximumFractionDigits: 2 })}%`}
          </span>
          <span className="block text-[11px] text-[var(--polaris-ink-4)]">{t('checksTotal', { count: live.total })}</span>
        </div>

        <div className="col-start-3 row-start-1 flex items-center justify-end gap-0.5 lg:col-start-6">
          <Tooltip content={t('history')} delay={300} closeDelay={0}>
            <Button size="sm" isIconOnly variant="light" aria-label={t('history')} onPress={() => onHistory(model)}>
              <History size={15} />
            </Button>
          </Tooltip>
          <Tooltip content={t('checkModel')} delay={300} closeDelay={0}>
            <Button size="sm" isIconOnly variant="light" isDisabled={locked} aria-label={t('checkModel')} onPress={() => onCheck(model)}>
              <SearchCheck size={15} />
            </Button>
          </Tooltip>
          <Dropdown placement="bottom-end">
            <DropdownTrigger>
              <Button size="sm" isIconOnly variant="light" isDisabled={locked && !rowBusy} isLoading={rowBusy} aria-label={t('moreNamed', { name: model.name })}>
                <MoreHorizontal size={16} />
              </Button>
            </DropdownTrigger>
            <DropdownMenu aria-label={t('moreNamed', { name: model.name })} disabledKeys={locked ? ['toggle', 'public', 'delete'] : []}>
              <DropdownSection showDivider>
                <DropdownItem key="edit" startContent={<Pencil size={15} />} onPress={() => onEdit(model)}>
                  {action('edit')}
                </DropdownItem>
                <DropdownItem key="duplicate" startContent={<Copy size={15} />} onPress={() => onDuplicate(model)}>
                  {t('duplicate')}
                </DropdownItem>
                <DropdownItem key="toggle" startContent={model.enabled ? <Pause size={15} /> : <Play size={15} />} onPress={() => onToggle(model)}>
                  {t(model.enabled ? 'pause' : 'resume')}
                </DropdownItem>
                <DropdownItem key="public" startContent={model.isPublic ? <EyeOff size={15} /> : <Eye size={15} />} onPress={() => onTogglePublic(model)}>
                  {t(model.isPublic ? 'makePrivate' : 'makePublic')}
                </DropdownItem>
              </DropdownSection>
              <DropdownSection>
                <DropdownItem key="delete" color="danger" className="text-danger" startContent={<Trash2 size={15} />} onPress={() => onDelete(model)}>
                  {action('delete')}
                </DropdownItem>
              </DropdownSection>
            </DropdownMenu>
          </Dropdown>
        </div>
      </div>
      {result ? <ManualResult className="mt-2 pl-8" result={result} label={t('manualResult')} /> : null}
    </li>
  );
}
